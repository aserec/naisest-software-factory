// The factory worker (seams.yml ci: local). It replaces GitLab CI: every minute it runs poll for each target (retry and,
// with a real log source, the watcher once an hour, and the improve job once a week), runs dispatch when the dashboard asks, takes the runs those steps queued, and runs each run with every step in a new container.
// FACTORY_EXECUTOR picks the Docker host of a run's containers:
// - machine (default): this machine's Docker, through the socket compose mounts into the worker container.
// - hetzner: a new Hetzner VM per run, deleted after it (HETZNER_TOKEN; FACTORY_HETZNER_TYPE and _LOCATION).
// Only run/ passes from one step to the next: a Docker volume per run. The worker alone writes RUNS_DIR
// (the finished runs) and mounts a run's earlier build run read-only, so the record still needs decision's checks.
import { setTimeout as wait } from "node:timers/promises";
import { errText } from "./errors";
import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { checkVars } from "./ci-vars";
import { TSX_IMPORT } from "./agents";
import { QUEUE_DIR, RUNS_DIR, type QueuedRun } from "./adapters/local-ci";
import { Hetzner, type Vm } from "./hetzner";
import { loadSeams, providerKeys } from "./config";
import { FACTORY_ROOT } from "./repo";
import { FILE_SECRETS, WORKER_ENV_NAMES } from "./secrets";
import { BUILD_STEPS, FINISH_STEPS } from "./steps/run";

export type Exec = (cmd: string, args: string[], env?: Record<string, string>, cwd?: string) => Promise<{ code: number; out: string }>;
const PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
// File secrets: a step reads each file and deletes it before any agent runs. Values never go on a command line:
// provider keys go to docker by name (`-e K`), with the value in docker's own env.
const WORKER_SECRETS = Object.fromEntries(FILE_SECRETS.map((n) => [n, WORKER_ENV_NAMES[n] ?? n]));
const SECRET_DIR = `${FACTORY_ROOT}.tmp`;

export const realExec: Exec = (cmd, args, env = {}, cwd) =>
  new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, env: { PATH, HOME: homedir(), ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const keep = (d: Buffer) => { process.stdout.write(d); out = (out + d).slice(-20_000); };
    p.stdout.on("data", keep);
    p.stderr.on("data", keep);
    p.on("close", (code) => resolve({ code: code ?? 1, out }));
    p.on("error", (e) => resolve({ code: 1, out: String(e) }));
  });

// The variables of one step, the same names .gitlab-ci.yml passes. Checked like a trigger's before anything runs.
export function stepEnv(base: NodeJS.ProcessEnv, v: { pipeline?: string; schedule?: string; target: string; run?: QueuedRun; id?: string; source?: string }, seams = loadSeams()): Record<string, string> {
  const e: Record<string, string> = {
    PATH, HOME: "/root", CLAUDE_CONFIG_DIR: `${FACTORY_ROOT}/run/claude-home`, PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright",
    FACTORY_PIPELINE: v.pipeline ?? "", FACTORY_SCHEDULE: v.schedule ?? "", FACTORY_TARGET: v.target,
    FACTORY_WORK_ITEM_IID: v.run?.ticket ?? "", FACTORY_MR_IID: v.run?.change ?? "", FACTORY_BUILD_PIPELINE_ID: v.run?.buildRun ?? "",
    FACTORY_SKIP_APPLY: v.run?.skipApply ? "1" : "", FACTORY_RUN_ID: v.id ?? "",
  };
  if (v.source) e.CI_PIPELINE_SOURCE = v.source; // web: a person started it (the watcher with logSource files)
  for (const k of ["FACTORY_DASHBOARD_URL", "NODE_EXTRA_CA_CERTS", ...providerKeys(seams)]) if (base[k]) e[k] = base[k]!;
  // A plan for the factory repo has no target, so only the fix step may leave it empty.
  checkVars(e, { FACTORY_RUN_ID: /^([0-9]+)?$/, FACTORY_TARGET: v.pipeline === "fix" ? /^[a-z0-9_-]*$/ : /^[a-z0-9_-]+$/ });
  return e;
}

