import { expect, test } from "vitest";
import { fakeTracker } from "../fakes";
import { cancelNote, pauseNote, stoppedNote, waitingNote, type PauseKind } from "./run";
import type { StepContext } from "./context";

const blockedNote = (line: string) => `The factory stopped. A person must look at this.\n\nThe tests failed.${line}`;

// Posts the notes oldest first, as the factory would, and reads the newest note of each kind.
async function read(notes: string[], kinds: PauseKind[] = ["blocked", "waiting", "stopped"]) {
  const tracker = fakeTracker([{ ref: "1" }]);
  for (const n of notes) await tracker.comment("1", n);
  const ctx = { tracker } as Partial<StepContext> as StepContext;
  return Promise.all(kinds.map((k) => pauseNote(ctx, "1", k)));
}

test("the reader reads each of the four notes", async () => {
  expect(await read([blockedNote("\n\nBlocked run: pipeline 7")], ["blocked"])).toEqual([{ kind: "blocked", run: "7" }]);
  expect(await read([waitingNote("8")], ["waiting"])).toEqual([{ kind: "waiting", run: "8" }]);
  const stop = { run: "9", step: "apply", reason: "switch off apply", change: "5", buildRun: "41" };
  expect(await read([stoppedNote(stop)], ["stopped"])).toEqual([{ kind: "stopped", ...stop }]);
  expect(await read([stoppedNote(stop), cancelNote("dev")], ["stopped"])).toEqual([{ kind: "cancelled" }]);
});

test("the state label picks the kind: an older note of another kind, or a person's copy, does not count", async () => {
  const tracker = fakeTracker([{ ref: "1" }]);
  await tracker.comment("1", blockedNote("\n\nBlocked run: pipeline 7"));
  await tracker.comment("1", waitingNote("8"));
  tracker.say("1", "dev", waitingNote("99"));
  const ctx = { tracker } as Partial<StepContext> as StepContext;
  expect(await pauseNote(ctx, "1", "blocked")).toEqual({ kind: "blocked", run: "7" });
  expect(await pauseNote(ctx, "1", "waiting")).toEqual({ kind: "waiting", run: "8" });
  expect(await pauseNote(ctx, "1", "stopped")).toBeUndefined();
});

test("a newer block with no run line wins over an older one with it", async () => {
  expect(await read([blockedNote("\n\nBlocked run: pipeline 7"), blockedNote("")], ["blocked"])).toEqual([{ kind: "blocked", run: undefined }]);
});

test("an old stopped note with only its run line gives the run and no step", async () => {
  const old = "A person stopped this run. Comment the line @factory resume to continue it.\n\nStopped run: pipeline 5";
  expect(await read([old], ["stopped"])).toEqual([{ kind: "stopped", run: "5" }]);
});
