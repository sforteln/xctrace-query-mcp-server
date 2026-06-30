// Tool description format: see the comment above createServer() in src/index.ts.
// Enforced by tests/driftGuard.test.ts — verb-led openers, ⚠️ Not for blocks, no stale identifiers.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Lens, QuickStart } from "../types.js";
import type { NextAction } from "../../core/response.js";
import { envelope, toMcpText } from "../../core/response.js";
import { safeTool, text } from "../../core/toolUtils.js";
import { getSchemaModel, getTableAtPosition, lastRun as sessionLastRun } from "../../engine/session.js";
import { findSchemaTableEntries } from "../../engine/schemaModel.js";
import { compareRows } from "../../core/tableFilter.js";
import type { ParsedTable } from "../../engine/parseTable.js";

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

/** Paginate and format a ParsedTable into the standard query result shape. */
function paginateTable(
  table: ParsedTable,
  schema: string,
  run: number,
  opts: { sort?: { by: string; dir?: "asc" | "desc" }; limit?: number; offset?: number }
) {
  const limit = Math.min(opts.limit ?? 20, 500);
  const offset = opts.offset ?? 0;
  const columnsShown = table.cols.map((c) => c.mnemonic);

  type Indexed = { tableIndex: number; row: (typeof table.rows)[0] };
  let rows: Indexed[] = table.rows.map((row, i) => ({ tableIndex: i, row }));

  if (opts.sort?.by) {
    const by = opts.sort.by;
    const dir = opts.sort.dir ?? "asc";
    rows = [...rows].sort((a, b) => compareRows(a.row, b.row, by, dir));
  }

  const totalRows = rows.length;
  const page = rows.slice(offset, offset + limit);

  return {
    schema,
    run,
    totalRows,
    returnedRows: page.length,
    offset,
    limit,
    hasMore: offset + page.length < totalRows,
    rows: page.map(({ tableIndex, row }, pageIdx) => ({
      index: offset + pageIdx,
      tableIndex,
      cells: Object.fromEntries(columnsShown.map((m) => [m, row[m]?.fmt ?? null])),
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
          "sort by downstream-cost desc to find the most expensive calls. " +
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
        },
      },
      async ({ sessionId, run: runOpt, sort, limit, offset }) =>
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
          const result = paginateTable(table, SWIFTUI_FILTERED_UPDATES_SCHEMA, run, {
            sort,
            limit,
            offset,
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
              tool: "aggregate",
              args: {
                sessionId,
                schema: SWIFTUI_FILTERED_UPDATES_SCHEMA,
                run,
                groupBy: "view-name",
                measure: "downstream-cost",
                op: "sum",
                topN: 20,
              },
              description: "Summarize view body re-evaluations by view name and downstream cost.",
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
        },
      },
      async ({ sessionId, run: runOpt, sort, limit, offset }) =>
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
          const result = paginateTable(table, SWIFTUI_FILTERED_UPDATES_SCHEMA, run, {
            sort,
            limit,
            offset,
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
              tool: "aggregate",
              args: {
                sessionId,
                schema: SWIFTUI_FILTERED_UPDATES_SCHEMA,
                run,
                groupBy: "view-name",
                measure: "downstream-cost",
                op: "sum",
                topN: 20,
              },
              description: "Summarize representable updates by view name and downstream cost.",
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
          "Sort by downstream-cost desc to surface the most impactful layout and environment passes. " +
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
        },
      },
      async ({ sessionId, run: runOpt, sort, limit, offset }) =>
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
          const result = paginateTable(table, SWIFTUI_FILTERED_UPDATES_SCHEMA, run, {
            sort,
            limit,
            offset,
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
              tool: "aggregate",
              args: {
                sessionId,
                schema: SWIFTUI_FILTERED_UPDATES_SCHEMA,
                run,
                groupBy: "category",
                measure: "downstream-cost",
                op: "sum",
                topN: 20,
              },
              description: "Break down layout and environment updates by category.",
            }
          );
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
      ];
    }
    return [];
  },

  quickStart(schemas: string[], sessionId: string, run: number): QuickStart | null {
    // swiftui-updates is the comprehensive update view — prefer it when present.
    if (schemas.includes(SWIFTUI_UPDATES_SCHEMA)) {
      return {
        schema: SWIFTUI_UPDATES_SCHEMA,
        tool: "query",
        args: {
          sessionId,
          schema: SWIFTUI_UPDATES_SCHEMA,
          run,
          sort: { by: "downstream-cost", dir: "desc" },
          limit: 20,
        },
        hint: "SwiftUI trace — sorted by downstream-cost shows the most expensive updates by total subtree impact; check view-name, severity, and root-causes. The category column splits View Body / Layout / Other. SwiftUIFilteredUpdates is also present: it pre-filters by update type so you can aggregate groupBy category to compare body vs layout cost directly.",
      };
    }

    // SwiftUIFilteredUpdates is a pre-filtered view with the same columns as swiftui-updates.
    // Present when swiftui-updates is absent (layout-focused traces).
    if (schemas.includes(SWIFTUI_FILTERED_UPDATES_SCHEMA)) {
      return {
        schema: SWIFTUI_FILTERED_UPDATES_SCHEMA,
        tool: "aggregate",
        args: {
          sessionId,
          schema: SWIFTUI_FILTERED_UPDATES_SCHEMA,
          run,
          groupBy: "category",
          measure: "downstream-cost",
          op: "sum",
          topN: 10,
        },
        hint: "SwiftUI filtered-updates trace — aggregate by category splits View Body vs Layout vs Other by total downstream cost; drill into the heaviest category with query sorted by downstream-cost.",
      };
    }

    // SwiftUILayoutUpdates2 adds depth to swiftui-layout-updates — prefer it.
    if (schemas.includes(SWIFTUI_LAYOUT_UPDATES2_SCHEMA)) {
      return {
        schema: SWIFTUI_LAYOUT_UPDATES2_SCHEMA,
        tool: "query",
        args: {
          sessionId,
          schema: SWIFTUI_LAYOUT_UPDATES2_SCHEMA,
          run,
          sort: { by: "duration", dir: "desc" },
          limit: 20,
        },
        hint: "SwiftUI layout trace — sorted by duration shows the most expensive layout passes; cached=false rows are uncached (most costly); depth shows nesting level; compare duration vs self-duration to see subtree vs self cost.",
      };
    }

    if (schemas.includes(SWIFTUI_LAYOUT_UPDATES_SCHEMA)) {
      return {
        schema: SWIFTUI_LAYOUT_UPDATES_SCHEMA,
        tool: "query",
        args: {
          sessionId,
          schema: SWIFTUI_LAYOUT_UPDATES_SCHEMA,
          run,
          sort: { by: "duration", dir: "desc" },
          limit: 20,
        },
        hint: "SwiftUI layout trace — sorted by duration shows the most expensive layout passes; cached=false rows are uncached (most costly); compare duration vs self-duration to see how much of the cost is from child layout vs this view alone.",
      };
    }

    return null;
  },
};

export default swiftUILens;
