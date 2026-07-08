/**
 * PMT:gravel-kite — partial-success run-issue extraction.
 *
 * When xctrace records a template but a bundled instrument is unsupported on the
 * target (e.g. Animation Hitches on a Simulator — no real display), it exits
 * non-zero yet STILL saves a viewable trace ("trace is still ready to be
 * viewed"). record() keeps that trace and surfaces the flagged instruments via
 * runIssues instead of discarding a valid capture. This pins the parsing of
 * those "[Error]/[Warning]" lines out of xctrace's real output.
 */
import { describe, it, expect } from "vitest";
import { extractRunIssues } from "../src/engine/record.js";

// Verbatim shape of xctrace's partial-success output (from a real Simulator run).
const SWIFTUI_ON_SIM = [
  "Starting recording with the SwiftUI template. Attaching to: Goldfish (88912). Time limit: 4.0 s",
  "Run issues were detected (trace is still ready to be viewed):",
  "* [Error] Hitches is not supported on this platform.",
  "",
  "Recording failed with errors. Saving output file...",
  "Output file saved as: Attach_88912_2026-07-07_21.31.35_F2BCA919.trace",
].join("\n");

describe("PMT:gravel-kite extractRunIssues", () => {
  it("pulls the flagged instrument out of a partial-success recording", () => {
    expect(extractRunIssues(SWIFTUI_ON_SIM)).toEqual([
      "Hitches is not supported on this platform.",
    ]);
  });

  it("returns [] for a clean recording (no run issues)", () => {
    const clean = "Starting recording with the os_log Instrument.\nOutput file saved as: X.trace";
    expect(extractRunIssues(clean)).toEqual([]);
  });

  it("captures multiple issues, Errors and Warnings alike", () => {
    const out =
      "* [Error] Allocations cannot handle a target type of 'All Processes'\n" +
      "* [Warning] Something minor happened";
    expect(extractRunIssues(out)).toEqual([
      "Allocations cannot handle a target type of 'All Processes'",
      "Something minor happened",
    ]);
  });
});
