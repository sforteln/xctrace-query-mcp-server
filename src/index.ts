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
import { describeSchema } from "./core/schema.js";
import { listInstruments } from "./core/listInstruments.js";
import { queryTable } from "./core/query.js";
import { getRow } from "./core/getRow.js";
import { aggregateTable } from "./core/aggregate.js";
import { callTree } from "./core/callTree.js";
import { findRows } from "./core/find.js";
import { registry } from "./lenses/index.js";
import type { Lens } from "./lenses/index.js";
import { safeTool, text } from "./core/toolUtils.js";
import fmLens from "./lenses/foundationModels/index.js";
import { getConfig, updateConfig, configPath } from "./config.js";
import {
  envelope,
  actionsAfterOpen,
  actionsAfterListInstruments,
  actionsAfterDescribeSchema,
  actionsAfterQuery,
  actionsAfterGetRow,
  actionsAfterAggregate,
  actionsAfterFind,
  toMcpText,
} from "./core/response.js";

const SERVER_NAME = "instruments-mcp-server";
const SERVER_VERSION = "0.1.0";


/** Lenses to register at startup. Add new lenses here. */
const LENSES: Lens[] = [fmLens];

function createServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  registry.registerAll(LENSES, server);

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
          [
            ...actionsAfterDescribeSchema(sessionId, schema, desc.run, {
              primaryWeight: desc.primaryWeight,
              groupByCandidate,
              hasBacktrace: desc.rolesSummary.backtrace.length > 0,
            }),
            ...registry.nextActions(sessionId, schema, desc.run),
          ]
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
          [
            ...actionsAfterQuery(sessionId, schema, result.run, result.hasMore),
            ...registry.nextActions(sessionId, schema, result.run),
          ]
        );
        return text(toMcpText(response));
      })
  );

  // ── aggregate ─────────────────────────────────────────────────────────────
  server.registerTool(
    "aggregate",
    {
      title: "Aggregate Table",
      description:
        "The workhorse for profiling questions: group rows by any label/thread column " +
        "and aggregate a weight column by sum, count, or avg. Returns the top N groups " +
        "sorted heaviest-first with values formatted in the correct unit (s/ms/µs, MB/KB/B, count). " +
        "Examples: top threads by sample count (Time Profiler), total duration per agent " +
        "(Foundation Models), largest allocation groups. `run` defaults to the most recent run.",
      inputSchema: {
        sessionId: z.string().describe("The sessionId returned by open_trace."),
        schema: z.string().describe("Schema/table name."),
        groupBy: z.string().describe("Mnemonic of the column to group by (typically a label or thread column)."),
        measure: z
          .string()
          .optional()
          .describe("Mnemonic of the weight column to aggregate. Required for sum/avg; ignored for count."),
        op: z
          .enum(["sum", "count", "avg"])
          .optional()
          .describe("Aggregation operation (default: sum)."),
        topN: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max groups to return, heaviest first (default 10)."),
        run: z.number().int().optional().describe("Run number. Optional — defaults to the most recent run."),
        filter: z
          .record(z.union([z.string(), z.number()]))
          .optional()
          .describe("Pre-filter rows before grouping: { mnemonic: value }."),
        timeRange: z
          .object({
            startNs: z.number().optional(),
            endNs: z.number().optional(),
          })
          .optional()
          .describe("Restrict to a time window (nanoseconds) before grouping."),
      },
    },
    async ({ sessionId, schema, groupBy, measure, op, topN, run, filter, timeRange }) =>
      safeTool(async () => {
        const result = await aggregateTable(sessionId, schema, {
          run, groupBy, measure, op, topN, filter, timeRange,
        });
        const hasBacktrace = false; // aggregate doesn't resolve backtraces
        const topKey = result.groups[0]?.key ?? null;
        const response = envelope(
          result,
          [
            ...actionsAfterAggregate(sessionId, schema, result.run, groupBy, topKey, hasBacktrace),
            ...registry.nextActions(sessionId, schema, result.run),
          ]
        );
        return text(toMcpText(response));
      })
  );

  // ── call_tree ─────────────────────────────────────────────────────────────
  server.registerTool(
    "call_tree",
    {
      title: "Call Tree",
      description:
        "Build a folded call tree from inline symbolicated backtraces, weighted by sample duration. " +
        "Use schema 'time-profile' for Time Profiler — it carries pre-symbolicated <frame> elements. " +
        "Frames are grouped root-to-leaf; each node shows total/self weight, sample count, and % of total. " +
        "Filter by thread name/id substring to focus on one thread. " +
        "`run` defaults to the most recent run.",
      inputSchema: {
        sessionId: z.string().describe("The sessionId returned by open_trace."),
        schema: z
          .string()
          .describe("Schema with tagged-backtrace column. Use 'time-profile' for Time Profiler."),
        run: z.number().int().optional().describe("Run number. Optional — defaults to the most recent run."),
        thread: z
          .string()
          .optional()
          .describe("Substring filter on thread fmt (e.g. 'PromptManager' or '0x25cc66') to scope to one thread."),
        timeRange: z
          .object({
            startNs: z.number().optional(),
            endNs: z.number().optional(),
          })
          .optional()
          .describe("Restrict samples to a time window (nanoseconds)."),
        maxDepth: z
          .number()
          .int()
          .min(1)
          .max(15)
          .optional()
          .describe("Max tree depth (default 6)."),
        topN: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("Max children shown per node (default 8)."),
      },
    },
    async ({ sessionId, schema, run, thread, timeRange, maxDepth, topN }) =>
      safeTool(async () => {
        const result = await callTree(sessionId, schema, { run, thread, timeRange, maxDepth, topN });
        const response = envelope(result, [
          {
            tool: "call_tree",
            args: { sessionId, schema, run: result.run, thread: "<thread-substring>", topN: 8 },
            description: "Narrow to a specific thread or increase topN for broader coverage.",
          },
          {
            tool: "aggregate",
            args: { sessionId, schema: schema === "time-profile" ? "time-sample" : schema, run: result.run, groupBy: "thread", op: "count", topN: 10 },
            description: "See sample count by thread to pick the busiest thread to filter on.",
          },
          ...registry.nextActions(sessionId, schema, result.run),
        ]);
        return text(toMcpText(response));
      })
  );

  // ── find ──────────────────────────────────────────────────────────────────
  server.registerTool(
    "find",
    {
      title: "Find Rows",
      description:
        "Filter rows in any instrument table by a compound predicate (AND of per-column conditions). " +
        "Supports richer operators than query's equality filter: eq, ne, gt, gte, lt, lte, " +
        "contains, not-contains, regex, is-null, not-null. All conditions are AND'd — a row must " +
        "match every condition to be included. Returns summary rows (fmt values) with tableIndex for " +
        "follow-up get_row calls. This is the substrate for lens-specific finders: e.g. " +
        "[{col:'error-count',op:'gt',val:0}] implements hasError; [{col:'resolve',op:'contains',val:'emptyContext'}] " +
        "implements emptyContext. `run` defaults to the most recent run.",
      inputSchema: {
        sessionId: z.string().describe("The sessionId returned by open_trace."),
        schema: z.string().describe("Schema/table name (e.g. 'time-sample', 'ModelInferenceTable')."),
        run: z.number().int().optional().describe("Run number. Optional — defaults to the most recent run."),
        where: z
          .array(
            z.object({
              col: z.string().describe("Column mnemonic to test."),
              op: z
                .enum(["eq", "ne", "gt", "gte", "lt", "lte", "contains", "not-contains", "regex", "is-null", "not-null"])
                .describe("Comparison operator."),
              val: z
                .union([z.string(), z.number()])
                .optional()
                .describe("Value to compare against. Not needed for is-null / not-null."),
            })
          )
          .describe("AND'd conditions. All must pass for a row to match."),
        columns: z
          .array(z.string())
          .optional()
          .describe("Column mnemonics to include in results. Omit for all columns."),
        sort: z
          .object({
            by: z.string().describe("Column mnemonic to sort by."),
            dir: z.enum(["asc", "desc"]).optional().describe("Sort direction. Default: asc."),
          })
          .optional()
          .describe("Sort matching rows by a column value."),
        timeRange: z
          .object({
            startNs: z.number().optional().describe("Earliest timestamp (nanoseconds, inclusive)."),
            endNs: z.number().optional().describe("Latest timestamp (nanoseconds, inclusive)."),
          })
          .optional()
          .describe("Restrict to a time window before evaluating predicates."),
        limit: z.number().int().min(1).max(500).optional().describe("Rows to return (default 50, max 500)."),
        offset: z.number().int().min(0).optional().describe("Rows to skip for pagination (default 0)."),
      },
    },
    async ({ sessionId, schema, run, where, columns, sort, timeRange, limit, offset }) =>
      safeTool(async () => {
        const result = await findRows(sessionId, schema, {
          run, where, columns, sort, timeRange, limit, offset,
        });
        const firstTableIndex = result.rows[0]?.tableIndex ?? null;
        const response = envelope(
          result,
          [
            ...actionsAfterFind(sessionId, schema, result.run, result.matchCount, result.hasMore, firstTableIndex),
            ...registry.nextActions(sessionId, schema, result.run),
          ]
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
          [
            ...actionsAfterGetRow(sessionId, schema, result.run, rowIndex, result.totalRows, hasBacktrace),
            ...registry.nextActions(sessionId, schema, result.run),
          ]
        );
        return text(toMcpText(response));
      })
  );

  // ── add_search_root ───────────────────────────────────────────────────────
  server.registerTool(
    "add_search_root",
    {
      title: "Add Search Root",
      description:
        "Add a directory to scan when searching for .trace files. " +
        "The path is validated (must exist and be a directory), resolved to absolute, " +
        "and de-duplicated before saving. Persists to the server config file so it " +
        "survives subprocess restarts. Use list_search_roots to see current roots.",
      inputSchema: {
        path: z.string().describe("Absolute or ~ path to a directory containing .trace files."),
      },
    },
    async ({ path: rawPath }) =>
      safeTool(async () => {
        const { resolve } = await import("node:path");
        const { homedir } = await import("node:os");
        const { stat } = await import("node:fs/promises");

        const expanded = rawPath.startsWith("~")
          ? rawPath.replace("~", homedir())
          : rawPath;
        const absPath = resolve(expanded);

        let isDir = false;
        try {
          const s = await stat(absPath);
          isDir = s.isDirectory();
        } catch {
          return text(JSON.stringify({
            error: "path_not_found",
            path: absPath,
            hint: "The path does not exist. Check the path and try again.",
          }, null, 2));
        }

        if (!isDir) {
          return text(JSON.stringify({
            error: "not_a_directory",
            path: absPath,
            hint: "Path exists but is not a directory.",
          }, null, 2));
        }

        const config = await updateConfig((c) => ({
          ...c,
          searchRoots: c.searchRoots.includes(absPath)
            ? c.searchRoots
            : [...c.searchRoots, absPath],
        }));

        return text(JSON.stringify({
          added: absPath,
          searchRoots: config.searchRoots,
          configPath: configPath(),
        }, null, 2));
      })
  );

  // ── remove_search_root ────────────────────────────────────────────────────
  server.registerTool(
    "remove_search_root",
    {
      title: "Remove Search Root",
      description:
        "Remove a directory from the search roots. Silently succeeds if the " +
        "path is not currently a root. Use list_search_roots to confirm.",
      inputSchema: {
        path: z.string().describe("Path to remove (must match exactly as stored — use list_search_roots to see stored values)."),
      },
    },
    async ({ path: rawPath }) =>
      safeTool(async () => {
        const { resolve } = await import("node:path");
        const { homedir } = await import("node:os");

        const expanded = rawPath.startsWith("~")
          ? rawPath.replace("~", homedir())
          : rawPath;
        const absPath = resolve(expanded);

        const config = await updateConfig((c) => ({
          ...c,
          searchRoots: c.searchRoots.filter((r) => r !== absPath),
        }));

        return text(JSON.stringify({
          removed: absPath,
          searchRoots: config.searchRoots,
        }, null, 2));
      })
  );

  // ── list_search_roots ─────────────────────────────────────────────────────
  server.registerTool(
    "list_search_roots",
    {
      title: "List Search Roots",
      description:
        "List all configured search root directories and whether they currently exist on disk. " +
        "Also shows the built-in roots that are always scanned (Xcode autosave, DerivedData). " +
        "Use add_search_root to add a directory.",
      inputSchema: {},
    },
    async () =>
      safeTool(async () => {
        const { homedir } = await import("node:os");
        const { stat } = await import("node:fs/promises");
        const { join } = await import("node:path");

        const home = homedir();
        const builtInRoots = [
          join(home, "Library", "Developer", "Xcode", "Instruments"),
          join(home, "Library", "Caches", "com.apple.dt.instruments"),
        ];

        const config = await getConfig();

        async function checkExists(p: string): Promise<boolean> {
          try { await stat(p); return true; } catch { return false; }
        }

        const userRoots = await Promise.all(
          config.searchRoots.map(async (r) => ({ path: r, exists: await checkExists(r), type: "user" as const }))
        );
        const builtIn = await Promise.all(
          builtInRoots.map(async (r) => ({ path: r, exists: await checkExists(r), type: "built-in" as const }))
        );

        return text(JSON.stringify({
          configPath: configPath(),
          builtInRoots: builtIn,
          userRoots,
          totalRoots: builtIn.length + userRoots.length,
        }, null, 2));
      })
  );

  return server;
}

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  // Load config eagerly at startup so the first tool call doesn't pay the I/O cost.
  await getConfig();
  await server.connect(transport);
  console.error(`${SERVER_NAME} v${SERVER_VERSION} ready (stdio)`);
}

main().catch((err) => {
  console.error(`${SERVER_NAME} failed to start:`, err);
  process.exit(1);
});
