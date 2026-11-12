import { describe, expect, it } from "vitest";
import { DICT, translator } from "./i18n";

describe("translator", () => {
  it("translates, fills in values, and falls back to the English text", () => {
    expect(translator("es")("Settings")).toBe("Ajustes");
    expect(translator("de")("Run {id}", { id: "abc" })).toBe("Lauf abc");
    expect(translator("es")("No row for this {x}", { x: 1 })).toBe("No row for this 1");
    expect(translator("en")("Run {id}", { id: "abc" })).toBe("Run abc");
  });

  it("has the same texts in every language", () => {
    expect(Object.keys(DICT.de).sort()).toEqual(Object.keys(DICT.es).sort());
  });
});
