import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { Insights, RunRow } from "@/server/insights";
import type { BoardItem } from "./board";
import { TargetSummaries } from "./boards-overview";
import { renderWithPrefs } from "./test-utils";

afterEach(cleanup);

const row = (target: string, kind: RunRow["kind"], costUsd: number, secs?: number): RunRow => ({ run: `${target}-${kind}-${costUsd}`, target, ticket: "1", startedAt: "2026-11-01T00:00:00Z", costUsd, kind, secs, bucket: "", stepSecs: {} });
const data = (list: RunRow[]) => ({ list }) as Insights;

test("each target gets a card that links to its board and counts only its own runs, even with none", () => {
  renderWithPrefs(<TargetSummaries data={data([row("api", "auto", 1, 60), row("api", "person", 2, 120), row("api", "open", 0.5), row("web", "auto", 9)])} targets={["api", "idle"]} />);
  const [api, idle] = screen.getAllByRole("listitem");
  expect(within(api).getByRole("link", { name: "api" }).getAttribute("href")).toBe("/boards/api");
  expect(within(api).getByText("3 runs")).toBeTruthy();
  const fig = (card: HTMLElement, label: string) => within(card).getByText(label).nextElementSibling?.textContent;
  expect(fig(api, "Merged alone")).toBe("1");
  expect(fig(api, "Running")).toBe("1");
  expect(fig(api, "Time per run")).toBe("1 m");
  expect(within(idle).getByText("0 runs")).toBeTruthy();
  expect(fig(idle, "Time per run")).toBe("—");
});

test("each card counts its target's live board: ongoing, needs you and problems; — while the board loads", () => {
  const item = (target: string, state: string, more: Partial<BoardItem> = {}) => ({ target, state, ticket: "1", title: "t", updatedAt: "2026-11-01T00:00:00Z", ...more }) as BoardItem;
  const board = [item("api", "implementing"), item("api", "needs_approval", { conflicts: true }), item("api", "done"), item("web", "blocked")];
  renderWithPrefs(<TargetSummaries data={data([])} targets={["api"]} board={board} now={Date.parse("2026-11-02T00:00:00Z")} />);
  const fig = (label: string) => screen.getByText(label).nextElementSibling?.textContent;
  expect([fig("Ongoing"), fig("Needs you"), fig("Problems")]).toEqual(["2", "1", "1"]);
  cleanup();
  renderWithPrefs(<TargetSummaries data={data([])} targets={["api"]} />);
  expect(fig("Ongoing")).toBe("—");
});
