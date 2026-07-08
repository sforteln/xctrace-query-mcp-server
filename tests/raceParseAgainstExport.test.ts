/**
 * PMT:loam-merlin (Data Persistence retrospective) — raceParseAgainstExport.
 * Verified live: xctrace crashed exporting core-data-fetch (silent, exit
 * 133, no stderr), truncating stdout mid-document; the streaming XML parser
 * correctly noticed the truncation and threw "Unclosed root tag" — and a
 * naive `Promise.all([parse, done])` surfaced THAT generic parse error
 * instead of the far more diagnostic process-exit one, because Promise.all
 * rejects with whichever promise settles first and the parser reliably
 * notices EOF-mid-document before the process "close" event fires.
 */
import { describe, it, expect } from "vitest";
import { raceParseAgainstExport } from "../src/engine/xctrace.js";

function rejectAfter(ms: number, err: unknown): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(err), ms));
}
function resolveAfter<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

describe("raceParseAgainstExport", () => {
  it("prefers the exit-code error over a parse error that settles FIRST (the real bug's exact shape)", async () => {
    const parseError = new Error("Failed to parse streamed table XML: Unclosed root tag");
    const exitError = new Error("xctrace export exited with an error (code 133)");
    const parse = rejectAfter(5, parseError); // parser notices truncation almost immediately
    const done = rejectAfter(50, exitError); // process "close" event fires later
    await expect(raceParseAgainstExport(parse, done)).rejects.toBe(exitError);
  });

  it("still surfaces the parse error when the export itself exits cleanly (code 0)", async () => {
    const parseError = new Error("some other genuine parse bug");
    const parse = rejectAfter(5, parseError);
    const done = resolveAfter(50, undefined);
    await expect(raceParseAgainstExport(parse, done)).rejects.toBe(parseError);
  });

  it("resolves with the parsed value on a clean export + clean parse", async () => {
    const parse = resolveAfter(5, { cols: [], rowCount: 0 });
    const done = resolveAfter(20, undefined);
    await expect(raceParseAgainstExport(parse, done)).resolves.toEqual({ cols: [], rowCount: 0 });
  });

  it("surfaces the exit error even if it settles AFTER the parse already succeeded on partial data", async () => {
    // A parse can "succeed" on truncated data that happens to look complete
    // (e.g. a crash after the last row's closing tag but before the outer
    // root close) — the exit code is still the authoritative signal that
    // something went wrong, per exportXPathStream's own doc comment.
    const exitError = new Error("xctrace export exited with an error (code 133)");
    const parse = resolveAfter(5, { cols: [], rowCount: 3 });
    const done = rejectAfter(20, exitError);
    await expect(raceParseAgainstExport(parse, done)).rejects.toBe(exitError);
  });
});
