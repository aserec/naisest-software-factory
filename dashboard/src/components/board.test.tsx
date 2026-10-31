import { screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Board, STATES, type BoardItem } from "./board";
import { json, renderWithQuery } from "./test-utils";

afterEach(() => vi.unstubAllGlobals());

const item = (o: Partial<BoardItem>): BoardItem => ({ target: "demo", ticket: "7", title: "Fix login", state: "factory_running", url: "http://gl/7", updatedAt: "", stuck: false, ...o });

test("renders a column per state label, each ticket in its column, and a Stuck badge", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json([item({ run: "r1", costUsd: 1.5, stuck: true }), item({ ticket: "8", title: "Add docs", state: "factory_done" })])));
  renderWithQuery(<Board />);
  expect(await screen.findByText("Fix login")).toBeTruthy();
  expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(STATES.length);
  expect(screen.getByRole("heading", { name: /needs info/ })).toBeTruthy();
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
