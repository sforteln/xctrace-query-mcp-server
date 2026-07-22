// Tool description format: see the comment above createServer() in src/index.ts.
// Enforced by tests/driftGuard.test.ts — verb-led openers, ⚠️ Not for blocks, no stale identifiers.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Lens, QuickStart } from "../types.js";
import type { NextAction } from "../../core/response.js";
import { envelope, toMcpText } from "../../core/response.js";
import { safeTool, text } from "../../core/toolUtils.js";
import { getSchemaModel, getTableAtPosition, getDb, lastRun as sessionLastRun } from "../../engine/session.js";
import { findSchemaTableEntries } from "../../engine/schemaModel.js";
import { aggregateTable } from "../../core/aggregate.js";
import {
  rawCol,
  buildDisplaySelect,
  resolveBacktraceDisplayValues,
  resolveInternedDisplayValues,
  makeFrameLookup,
  makeInternResolver,
  type DisplayField,
} from "../../engine/sqlHydrate.js";
import { isBacktraceCol, quoteIdent, ROW_IDX_COLUMN } from "../../engine/sqliteStore.js";
import type { SqliteTableHandle } from "../../engine/session.js";

const SWIFTUI_UPDATES_SCHEMA = "swiftui-updates";
const SWIFTUI_CHANGES_SCHEMA = "swiftui-changes";
const SWIFTUI_CAUSES_SCHEMA = "swiftui-causes";
const SWIFTUI_FULL_CAUSES_SCHEMA = "swiftui-full-causes";
const SWIFTUI_LAYOUT_UPDATES_SCHEMA = "swiftui-layout-updates";
const SWIFTUI_UPDATE_GROUPS_SCHEMA = "swiftui-update-groups";
// Xcode 27+ pre-filtered views — same columns as swiftui-updates / swiftui-layout-updates.
// SwiftUIFilteredUpdates appears 3× in a trace TOC (exclude-both, body-only, representable-only).
const SWIFTUI_FILTERED_UPDATES_SCHEMA = "SwiftUIFilteredUpdates";
// SwiftUILayoutUpdates2 adds a depth column to swiftui-layout-updates.
const SWIFTUI_LAYOUT_UPDATES2_SCHEMA = "SwiftUILayoutUpdates2";

const SWIFTUI_SCHEMAS = new Set([
  SWIFTUI_UPDATES_SCHEMA,
  SWIFTUI_CHANGES_SCHEMA,
  SWIFTUI_CAUSES_SCHEMA,
  SWIFTUI_FULL_CAUSES_SCHEMA,
  SWIFTUI_LAYOUT_UPDATES_SCHEMA,
  SWIFTUI_UPDATE_GROUPS_SCHEMA,
  SWIFTUI_FILTERED_UPDATES_SCHEMA,
  SWIFTUI_LAYOUT_UPDATES2_SCHEMA,
]);

// ── SwiftUIFilteredUpdates helpers ────────────────────────────────────────────

type FilteredUpdatesKind = "view-body" | "representable" | "other";

/**
 * Classify a SwiftUIFilteredUpdates instance by its swift-table attribute.
 * "including: nil" is the exclusion filter (layout + environment + everything
 * except view body and representable); other values name which type is included.
 */
function classifyFilteredUpdates(swiftTable: string | null): FilteredUpdatesKind | null {
  if (!swiftTable) return null;
  if (swiftTable.includes("including: nil")) return "other";
  const lower = swiftTable.toLowerCase();
  if (lower.includes("viewbody") || lower.includes("view body")) return "view-body";
  if (lower.includes("representable")) return "representable";
  return null;
}

/**
 * Find the 1-based position of the SwiftUIFilteredUpdates instance of a given
 * kind in the session's schema model. Positions map directly to the xctrace
 * positional xpath table[@schema="..."][N].
 */
function findFilteredUpdatesPosition(
  sessionId: string,
  run: number,
  kind: FilteredUpdatesKind
): number | null {
  const model = getSchemaModel(sessionId);
  const entries = findSchemaTableEntries(model, run, SWIFTUI_FILTERED_UPDATES_SCHEMA);
  for (let i = 0; i < entries.length; i++) {
    if (classifyFilteredUpdates(entries[i].toc.swiftTable) === kind) {
      return i + 1; // 1-based
    }
  }
  return null;
}