// Fresh secret files in dir, and their paths as the step sees them (under seen, the step's <factory root>.tmp).
function secretFiles(base: NodeJS.ProcessEnv, dir: string, seen: string): Record<string, string> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const paths: Record<string, string> = {};
  for (const [name, from] of Object.entries(WORKER_SECRETS)) {
    if (!base[from]) continue;
    writeFileSync(join(dir, name), base[from]!, { mode: 0o600 });
    paths[name] = join(seen, name);
  }
  return paths;
}

// poll, resume-waiting, dispatch, watcher, improve and fix: short steps with no code tools, run in the worker container itself.
const SHORT = { poll: { schedule: "poll" }, "resume-waiting": { schedule: "retry" }, dispatch: { pipeline: "dispatch" }, watcher: { schedule: "watch" }, improve: { schedule: "improve" }, fix: { pipeline: "fix" } } as const;
export type ShortStep = keyof typeof SHORT;
// extra: more variables for the step, merged last (the fix step's plan). cwd: a folder for the step to work in. Then the step and tsx are named by absolute path, as a bare `tsx` or a relative path would not be found.
export async function runShort(exec: Exec, base: NodeJS.ProcessEnv, step: ShortStep, target: string, source?: string, cwd?: string, extra: Record<string, string> = {}): Promise<number> {
  const env = stepEnv(base, { ...SHORT[step], target, source });
  const dir = mkdtempSync(join(SECRET_DIR, "s-"));
  try {
    const script = cwd ? ["--import", TSX_IMPORT, join(FACTORY_ROOT, "factory/steps", `${step}.ts`)] : ["--import", "tsx", `factory/steps/${step}.ts`];
    const r = await exec("node", script, { ...env, HOME: homedir(), ...secretFiles(base, dir, dir), ...extra }, cwd);
    if (r.code !== 0) console.log(`${step} for ${target} ended with code ${r.code}`);
    return r.code;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The improve step clones the target into run/target of its working folder, and an existing clone is reused. So each job
// gets a folder of its own, removed afterwards: no later job, and no other target, ever finds an old clone or shares one.
export async function runImprove(exec: Exec, base: NodeJS.ProcessEnv, target: string) {
  const work = mkdtempSync(join(tmpdir(), `improve-${target}-`));
  try {
    await runShort(exec, base, "improve", target, undefined, work);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// The weekly improve job: true when <runsDir>/improve-<target> is missing or holds a time 7 or more days before now.
// The time is written first, so a failing job runs again in a week, and a restart does not run it again.
export function improveDue(target: string, now: Date, runsDir = RUNS_DIR): boolean {
  const f = join(runsDir, `improve-${target}`);
  const last = existsSync(f) ? Date.parse(readFileSync(f, "utf8")) : NaN;
  if (last > now.getTime() - 7 * 86_400_000) return false;
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(f, now.toISOString());
  return true;
}

// Where a run's containers start: this machine, or a VM made for the run.
export interface DockerHost { env: Record<string, string>; network?: string; close(): Promise<void> }
export type OpenHost = (id: string) => Promise<DockerHost>;

export const machineHost = (network = "factory"): OpenHost => async () => ({ env: {}, network, close: async () => {} });

export function hetznerHost(exec: Exec, base: NodeJS.ProcessEnv, image: string, hetzner = new Hetzner(base.HETZNER_TOKEN ?? "")): OpenHost {
  if (!base.HETZNER_TOKEN) throw new Error("FACTORY_EXECUTOR=hetzner needs HETZNER_TOKEN");
  // runner/cloud-init.yml, filled by install.sh: Docker, the user namespace setting, no metadata service for containers.
  const userData = readFileSync(base.FACTORY_HETZNER_USER_DATA ?? join(FACTORY_ROOT, "deploy/runner/cloud-init.yml"), "utf8");
  return async (id) => {
    const dir = mkdtempSync(join(tmpdir(), `vm-${id}-`));
    // A client key and a host key made for this VM alone, so the worker checks the host it talks to.
    for (const k of ["client", "host"]) {
      const r = await exec("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", `factory-${id}`, "-f", join(dir, k)]);
      if (r.code !== 0) throw new Error(`ssh-keygen failed: ${r.out}`);
    }
    const pub = (k: string) => readFileSync(join(dir, `${k}.pub`), "utf8").trim();
    const hostKeys = `\nssh_keys:\n  ed25519_private: |\n${readFileSync(join(dir, "host"), "utf8").trimEnd().replace(/^/gm, "    ")}\n  ed25519_public: ${pub("host")}\n`;
    const vm: Vm = await hetzner.create({ name: `factory-run-${id}`, serverType: base.FACTORY_HETZNER_TYPE ?? "ccx23", location: base.FACTORY_HETZNER_LOCATION ?? "fsn1", userData: userData + hostKeys, sshPublicKey: pub("client") });
    const close = async () => {
      await hetzner.remove(vm).catch((e) => console.log(`Could not delete VM ${vm.id}, delete it by hand: ${e}`));
      rmSync(dir, { recursive: true, force: true });
    };
    try {
      const alias = `factory-${id}`;
      writeFileSync(join(dir, "known_hosts"), `${vm.ip} ${pub("host")}\n`);
      writeFileSync(join(dir, "ssh_config"), `Host ${alias}\n  HostName ${vm.ip}\n  User root\n  IdentityFile ${join(dir, "client")}\n  IdentitiesOnly yes\n  UserKnownHostsFile ${join(dir, "known_hosts")}\n  StrictHostKeyChecking yes\n`);
      includeSshConfigs();
      // Wait for cloud-init (Docker, sysctl). 2 means done with warnings.
      let ready = false;
      for (let i = 0; i < 60 && !ready; i++) {
        const r = await exec("ssh", ["-F", join(dir, "ssh_config"), alias, "cloud-init status --wait"]);
        ready = r.code === 0 || r.code === 2;
        if (!ready) await wait(10_000);
      }
      if (!ready) throw new Error(`VM ${vm.ip} did not finish cloud-init`);
      const env = { DOCKER_HOST: `ssh://${alias}` };
      // ponytail: the whole image goes over ssh for each run; push it to a registry when that is too slow.
      const load = await exec("sh", ["-c", 'docker save "$1" | DOCKER_HOST="$2" docker load', "sh", image, env.DOCKER_HOST]);
      if (load.code !== 0) throw new Error(`Loading the image on VM ${vm.ip} failed`);
      return { env, close };
    } catch (e) {
      await close();
      throw e;
    }
  };
}
// docker reaches ssh:// hosts through ssh, which reads ~/.ssh/config. Each VM's file is included from there.
function includeSshConfigs() {
  const cfg = join(homedir(), ".ssh", "config");
  const line = `Include ${tmpdir()}/vm-*/ssh_config`;
  if (existsSync(cfg) && readFileSync(cfg, "utf8").includes(line)) return;
  mkdirSync(join(homedir(), ".ssh"), { recursive: true, mode: 0o700 });
  writeFileSync(cfg, `${line}\n`, { mode: 0o600 });
}

const SECURITY = ["--security-opt", "seccomp=unconfined", "--security-opt", "apparmor=unconfined"]; // bubblewrap needs user namespaces
const stepsOf = (q: QueuedRun) => (q.kind === "build" ? BUILD_STEPS : FINISH_STEPS);

// One run: a volume for run/, the earlier build run read-only when it has one, then each step in a new container.
// A step that fails ends the run, as a failed CI job does. Afterwards run/ goes to RUNS_DIR (no node_modules);
// a build run whose decision step ended well also gets `ok`, the mark buildRecord and restoreRun ask for.
// A run in progress, for a cancel from the dashboard: no next step starts, and kill ends the step's container.
export interface Live { cancelled: boolean; kill?: () => Promise<unknown> }

export interface RunOptions { exec: Exec; base: NodeJS.ProcessEnv; open: OpenHost; image: string; lock: (target: string, f: () => Promise<boolean>) => Promise<boolean>; runsDir?: string; queueDir?: string; live?: Live }
export async function runOne(q: QueuedRun, id: string, { exec, base, open, image, lock, runsDir = RUNS_DIR, queueDir = QUEUE_DIR, live = { cancelled: false } }: RunOptions) {
  const pipeline = q.kind;
  stepEnv(base, { pipeline, target: q.target, run: q, id }); // refuses a bad queued run before a VM is made
  const host = await open(id);
  const docker = (...args: string[]) => exec("docker", args, host.env);
  const vol = `factory-run-${id}`, ref = `factory-ref-${id}`;
  const helper = async (mounts: string[], f: (c: string) => Promise<void>) => {
    const c = `factory-helper-${id}`;
    await docker("create", "--name", c, ...mounts, image, "true");
    try { await f(c); } finally { await docker("rm", "-f", c); }
  };
  let decisionOk = false;
  const asked = mkdtempSync(join(tmpdir(), `asked-${id}-`));
  try {
    await docker("volume", "create", vol);
    const mounts = ["-v", `${vol}:${FACTORY_ROOT}/run`];
    if (q.buildRun) {
      if (!existsSync(join(runsDir, q.buildRun, "ok"))) throw new Error(`Run ${q.buildRun} is not a finished build run`);
      await docker("volume", "create", ref);
      await helper(["-v", `${ref}:${RUNS_DIR}`], async (c) => void (await docker("cp", join(runsDir, q.buildRun!), `${c}:${RUNS_DIR}/${q.buildRun}`)));
      mounts.push("-v", `${ref}:${RUNS_DIR}:ro`);
    }
    for (const step of stepsOf(q)) {
      if (live.cancelled) break;
      const ok = await (step === "event" ? lock(q.target, () => runStep(step)) : runStep(step));
      if (step === "decision") decisionOk = ok;
      if (!ok) break;
    }
    async function runStep(step: string): Promise<boolean> {
      const env = stepEnv(base, { pipeline, target: q.target, run: q, id });
      const c = `factory-${id}-${step}`;
      const local = mkdtempSync(join(tmpdir(), "sec-"));
      try {
        const files = secretFiles(base, local, SECRET_DIR);
        // The dashboard's CA (machine mode, Caddy's own CA) goes in with the secret files.
        if (env.NODE_EXTRA_CA_CERTS) {
          writeFileSync(join(local, "ca.crt"), readFileSync(env.NODE_EXTRA_CA_CERTS));
          env.NODE_EXTRA_CA_CERTS = join(SECRET_DIR, "ca.crt");
        }
        const keys = new Set(providerKeys(loadSeams()));
        const envArgs = Object.entries({ ...env, ...files }).flatMap(([k, v]) => ["-e", keys.has(k) ? k : `${k}=${v}`]);
        const keyEnv = Object.fromEntries(Object.entries(env).filter(([k]) => keys.has(k)));
        const created = await exec("docker", ["create", "--name", c, ...SECURITY, ...(host.network ? ["--network", host.network] : []), ...mounts, ...envArgs, image, "node", "--import", "tsx", `factory/steps/${step}.ts`], { ...host.env, ...keyEnv });
        if (created.code !== 0) return false;
        await docker("cp", `${local}/.`, `${c}:${SECRET_DIR}`);
        live.kill = () => docker("kill", c);
        if (live.cancelled) return false;
        const r = await docker("start", "-a", c);
        live.kill = undefined;
        // Runs the step asked for (start()). They join the queue when this run is saved, so a finish run finds `ok`.
        await docker("cp", `${c}:${QUEUE_DIR}/.`, asked);
        console.log(`run ${id} ${step}: code ${r.code}`);
        return r.code === 0;
      } finally {
        rmSync(local, { recursive: true, force: true });
        await docker("rm", "-f", c);
      }
    }
    const out = join(runsDir, id);
    mkdirSync(out, { recursive: true });
    await helper(mounts.slice(0, 2), async (c) => void (await docker("cp", `${c}:${FACTORY_ROOT}/run`, out)));
    rmSync(join(out, "run", "target", "node_modules"), { recursive: true, force: true });
    if (q.kind === "build" && decisionOk) writeFileSync(join(out, "ok"), "");
  } finally {
    mkdirSync(queueDir, { recursive: true });
    for (const f of readdirSync(asked)) renameSync(join(asked, f), join(queueDir, f));
    rmSync(asked, { recursive: true, force: true });
    await docker("volume", "rm", "-f", vol, ref);
    await host.close();
  }
}

// One event step per target at a time, as the GitLab resource_group did (decideStart and the run count).
export function targetLock() {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(target: string, f: () => Promise<T>): Promise<T> => {
    const next = (tails.get(target) ?? Promise.resolve()).then(f, f);
    tails.set(target, next.catch(() => {}));
    return next;
  };
}

// Takes the queued runs, oldest first. A file that does not parse is moved aside, never run.
export function takeQueue(queueDir = QUEUE_DIR): QueuedRun[] {
  if (!existsSync(queueDir)) return [];
  const out: QueuedRun[] = [];
  for (const f of readdirSync(queueDir).filter((n) => n.endsWith(".json")).sort()) {
    const p = join(queueDir, f);
    try {
      const q = JSON.parse(readFileSync(p, "utf8"));
      if (q.kind !== "build" && q.kind !== "finish") throw new Error(`kind ${q.kind}`);
      out.push({ kind: q.kind, target: String(q.target), ticket: q.ticket, change: q.change, buildRun: q.buildRun, skipApply: !!q.skipApply });
      rmSync(p);
    } catch (e) {
      console.log(`Queued run ${f} is not valid (${errText(e, 200)}), moved to ${f}.bad`);
      renameSync(p, `${p}.bad`);
    }
  }
  return out;
}

// Run ids are numbers, as the step variables require. The counter file lives with the runs.
export function nextId(runsDir = RUNS_DIR): string {
  mkdirSync(runsDir, { recursive: true });
  const f = join(runsDir, "last-id");
  const id = (existsSync(f) ? Number(readFileSync(f, "utf8")) : 0) + 1;
  writeFileSync(f, String(id));
  return String(id);
}

export async function main(base: NodeJS.ProcessEnv = process.env, exec: Exec = realExec) {
  if (loadSeams().ci !== "local") throw new Error("The worker runs the factory only with seams.yml ci: local");
  const image = base.FACTORY_STEP_IMAGE ?? "factory-worker";
  const mode = base.FACTORY_EXECUTOR || "machine";
  if (mode !== "machine" && mode !== "hetzner") throw new Error("FACTORY_EXECUTOR must be machine or hetzner");
  const open = mode === "machine" ? machineHost() : hetznerHost(exec, base, image);
  const targets = readdirSync(join(FACTORY_ROOT, "targets")).filter((f) => f.endsWith(".yml")).map((f) => f.slice(0, -4));
  const lock = targetLock();
  mkdirSync(SECRET_DIR, { recursive: true, mode: 0o700 });
  const runs = new Map<string, Live>();
  // Two dispatch runs at once could both find no open ticket for the same dispatch and open two.
  const dispatch = (t: string) => void lock(`dispatch:${t}`, () => runShort(exec, base, "dispatch", t).then(() => true)).catch((e) => console.log(`dispatch for ${t} failed: ${errText(e, 500)}`));
  // The improve job can wait up to an hour for a fix pipeline, so it runs beside the poller, one at a time per target.
  const improve = (t: string) => void lock(`improve:${t}`, () => runImprove(exec, base, t).then(() => true)).catch((e) => console.log(`improve for ${t} failed: ${errText(e, 500)}`));
  createServer(handler(base.FACTORY_DASHBOARD_TOKEN, {
    cancel: async (run) => {
      const l = runs.get(run);
      if (!l) return false;
      l.cancelled = true;
      await l.kill?.();
      return true;
    },
    dispatch: (t) => targets.includes(t) && (dispatch(t), true),
  })).listen(Number(base.FACTORY_WORKER_PORT ?? 8080));
  // With logSource files (fake errors) the watcher runs only when a person starts it: `worker.ts watch <target>`.
  const watch = loadSeams().logSource !== "files";
  console.log(`The factory worker runs ${targets.join(", ")} with executor ${mode}`);
  for (let tick = 0; ; tick++) {
    for (const t of targets) await tickTarget(exec, base, t, tick, { watch, improve });
    for (const q of takeQueue()) {
      const id = nextId();
      const live: Live = { cancelled: false };
      runs.set(id, live);
      console.log(`run ${id}: ${q.kind} of ticket ${q.ticket} in ${q.target}`);
      // ponytail: a run in progress is lost when the worker stops; its ticket keeps factory_running, as on a killed CI job.
      void runOne(q, id, { exec, base, open, image, lock, live })
        .catch((e) => console.log(`run ${id} failed: ${errText(e, 500)}`))
        .finally(() => runs.delete(id));
    }
    await wait(60_000);
  }
}
// One minute of one target: poll every tick; retry, the watcher and a due improve job on the hour.
// A failure is logged and ends only this target's tick: the other targets still poll.
export async function tickTarget(exec: Exec, base: NodeJS.ProcessEnv, t: string, tick: number, o: { watch: boolean; improve: (t: string) => void; now?: Date; runsDir?: string }) {
  try {
    await runShort(exec, base, "poll", t);
    if (tick % 60 !== 0) return;
    await runShort(exec, base, "resume-waiting", t);
    if (o.watch) await runShort(exec, base, "watcher", t);
    if (improveDue(t, o.now ?? new Date(), o.runsDir)) o.improve(t);
  } catch (e) {
    console.log(`tick of ${t} failed: ${errText(e, 500)}`);
  }
}

// The dashboard's calls (dashboard/src/server/worker.ts), on the compose network only, with the dashboard token.
export function handler(token: string | undefined, o: { cancel: (run: string) => Promise<boolean>; dispatch: (target: string) => boolean }) {
  const digest = (v: string) => createHash("sha256").update(v).digest();
  return async (req: Pick<IncomingMessage, "headers" | "url" | "method">, res: Pick<ServerResponse, "writeHead">) => {
    const auth = req.headers.authorization ?? "";
    const m = /^\/(runs\/([0-9]+)\/cancel|dispatch\/([a-z0-9_-]+))$/.exec(req.url ?? "");
    const send = (code: number) => res.writeHead(code).end();
    if (!token || !timingSafeEqual(digest(auth), digest(`Bearer ${token}`))) return send(401);
    if (req.method !== "POST" || !m) return send(404);
    if (m[2]) return send((await o.cancel(m[2])) ? 204 : 404);
    return send(o.dispatch(m[3]) ? 202 : 404);
  };
}

if (process.argv[1]?.endsWith("worker.ts")) {
  // `worker.ts watch <target>`: a person runs the watcher once (docker compose exec worker ...).
  if (process.argv[2] === "watch") await runShort(realExec, process.env, "watcher", process.argv[3] ?? "", "web");
  else await main();
}
