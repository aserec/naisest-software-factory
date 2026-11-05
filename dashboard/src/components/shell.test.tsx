import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { ThemeSelect } from "./shell";

test("Dark sets data-theme and saves it; System removes both", () => {
  render(<ThemeSelect />);
  const html = document.documentElement;

  fireEvent.click(screen.getByRole("button", { name: "Dark theme" }));
  expect(screen.getByRole("button", { name: "Dark theme" }).getAttribute("aria-pressed")).toBe("true");
  expect(html.getAttribute("data-theme")).toBe("dark");
  expect(localStorage.getItem("theme")).toBe("dark");

  fireEvent.click(screen.getByRole("button", { name: "System theme" }));
  expect(html.hasAttribute("data-theme")).toBe(false);
  expect(localStorage.getItem("theme")).toBeNull();
});
