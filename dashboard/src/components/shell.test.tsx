import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { ThemeSelect } from "./shell";

test("the theme button steps System, Light, Dark and back, saving each choice", () => {
  render(<ThemeSelect />);
  const html = document.documentElement;
  const button = () => screen.getByRole("button", { name: /^Theme:/ });
  expect(button().getAttribute("aria-label")).toBe("Theme: System. Switch to Light");

  fireEvent.click(button());
  expect(html.getAttribute("data-theme")).toBe("light");
  expect(localStorage.getItem("theme")).toBe("light");

  fireEvent.click(button());
  expect(html.getAttribute("data-theme")).toBe("dark");
  expect(button().getAttribute("aria-label")).toBe("Theme: Dark. Switch to System");

  fireEvent.click(button());
  expect(html.hasAttribute("data-theme")).toBe(false);
  expect(localStorage.getItem("theme")).toBeNull();
});
