import { expect, test } from "vitest";
import { loadRouter } from "./config";
import { pickModels } from "./router";

test("low risk, effort 7 uses the low row", () => expect(pickModels("low", 7, loadRouter()).author.model).toBe("claude-sonnet-5-5"));
test("low risk, effort 8 moves up", () => expect(pickModels("low", 8, loadRouter()).mayAutoMerge).toBe(false));
test("medium risk never auto-merges", () => expect(pickModels("medium", 2, loadRouter()).mayAutoMerge).toBe(false));
