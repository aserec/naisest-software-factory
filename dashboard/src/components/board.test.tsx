import { screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ago, duration } from "@/lib/utils";
import { Board, finding, STATES, type BoardItem } from "./board";
import { json, renderWithQuery } from "./test-utils";

afterEach(() => vi.unstubAllGlobals());

const item = (o: Partial<BoardItem>): BoardItem => ({ target: "demo", ticket: "7", title: "Fix login", state: "factory_running", url: "http://gl/7", updatedAt: "", stuck: false, ...o });

test("renders a column per state label, each ticket in its column, and a Stuck badge", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json([item({ run: "r1", costUsd: 1.5, stuck: true }), item({ ticket: "8", title: "Add docs", state: "factory_done" })])));
  renderWithQuery(<Board />);
  expect(await screen.findByText("Fix login")).toBeTruthy();
  expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(STATES.length);
  expect(screen.getByRole("heading", { name: /needs info/i })).toBeTruthy();
  expect(screen.getAllByText("Stuck")).toHaveLength(1);
  expect(screen.getByText("$1.50")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Fix login" }).getAttribute("href")).toBe("/runs/r1");
  expect(screen.getByRole("link", { name: "Add docs" }).getAttribute("href")).toBe("http://gl/7"); // no run: links to GitLab
});

test("shows the error when the board fails", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 502 })));
  renderWithQuery(<Board />);
  expect((await screen.findByRole("alert")).textContent).toContain("502");
});

test("the finding names what waits for a person, and says so when nothing does", () => {
  expect(finding([item({ state: "factory_needs_approval" }), item({ state: "factory_needs_info" }), item({ state: "factory_needs_info" }), item({ stuck: true })])).toBe("1 to approve, 2 need an answer, 1 run stuck.");
  expect(finding([item({ state: "factory_done" })])).toBe("Nothing waits for you.");
});

test("durations and ages read as people say them", () => {
  expect([duration(42), duration(540), duration(8400)]).toEqual(["42 s", "9 m", "2 h 20 m"]);
  const now = Date.parse("2026-11-01T12:00:00Z");
  expect([ago("2026-11-01T11:59:40Z", now), ago("2026-11-01T11:12:00Z", now), ago("2026-10-30T12:00:00Z", now), ago("", now)]).toEqual(["just now", "48 m ago", "2 d ago", undefined]);
});
