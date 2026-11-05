import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { ThemeSelect } from "./shell";

test("Dark sets data-theme and saves it; System removes both", () => {
  render(<ThemeSelect />);
  const select = screen.getByRole("combobox", { name: "Theme" });
  const html = document.documentElement;

  fireEvent.change(select, { target: { value: "dark" } });
  expect(html.getAttribute("data-theme")).toBe("dark");
  expect(localStorage.getItem("theme")).toBe("dark");

  fireEvent.change(select, { target: { value: "system" } });
  expect(html.hasAttribute("data-theme")).toBe(false);
  expect(localStorage.getItem("theme")).toBeNull();
});
