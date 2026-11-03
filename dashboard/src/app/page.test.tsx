import { screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderWithQuery } from "@/components/test-utils";
import Home from "./page";

afterEach(() => vi.unstubAllGlobals());

test("the home page shows the Factory heading and the board", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json([])));
  renderWithQuery(<Home />);
  expect(screen.getByRole("heading", { name: "Board" })).toBeTruthy();
  expect(await screen.findByRole("heading", { name: "With the factory" })).toBeTruthy();
});
