import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { RangePicker } from "./range-picker";

const replace = vi.fn();
let search = "range=7d&tz=Europe%2FMadrid";
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }), usePathname: () => "/insights", useSearchParams: () => new URLSearchParams(search) }));

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const query = () => Object.fromEntries(new URL(replace.mock.calls.at(-1)![0], "http://x").searchParams);

beforeEach(() => replace.mockClear());
afterEach(cleanup);

test("a preset goes into the URL with the viewer's time zone", () => {
  render(<RangePicker range="7d" />);
  expect(replace).not.toHaveBeenCalled(); // the URL already has a time zone
  fireEvent.change(screen.getByLabelText("Range"), { target: { value: "yesterday" } });
  expect(query()).toEqual({ range: "yesterday", tz });
});

test("a custom range asks for both dates and goes into the URL on Show", () => {
  render(<RangePicker range="7d" />);
  fireEvent.change(screen.getByLabelText("Range"), { target: { value: "custom" } });
  expect(replace).not.toHaveBeenCalled(); // nothing to show until both dates are in
  fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-10-01" } });
  fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-10-15" } });
  fireEvent.click(screen.getByRole("button", { name: "Show" }));
  expect(query()).toEqual({ range: "custom", from: "2026-10-01", to: "2026-10-15", tz });
});

test("a first visit with no time zone in the URL gets one, keeping the rest", () => {
  search = "range=today";
  render(<RangePicker range="today" />);
  expect(query()).toEqual({ range: "today", tz });
  search = "range=7d&tz=Europe%2FMadrid";
});
