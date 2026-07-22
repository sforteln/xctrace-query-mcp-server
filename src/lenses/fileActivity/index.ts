// Tool description format: see the comment above createServer() in src/index.ts.
// Enforced by tests/driftGuard.test.ts — verb-led openers, ⚠️ Not for blocks, no stale identifiers.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Lens, QuickStart } from "../types.js";
import type { NextAction } from "../../core/response.js";
import type { CellDetail } from "../../core/getRow.js";

const FS_ANTIPATTERN_SCHEMA = "detected-fs-antipattern";
const FS_SYSCALL_SCHEMA = "fs-syscall";

/**
 * File Activity's detected-fs-antipattern is a SMALL,
 * bounded diagnosed-anomaly table (verified live: 43 rows in a real 7GB
 * trace — a kdebug-derived detector output, not a raw per-event log), so a
 * raw sorted query is safe here unlike this project's usual firehose
 * schemas (swiftui-updates, thermal-state, etc.) that need aggregate to stay
 * bounded-by-construction — same reasoning as the Leaks lens's own
 * quickStart exception.
 *
 * Verified live, worth surfacing directly rather than leaving an agent to
 * discover it the slow way: `significance` (High/Moderate/Low) does NOT
 * track `duration` — in the same real trace, 28 "Failed System Calls" rows
 * marked High significance summed to under 10 microseconds total, while a
 * single "Suboptimal Caching" row marked only Moderate ran ~9.5 SECONDS.
 * Reading significance as a severity ranking would completely miss the
 * actual dominant cost. Sorting by duration desc (not significance) is the
 * right default.
 */
const timeWindowSyscallAction = (
  sessionId: string,
  schema: string,
  run: number,
  allSchemas: string[],
  row?: Record<string, CellDetail | null>
): NextAction | null => {
  if (schema !== FS_ANTIPATTERN_SCHEMA) return null;
  if (!row) return null;
  if (!allSchemas.includes(FS_SYSCALL_SCHEMA)) return null;
  const start = row["start"]?.raw;
  const duration = row["duration"]?.raw;
  if (typeof start !== "number" || typeof duration !== "number") return null;

  const path = row["path"]?.fmt ?? "";
  const isUnresolvedVnode = path.includes("unknown (vnode");
  const process = row["process"]?.fmt;

  return {
    tool: "query",
    args: {
      sessionId,
      schema: FS_SYSCALL_SCHEMA,
      run,
      timeRange: { startNs: start, endNs: start + duration },
      ...(process ? { filter: { process } } : {}),
      sort: { by: "start", dir: "asc" },
      limit: 50,
    },
    description: isUnresolvedVnode
      ? "path is unresolved (\"unknown (vnode ...)\") — the underlying fs-syscall rows in this exact " +
        "window carry their own `vnode` value on the same file. Once you have one, " +
        "relate(schemaA: \"fs-syscall\", schemaB: \"vnode-to-path\", joinCondition: \"equality\", " +
        "on: [{fromCol: \"vnode\", toCol: \"vnode\"}]) resolves the real path — vnode-to-path is a " +
        "real schema in this trace but isn't ingested until queried, so this two-hop path (window " +
        "query, then equality-join) is the way there, not a single call."
      : "See the individual syscalls (open/read/write/close, etc.) underlying this antipattern in its " +
        "exact time window, scoped to the same process.",
  };
};

const fileActivityLens: Lens = {
  instruments: [FS_ANTIPATTERN_SCHEMA],

  registerTools(_server: McpServer): void {
    // No lens-specific tools — core verbs (query, aggregate, relate) work directly on this schema.
  },

  nextActions(
    sessionId: string,
    schema: string,
    run: number,
    allSchemas: string[],
    row?: Record<string, CellDetail | null>
  ): NextAction[] {
    if (schema !== FS_ANTIPATTERN_SCHEMA) return [];
    const actions: NextAction[] = [];

    if (row) {
      const rowAction = timeWindowSyscallAction(sessionId, schema, run, allSchemas, row);
      if (rowAction) actions.push(rowAction);
    } else {
      actions.push({
        tool: "aggregate",
        args: { sessionId, schema: FS_ANTIPATTERN_SCHEMA, run, groupBy: "type", measure: "duration", op: "sum", topN: 10 },
        description:
          "Bucket by antipattern type (Suboptimal Caching / Excessive Writes / Failed System Calls / " +
          "...) to see which category dominates total time — verified live, and consistent with Apple's " +
          "own typing: `significance` is an event-concept (an ADJECTIVE/severity annotation per the " +
          "Engineering Type Reference, not a measure) — it does NOT track duration; a single 'Moderate' " +
          "row can dwarf every 'High' row combined, so group/sort by duration, don't trust significance alone.",
      });
    }

    return actions;
  },

  quickStart(schemas: string[], sessionId: string, run: number): QuickStart | null {
    if (!schemas.includes(FS_ANTIPATTERN_SCHEMA)) return null;
    // Raw sorted query, not aggregate — see this file's header doc comment
    // for why this schema is safely bounded regardless of trace size.
    return {
      schema: FS_ANTIPATTERN_SCHEMA,
      tool: "query",
      args: {
        sessionId,
        schema: FS_ANTIPATTERN_SCHEMA,
        run,
        sort: { by: "duration", dir: "desc" },
        limit: 50,
      },
      hint:
        "File Activity anomaly detector — bounded (typically ~40 rows even in a multi-GB trace), " +
        "sorted by duration desc so the worst offenders lead. Each row carries `type` (Suboptimal " +
        "Caching / Excessive Writes / Failed System Calls / ...) and `significance` (High/Moderate/" +
        "Low) — verified live: significance does NOT track duration, read duration directly rather " +
        "than trusting the label. `path` sometimes reads \"unknown (vnode 0x...)\" when unresolved — " +
        "get_row that row for the vnode-resolution next step.",
    };
  },
};

export default fileActivityLens;
