import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { RangePicker } from "./range-picker";

afterEach(cleanup);

test("a preset is picked as soon as it is chosen", () => {
  const onPick = vi.fn();
  render(<RangePicker value={{ range: "7d" }} onPick={onPick} />);
  fireEvent.change(screen.getByLabelText("Range"), { target: { value: "yesterday" } });
  expect(onPick).toHaveBeenLastCalledWith({ range: "yesterday" });
});

test("a custom range asks for both dates in the same row and is picked on Show", () => {
  const onPick = vi.fn();
  render(<RangePicker value={{ range: "7d" }} onPick={onPick} />);
  const row = screen.getByLabelText("Range").parentElement!;
  fireEvent.change(screen.getByLabelText("Range"), { target: { value: "custom" } });
  expect(onPick).not.toHaveBeenCalled(); // nothing to show until both dates are in
  expect(screen.getByLabelText("From").parentElement).toBe(row);
  fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-10-01" } });
  fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-10-15" } });
  fireEvent.click(screen.getByRole("button", { name: "Show" }));
  expect(onPick).toHaveBeenLastCalledWith({ range: "custom", from: "2026-10-01", to: "2026-10-15" });
});
