/**
 * PMT:thick-haze — the grounded one-line call summaries the "show your work"
 * narration is built on. Each asserts the summary echoes the EFFECTIVE query +
 * the headline count in the "what ran → what came back" skeleton.
 */
import { describe, it, expect } from "vitest";
import {
  summarizeQuery, summarizeFind, summarizeAggregate, summarizeCorrelate,
  summarizeRelate, summarizeCallTree, summarizeTimeline,
} from "../src/core/callSummary.js";

describe("callSummary", () => {
  it("query echoes filter, window, and returned/total", () => {
    const s = summarizeQuery("hitches", { filter: { "is-system": "No" }, timeRange: { startNs: 1_000_000, endNs: 5_000_000 } }, { totalRows: 1560, returnedRows: 20 });
    expect(s).toBe("query hitches where is-system=No in [1.0ms, 5.0ms] → 20 of 1,560 rows");
  });

  it("query with no filter/window is just schema → counts", () => {
    expect(summarizeQuery("time-sample", {}, { totalRows: 5, returnedRows: 5 })).toBe("query time-sample → 5 of 5 rows");
  });

  it("find renders a flat AND of leaf conditions", () => {
    const s = summarizeFind("hitches", { where: [{ col: "is-system", op: "eq", val: "No" }, { col: "duration", op: "gt", val: 33 }] }, { matchCount: 47 });
    expect(s).toBe("find hitches where is-system eq No AND duration gt 33 → 47 matches");
  });

  it("find renders a nested anyOf group and a compareCol leaf", () => {
    const s = summarizeFind("t", { where: [{ anyOf: [{ col: "a", op: "eq", val: 1 }, { col: "b", op: "eq", val: 2 }] }, { col: "x", op: "gt", compareCol: "y" }] }, { matchCount: 1 });
    expect(s).toBe("find t where (a eq 1 OR b eq 2) AND x gt y → 1 match");
  });

  it("aggregate echoes group-by, op/measure, group count and top group", () => {
    const s = summarizeAggregate("hitches", { groupBy: "display", measure: "duration", op: "sum" }, { totalGroups: 3, groups: [{ key: "Display 1", valueFmt: "412 ms" }] });
    expect(s).toBe("aggregate hitches by display (sum duration) → 3 groups, top: Display 1=412 ms");
  });

  it("aggregate count op reads cleanly and blank top key shows as quotes", () => {
    const s = summarizeAggregate("x", { groupBy: "view-name", measure: null, op: "count" }, { totalGroups: 1, groups: [{ key: "", valueFmt: "900" }] });
    expect(s).toContain("(count)");
    expect(s).toContain('top: ""=900');
  });

  it("correlate echoes the containment + matched-events headline", () => {
    const s = summarizeCorrelate({ intervalsSchema: "hitches", eventsSchema: "time-sample", matchThread: false, totalMatchedEvents: 312, totalGroups: 47 });
    expect(s).toBe("correlate hitches ⊃ time-sample (time-window) → 312 matched events across 47 groups");
  });

  it("relate not-exists headlines the UNMATCHED count (the leak/idle question)", () => {
    const s = summarizeRelate({ schemaA: "Leaks/Leaks", schemaB: "Allocations/Allocations List", joinCondition: "equality", polarity: "not-exists", totalMatches: 2, totalA: 10, totalGroups: 1 });
    expect(s).toBe("relate Leaks/Leaks equality/not-exists Allocations/Allocations List → 8 of 10 Leaks/Leaks rows had NO match");
  });

  it("call_tree echoes view, thread, window and sample count", () => {
    const s = summarizeCallTree({ schema: "time-profile", view: "hot", threadFilter: "Main Thread", totalSamples: 0 }, { startNs: 2_000_000, endNs: 3_000_000 });
    expect(s).toBe("call_tree time-profile (hot) thread=Main Thread in [2.0ms, 3.0ms] → 0 samples");
  });

  it("timeline echoes the merged schemas and returned/total", () => {
    const s = summarizeTimeline({ schemas: ["swiftui-updates", "core-data-fetch"], returnedRows: 20, totalInWindow: 84, timeRange: { startNs: 0, endNs: 10_000_000 } });
    expect(s).toBe("timeline swiftui-updates+core-data-fetch in [0.0ms, 10.0ms] → 20 of 84 events");
  });
});