/**
 * Columns excluded from the default response. Each carries unbounded-size
 * data per row — view-hierarchy is a full ancestor modifier chain,
 * cause-graph-node and downstream-events are arrays — and in production use
 * even `limit: 30` overflowed response size limits because of these alone.
 * Pass their mnemonics explicitly via `columns` when actually needed.
 */
const HEAVY_COLUMNS = new Set([
  "view-hierarchy",
  "root-causes",
  "downstream-events",
  "cause-graph-node",
  "full-cause-graph-node",
]);

/**
 * Paginate and format a SqliteTableHandle's rows into the standard query
 * result shape — a direct scoped SQL page (ORDER BY/LIMIT/OFFSET), not a
 * fetchAllRowsHydrated full-table scan (see howLensesWork.md's "Lenses use
 * bespoke scoped SQL" note). handle.rowCount is already known (from
 * ingestion) so totalRows needs no extra query.
 */
async function paginateTable(
  sessionId: string,
  handle: SqliteTableHandle,
  schema: string,
  run: number,
  opts: { sort?: { by: string; dir?: "asc" | "desc" }; limit?: number; offset?: number; columns?: string[] }
) {
  const limit = Math.min(opts.limit ?? 20, 500);
  const offset = opts.offset ?? 0;
  const allMnemonics = handle.cols.map((c) => c.mnemonic);
  const columnsShown =
    opts.columns && opts.columns.length > 0
      ? opts.columns.filter((m) => allMnemonics.includes(m))
      : allMnemonics.filter((m) => !HEAVY_COLUMNS.has(m));

  const db = await getDb(sessionId);
  const table = quoteIdent(handle.tableName);
  const colByMnemonic = new Map(handle.cols.map((c) => [c.mnemonic, c]));
  const displayFields: DisplayField[] = columnsShown.map((m) => ({
    ref: m,
    base: m,
    isBacktrace: isBacktraceCol(colByMnemonic.get(m)!),
  }));
  const displayPlan = buildDisplaySelect(displayFields);
  const selectCols = [quoteIdent(ROW_IDX_COLUMN), ...displayPlan.selectCols];

  const totalRows = handle.rowCount;

  // Sort on the raw column, like query.ts's own ORDER BY — same known minor
  // divergence from the old JS natural-sort comparator (localeCompare with
  // {numeric:true}) for TEXT columns with embedded digits, already accepted
  // there since query/aggregate/find/get_row moved to reading via SQL against
  // the ingested table instead of an in-memory rows array (see
  // howSessionsWork.md's lifecycle section — "the cutover is complete"); no
  // explicit sort falls back to insertion order.
  const orderBy = opts.sort?.by
    ? `ORDER BY ${quoteIdent(rawCol(opts.sort.by))} ${(opts.sort.dir ?? "asc").toUpperCase()}`
    : `ORDER BY ${quoteIdent(ROW_IDX_COLUMN)} ASC`;

  const pageStmt = db.prepare(
    `SELECT ${selectCols.join(", ")} FROM ${table} ${orderBy} LIMIT ? OFFSET ?`
  );
  let sqlRows = pageStmt.all(limit, offset) as Record<string, unknown>[];
  if (displayPlan.backtraceMnemonics.length > 0) {
    sqlRows = resolveBacktraceDisplayValues(sqlRows, displayPlan.backtraceMnemonics, makeFrameLookup(db));
  }
  // swiftui-updates' blob columns (view-hierarchy, cause-graph-node) are large
  // repeated values, so they're stored on disk as a short sentinel token
  // pointing into a dedup side table rather than the literal content — resolve
  // them back to real content for display.
  sqlRows = resolveInternedDisplayValues(sqlRows, columnsShown, makeInternResolver(db));

  return {
    schema,
    run,
    totalRows,
    returnedRows: sqlRows.length,
    offset,
    limit,
    hasMore: offset + sqlRows.length < totalRows,
    rows: sqlRows.map((sqlRow, pageIdx) => ({
      index: offset + pageIdx,
      tableIndex: sqlRow[ROW_IDX_COLUMN] as number,
      cells: Object.fromEntries(columnsShown.map((m) => [m, (sqlRow[`__out_${m}`] as string | null) ?? null])),
    })),
    columnsShown,
  };
}

