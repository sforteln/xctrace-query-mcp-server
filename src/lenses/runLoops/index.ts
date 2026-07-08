// Tool description format: see the comment above createServer() in src/index.ts.
// Enforced by tests/driftGuard.test.ts — verb-led openers, ⚠️ Not for blocks, no stale identifiers.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Lens, QuickStart } from "../types.js";
import type { NextAction } from "../../core/response.js";
import type { CellDetail } from "../../core/getRow.js";
import { hintFor } from "../../engine/roleHints.js";

const INTERVALS_SCHEMA = "runloop-intervals";
const EVENTS_SCHEMA = "runloop-events";

// Pinned in roleHints.ts — read from there instead of re-hardcoding the mnemonic.
const RUNLOOP_WEIGHT = hintFor(INTERVALS_SCHEMA)!.primaryWeight!;

/**
 * PMT:steel-spruce, verified live with real production data: a naive
 * duration-sort of main-thread "Runloop Run" turns is misleading — several
 * looked alarming (~1s, one 2.94s) but their child interval was "Waiting For
 * Events" (the runloop correctly parked while async work ran elsewhere, e.g.
 * a Foundation Models inference on the ANE), not a real block. Filtering to
 * interval-type "Busy" collapses to the truth: genuine main-thread work,
 * excluding benign idle-wait time that would otherwise pollute the ranking.
 *
 * Containment structure (don't sum across levels or you'll double-count):
 * "Runloop Run" contains "Busy" + "Individual Iteration" as siblings;
 * "Individual Iteration" itself contains "Waiting For Events". nesting-level/
 * containment-level record this nesting but aren't a partition key to group by
 * — the interval-type filter below is what isolates genuine work.
 */
function busyVsWaitingFinder(sessionId: string, run: number): NextAction {
  return {
    tool: "find",
    args: {
      sessionId,
      schema: INTERVALS_SCHEMA,
      run,
      where: [
        // is-main is a boolean column; find()'s val is string|number only
        // (no boolean), and the raw storage for "Yes" is numeric 1 — verified
        // live against the real TOC export (<boolean fmt="Yes">1</boolean>).
        { col: "is-main", op: "eq", val: 1 },
        { col: "interval-type", op: "eq", val: "Busy" },
      ],
      sort: { by: RUNLOOP_WEIGHT, dir: "desc" },
    },
    description:
      "Real main-thread blocks, sorted heaviest first — distinct from a raw duration-sort of " +
      "\"Runloop Run\" turns, which is misleading: a long Runloop Run often just means the main " +
      "thread correctly parked in \"Waiting For Events\" while async work ran elsewhere (e.g. a " +
      "Foundation Models inference), not a real block. Containment: \"Runloop Run\" contains " +
      "\"Busy\" + \"Individual Iteration\", which itself contains \"Waiting For Events\" — don't sum " +
      "durations across nesting-level/containment-level, filtering to interval-type: \"Busy\" is " +
      "what isolates genuine work.",
  };
}

const runLoopsLens: Lens = {
  instruments: [INTERVALS_SCHEMA, EVENTS_SCHEMA],

  registerTools(_server: McpServer): void {
    // No lens-specific tools — core verbs (find, query, aggregate, correlate) work directly on these schemas.
  },

  nextActions(
    sessionId: string,
    schema: string,
    run: number,
    _allSchemas: string[],
    row?: Record<string, CellDetail | null>
  ): NextAction[] {
    // Only surface this on the intervals table itself, and only as a
    // table-level suggestion (row is already a specific interval by then).
    if (schema !== INTERVALS_SCHEMA || row) return [];
    return [busyVsWaitingFinder(sessionId, run)];
  },

  quickStart(schemas: string[], sessionId: string, run: number): QuickStart | null {
    if (!schemas.includes(INTERVALS_SCHEMA)) return null;
    // Bounded-by-construction (PMT:spare-goat) — quickStart runs from schema
    // names alone, before any row count is known, so it defaults to the safe
    // aggregate breakdown rather than the (still filtered, but individually
    // row-returning) Busy-vs-Waiting finder above, which nextActions already
    // surfaces on the very next call against this schema.
    return {
      schema: INTERVALS_SCHEMA,
      tool: "aggregate",
      args: {
        sessionId,
        schema: INTERVALS_SCHEMA,
        run,
        groupBy: "interval-type",
        measure: RUNLOOP_WEIGHT,
        op: "sum",
        filter: { "is-main": 1 }, // raw storage for the boolean is numeric — see busyVsWaitingFinder's comment
        topN: 10,
      },
      hint:
        "Run Loops trace — total time by interval-type on the main runloop. Compare \"Busy\" vs " +
        "\"Waiting For Events\" to see whether the main thread is genuinely saturated or mostly " +
        "idle-parked; then find() with interval-type: \"Busy\" for the individual blocks (a raw " +
        "duration-sort of \"Runloop Run\" is misleading — see that finder's description).",
    };
  },
};

export default runLoopsLens;
