import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { parse } from "yaml";

const cloudInit = parse(readFileSync("runner/cloud-init.yml", "utf8")) as { write_files: { path: string; content: string }[]; runcmd: string[] };

test("cloud-init writes the same Alloy config as deploy/alloy/runner.alloy", () => {
  const written = cloudInit.write_files.find((f) => f.path === "/etc/alloy/runner.alloy")?.content;
  expect(written).toBe(readFileSync("deploy/alloy/runner.alloy", "utf8"));
});

// The metadata service serves the user data, and with it the Alloy push credential.
test("job containers cannot reach the Hetzner metadata service", () => {
  expect(cloudInit.runcmd).toContain("iptables -I DOCKER-USER -d 169.254.169.254 -j DROP");
  // runcmd has no `set -e`: only the last command fails cloud-init, so a VM without the rule never takes a job.
  expect(cloudInit.runcmd.at(-1)).toBe("iptables -C DOCKER-USER -d 169.254.169.254 -j DROP");
});
