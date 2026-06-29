#!/usr/bin/env node
/**
 * instruments-mcp-server — headless stdio MCP server entry point.
 *
 * Registers the universal core MCP tools. The server is schema-agnostic:
 * it works on any Instruments .trace by introspecting column roles at runtime.
 * Per-instrument lens verbs (Foundation Models, Time Profiler, …) are layered
 * on in src/lenses/ and injected into each response's nextActions by the lens
 * framework (FTR:flint-granite).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { openTrace, summary } from "./engine/session.js";
import { XctraceError } from "./engine/xctrace.js";
import { describeSchema } from "./core/schema.js";
import { listInstruments } from "./core/listInstruments.js";
import { queryTable } from "./core/query.js";
import { getRow } from "./core/getRow.js";
import {
  envelope,
  actionsAfterOpen,
  actionsAfterListInstruments,
  actionsAfterDescribeSchema,
  actionsAfterQuery,
  actionsAfterGetRow,
  toMcpText,
} from "./core/response.js";

const SERVER_NAME = "instruments-mcp-server";
const SERVER_VERSION = "0.1.0";

/** Wrap a tool handler so any XctraceError becomes a structured text error
 *  rather than a thrown exception (which the SDK turns into a generic error). */
async function safeTool(
  fn: () => Promise<{ content: Array<{ type: "text"; text: string }> }>
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof XctraceError) {
      return {
        content: [{ type: "text", text: JSON.stringify(err.toStructured(), null, 2) }],
      };
    }
    throw err as Error;
  }
}

function text(str: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: str }] };
}

function createServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  // ── open_trace ─────────────────────────────────────────────────────────────
  server.registerTool(
    "open_trace",
    {
      title: "Open Trace",
      description:
        "Load an Instruments .trace file and return a sessionId for subsequent calls. " +
        "The trace is loaded once and cached — all later tools reuse this session. " +
        "Returns the list of runs, instruments (schemas), and a coarse timeRange once " +
        "data is fetched. Always call this first.",
      inputSchema: {
        path: z.string().describe("Absolute or ~ path to the .trace bundle."),
      },
    },
    async ({ path }) =>
      safeTool(async () => {
        const result = await openTrace(path);
        const response = envelope(result, actionsAfterOpen(result.sessionId));
        return text(toMcpText(response));
      })
  );

  // ── get_summary ────────────────────────────────────────────────────────────
  server.registerTool(
    "get_summary",
    {
      title: "Get Trace Summary",
      description:
        "Return a summary of an open trace session: runs, instruments (with row counts " +
        "for tables already fetched), and the time range discovered so far. " +
        "Lightweight — no xctrace calls.",
      inputSchema: {
        sessionId: z.string().describe("The sessionId returned by open_trace."),
      },
    },
    async ({ sessionId }) =>
      safeTool(async () => {
        const result = summary(sessionId);
        const response = envelope(result, actionsAfterOpen(sessionId));
        return text(toMcpText(response));
      })
  );

  // ── list_instruments ───────────────────────────────────────────────────────
  server.registerTool(
    "list_instruments",
    {
      title: "List Instruments",
      description:
        "List every instrument (schema/table) in a trace, grouped by run. " +
        "Returns schema names, row counts (if already fetched), documentation, " +
        "and whether each schema is present in all runs. Includes a crossRunDiff " +
        "note when runs differ — e.g. 'run 3 adds: time-sample, context-switch-sample'. " +
        "Cheap: no xctrace calls. Call this right after open_trace to pick an instrument.",
      inputSchema: {
        sessionId: z.string().describe("The sessionId returned by open_trace."),
      },
    },
    async ({ sessionId }) =>
      safeTool(async () => {
        const result = listInstruments(sessionId);
        const lastRunSchemas =
          result.runs.find((r) => r.run === result.lastRun)?.schemas.map((s) => s.schema) ?? [];
        const response = envelope(
          result,
          actionsAfterListInstruments(sessionId, lastRunSchemas, result.lastRun)
        );
        return text(toMcpText(response));
      })
  );

  // ── describe_schema ──────────────────────────────────────────────────────────
  server.registerTool(
    "describe_schema",
    {
      title: "Describe Schema",
      description:
        "Describe an instrument's table: every column with its INFERRED role " +
        "(time/weight/backtrace/thread/label/detail), the canonical primaryTime " +
        "and primaryWeight columns, row count, and a by-role grouping of columns. " +
        "Output is sufficient to form a query or aggregate call with no further " +
        "schema knowledge. `run` is optional and defaults to the most recent run.",
      inputSchema: {
        sessionId: z.string().describe("The sessionId returned by open_trace."),
        schema: z
          .string()
          .describe("The schema/table name (e.g. 'time-sample', 'ModelInferenceTable')."),
        run: z
          .number()
          .int()
          .optional()
          .describe("Run number. Optional — defaults to the most recent run."),
      },
    },
    async ({ sessionId, schema, run }) =>
      safeTool(async () => {
        const desc = await describeSchema(sessionId, schema, run);
        const groupByCandidate = desc.rolesSummary.label[0] ?? desc.rolesSummary.thread[0] ?? null;
        const response = envelope(
          desc,
          actionsAfterDescribeSchema(sessionId, schema, desc.run, {
            primaryWeight: desc.primaryWeight,
            groupByCandidate,
            hasBacktrace: desc.rolesSummary.backtrace.length > 0,
          })
        );
        return text(toMcpText(response));
      })
  );

  // ── query ──────────────────────────────────────────────────────────────────
  server.registerTool(
    "query",
    {
      title: "Query Table",
      description:
        "Fetch rows from any instrument table with optional filter, column projection, " +
        "timeRange window, sort, and pagination. Returns summary rows (formatted display " +
        "values — no raw numbers or backtrace frames). Use get_row for full detail on a " +
        "specific row. Defaults to the first 20 rows of the most recent run. " +
        "Always call describe_schema first to know which columns/mnemonics exist.",
      inputSchema: {
        sessionId: z.string().describe("The sessionId returned by open_trace."),
        schema: z.string().describe("Schema/table name (e.g. 'time-sample', 'ModelInferenceTable')."),
        run: z.number().int().optional().describe("Run number. Optional — defaults to the most recent run."),
        filter: z
          .record(z.union([z.string(), z.number()]))
          .optional()
          .describe("Equality filter: { mnemonic: value }. Rows must match ALL entries. Values compared against fmt (display) and raw."),
        columns: z
          .array(z.string())
          .optional()
          .describe("Column mnemonics to include. Omit for all columns."),
        timeRange: z
          .object({
            startNs: z.number().optional().describe("Earliest timestamp (nanoseconds, inclusive)."),
            endNs: z.number().optional().describe("Latest timestamp (nanoseconds, inclusive)."),
          })
          .optional()
          .describe("Restrict rows to a time window. Applied to the primary time column for this schema."),
        sort: z
          .object({
            by: z.string().describe("Column mnemonic to sort by."),
            dir: z.enum(["asc", "desc"]).optional().describe("Sort direction. Default: asc."),
          })
          .optional()
          .describe("Sort rows by a column value."),
        limit: z.number().int().min(1).max(500).optional().describe("Rows to return (default 20, max 500)."),
        offset: z.number().int().min(0).optional().describe("Rows to skip for pagination (default 0)."),
      },
    },
    async ({ sessionId, schema, run, filter, columns, timeRange, sort, limit, offset }) =>
      safeTool(async () => {
        const result = await queryTable(sessionId, schema, { run, filter, columns, timeRange, sort, limit, offset });
        const response = envelope(
          result,
          actionsAfterQuery(sessionId, schema, result.run, result.hasMore)
        );
        return text(toMcpText(response));
      })
  );

  // ── get_row ────────────────────────────────────────────────────────────────
  server.registerTool(
    "get_row",
    {
      title: "Get Row Detail",
      description:
        "Fetch the full detail of one row by its raw table index (the `tableIndex` field " +
        "returned by query). Returns every column with type, fmt, raw value, role, and " +
        "for compound cells (thread, process) the nested child values. " +
        "For backtrace columns (kperf-bt): surfaces the top-of-stack PC, frame count, and " +
        "process; use call_tree for a full aggregated symbolicated call tree. " +
        "`run` is optional and defaults to the most recent run.",
      inputSchema: {
        sessionId: z.string().describe("The sessionId returned by open_trace."),
        schema: z.string().describe("Schema/table name."),
        rowIndex: z
          .number()
          .int()
          .min(0)
          .describe("Raw table index (`tableIndex` from query results, 0-based)."),
        run: z.number().int().optional().describe("Run number. Optional — defaults to the most recent run."),
      },
    },
    async ({ sessionId, schema, rowIndex, run }) =>
      safeTool(async () => {
        const result = await getRow(sessionId, schema, rowIndex, { run });
        const hasBacktrace = Object.values(result.cells).some(
          (c) => c?.backtrace !== undefined
        );
        const response = envelope(
          result,
          actionsAfterGetRow(
            sessionId, schema, result.run, rowIndex, result.totalRows, hasBacktrace
          )
        );
        return text(toMcpText(response));
      })
  );

  return server;
}

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`${SERVER_NAME} v${SERVER_VERSION} ready (stdio)`);
}

main().catch((err) => {
  console.error(`${SERVER_NAME} failed to start:`, err);
  process.exit(1);
});
