import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { MergeProblems } from "./merge-problems";
import type { BoardRow } from "@/server/seams";

const card = (o: Partial<BoardRow>) => ({ target: "t", ticket: "7", title: "Fix login", state: "needs_approval", url: "", updatedAt: "", changeUrl: "http://gl/pr/1", ...o }) as BoardRow;
const env = (id: string, run: string) => ({ id, run, at: "2026-11-06T10:00:00Z", target: "t", ticket: "7" });

test("lists the conflict round, a failed build check and the decision, and links events of other runs", () => {
  render(
    <MergeProblems
      run="r2"
      item={card({ conflicts: true })}
      events={[
        { ...env("a", "r1"), type: "change_state", data: { conflicts: true } },
        { ...env("b", "r2"), type: "gate_check", data: { command: "pnpm build", exitCode: 1, outputTail: "" } },
        { ...env("c", "r2"), type: "decision", data: { auto: false, reasons: [] } },
      ]}
    />,
  );
  expect(screen.getByText("Has conflicts with the base branch")).toBeTruthy();
  expect(screen.getByText("Conflicts with the base branch. The factory started a conflict round.")).toBeTruthy();
  expect(screen.getByText("Build check failed with exit code 1: pnpm build")).toBeTruthy();
  expect(screen.getByText("The change passed its checks and waits for a person to merge it.")).toBeTruthy();
  expect(screen.getByRole("heading", { name: /^Merge problems/ }).textContent).toContain("Has conflicts with the base branch");
  expect(screen.getByRole("heading", { name: "Merge history" })).toBeTruthy();
  expect(screen.getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(["/runs/r1"]);
});

test("says why the change cannot merge, and shows nothing with no change and no events", () => {
  const { container, rerender } = render(<MergeProblems run="r1" item={card({ mergeBlock: "a required review or check is missing" })} events={[]} />);
  expect(screen.getByText("Cannot merge: a required review or check is missing")).toBeTruthy();
  rerender(<MergeProblems run="r1" item={card({ checksFailed: true })} events={[]} />);
  expect(screen.getByText("A check of the change failed")).toBeTruthy();
  rerender(<MergeProblems run="r1" item={card({ changeUrl: undefined })} events={[]} />);
  expect(container.innerHTML).toBe("");
});
