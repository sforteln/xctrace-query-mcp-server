/**
 * PMT:thorny-verge — emptyResultNote, the shared "why is this empty" helper.
 * Scratchpad 062's throughline: a bare [] is read as a positive conclusion;
 * distinguishing filter-excluded-all from genuinely-empty is the single
 * highest-value fix.
 */
import { describe, it, expect } from "vitest";
import { emptyResultNote } from "../src/core/emptyResultNote.js";

describe("emptyResultNote", () => {
  it("returns undefined when something actually matched", () => {
    expect(emptyResultNote({ matchedCount: 5, unfilteredCount: 100, filterApplied: true })).toBeUndefined();
  });

  it("says the schema is genuinely empty when no filter was applied at all", () => {
    const note = emptyResultNote({ matchedCount: 0, unfilteredCount: 0, filterApplied: false });
    expect(note).toMatch(/genuinely has 0/);
  });

  it("says the schema is genuinely empty when the unfiltered count is also 0", () => {
    const note = emptyResultNote({ matchedCount: 0, unfilteredCount: 0, filterApplied: true });
    expect(note).toMatch(/genuinely has 0/);
  });

  it("says the filter excluded everything when the schema has real data", () => {
    const note = emptyResultNote({ matchedCount: 0, unfilteredCount: 5476, filterApplied: true });
    expect(note).toMatch(/0 of 5,476/);
    expect(note).toMatch(/has data/);
  });

  it("uses the supplied item noun", () => {
    const note = emptyResultNote({ matchedCount: 0, unfilteredCount: 10, filterApplied: true, itemNoun: "samples" });
    expect(note).toMatch(/samples/);
  });
});
