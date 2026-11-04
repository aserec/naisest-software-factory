// A week of corrections people made to the factory in one target: the evidence for the weekly improve job.
// Text written by people reaches models as data, after scrub and the injection check.
import { DEDUPE_MARKER } from "../dedupe";
import { isRequest } from "../requests";
import { HISTORY_LIMIT } from "../run-events";
import type { RunEvent } from "../seams";
import type { StepContext } from "../steps/context";
import { buildTriageState, injectionYes, INJECTION_LIMIT } from "../triage";
import { scrub } from "../watcher/scrub";

export type EvidenceKind = "change_comment" | "change_edit" | "ticket_reply" | "agent_rounds" | "repeat_finding" | "too_strict" | "too_loose" | "reopened_duplicate";
export interface Evidence { kind: EvidenceKind; link: string; at: string; text: string }

export const WEEK_MS = 7 * 86_400_000;
// A person may merge or revert a change weeks after its decision, so decisions are read this far back.
export const DECISION_MS = 30 * 86_400_000;
// Injection checks that run at once.
const PARALLEL_CHECKS = 10;
export const MAX_EVIDENCE = 300;
export const MAX_EVIDENCE_TEXT = 2000;

const ms = (t: string) => Date.parse(t);
const squash = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

// True when the commit undoes the change: its message names the change's commit, or it is a host-made revert of the change's title.
export function isRevertOf(c: { title: string; message: string }, change: { title: string; head: string; landedSha: string }): boolean {
  const sha = /This reverts commit ([0-9a-f]{7,40})/i.exec(c.message)?.[1]?.toLowerCase();
  if (sha && [change.landedSha, change.head].some((s) => s.toLowerCase().startsWith(sha))) return true;
  const quoted = /^Revert "(.+)"(?: \(#\d+\))?$/.exec(c.title)?.[1];
  return quoted !== undefined && (quoted === change.title || quoted === `[AM] ${change.title}`);
}

// What the agents' own rounds show: runs that needed 2 or more review or gate rounds, and findings that came back in the next round.
export function loopEvidence(events: RunEvent[], linkOf: (ticket: string) => string): Evidence[] {
  const runs = new Map<string, RunEvent[]>();
  for (const e of events) runs.set(e.run, [...(runs.get(e.run) ?? []), e]);
  return [...runs.values()].flatMap((evs) => {
    const link = linkOf(evs[0].ticket);
    const at = evs.map((e) => e.at).sort((a, b) => ms(b) - ms(a))[0];
    const blocking = evs.filter((e) => e.type === "review_finding" && e.data.blocking === true);
    const rounds = new Set(blocking.map((e) => e.data.round as number));
    const failed = evs.filter((e) => e.type === "gate_check" && e.data.exitCode !== 0).length;
    const out: Evidence[] = rounds.size >= 2 || failed >= 2 ? [{ kind: "agent_rounds", link, at, text: `review rounds with blocking findings: ${rounds.size}; failed gate checks: ${failed}` }] : [];
    const seen = new Set<string>();
    for (const e of blocking) {
      const text = squash(String(e.data.text));
      const round = e.data.round as number;
      if (seen.has(text) || !blocking.some((o) => squash(String(o.data.text)) === text && o.data.round === round + 1)) continue;
      seen.add(text);
      out.push({ kind: "repeat_finding", link, at, text });
    }
    return out;
  });
}

export async function collectEvidence(ctx: Pick<StepContext, "tracker" | "codeHost" | "dashboard" | "judge" | "target">, now: Date): Promise<{ evidence: Evidence[]; dropped: number }> {
  const { tracker, codeHost, dashboard, judge } = ctx;
  const since = new Date(now.getTime() - WEEK_MS).toISOString();
  const week = await dashboard.history(ctx.target.name, since, ["run_start", "review_finding", "gate_check"]);
  const allDecisions = await dashboard.history(ctx.target.name, new Date(now.getTime() - DECISION_MS).toISOString(), ["decision"]);
  // ponytail: a read stops at HISTORY_LIMIT, oldest first, so a busier target loses its newest events. Page by time if this log shows up.
  for (const [name, list] of [["week", week], ["decision", allDecisions]] as const) if (list.length >= HISTORY_LIMIT) console.log(`The ${name} history read hit ${HISTORY_LIMIT} events, so its newest events are missing from the evidence.`);
  const baseCommits = await codeHost.baseCommits(since); // once per job
  const found: Evidence[] = [];
  // One item per kind and change: a change with two decisions, or two work items with one change, is still one case.
  const once = new Set<string>();

  for (const ref of new Set([...week, ...allDecisions].map((e) => e.ticket))) {
    try {
      const evs = week.filter((e) => e.ticket === ref);
      const ticket = await tracker.ticket(ref);
      const comments = await tracker.comments(ref); // all of them: the factory may have spoken before the week began
      const people = comments.filter((c) => !c.byFactory);
      const out: Evidence[] = loopEvidence(evs, () => ticket.url);

      const firstFactory = Math.min(...comments.filter((c) => c.byFactory).map((c) => ms(c.at)));
      for (const c of people) {
        const line = c.body.trim();
        if (ms(c.at) >= ms(since) && ms(c.at) > firstFactory && line !== "@factory stop" && line !== "@factory resume") out.push({ kind: "ticket_reply", link: ticket.url, at: c.at, text: c.body });
      }
      const dupe = comments.find((c) => c.byFactory && c.body.includes(DEDUPE_MARKER) && ms(c.at) >= ms(since));
      if (dupe && ticket.open) out.push({ kind: "reopened_duplicate", link: ticket.url, at: dupe.at, text: ticket.title });

      const ofTicket = await codeHost.changeOfTicket(ref);
      const change = ofTicket && (await codeHost.change(ofTicket.ref));
      // A decision about an older change of the work item is not judged against the newest one.
      const decisions = allDecisions.filter((d) => d.ticket === ref && (!change || typeof d.data.changeUrl !== "string" || d.data.changeUrl === change.url));
      if (change) {
        const strict = decisions.filter((d) => d.data.auto === false);
        // Comments from the oldest decision on, so a request after it counts even before the week.
        const from = [since, ...strict.map((d) => d.at)].sort((a, b) => ms(a) - ms(b))[0];
        const onChange = await codeHost.changeComments(change.ref, new Date(ms(from) - 1).toISOString()); // newest first
        for (const c of onChange.filter((c) => !c.byFactory && ms(c.at) >= ms(since))) out.push({ kind: "change_comment", link: change.url, at: c.at, text: c.body });
        const edit = (await codeHost.changeEdits(change.ref, since)).filter((e) => !e.byFactory && ms(e.at) >= ms(since)).sort((a, b) => ms(b.at) - ms(a.at))[0];
        if (edit) out.push({ kind: "change_edit", link: change.url, at: edit.at, text: `${change.title}\n\n${change.body}` });

        // Merged this week, so a merge counts once, not in every week its decision is read.
        const mergedThisWeek = change.merged && (!change.mergedAt || ms(change.mergedAt) >= ms(since));
        if (mergedThisWeek && strict.length > 0 && (await codeHost.changeCommits(change.ref)).every((c) => c.byFactory)) {
          for (const d of strict) {
            const asked = [...onChange, ...comments].some((c) => !c.byFactory && ms(c.at) > ms(d.at) && isRequest(c.body));
            if (!asked) out.push({ kind: "too_strict", link: change.url, at: d.at, text: (d.data.reasons as string[]).join("; ") });
          }
        }
      }
      for (const d of decisions.filter((d) => d.data.auto === true)) {
        const revert = change && baseCommits.find((c) => isRevertOf(c, change));
        if (revert) out.push({ kind: "too_loose", link: change.url, at: revert.at, text: revert.title });
        // The mark has no time, so only a decision of this week counts it.
        else if (ticket.marks.includes("reverted") && ms(d.at) >= ms(since)) out.push({ kind: "too_loose", link: change?.url ?? ticket.url, at: d.at, text: "reverted by the factory's verify step" });
      }
      found.push(...out.filter((e) => !/^too_/.test(e.kind) || (!once.has(e.kind + e.link) && !!once.add(e.kind + e.link))));
    } catch (e) {
      console.log(`Evidence of ticket ${ref} failed: ${String(e).slice(0, 300)}`);
    }
  }

  const items = found.sort((a, b) => ms(b.at) - ms(a.at)).slice(0, MAX_EVIDENCE).map((item) => ({ ...item, text: scrub(item.text).slice(0, MAX_EVIDENCE_TEXT) }));
  const safe: boolean[] = [];
  for (let i = 0; i < items.length; i += PARALLEL_CHECKS) {
    // Fails closed, like triage: NaN counts as an injection.
    safe.push(...(await Promise.all(items.slice(i, i + PARALLEL_CHECKS).map(async (item) => (await injectionYes(judge, buildTriageState("Evidence", item.text, []))) < INJECTION_LIMIT))));
  }
  const evidence = items.filter((_, i) => safe[i]);
  return { evidence, dropped: items.length - evidence.length };
}
