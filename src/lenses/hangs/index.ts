// Tool description format: see the comment above createServer() in src/index.ts.
// Enforced by tests/driftGuard.test.ts — verb-led openers, ⚠️ Not for blocks, no stale identifiers.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Lens, QuickStart } from "../types.js";
import type { NextAction } from "../../core/response.js";
import type { CellDetail } from "../../core/getRow.js";
import { hintFor } from "../../engine/roleHints.js";

const HANGS_SCHEMA = "potential-hangs";
const HITCHES_SCHEMA = "hitches";
const HANG_RISKS_SCHEMA = "hang-risks";
const TIME_PROFILE_SCHEMAS = ["time-sample", "time-profile"];

// Pinned in roleHints.ts — read from there instead of re-hardcoding the mnemonic.
const HANGS_WEIGHT = hintFor(HANGS_SCHEMA)!.primaryWeight!;

const HANGS_SCHEMAS = [HANGS_SCHEMA, HITCHES_SCHEMA, HANG_RISKS_SCHEMA];

/**
 * potential-hangs/hitches carry start/duration/thread/process but NO
 * backtrace of their own (confirmed: not in roleHints.ts's column set for
 * either schema) — they say WHEN, never WHAT. This is a backstop for the
 * RECORDING_INTENTS notes on "hangs"/"hitches" that already tell an agent to
 * compose Time Profiler upfront; this only fires if that got missed (or a
 * pre-existing trace is being reopened, where the recording-time note was
 * never seen at all) — same two-destination shape as the Leaks lens's
 * unattributableFractionHint, just auto-derived from schema presence instead
 * of a data-content check.
 */
function timeProfileCorrelationHint(
  sessionId: string,
  schema: string,
  run: number,
  allSchemas: string[]
): NextAction | null {
  if (schema !== HANGS_SCHEMA && schema !== HITCHES_SCHEMA) return null;
  const hasTimeProfile = TIME_PROFILE_SCHEMAS.some((s) => allSchemas.includes(s));
  const groupBy = schema === HANGS_SCHEMA ? "hang-type" : "is-system";

  if (hasTimeProfile) {
    return {
      tool: "correlate",
      args: { sessionId, intervalsSchema: schema, eventsSchema: "time-sample", groupBy, run },
      description:
        `${schema} has no backtrace column of its own, but Time Profiler samples are already in ` +
        "this trace — correlate them to see what was actually running, or call_tree(view: \"hot\" " +
        "or \"spine\", timeRange: <this hang/hitch's [start, start+duration]>) for a specific one.",
    };
  }

  // Redirect to a richer TEMPLATE rather than composing bare "Time Profiler"
  // onto this recording — composing the bare instrument doesn't bring
  // Thermal State along (that's template-level bundling only) and would run
  // two separate CPU-sampling instruments (this schema's own + time-profile)
  // side by side for no benefit. type: "cpu" already bundles Hangs + Points
  // of Interest + Thermal State, a strict superset of type: "hangs" plus
  // full CPU attribution in one pass. hitches has no analog in Time
  // Profiler at all (only Animation Hitches produces it, and that template
  // already bundles Time Profiler) — verified live, don't guess here either.
  const redirect = schema === HANGS_SCHEMA ? { type: "cpu" } : { type: "hitches" };
  return {
    tool: "start_recording",
    args: redirect,
    description:
      schema === HANGS_SCHEMA
        ? "potential-hangs has no backtrace column of its own, and this trace has no Time Profiler " +
          "samples to correlate against — re-record with type: \"cpu\" instead of composing " +
          "instruments: [\"Time Profiler\"] onto this one: Time Profiler's own template already " +
          "bundles Hangs + Points of Interest + Thermal State for free, so it's a strict superset " +
          "of this recording plus full CPU attribution, without running two CPU-sampling " +
          "instruments side by side."
        : "hitches has no backtrace column of its own, and this trace has no Time Profiler samples " +
          "to correlate against — re-record with type: \"hitches\" (Animation Hitches), which " +
          "already bundles Time Profiler for free.",
  };
}

/**
 * Per-row version of the same correlation, once a specific hang/hitch is in
 * hand (get_row supplied it) — points call_tree straight at that interval's
 * own [start, start+duration] instead of leaving the agent to read start/
 * duration off the row and build the timeRange by hand.
 */
function timeProfileRowAction(
  sessionId: string,
  schema: string,
  run: number,
  allSchemas: string[],
  row: Record<string, CellDetail | null>
): NextAction | null {
  if (schema !== HANGS_SCHEMA && schema !== HITCHES_SCHEMA) return null;
  if (!TIME_PROFILE_SCHEMAS.some((s) => allSchemas.includes(s))) return null;
  const start = row["start"]?.raw;
  const duration = row["duration"]?.raw;
  if (typeof start !== "number" || typeof duration !== "number") return null;

  return {
    tool: "call_tree",
    args: {
      sessionId,
      schema: "time-profile",
      run,
      timeRange: { startNs: start, endNs: start + duration },
      view: "hot",
    },
    description: `See what was actually running during this specific ${schema === HANGS_SCHEMA ? "hang" : "hitch"} (self-time ranking scoped to its exact window) — try view: "spine" too for the single dominant path.`,
  };
}

const hangsLens: Lens = {
  instruments: HANGS_SCHEMAS,

  registerTools(_server: McpServer): void {
    // No lens-specific tools — core verbs (query, aggregate, find) work directly on these schemas.
  },

  nextActions(
    sessionId: string,
    schema: string,
    run: number,
    allSchemas: string[],
    row?: Record<string, CellDetail | null>
  ): NextAction[] {
    if (!HANGS_SCHEMAS.includes(schema)) return [];
    const actions: NextAction[] = [];

    if (row) {
      const rowAction = timeProfileRowAction(sessionId, schema, run, allSchemas, row);
      if (rowAction) actions.push(rowAction);
    } else {
      const tableAction = timeProfileCorrelationHint(sessionId, schema, run, allSchemas);
      if (tableAction) actions.push(tableAction);
    }

    return actions;
  },

  quickStart(schemas: string[], sessionId: string, run: number): QuickStart | null {
    if (schemas.includes(HANGS_SCHEMA)) {
      // Bounded-by-construction (PMT:spare-goat) — a raw sorted query forces
      // a full-table scan regardless of size, and quickStart runs from
      // schema names alone (no row count known yet). aggregate by hang-type
      // (the same column this lens's own correlate call already keys on for
      // this schema) answers "which kind of hang dominates" instead of "the
      // single worst hang", staying bounded on a huge trace.
      return {
        schema: HANGS_SCHEMA,
        tool: "aggregate",
        args: {
          sessionId,
          schema: HANGS_SCHEMA,
          run,
          groupBy: "hang-type",
          measure: HANGS_WEIGHT,
          op: "sum",
          topN: 10,
        },
        hint: `Hangs & Hitches trace — total ${HANGS_WEIGHT} by hang-type (main-thread vs. background) shows which kind of hang dominates; query with sort:{by:"${HANGS_WEIGHT}",dir:"desc"} for the single worst hang`,
      };
    }

    if (schemas.includes(HITCHES_SCHEMA)) {
      return {
        schema: HITCHES_SCHEMA,
        tool: "aggregate",
        args: {
          sessionId,
          schema: HITCHES_SCHEMA,
          run,
          groupBy: "is-system",
          op: "count",
          topN: 10,
        },
        hint: "Hitches trace — aggregate by is-system splits hitches into app-owned vs. system-owned; focus on is-system=false rows to find app regressions",
      };
    }

    return null;
  },
};

export default hangsLens;
