/**
 * Example lens — demonstrates the lens pattern using only framework helpers.
 *
 * NOT registered in LENSES[]. Exists to verify the helpers API composes
 * correctly and to serve as a copy-paste starting point for real lenses.
 *
 * A lens is NOT limited to the base verbs (query/aggregate/find/relate) —
 * this template deliberately demonstrates BOTH patterns (PMT:warm-mica):
 *
 *   1. example_list — reach for a base verb when it already fits. query()
 *      already does filter/sort/pagination/backtrace-safety; a lens just
 *      re-labels the result into domain vocabulary. Don't reinvent this.
 *
 *   2. example_detail — drop to direct scoped SQL when a base verb doesn't
 *      cleanly express what's needed (here: one row's role-classified detail,
 *      the shape get_row/getRequest-style lens tools need). Write a bespoke
 *      query against the ingested (dbPath, tableName) via getDb + the
 *      sqlHydrate helpers — NEVER fetchAllRowsHydrated's whole-table fetch
 *      just to reach one row or compute one scalar. That full-table-scan-
 *      into-JS pattern is exactly what this feature exists to eliminate.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Lens } from "./types.js";
import type { NextAction } from "../core/response.js";
import { getTable, getDb, lastRun as sessionLastRun } from "../engine/session.js";
import { classifyWithHints } from "../engine/roleHints.js";
import { queryTable } from "../core/query.js";
import { hydrateNormalizedRow, makeFrameLookup } from "../engine/sqlHydrate.js";
import { quoteIdent, ROW_IDX_COLUMN } from "../engine/sqliteStore.js";
import { projectRow } from "./helpers.js";

/** Domain row type produced by this lens. */
interface ExampleRow {
  startTime: string | null;
  duration: string | null;
  name: string | null;
  thread: string | null;
}

export const exampleLens: Lens = {
  instruments: ["example-schema"],

  registerTools(server: McpServer): void {
    // ── Pattern 1: a base verb already fits ─────────────────────────────────
    server.registerTool(
      "example_list",
      {
        title: "Example List",
        description: "List rows from example-schema in domain vocabulary.",
        inputSchema: {}, // real lenses add z.string() fields here
      },
      async (_args: Record<string, never>) => {
        // In a real tool: sessionId and run come from the MCP args.
        const sessionId = "<sessionId>";
        const schema = "example-schema";
        const run = sessionLastRun(sessionId);

        // query() already handles pagination, filter/sort, and backtrace
        // safety — a lens just re-labels its fmt-string cells into domain
        // vocabulary. No direct SQL needed here; reaching for one anyway
        // would just be reinventing query()'s own paging/bounds logic.
        const result = await queryTable(sessionId, schema, { run, limit: 20 });
        const rows: ExampleRow[] = result.rows.map((r) => ({
          startTime: r.cells["start"] ?? null,
          duration: r.cells["duration"] ?? null,
          name: r.cells["event-name"] ?? null,
          thread: r.cells["thread"] ?? null,
        }));

        return {
          content: [{ type: "text" as const, text: JSON.stringify({ rows }, null, 2) }],
        };
      }
    );

    // ── Pattern 2: drop to direct scoped SQL ────────────────────────────────
    server.registerTool(
      "example_detail",
      {
        title: "Example Detail",
        description: "Full role-classified detail for one example-schema row.",
        inputSchema: { rowIndex: z.number().int().min(0) }, // real lenses add sessionId/schema/run too
      },
      async ({ rowIndex }: { rowIndex: number }) => {
        const sessionId = "<sessionId>";
        const schema = "example-schema";
        const run = sessionLastRun(sessionId);
        const handle = await getTable(sessionId, run, schema);
        const db = await getDb(sessionId);

        // A single scoped row lookup — WHERE _row_idx = ?, not a whole-table
        // fetch discarding every row but one. This is the pattern a lens
        // reaches for whenever a base verb's shape doesn't fit (here: one
        // row's full role-classified detail rather than a page of summaries).
        const sqlRow = db
          .prepare(`SELECT * FROM ${quoteIdent(handle.tableName)} WHERE ${quoteIdent(ROW_IDX_COLUMN)} = ?`)
          .get(rowIndex) as Record<string, unknown> | undefined;
        if (!sqlRow) throw new Error(`rowIndex ${rowIndex} out of range (0–${handle.rowCount - 1})`);

        const classified = classifyWithHints(schema, handle.cols);
        const row = hydrateNormalizedRow(handle.cols, sqlRow, makeFrameLookup(db));
        const detail = projectRow(
          row,
          classified,
          // Role-based: generic columns that transfer across schemas.
          { time: "startTime", weight: "duration", thread: "thread" },
          // Mnemonic-based: schema-specific columns.
          { "event-name": "name" }
        ) as unknown as ExampleRow;

        return {
          content: [{ type: "text" as const, text: JSON.stringify({ rowIndex, ...detail }, null, 2) }],
        };
      }
    );
  },

  nextActions(sessionId: string, schema: string, run: number, _allSchemas: string[]): NextAction[] {
    return [
      {
        tool: "example_list",
        args: { sessionId, schema, run },
        description: "List rows in domain vocabulary.",
      },
    ];
  },
};
