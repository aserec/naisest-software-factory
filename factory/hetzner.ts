// A small Hetzner Cloud client for the worker's hetzner mode: one VM per run, deleted after it.
// A failed call names the status and endpoint, never the token.
export const HETZNER_API = "https://api.hetzner.cloud/v1";

export interface VmSpec { name: string; serverType: string; location: string; userData: string; sshPublicKey: string }
export interface Vm { id: number; ip: string; keyId: number }

export class Hetzner {
  constructor(private token: string, private fetchFn: typeof fetch = fetch, private sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))) {}

  private async json(method: string, path: string, body?: unknown) {
    const res = await this.fetchFn(`${HETZNER_API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`Hetzner ${method} ${path} failed with status ${res.status}`);
    return res.status === 204 ? undefined : res.json();
  }

  // Registers the run's own SSH key, starts the VM with it, and waits until it runs and has an address.
  async create(spec: VmSpec): Promise<Vm> {
    const { ssh_key } = await this.json("POST", "/ssh_keys", { name: spec.name, public_key: spec.sshPublicKey });
    try {
      const { server } = await this.json("POST", "/servers", {
        name: spec.name, server_type: spec.serverType, location: spec.location, image: "ubuntu-24.04",
        ssh_keys: [ssh_key.id], user_data: spec.userData, labels: { factory: "run" },
      });
      for (let i = 0; i < 60; i++) {
        const { server: s } = await this.json("GET", `/servers/${server.id}`);
        if (s.status === "running" && s.public_net?.ipv4?.ip) return { id: s.id, ip: s.public_net.ipv4.ip, keyId: ssh_key.id };
        await this.sleep(5000);
      }
      await this.json("DELETE", `/servers/${server.id}`);
      throw new Error(`Hetzner VM ${spec.name} did not start in 5 minutes`);
    } catch (e) {
      await this.json("DELETE", `/ssh_keys/${ssh_key.id}`).catch(() => {});
      throw e;
    }
  }

  async remove(vm: Vm): Promise<void> {
    await this.json("DELETE", `/servers/${vm.id}`);
    await this.json("DELETE", `/ssh_keys/${vm.keyId}`).catch(() => {}); // a left key is harmless: its VM is gone
  }
}
