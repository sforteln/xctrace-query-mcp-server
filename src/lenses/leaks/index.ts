// Tool description format: see the comment above createServer() in src/index.ts.
// Enforced by tests/driftGuard.test.ts — verb-led openers, ⚠️ Not for blocks, no stale identifiers.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Lens, QuickStart } from "../types.js";
import type { NextAction } from "../../core/response.js";
import type { CellDetail } from "../../core/getRow.js";
import { peekTable } from "../../engine/session.js";
import { hintFor } from "../../engine/roleHints.js";

const LEAKS_SCHEMA = "Leaks/Leaks";
const ALLOCATIONS_LIST_SCHEMA = "Allocations/Allocations List";
const ALLOCATIONS_STATS_SCHEMA = "Allocations/Statistics";
const UNRESOLVED_CALLER = "<Call stack limit reached>";
// Pinned in roleHints.ts — Allocations/Allocations List's weight column is
// "size" (bytes allocated); Allocations/Statistics' is "persistent-bytes"
// (live retained footprint) — a DIFFERENT column that only exists on that
// schema. Reading both from roleHints instead of hardcoding catches this
// kind of mismatch instead of silently aggregating on a missing column.
const LEAKS_WEIGHT = hintFor(LEAKS_SCHEMA)!.primaryWeight!;
const LIST_WEIGHT = hintFor(ALLOCATIONS_LIST_SCHEMA)!.primaryWeight!;
const STATS_WEIGHT = hintFor(ALLOCATIONS_STATS_SCHEMA)!.primaryWeight!;
// Track-detail attributes have no separate raw-nanosecond/formatted split like
// schema-table cells do — timestamp's `.raw` is this same formatted string, not
// a number. Pre-attach snapshot rows all carry this exact sentinel value.
const ZERO_TIMESTAMP = "00:00.000.000";

/**
 * Build the Leaks -> Allocations address-join nextAction, labeling the two
 * failure modes distinctly when the target row is already cached: pre-
 * attachment (allocated before Instruments attached — no stack recoverable
 * in principle, joined timestamp is 0) vs. unresolved (allocated during the
 * recording but the stack wasn't captured — a different, potentially
 * transient cause). Only peeks the cache — never triggers a fetch, so this
 * never turns a fast get_row call into a slow one on a cold Allocations table.
 */
function buildAllocationJoinAction(
  sessionId: string,
  run: number,
  address: string
): NextAction {
  const baseArgs = { sessionId, schema: ALLOCATIONS_LIST_SCHEMA, run, filter: { address } };
  const cached = peekTable(sessionId, run, ALLOCATIONS_LIST_SCHEMA);
  const match = cached?.rows.find((r) => r["address"]?.fmt === address);

  if (match) {
    const isPreAttach = match["timestamp"]?.fmt === ZERO_TIMESTAMP;
    const callerFmt = match["responsible-caller"]?.fmt ?? null;
    const isUnresolved = !isPreAttach && (callerFmt === null || callerFmt === UNRESOLVED_CALLER);

    if (isPreAttach) {
      return {
        tool: "query",
        args: baseArgs,
        description:
          "PRE-ATTACHMENT — this leak's joined allocation has timestamp 0, meaning it was allocated " +
          "before Instruments attached. No stack is recoverable in principle — relaunch with launch " +
          "mode instead of attach to capture this object's allocation from t=0.",
      };
    }
    if (isUnresolved) {
      return {
        tool: "query",
        args: baseArgs,
        description:
          "UNRESOLVED — allocated during the recording but the stack wasn't captured (too deep, or " +
          "logging missed it) — not the same as pre-attachment. Still useful for category/size/" +
          "responsible-library even without a backtrace.",
      };
    }
    return {
      tool: "query",
      args: baseArgs,
      description:
        "Look up this leak's allocation record for its resolved backtrace — the address join to " +
        "Allocations is deterministic 1:1.",
    };
  }

  return {
    tool: "query",
    args: baseArgs,
    description:
      "Look up this leak's allocation record for its backtrace — Leaks has no backtrace column; " +
      "the address join to Allocations is deterministic 1:1.",
  };
}

const leaksLens: Lens = {
  instruments: [LEAKS_SCHEMA],

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
    if (schema !== LEAKS_SCHEMA) return [];
    const actions: NextAction[] = [];

    // Leaks/Leaks has no backtrace column — Instruments' own design is to
    // cross-reference by address into Allocations for the responsible frames.
    // Only offer this when get_row supplied a specific leak's address (query/
    // aggregate/find have no single row in context, so row is undefined there).
    const address = row?.["address"]?.fmt;
    if (address && allSchemas.includes(ALLOCATIONS_LIST_SCHEMA)) {
      actions.push(buildAllocationJoinAction(sessionId, run, address));
    }

    actions.push({
      tool: "aggregate",
      args: {
        sessionId,
        schema: LEAKS_SCHEMA,
        run,
        groupBy: "responsible-library",
        measure: LEAKS_WEIGHT,
        op: "sum",
        topN: 20,
      },
      description:
        "Group leaks by owning library — shows whether leaked bytes are app-owned or framework-owned.",
    });
    if (allSchemas.includes(ALLOCATIONS_LIST_SCHEMA)) {
      actions.push({
        tool: "aggregate",
        args: {
          sessionId,
          schema: ALLOCATIONS_LIST_SCHEMA,
          run,
          groupBy: "category",
          measure: LIST_WEIGHT,
          op: "sum",
          topN: 20,
        },
        description:
          `Summarise allocated bytes by category alongside the leaks — ${LIST_WEIGHT} is total bytes allocated (including freed), grouped by framework or class name.`,
      });
    }
    if (allSchemas.includes(ALLOCATIONS_STATS_SCHEMA)) {
      actions.push({
        tool: "aggregate",
        args: {
          sessionId,
          schema: ALLOCATIONS_STATS_SCHEMA,
          run,
          groupBy: "category",
          measure: STATS_WEIGHT,
          op: "sum",
          topN: 20,
        },
        description:
          `Pre-summarised Allocations view — ${STATS_WEIGHT} shows the live persistent footprint by category, faster than Allocations List. Try this if Allocations List is slow or empty.`,
      });
    }
    return actions;
  },

  quickStart(schemas: string[], sessionId: string, run: number): QuickStart | null {
    if (!schemas.includes(LEAKS_SCHEMA)) return null;
    return {
      schema: LEAKS_SCHEMA,
      tool: "query",
      args: {
        sessionId,
        schema: LEAKS_SCHEMA,
        run,
        sort: { by: LEAKS_WEIGHT, dir: "desc" },
        limit: 20,
      },
      hint: `Leaks trace — query sorted by ${LEAKS_WEIGHT} shows all leaks largest-first; zero rows means no leaks detected`,
    };
  },
};

export default leaksLens;
