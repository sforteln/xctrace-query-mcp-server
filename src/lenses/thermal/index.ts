// Tool description format: see the comment above createServer() in src/index.ts.
// Enforced by tests/driftGuard.test.ts — verb-led openers, ⚠️ Not for blocks, no stale identifiers.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Lens, QuickStart } from "../types.js";
import type { NextAction } from "../../core/response.js";
import type { CellDetail } from "../../core/getRow.js";
import { hintFor } from "../../engine/roleHints.js";

const THERMAL_SCHEMA = "device-thermal-state-intervals";
const TIME_PROFILE_SCHEMAS = ["time-sample", "time-profile"];

// Pinned in roleHints.ts — read from there instead of re-hardcoding the mnemonic.
const THERMAL_WEIGHT = hintFor(THERMAL_SCHEMA)!.primaryWeight!;

/**
 * device-thermal-state-intervals has NO thread/process/backtrace column at
 * all — verified live (see roleHints.ts's comment) — it's a state level over
 * an interval, nothing else. It can only ever say WHEN the device got hot,
 * never WHY. Unlike potential-hangs/hitches, Thermal State isn't a
 * standalone template (confirmed: absent from `xcrun xctrace list
 * templates`, only in `list instruments`) — it's always composed onto some
 * other template, or bundled for free (e.g. by Time Profiler's own
 * template). So there's no TEMPLATE_NOTES entry of its own to attach an
 * upfront warning to the way "CPU Profiler"/"Animation Hitches" got one; this
 * auto-derived nextActions check is the only practical hook point.
 */
function timeProfileCorrelationHint(
  sessionId: string,
  schema: string,
  run: number,
  allSchemas: string[]
): NextAction | null {
  if (schema !== THERMAL_SCHEMA) return null;
  const hasTimeProfile = TIME_PROFILE_SCHEMAS.some((s) => allSchemas.includes(s));

  if (hasTimeProfile) {
    return {
      tool: "correlate",
      args: { sessionId, intervalsSchema: THERMAL_SCHEMA, eventsSchema: "time-sample", groupBy: "thermal-state", run },
      description:
        "device-thermal-state-intervals has no signal of its own about WHY the state changed — " +
        "Time Profiler samples are already in this trace — correlate them to see what was driving " +
        "CPU load during a hot interval, or call_tree(view: \"hot\" or \"spine\", timeRange: <that " +
        "interval's [start, start+duration]>) for a specific one.",
    };
  }

  return {
    tool: "start_recording",
    args: { template: "Time Profiler" },
    description:
      "device-thermal-state-intervals has no signal of its own about WHY the state changed, and " +
      "this trace has no Time Profiler samples to correlate against — re-record with template: " +
      "\"Time Profiler\" (already bundles Thermal State for free) to see what was driving CPU load.",
  };
}

/**
 * Per-row version — once a specific thermal-state interval is in hand
 * (get_row supplied it), point call_tree straight at that interval's own
 * [start, start+duration] instead of leaving the agent to build the
 * timeRange by hand. Mirrors the Hangs lens's timeProfileRowAction.
 */
function timeProfileRowAction(
  sessionId: string,
  schema: string,
  run: number,
  allSchemas: string[],
  row: Record<string, CellDetail | null>
): NextAction | null {
  if (schema !== THERMAL_SCHEMA) return null;
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
    description: "See what was driving CPU load during this specific thermal-state interval (self-time ranking scoped to its exact window) — try view: \"spine\" too for the single dominant path.",
  };
}

const thermalLens: Lens = {
  instruments: [THERMAL_SCHEMA],

  registerTools(_server: McpServer): void {
    // No lens-specific tools — core verbs (query, aggregate, correlate) work directly on this schema.
  },

  nextActions(
    sessionId: string,
    schema: string,
    run: number,
    allSchemas: string[],
    row?: Record<string, CellDetail | null>
  ): NextAction[] {
    if (schema !== THERMAL_SCHEMA) return [];
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
    if (!schemas.includes(THERMAL_SCHEMA)) return null;
    // Bounded-by-construction (PMT:spare-goat) — a raw query sorted by
    // duration forces a full-table scan regardless of table size, and
    // quickStart runs from schema names alone (no row count known yet) so it
    // can't tell a short trace from a long one before recommending. thermal-
    // state naturally partitions into a handful of named states, so "total
    // time per state" (aggregate) answers the same "what dominated" question
    // as a sorted list of individual intervals, without the unbounded scan.
    return {
      schema: THERMAL_SCHEMA,
      tool: "aggregate",
      args: {
        sessionId,
        schema: THERMAL_SCHEMA,
        run,
        groupBy: "thermal-state",
        measure: THERMAL_WEIGHT,
        op: "sum",
        topN: 10,
      },
      hint: `Thermal state trace — total ${THERMAL_WEIGHT} per thermal-state shows which state dominated the recording; this schema has no backtrace of its own, correlate against Time Profiler samples to see what was driving load`,
    };
  },
};

export default thermalLens;
