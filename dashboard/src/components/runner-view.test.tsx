import { cleanup, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { RunnerView } from "./runner-view";
import { json, renderWithQuery } from "./test-utils";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("a failed part shows its error while the jobs still show", async () => {
  vi.stubGlobal("fetch", async () => json({ jobs: [{ job: "1", name: "build", run: "7", startedAt: "2026-10-29T10:00:00Z" }], hosts: [{ host: "vm1", diskUsedPct: 41.5, memUsedPct: 72 }], logs: { error: "Grafana 502" } }));
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

test("without Grafana the log tabs are gone and the settings to set read in mono", async () => {
  const unset = { unset: "Grafana is not set up. Set GRAFANA_URL and LOKI_UID." };
  vi.stubGlobal("fetch", async () => json({ jobs: [], hosts: unset, logs: unset }));
  renderWithQuery(<RunnerView />);
  expect((await screen.findAllByText("GRAFANA_URL"))[0].tagName).toBe("CODE");
  expect(screen.queryByRole("tab")).toBeNull();
});

test("with Grafana the log tabs show", async () => {
  vi.stubGlobal("fetch", async () => json({ jobs: [], hosts: [], logs: [], sources: ["docker", "gitlab-runner", "system"] }));
  renderWithQuery(<RunnerView />);
  expect(await screen.findAllByRole("tab")).toHaveLength(3);
});

test("the log tabs are the sources the answer lists, and the first is asked for", async () => {
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    urls.push(url);
    return json({ jobs: [], hosts: [], logs: [], sources: ["alpha", "beta"] });
  });
  renderWithQuery(<RunnerView />);
  expect((await screen.findAllByRole("tab")).map((t) => t.textContent)).toEqual(["alpha", "beta"]);
  expect(screen.getByRole("tab", { name: "alpha" }).getAttribute("aria-selected")).toBe("true");
  expect(urls[0]).not.toContain("source=docker");
});
