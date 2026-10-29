import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import Home from "./page";

test("the home page shows the Factory heading", () => {
  render(<Home />);
  expect(screen.getByRole("heading", { name: "Factory" })).toBeTruthy();
});
