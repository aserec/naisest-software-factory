import { cleanup, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { RunnerView } from "./runner-view";
import { json, renderWithQuery } from "./test-utils";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("a failed part shows its error while the jobs still show", async () => {
  vi.stubGlobal("fetch", async () => json({ jobs: [{ job: "1", name: "build", pipeline: "7", startedAt: "2026-10-29T10:00:00Z" }], hosts: [{ host: "vm1", diskUsedPct: 41.5, memUsedPct: 72 }], logs: { error: "Grafana 502" } }));
  renderWithQuery(<RunnerView />);
  expect(await screen.findByText("build")).toBeTruthy();
  expect(screen.getByText("42%")).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toBe("Grafana 502");
});

test("a source that is not set up shows a muted line, not an alert", async () => {
  vi.stubGlobal("fetch", async () => json({ jobs: [], hosts: { unset: "Grafana is not set up." }, logs: { unset: "Grafana is not set up." } }));
  renderWithQuery(<RunnerView />);
  expect(await screen.findAllByText("Grafana is not set up.")).toHaveLength(2);
  expect(screen.queryByRole("alert")).toBeNull();
});
