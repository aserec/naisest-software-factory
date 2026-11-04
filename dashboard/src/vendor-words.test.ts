import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

// MR and factory_ are case sensitive: a class like "-mr-3" or a setting like FACTORY_DISPATCH_TOKEN is no vendor word.
const VENDOR = /gitlab|github|grafana|loki|\bpipeline|mrUrl|\/-\/issues|merge request/i;
const VENDOR_EXACT = /\bMR\b|\bfactory_/;

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? files(p) : /\.tsx?$/.test(e.name) && !/\.test\./.test(e.name) ? [p] : [];
  });

it("pages, components and routes name no vendor", () => {
  const hits = ["src/app", "src/components"]
    .flatMap(files)
    .flatMap((f) => readFileSync(f, "utf8").split("\n").flatMap((l, i) => (VENDOR.test(l) || VENDOR_EXACT.test(l) ? [`${f}:${i + 1}: ${l.trim()}`] : [])));
  expect(hits).toEqual([]);
});