const swiftUILens: Lens = {
  instruments: [...SWIFTUI_SCHEMAS],

  registerTools(server: McpServer): void {
    // ── list_swiftui_view_body_updates ────────────────────────────────────────
    server.registerTool(
      "list_swiftui_view_body_updates",
      {
        title: "List SwiftUI View Body Updates",
        description:
          "List SwiftUI View Body re-evaluation events from the pre-filtered 'SwiftUIFilteredUpdates' table " +
          "(body-only instance). Each row is one view body re-evaluation; " +
          "sort by duration desc to find what actually blocked the main thread (this update's own " +
          "inclusive wall time) — sort by downstream-cost desc instead for which update triggered the " +
          "most cascading work in OTHER views; the two can diverge sharply and rank differently. " +
          "`run` defaults to the most recent run. " +
          "⚠️ Not for layout or environment events — use `list_swiftui_layout_env_updates` for those, " +
          "or `list_swiftui_representable_updates` for UIKit/AppKit bridge updates.",
        inputSchema: {
          sessionId: z.string().describe("The sessionId returned by open_trace."),
          run: z.number().int().optional().describe("Run number. Defaults to the most recent run."),
          sort: z
            .object({ by: z.string(), dir: z.enum(["asc", "desc"]) })
            .optional()
            .describe("Column mnemonic and direction."),
          limit: z
            .number()
            .int()
            .min(1)
            .max(500)
            .optional()
            .describe("Max rows to return (default 20, max 500)."),
          offset: z.number().int().min(0).optional().describe("Rows to skip for pagination."),
          columns: z
            .array(z.string())
            .optional()
            .describe(
              "Column mnemonics to include. Omit for the compact default, which excludes " +
              "view-hierarchy, root-causes, downstream-events, and cause-graph-node — each " +
              "carries unbounded per-row data and can overflow response limits even at small " +
              "row counts. Pass their mnemonics explicitly when actually needed."
            ),
        },
      },
      async ({ sessionId, run: runOpt, sort, limit, offset, columns }) =>
        safeTool(async () => {
          const run = runOpt ?? sessionLastRun(sessionId);
          const position = findFilteredUpdatesPosition(sessionId, run, "view-body");
          if (position === null) {
            return text(
              JSON.stringify({ error: "View Body filtered updates table not found in this trace" })
            );
          }
          const table = await getTableAtPosition(
            sessionId,
            run,
            SWIFTUI_FILTERED_UPDATES_SCHEMA,
            position
          );
          const result = await paginateTable(sessionId, table, SWIFTUI_FILTERED_UPDATES_SCHEMA, run, {
            sort,
            limit,
            offset,
            columns,
          });
          const actions: NextAction[] = [];
          if (result.hasMore) {
            actions.push({
              tool: "list_swiftui_view_body_updates",
              args: {
                sessionId,
                run,
                offset: result.offset + result.returnedRows,
                limit: result.limit,
              },
              description: "Fetch the next page of view body updates.",
            });
          }
          actions.push(
            {
              tool: "list_swiftui_layout_env_updates",
              args: { sessionId, run },
              description: "Switch to Layout, Environment, and other non-body updates.",
            },
            {
              tool: "list_swiftui_representable_updates",
              args: { sessionId, run },
              description: "Switch to Representable (UIKit/AppKit) bridge updates.",
            },
            {
              tool: "aggregate_swiftui_filtered_updates",
              args: {
                sessionId,
                run,
                kind: "view-body",
                groupBy: "view-name",
                measure: "duration",
                op: "sum",
                topN: 20,
              },
              description: "Summarize view body re-evaluations by view name and total main-thread time.",
            }
          );
          return text(toMcpText(envelope(result, actions)));
        })
    );

    // ── list_swiftui_representable_updates ────────────────────────────────────
    server.registerTool(
      "list_swiftui_representable_updates",
      {
        title: "List SwiftUI Representable Updates",
        description:
          "List SwiftUI Representable (UIKit/AppKit bridge) update events from the pre-filtered 'SwiftUIFilteredUpdates' table. " +
          "Rows cover views bridging to UIKit or AppKit via UIViewRepresentable/NSViewRepresentable. " +
          "`run` defaults to the most recent run. " +
          "⚠️ Not for native SwiftUI view body events — use `list_swiftui_view_body_updates` for those, " +
          "or `list_swiftui_layout_env_updates` for layout and environment updates.",
        inputSchema: {
          sessionId: z.string().describe("The sessionId returned by open_trace."),
          run: z.number().int().optional().describe("Run number. Defaults to the most recent run."),
          sort: z
            .object({ by: z.string(), dir: z.enum(["asc", "desc"]) })
            .optional()
            .describe("Column mnemonic and direction."),
          limit: z
            .number()
            .int()
            .min(1)
            .max(500)
            .optional()
            .describe("Max rows to return (default 20, max 500)."),
          offset: z.number().int().min(0).optional().describe("Rows to skip for pagination."),
          columns: z
            .array(z.string())
            .optional()
            .describe(
              "Column mnemonics to include. Omit for the compact default, which excludes " +
              "view-hierarchy, root-causes, downstream-events, and cause-graph-node — each " +
              "carries unbounded per-row data and can overflow response limits even at small " +
              "row counts. Pass their mnemonics explicitly when actually needed."
            ),
        },
      },
      async ({ sessionId, run: runOpt, sort, limit, offset, columns }) =>
        safeTool(async () => {
          const run = runOpt ?? sessionLastRun(sessionId);
          const position = findFilteredUpdatesPosition(sessionId, run, "representable");
          if (position === null) {
            return text(
              JSON.stringify({
                error: "Representable filtered updates table not found in this trace",
              })
            );
          }
          const table = await getTableAtPosition(
            sessionId,
            run,
            SWIFTUI_FILTERED_UPDATES_SCHEMA,
            position
          );
          const result = await paginateTable(sessionId, table, SWIFTUI_FILTERED_UPDATES_SCHEMA, run, {
            sort,
            limit,
            offset,
            columns,
          });
          const actions: NextAction[] = [];
          if (result.hasMore) {
            actions.push({
              tool: "list_swiftui_representable_updates",
              args: {
                sessionId,
                run,
                offset: result.offset + result.returnedRows,
                limit: result.limit,
              },
              description: "Fetch the next page of representable updates.",
            });
          }
          actions.push(
            {
              tool: "list_swiftui_view_body_updates",
              args: { sessionId, run },
              description: "Switch to View Body re-evaluation updates.",
            },
            {
              tool: "list_swiftui_layout_env_updates",
              args: { sessionId, run },
              description: "Switch to Layout, Environment, and other non-body updates.",
            },
            {
              tool: "aggregate_swiftui_filtered_updates",
              args: {
                sessionId,
                run,
                kind: "representable",
                groupBy: "view-name",
                measure: "duration",
                op: "sum",
                topN: 20,
              },
              description: "Summarize representable updates by view name and total main-thread time.",
            }
          );
          return text(toMcpText(envelope(result, actions)));
        })
    );

    // ── list_swiftui_layout_env_updates ───────────────────────────────────────
    server.registerTool(
      "list_swiftui_layout_env_updates",
      {
        title: "List SwiftUI Layout, Environment, and Other Updates",
        description:
          "List SwiftUI Layout, Environment, and other non-body update events from the pre-filtered 'SwiftUIFilteredUpdates' table — " +
          "every update except View Body re-evaluations and Representable (UIKit/AppKit) bridge updates. " +
          "Sort by duration desc to find what blocked the main thread, or downstream-cost desc for " +
          "which pass triggered the most cascading work elsewhere — they can diverge sharply. " +
          "`run` defaults to the most recent run. " +
          "⚠️ Not for view body or Representable events — use `list_swiftui_view_body_updates` or `list_swiftui_representable_updates` for those.",
        inputSchema: {
          sessionId: z.string().describe("The sessionId returned by open_trace."),
          run: z.number().int().optional().describe("Run number. Defaults to the most recent run."),
          sort: z
            .object({ by: z.string(), dir: z.enum(["asc", "desc"]) })
            .optional()
            .describe("Column mnemonic and direction."),
          limit: z
            .number()
            .int()
            .min(1)
            .max(500)
            .optional()
            .describe("Max rows to return (default 20, max 500)."),
          offset: z.number().int().min(0).optional().describe("Rows to skip for pagination."),
          columns: z
            .array(z.string())
            .optional()
            .describe(
              "Column mnemonics to include. Omit for the compact default, which excludes " +
              "view-hierarchy, root-causes, downstream-events, and cause-graph-node — each " +
              "carries unbounded per-row data and can overflow response limits even at small " +
              "row counts. Pass their mnemonics explicitly when actually needed."
            ),
        },
      },
      async ({ sessionId, run: runOpt, sort, limit, offset, columns }) =>
        safeTool(async () => {
          const run = runOpt ?? sessionLastRun(sessionId);
          const position = findFilteredUpdatesPosition(sessionId, run, "other");
          if (position === null) {
            return text(
              JSON.stringify({
                error: "Layout/Environment filtered updates table not found in this trace",
              })
            );
          }
          const table = await getTableAtPosition(
            sessionId,
            run,
            SWIFTUI_FILTERED_UPDATES_SCHEMA,
            position
          );
          const result = await paginateTable(sessionId, table, SWIFTUI_FILTERED_UPDATES_SCHEMA, run, {
            sort,
            limit,
            offset,
            columns,
          });
          const actions: NextAction[] = [];
          if (result.hasMore) {
            actions.push({
              tool: "list_swiftui_layout_env_updates",
              args: {
                sessionId,
                run,
                offset: result.offset + result.returnedRows,
                limit: result.limit,
              },
              description: "Fetch the next page of layout/environment updates.",
            });
          }
          actions.push(
            {
              tool: "list_swiftui_view_body_updates",
              args: { sessionId, run },
              description: "Switch to View Body re-evaluation updates.",
            },
            {
              tool: "list_swiftui_representable_updates",
              args: { sessionId, run },
              description: "Switch to Representable (UIKit/AppKit) bridge updates.",
            },
            {
              tool: "aggregate_swiftui_filtered_updates",
              args: {
                sessionId,
                run,
                kind: "other",
                groupBy: "category",
                measure: "duration",
                op: "sum",
                topN: 20,
              },
              description: "Break down layout and environment updates by category and total main-thread time.",
            }
          );
          return text(toMcpText(envelope(result, actions)));
        })
    );

    // ── aggregate_swiftui_filtered_updates ────────────────────────────────────
    server.registerTool(
      "aggregate_swiftui_filtered_updates",
      {
        title: "Aggregate SwiftUI Filtered Updates",
        description:
          "Group and sum/count/avg one of the three pre-filtered 'SwiftUIFilteredUpdates' instances " +
          "by any column — e.g. groupBy view-name and measure duration to find which views cost the " +
          "most main-thread time (use this for hang/stutter investigations), measure downstream-cost " +
          "instead for which views trigger the most cascading work in others — these diverge sharply " +
          "and rank differently, or groupBy update-type with op count for a frequency breakdown. " +
          "Resolves the schema's position automatically from `kind`, so the caller never needs to " +
          "know SwiftUIFilteredUpdates exists 3× in the trace or pass a raw position. " +
          "`run` defaults to the most recent run. " +
          "⚠️ Not for reading individual rows — use list_swiftui_view_body_updates, " +
          "list_swiftui_representable_updates, or list_swiftui_layout_env_updates for that.",
        inputSchema: {
          sessionId: z.string().describe("The sessionId returned by open_trace."),
          kind: z
            .enum(["view-body", "representable", "other"])
            .describe(
              "Which pre-filtered instance to aggregate: 'view-body' for View Body re-evaluations, " +
              "'representable' for UIKit/AppKit bridge updates, or 'other' for Layout, Environment, " +
              "and everything except the other two."
            ),
          groupBy: z.string().describe("Mnemonic of the column to group by, e.g. view-name or update-type."),
          measure: z
            .string()
            .optional()
            .describe(
              "Mnemonic of the weight column to aggregate. Use \"duration\" (this update's own inclusive " +
              "wall time) to find what blocked the main thread; use \"downstream-cost\" (time propagated " +
              "to dependents) to find which updates cause the most cascading work elsewhere — they can " +
              "rank very differently. Required for sum/avg; ignored for count."
            ),
          op: z.enum(["sum", "count", "avg"]).optional().describe("Aggregation operation (default: sum)."),
          topN: z
            .number()
            .int()
            .min(1)
            .max(100)
            .optional()
            .describe("Max groups to return, heaviest first (default 10)."),
          run: z.number().int().optional().describe("Run number. Optional — defaults to the most recent run."),
        },
      },
      async ({ sessionId, kind, groupBy, measure, op, topN, run: runOpt }) =>
        safeTool(async () => {
          const run = runOpt ?? sessionLastRun(sessionId);
          const position = findFilteredUpdatesPosition(sessionId, run, kind);
          if (position === null) {
            return text(
              JSON.stringify({ error: `${kind} filtered updates table not found in this trace` })
            );
          }
          const result = await aggregateTable(sessionId, SWIFTUI_FILTERED_UPDATES_SCHEMA, {
            run,
            groupBy,
            measure,
            op,
            topN,
            position,
          });

          const listToolByKind: Record<FilteredUpdatesKind, string> = {
            "view-body": "list_swiftui_view_body_updates",
            representable: "list_swiftui_representable_updates",
            other: "list_swiftui_layout_env_updates",
          };
          const actions: NextAction[] = [
            {
              tool: listToolByKind[kind],
              args: { sessionId, run, sort: { by: measure ?? groupBy, dir: "desc" } },
              description: `Drill into individual ${kind} rows, sorted by ${measure ?? groupBy}.`,
            },
            {
              tool: "aggregate_swiftui_filtered_updates",
              args: { sessionId, run, kind, groupBy: "<different-mnemonic>", measure, op, topN },
              description: "Re-aggregate this same instance by a different column.",
            },
          ];
          for (const otherKind of ["view-body", "representable", "other"] as const) {
            if (otherKind === kind) continue;
            actions.push({
              tool: "aggregate_swiftui_filtered_updates",
              args: { sessionId, run, kind: otherKind, groupBy, measure, op, topN },
              description: `Compare against the ${otherKind} instance.`,
            });
          }
          return text(toMcpText(envelope(result, actions)));
        })
    );
  },

  nextActions(sessionId: string, schema: string, run: number, _allSchemas: string[]): NextAction[] {
    if (!SWIFTUI_SCHEMAS.has(schema)) return [];
    if (schema === SWIFTUI_FILTERED_UPDATES_SCHEMA) {
      return [
        {
          tool: "list_swiftui_view_body_updates",
          args: { sessionId, run },
          description: "List View Body re-evaluation events from the body-only pre-filtered table.",
        },
        {
          tool: "list_swiftui_representable_updates",
          args: { sessionId, run },
          description: "List Representable (UIKit/AppKit) events from the representable-only table.",
        },
        {
          tool: "list_swiftui_layout_env_updates",
          args: { sessionId, run },
          description:
            "List Layout, Environment, and other non-body events (everything except body and representable).",
        },
        {
          tool: "aggregate_swiftui_filtered_updates",
          args: { sessionId, run, kind: "other", groupBy: "view-name", measure: "duration", op: "sum", topN: 20 },
          description: "Aggregate one of the three instances directly by any column (view-name, update-type, category, ...).",
        },
      ];
    }
    return [];
  },

  quickStart(schemas: string[], sessionId: string, run: number): QuickStart | null {
    // swiftui-updates is the comprehensive update view — prefer it when present.
    // Bounded-by-construction (see howLensesWork.md's `quickStart` section for
    // the standing rule) — a raw sorted query forces a full-table scan
    // regardless of size, and quickStart runs from schema names alone (no row
    // count known yet). This is the ACTUAL schema that crashed the server at
    // 736,282 rows in production (see engine/memoryGuard.ts) — the concrete
    // case this policy exists for. aggregate by view-name answers
    // "which view cost the most total main-thread time" instead of "the
    // single slowest update", staying bounded regardless of trace size.
    if (schemas.includes(SWIFTUI_UPDATES_SCHEMA)) {
      return {
        schema: SWIFTUI_UPDATES_SCHEMA,
        tool: "aggregate",
        args: {
          sessionId,
          schema: SWIFTUI_UPDATES_SCHEMA,
          run,
          groupBy: "view-name",
          measure: "duration",
          op: "sum",
          topN: 20,
        },
        hint: "SwiftUI trace — total duration by view-name shows which view cost the most cumulative main-thread time (this update's own inclusive wall time); measure downstream-cost instead to find which view triggers the most cascading work in OTHER views — the two can diverge sharply and rank very differently, so pick the one that matches the question. query with sort:{by:\"duration\",dir:\"desc\"} for the single slowest individual update (a raw sort — potentially slow on a very large trace). The category column splits View Body / Layout / Other. SwiftUIFilteredUpdates is also present as three pre-filtered instances (view-body/representable/other) — use aggregate_swiftui_filtered_updates(kind=...) to compare them directly.",
      };
    }

    // SwiftUIFilteredUpdates is a pre-filtered view with the same columns as swiftui-updates,
    // split into three TOC instances (view-body/representable/other) — never query it
    // unqualified, that throws ambiguous-schema. Present when swiftui-updates is absent
    // (layout-focused traces).
    if (schemas.includes(SWIFTUI_FILTERED_UPDATES_SCHEMA)) {
      return {
        schema: SWIFTUI_FILTERED_UPDATES_SCHEMA,
        tool: "aggregate_swiftui_filtered_updates",
        args: {
          sessionId,
          run,
          kind: "other",
          groupBy: "view-name",
          measure: "duration",
          op: "sum",
          topN: 10,
        },
        hint: "SwiftUI filtered-updates trace — SwiftUIFilteredUpdates exists as three pre-filtered instances (view-body/representable/other), starting here with 'other' (Layout, Environment, and everything else) aggregated by view-name and total main-thread duration. Switch kind to 'view-body' or 'representable' for the other instances, or measure to downstream-cost for cascading impact on other views instead of this update's own time. Use list_swiftui_view_body_updates / list_swiftui_representable_updates / list_swiftui_layout_env_updates to read individual rows.",
      };
    }

    // SwiftUILayoutUpdates2 adds depth to swiftui-layout-updates — prefer it.
    // Bounded-by-construction — same reasoning as swiftui-updates above:
    // quickStart can't know row count up front, so default to the aggregate
    // that stays bounded regardless of trace size.
    if (schemas.includes(SWIFTUI_LAYOUT_UPDATES2_SCHEMA)) {
      return {
        schema: SWIFTUI_LAYOUT_UPDATES2_SCHEMA,
        tool: "aggregate",
        args: {
          sessionId,
          schema: SWIFTUI_LAYOUT_UPDATES2_SCHEMA,
          run,
          groupBy: "view-name",
          measure: "duration",
          op: "sum",
          topN: 20,
        },
        hint: "SwiftUI layout trace — total duration by view-name shows which view's layout passes cost the most cumulative time; query with sort:{by:\"duration\",dir:\"desc\"} for the single most expensive individual pass (cached=\"No\" rows are uncached/most costly — boolean columns display Yes/No, a JSON false matches 0 rows; depth shows nesting level; compare duration vs self-duration for subtree vs self cost).",
      };
    }

    if (schemas.includes(SWIFTUI_LAYOUT_UPDATES_SCHEMA)) {
      return {
        schema: SWIFTUI_LAYOUT_UPDATES_SCHEMA,
        tool: "aggregate",
        args: {
          sessionId,
          schema: SWIFTUI_LAYOUT_UPDATES_SCHEMA,
          run,
          groupBy: "view-name",
          measure: "duration",
          op: "sum",
          topN: 20,
        },
        hint: "SwiftUI layout trace — total duration by view-name shows which view's layout passes cost the most cumulative time; query with sort:{by:\"duration\",dir:\"desc\"} for the single most expensive individual pass (cached=\"No\" rows are uncached/most costly — boolean columns display Yes/No, a JSON false matches 0 rows; compare duration vs self-duration for how much cost is child layout vs this view alone).",
      };
    }

    return null;
  },
};

export default swiftUILens;
