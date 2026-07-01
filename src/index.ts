#!/usr/bin/env node
/**
 * instruments-mcp-server — headless stdio MCP server entry point.
 *
 * Registers the universal core MCP tools. The server is schema-agnostic:
 * it works on any Instruments .trace by introspecting column roles at runtime.
 * Per-instrument lens verbs (Foundation Models, Time Profiler, …) are layered
 * on in src/lenses/ and injected into each response's nextActions by the lens
 * registry.
 */
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { openTrace, summary, getSession, closeSession } from "./engine/session.js";
import { describeSchema } from "./core/schema.js";
import { listInstruments } from "./core/listInstruments.js";
import { queryTable } from "./core/query.js";
import { getRow } from "./core/getRow.js";
import { aggregateTable } from "./core/aggregate.js";
import { correlate } from "./core/correlate.js";
import { callTree } from "./core/callTree.js";
import { findRows } from "./core/find.js";
import { registry } from "./lenses/index.js";
import type { Lens } from "./lenses/index.js";
import { safeTool, safeToolWithLog, text } from "./core/toolUtils.js";
import { buildVersionWarning } from "./engine/versionRules.js";
import fmLens from "./lenses/foundationModels/index.js";
import leaksLens from "./lenses/leaks/index.js";
import timeProfilerLens from "./lenses/timeProfiler/index.js";
import networkLens from "./lenses/network/index.js";
import hangsLens from "./lenses/hangs/index.js";
import swiftConcurrencyLens from "./lenses/swiftConcurrency/index.js";
import swiftUILens from "./lenses/swiftUI/index.js";
import coreDataLens from "./lenses/coreData/index.js";
import allocationsLens from "./lenses/allocations/index.js";
import { getConfig, updateConfig, configPath } from "./config.js";
import { listTraces, findTrace } from "./core/discovery.js";
import {
  RECORDING_INTENTS,
  tryOpenTrace,
} from "./core/recording.js";
import {
  startSession,
  stopSession,
  getRecordingStatus,
} from "./core/recordingSession.js";
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

// ─── Heap guard ─────────────────────────────────────────────────────────────
//
// session.tableCache holds a fully-parsed table in memory for the life of the
// session, with no eviction (see howSessionsWork.md). Large real traces —
// swiftui-updates on a busy, multi-instrument recording in particular — can
// hold enough parsed rows to exceed Node's default old-space limit (~4 GB on
// most systems), which aborts the ENTIRE process with a fatal OOM. That kills
// the MCP connection outright (no error reaches the client — it just reads as
// "Connection closed") and wipes every open session, not just the one query
// that tripped it. Re-exec with a larger heap if the launch config (Xcode's
// MCP registration, `claude mcp add`, etc.) didn't already request one,
// rather than requiring every possible launcher to know to pass this flag.
// A larger ceiling is a mitigation, not a fix for the underlying unbounded
// cache growth — an even larger trace can still exceed it.
const HEAP_MB = Number(process.env.INSTRUMENTS_MCP_MAX_HEAP_MB) || 8192;
if (
  process.argv[1] === fileURLToPath(import.meta.url) &&
  !process.execArgv.some((a) => a.startsWith("--max-old-space-size"))
) {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(
    process.execPath,
    [`--max-old-space-size=${HEAP_MB}`, ...process.argv.slice(1)],
    { stdio: "inherit" }
  );
  process.exit(result.status ?? 1);
}


/**
 * Lenses to register at startup. Add new lenses here.
 *
 * Order matters: registry.quickStart() returns the first lens whose
 * quickStart() matches, so this is a priority list, not just a registration
 * list. Time Profiler and Hangs are deliberately LAST — both get auto-bundled
 * as auxiliary instruments into other templates (SwiftUI, Swift Concurrency,
 * Animation Hitches, and each other — confirmed via `xctrace record
 * --show-recording-options`), so their schemas are present far more often
 * than they're the actual recording intent. Putting them first meant e.g. a
 * trace recorded specifically to investigate SwiftUI always won a generic
 * "aggregate by thread" suggestion instead of a SwiftUI-specific one, since
 * time-sample/time-profile are always along for the ride.
 *
 * Known residual gap: Time Profiler and Hangs bundle each other (a plain "cpu"
 * recording can carry Hangs schemas too, and a plain "hitches" recording
 * carries Time Profiler schemas), so their relative order can't be fully
 * correct for both directions with static priority alone — there's no TOC
 * signal distinguishing "the actual recording target" from "came along for
 * free." Not solved here; falls back to whichever of the two is listed first
 * below when both are ambiguous winners.
 */
const LENSES: Lens[] = [
  fmLens,
  leaksLens,
  networkLens,
  swiftConcurrencyLens,
  swiftUILens,
  coreDataLens,
  allocationsLens,
  hangsLens,
  timeProfilerLens,
];

/**
 * ## Tool description format (behavioral spec, not API docs)
 *
 * Descriptions are re-injected every turn as sticky context — they steer the AI's
 * call DECISION, not just document the function. Three-move pattern:
 *
 *   1. WHAT      — verb-led sentence saying WHEN to call this (user intent / trigger).
 *   2. ⚠️ Not for X — explicitly name wrong call sites. Most important move.
 *   3. PREFER    — name the cheaper or purpose-built sibling when one exists.
 *
 * Anti-patterns: don't open with a determiner (the/this/a/an); don't restate the JSON
 * schema in the tool description; don't write marketing copy; don't use static labels
 * like "cheap/expensive" — bake cost reasoning into prose ("no xctrace calls").
 *
 * Parameter descriptions are a different register: intent vocabulary + what the value
 * becomes ("Becomes the query's time window", not "Optional. The start time.").
 *
 * Enforced by: tests/driftGuard.test.ts
 * Full guide:  Update_for_your_version_and_submit_a_PR.md
 */
export function createServer(): McpServer {
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
        "Returns runs with `recordedAt` timestamps so the agent can identify 'the run I just created'; " +
        "instruments (schemas); and when a lens recognises the trace type, a `suggestedStart` block " +
        "with the exact next tool call to make — follow it to reach first real data in 2 calls total. " +
        "Always call this first. " +
        "⚠️ Not for traces already open — reuse the returned sessionId across all subsequent calls.",
      inputSchema: {
        path: z.string().describe("Absolute or ~ path to the .trace bundle."),
      },
    },
    async ({ path }) =>
      safeToolWithLog("open_trace", { path }, async () => {
        const result = await openTrace(path);
        const schemas = [...new Set(result.instruments.map((i) => i.schema))];
        const versionWarning = buildVersionWarning(result.xcodeVersion, schemas);
        const lastRunNum = Math.max(...result.runs.map((r) => r.number));
        const lastRunSchemas = result.runs.find((r) => r.number === lastRunNum)?.schemas ?? [];
        const suggestedStart = registry.quickStart(lastRunSchemas, result.sessionId, lastRunNum);
        const payload = {
          ...result,
          ...(versionWarning && { versionWarning }),
          ...(suggestedStart && { suggestedStart }),
        };
        const response = envelope(payload, actionsAfterOpen(result.sessionId));
        return text(toMcpText(response));
      })
  );

  // ── close_trace ─────────────────────────────────────────────────────────────
  server.registerTool(
    "close_trace",
    {
      title: "Close Trace",
      description:
        "Close a session opened by open_trace and free its cached tables from memory. " +
        "Sessions are never evicted automatically — each open_trace call adds a new session " +
        "that persists for the life of the server process, so closing ones you're done with " +
        "matters on a long-running server that opens many traces (large tables like " +
        "swiftui-updates can hold gigabytes). Safe to call even if you're not sure whether " +
        "you still need the session — open_trace on the same path again returns a fresh one. " +
        "⚠️ Not for pausing — there is no way to reopen a closed sessionId; call open_trace again instead.",
      inputSchema: {
        sessionId: z.string().describe("The sessionId returned by open_trace, to close."),
      },
    },
    async ({ sessionId }) =>
      safeToolWithLog("close_trace", { sessionId }, async () => {
        getSession(sessionId); // throws a structured error if sessionId is invalid/already closed
        closeSession(sessionId);
        return text(JSON.stringify({ closed: true, sessionId }));
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
        "Lightweight — no xctrace calls. " +
        "⚠️ Not for fetching rows — use query, find, or aggregate for data access. " +
        "Prefer list_instruments right after open_trace for full schema documentation " +
        "and cross-run diffs — use get_summary to refresh session state mid-analysis.",
      inputSchema: {
        sessionId: z.string().describe("The sessionId returned by open_trace."),
      },
    },
    async ({ sessionId }) =>
      safeToolWithLog("get_summary", { sessionId }, async () => {
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
        "Returns schema names, row counts (if already fetched), schema documentation, " +
        "and a crossRunDiff note when runs differ — e.g. 'run 3 adds: time-sample, context-switch-sample'. " +
        "Cheap: no xctrace calls. " +
        "Use this when open_trace did not return a suggestedStart, when you need cross-run comparison, " +
        "or when you want schema documentation before querying.",
      inputSchema: {
        sessionId: z.string().describe("The sessionId returned by open_trace."),
      },
    },
    async ({ sessionId }) =>
      safeToolWithLog("list_instruments", { sessionId }, async () => {
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
        "schema knowledge. `run` is optional and defaults to the most recent run. " +
        "⚠️ Not for reading row data — call query or find after this to access actual rows.",
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
        position: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "1-based instance to pick when this schema appears more than once in the run. " +
            "Omit on the first try — an ambiguous-schema error will list the instances if needed."
          ),
      },
    },
    async ({ sessionId, schema, run, position }) =>
      safeToolWithLog("describe_schema", { sessionId, schema, run, position }, async () => {
        const desc = await describeSchema(sessionId, schema, run, position);
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
        "Always call describe_schema first to know which columns/mnemonics exist. " +
        "⚠️ Not for full row detail or resolved backtraces — use get_row for that. " +
        "Not for grouping or counting — use aggregate for that. " +
        "Prefer find over query when you need richer operators than equality (gt, contains, regex, …).",
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
        position: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "1-based instance to pick when this schema appears more than once in the run. " +
            "Omit on the first try — an ambiguous-schema error will list the instances if needed."
          ),
      },
    },
    async ({ sessionId, schema, run, filter, columns, timeRange, sort, limit, offset, position }) =>
      safeToolWithLog("query", { sessionId, schema, run, filter, columns, timeRange, sort, limit, offset, position }, async () => {
        const result = await queryTable(sessionId, schema, { run, filter, columns, timeRange, sort, limit, offset, position });
        const response = envelope(
          result,
          [
            ...actionsAfterQuery(sessionId, schema, result.run, result.hasMore, result.hasBacktrace),
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
        "Group rows by any label or thread column and aggregate a weight column by sum, count, or avg — " +
        "the workhorse for most profiling questions. Returns the top N groups sorted heaviest-first " +
        "with values formatted in the correct unit (s/ms/µs, MB/KB/B, count). " +
        "Examples: top threads by sample count (Time Profiler), total duration per agent " +
        "(Foundation Models), largest allocation groups. `run` defaults to the most recent run. " +
        "⚠️ Not for reading individual rows — use query or find to access specific rows.",
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
        position: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "1-based instance to pick when this schema appears more than once in the run. " +
            "Omit on the first try — an ambiguous-schema error will list the instances if needed."
          ),
      },
    },
    async ({ sessionId, schema, groupBy, measure, op, topN, run, filter, timeRange, position }) =>
      safeToolWithLog("aggregate", { sessionId, schema, groupBy, measure, op, topN, run, filter, timeRange, position }, async () => {
        const result = await aggregateTable(sessionId, schema, {
          run, groupBy, measure, op, topN, filter, timeRange, position,
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

  // ── correlate ─────────────────────────────────────────────────────────────
  server.registerTool(
    "correlate",
    {
      title: "Correlate Intervals with Events",
      description:
        "Find which point events (schema B, e.g. core-data-fetch) fall inside which time " +
        "intervals (schema A, e.g. swiftui-updates' [start, start+duration] windows) — the " +
        "cross-instrument causation primitive. Matched on the same thread by default, since " +
        "two unrelated interval/event pairs can otherwise overlap in time by coincidence; " +
        "pass matchThread:false to correlate on time alone (weaker evidence) — confirmed in " +
        "practice that some instrument pairs record thread identity differently, which makes " +
        "matchThread:true silently return zero matches even when events genuinely fall inside " +
        "the intervals; a threadMismatchWarning field flags exactly this case. Grouped by an " +
        "intervals-schema label column (e.g. view-name) so the result reads as a direct " +
        "answer — 'SidebarView.body contained 445 Feature fetches' — not a raw per-interval " +
        "dump. Both schemas must already be in the SAME trace on the SAME clock — use " +
        "start_recording's `instruments` param to compose them into one recording; two " +
        "separate recordings can never be correlated this way. " +
        "`run` defaults to the most recent run. " +
        "⚠️ Not for aggregating within one schema — use aggregate for that.",
      inputSchema: {
        sessionId: z.string().describe("The sessionId returned by open_trace."),
        intervalsSchema: z.string().describe("Schema carrying the [start, start+duration] windows, e.g. \"swiftui-updates\"."),
        eventsSchema: z.string().describe("Schema carrying point timestamps to test for containment, e.g. \"core-data-fetch\"."),
        groupBy: z.string().describe("Mnemonic of an intervalsSchema label column to group results by, e.g. \"view-name\"."),
        measure: z
          .string()
          .optional()
          .describe("Mnemonic of an eventsSchema weight column to sum per group, alongside the match count."),
        matchThread: z
          .boolean()
          .optional()
          .describe("Require the matched event to be on the same thread as the interval (default true)."),
        intervalsFilter: z
          .record(z.union([z.string(), z.number()]))
          .optional()
          .describe("Pre-filter intervals before joining: { mnemonic: value }."),
        eventsFilter: z
          .record(z.union([z.string(), z.number()]))
          .optional()
          .describe("Pre-filter events before joining: { mnemonic: value }."),
        topN: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max groups to return, heaviest by matched-event-count first (default 10)."),
        run: z.number().int().optional().describe("Run number. Optional — defaults to the most recent run."),
      },
    },
    async ({ sessionId, intervalsSchema, eventsSchema, groupBy, measure, matchThread, intervalsFilter, eventsFilter, topN, run }) =>
      safeToolWithLog(
        "correlate",
        { sessionId, intervalsSchema, eventsSchema, groupBy, measure, matchThread, intervalsFilter, eventsFilter, topN, run },
        async () => {
          const result = await correlate(sessionId, intervalsSchema, eventsSchema, {
            run, groupBy, measure, matchThread, intervalsFilter, eventsFilter, topN,
          });
          const topKey = result.groups[0]?.key ?? null;
          const actions = [
            {
              tool: "query",
              args: { sessionId, schema: intervalsSchema, run: result.run, ...(topKey ? { filter: { [groupBy]: topKey } } : {}), limit: 20 },
              description: topKey
                ? `Read the individual "${topKey}" intervals to see specific rows.`
                : "Query the intervals schema directly.",
            },
            {
              tool: "query",
              args: { sessionId, schema: eventsSchema, run: result.run, limit: 20 },
              description: "Read the individual events to see specific rows.",
            },
          ];
          return text(toMcpText(envelope(result, actions)));
        }
      )
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
        "`run` defaults to the most recent run. " +
        "⚠️ Not for schemas without backtrace columns — only works on sample-based instruments like time-profile.",
      inputSchema: {
        sessionId: z.string().describe("The sessionId returned by open_trace."),
        schema: z
          .string()
          .describe("Schema with tagged-backtrace column. Use 'time-profile' for Time Profiler."),
        run: z.number().int().optional().describe("Run number. Optional — defaults to the most recent run."),
        thread: z
          .string()
          .optional()
          .describe("Substring filter on thread fmt (e.g. 'MyApp' or '0x25cc66') to scope to one thread."),
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
        position: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "1-based instance to pick when this schema appears more than once in the run. " +
            "Omit on the first try — an ambiguous-schema error will list the instances if needed."
          ),
      },
    },
    async ({ sessionId, schema, run, thread, timeRange, maxDepth, topN, position }) =>
      safeToolWithLog("call_tree", { sessionId, schema, run, thread, timeRange, maxDepth, topN, position }, async () => {
        const result = await callTree(sessionId, schema, { run, thread, timeRange, maxDepth, topN, position });
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
        "follow-up get_row calls. Lens-specific finders like find_fm_requests are preset predicates " +
        "built on top of this tool. `run` defaults to the most recent run. " +
        "⚠️ Not for counting or grouping — use aggregate for that.",
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
        position: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "1-based instance to pick when this schema appears more than once in the run. " +
            "Omit on the first try — an ambiguous-schema error will list the instances if needed."
          ),
      },
    },
    async ({ sessionId, schema, run, where, columns, sort, timeRange, limit, offset, position }) =>
      safeToolWithLog("find", { sessionId, schema, run, where, columns, sort, timeRange, limit, offset, position }, async () => {
        const result = await findRows(sessionId, schema, {
          run, where, columns, sort, timeRange, limit, offset, position,
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
        "`run` is optional and defaults to the most recent run. " +
        "⚠️ Not for scanning many rows in bulk — use query or find for that.",
      inputSchema: {
        sessionId: z.string().describe("The sessionId returned by open_trace."),
        schema: z.string().describe("Schema/table name."),
        rowIndex: z
          .number()
          .int()
          .min(0)
          .describe("Raw table index (`tableIndex` from query results, 0-based)."),
        run: z.number().int().optional().describe("Run number. Optional — defaults to the most recent run."),
        position: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "1-based instance to pick when this schema appears more than once in the run. " +
            "Omit on the first try — an ambiguous-schema error will list the instances if needed."
          ),
      },
    },
    async ({ sessionId, schema, rowIndex, run, position }) =>
      safeToolWithLog("get_row", { sessionId, schema, rowIndex, run, position }, async () => {
        const result = await getRow(sessionId, schema, rowIndex, { run, position });
        const hasBacktrace = Object.values(result.cells).some(
          (c) => c?.backtrace !== undefined
        );
        const response = envelope(
          result,
          [
            ...actionsAfterGetRow(sessionId, schema, result.run, rowIndex, result.totalRows, hasBacktrace),
            ...registry.nextActions(sessionId, schema, result.run, result.cells),
          ]
        );
        return text(toMcpText(response));
      })
  );

  // ── list_traces ───────────────────────────────────────────────────────────
  server.registerTool(
    "list_traces",
    {
      title: "List Traces",
      description:
        "List all .trace bundles found across built-in Xcode directories and " +
        "user-configured search roots, sorted newest first. " +
        "Use this to discover available traces before opening one. " +
        "Returns path, name, modification time, and which root each trace was found in. " +
        "If no traces are found, the response includes a hint to add a search root. " +
        "Prefer find_trace when the user describes a specific trace in natural language — " +
        "it scores by keyword overlap and recency.",
      inputSchema: {},
    },
    async () =>
      safeToolWithLog("list_traces", {}, async () => {
        const result = await listTraces();
        return text(JSON.stringify(result, null, 2));
      })
  );

  // ── find_trace ────────────────────────────────────────────────────────────
  server.registerTool(
    "find_trace",
    {
      title: "Find Trace",
      description:
        "Find a .trace bundle by natural-language description — e.g. " +
        '"my last Foundation Models run", "the time profile from this morning", ' +
        '"newest trace". ' +
        "Scans the same roots as list_traces, ranks by keyword overlap with the " +
        "bundle name, tiebroken by recency. Words like last/latest/recent rank " +
        "purely by modification time. Returns up to 10 matches with paths ready " +
        "to pass to open_trace. " +
        "⚠️ Not for opening a trace — pass the returned path to open_trace.",
      inputSchema: {
        query: z.string().describe('Natural-language description of the trace, e.g. "Foundation Models" or "last recording".'),
      },
    },
    async ({ query }) =>
      safeToolWithLog("find_trace", { query }, async () => {
        const result = await findTrace(query);
        return text(JSON.stringify(result, null, 2));
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
        "survives subprocess restarts. Use list_search_roots to see current roots. " +
        "⚠️ Not for opening a trace — use open_trace with the path you want to load.",
      inputSchema: {
        path: z.string().describe("Absolute or ~ path to a directory containing .trace files."),
      },
    },
    async ({ path: rawPath }) =>
      safeToolWithLog("add_search_root", { path: rawPath }, async () => {
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
        "path is not currently a root. Use list_search_roots to confirm. " +
        "⚠️ Not for deleting trace files — only removes the directory from the search index; " +
        "the .trace files on disk are untouched.",
      inputSchema: {
        path: z.string().describe("Path to remove (must match exactly as stored — use list_search_roots to see stored values)."),
      },
    },
    async ({ path: rawPath }) =>
      safeToolWithLog("remove_search_root", { path: rawPath }, async () => {
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
      safeToolWithLog("list_search_roots", {}, async () => {
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

  // ── list_processes ────────────────────────────────────────────────────────
  server.registerTool(
    "list_processes",
    {
      title: "List Processes",
      description:
        "Find running processes to attach a recording to. " +
        "Pass a search term (app name, bundle ID substring, or path fragment) to filter results. " +
        "Omit search to list all user-owned non-system processes. " +
        "Returns PID and command path — pass the PID or bare app name to the attach parameter of start_recording.",
      inputSchema: {
        search: z
          .string()
          .optional()
          .describe(
            "Filter by name or path substring, e.g. \"MyApp\" or \"com.example\". " +
            "Omit to list all user processes."
          ),
      },
    },
    async ({ search }) =>
      safeToolWithLog("list_processes", { search }, async () => {
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const { userInfo } = await import("node:os");
        const execFileAsync = promisify(execFile);

        let lines: string[];

        if (search) {
          // pgrep -f matches against the full command line; -l lists PID + command.
          // Exit code 1 means no matches — not an error.
          let raw = "";
          try {
            const out = await execFileAsync("pgrep", ["-fl", search]);
            raw = out.stdout;
          } catch (err: unknown) {
            const e = err as { code?: number; stdout?: string };
            if (e.code === 1) raw = ""; // no matches
            else throw err;
          }
          lines = raw
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean)
            // strip xctrace and this server process from results
            .filter((l) => !l.includes("xctrace") && !l.includes("instruments-mcp-server"));
        } else {
          // List all processes owned by the current user, skipping OS internals.
          const me = userInfo().username;
          const { stdout } = await execFileAsync("ps", ["-axo", "pid,user,args"]);
          const SYSTEM_PREFIXES = ["/System/", "/usr/", "/sbin/", "/bin/", "sysmond", "launchd"];
          lines = stdout
            .split("\n")
            .slice(1) // skip header
            .filter((l) => {
              const cols = l.trim().split(/\s+/);
              const user = cols[1];
              const cmd = cols.slice(2).join(" ");
              return (
                user === me &&
                !SYSTEM_PREFIXES.some((p) => cmd.startsWith(p)) &&
                !cmd.includes("xctrace") &&
                !cmd.includes("instruments-mcp-server")
              );
            })
            .map((l) => l.trim())
            .filter(Boolean);
        }

        const processes = lines.map((l) => {
          const spaceIdx = l.indexOf(" ");
          const pid = l.slice(0, spaceIdx).trim();
          const command = l.slice(spaceIdx + 1).trim();
          // Extract the bare executable name for easy use as an attach value.
          const name = command.split("/").pop()?.split(" ")[0] ?? command;
          return { pid: Number(pid), name, command };
        });

        return text(
          JSON.stringify(
            {
              count: processes.length,
              processes,
              hint: processes.length > 0
                ? "Pass pid (number) or name (string) to the attach parameter of start_recording."
                : search
                ? `No processes matched "${search}". Try a shorter search term.`
                : "No user processes found.",
            },
            null,
            2
          )
        );
      })
  );

  // ── Recording lifecycle ───────────────────────────────────────────────────
  //
  // start_recording spawns xctrace in the background and returns a recordingId
  // immediately. Interact with the app, then call stop_recording to finalize.
  // stop_recording sends SIGINT for graceful finalization and auto-opens the
  // resulting trace so the next action is list_instruments.

  // Derive the type enum directly from RECORDING_INTENTS so adding a new intent
  // there is the only change needed — this file never needs to be updated.
  const intentKeys = Object.keys(RECORDING_INTENTS) as [string, ...string[]];
  const intentDescriptions = Object.entries(RECORDING_INTENTS)
    .map(([k, v]) => `"${k}" → ${v.label}`)
    .join(", ");

  const INTERACTIVE_RECORD_INPUTS = {
    type: z
      .enum(intentKeys)
      .optional()
      .describe(
        `Which Instruments template to record with. Options: ${intentDescriptions}. ` +
        "Optional if `template` is given instead — required otherwise."
      ),
    instruments: z
      .array(z.string())
      .optional()
      .describe(
        "Extra instruments to compose on top of the base template via repeated " +
        "`--instrument <name>` (e.g. [\"SwiftUI\"] on type: \"core-data\" to attribute " +
        "SwiftData fetches/faults to the SwiftUI update that triggered them — get_row on " +
        "the resulting core-data-fetch/fault row will show the full resolved call stack " +
        "including the triggering SwiftUI frame). Names must match `xcrun xctrace list " +
        "instruments` exactly, e.g. \"SwiftUI\", \"Data Fetches\", \"Network\"."
      ),
    template: z
      .string()
      .optional()
      .describe(
        "Raw `--template <name|path>` override for a custom or uncurated template `type` " +
        "doesn't cover. Overrides the base template while keeping type's other behavior " +
        "(privacy notice, launchRequired) when both are given. Provide this OR `type` — " +
        "one of the two is required."
      ),
    attach: z
      .string()
      .optional()
      .describe("PID or process name of a running process to attach to."),
    launch: z
      .string()
      .optional()
      .describe("Absolute path to the app bundle (.app) to launch and profile."),
    timeLimit: z
      .string()
      .optional()
      .describe('Optional cap, e.g. "30s", "2m". Omit for open-ended (stop via stop_recording).'),
    device: z
      .string()
      .optional()
      .describe("Target device name or UDID. Omit for host Mac."),
  };

  // ── start_recording ─────────────────────────────────────────────────────────
  server.registerTool(
    "start_recording",
    {
      title: "Start Recording (interactive)",
      description:
        "Spawn an Instruments recording in the background and return a recordingId. " +
        "Use stop_recording(recordingId) to finalize — xctrace receives SIGINT so it " +
        "flushes data and writes a valid .trace. Then pass the tracePath to open_trace.\n\n" +
        "For time-limited recordings, set timeLimit and the process auto-stops; " +
        "stop_recording still works (it will see the recording is already done).\n\n" +
        "Pass `instruments` to compose extra instruments onto `type`'s base template " +
        "(e.g. cross-instrument causation questions like \"did this SwiftUI update cause " +
        "this SwiftData fetch\"), or `template` for a fully custom/uncurated template.\n\n" +
        'Use list_instruments after opening to see which schemas are available, ' +
        "then describe_schema on any schema to learn its columns before querying. " +
        "⚠️ Not for opening an existing .trace file — use open_trace instead.",
      inputSchema: INTERACTIVE_RECORD_INPUTS,
    },
    async ({ type, instruments, template, attach, launch, timeLimit, device }) =>
      safeToolWithLog("start_recording", { type, instruments, template, attach, launch, timeLimit, device }, async () => {
        if (type === undefined && template === undefined) {
          return text(
            JSON.stringify({
              error: "one of `type` or `template` is required",
              hint: `Pass type (one of: ${intentKeys.join(", ")}) or a raw template name/path.`,
            })
          );
        }
        const intent =
          type !== undefined
            ? RECORDING_INTENTS[type as keyof typeof RECORDING_INTENTS]
            : { label: template!, template: template!, launchRequired: false };
        const result = await startSession({ intent, instruments, template, attach, launch, device, timeLimit });
        return text(
          JSON.stringify(
            {
              ...result,
              nextAction: "stop_recording",
              nextArgs: { recordingId: result.recordingId },
              hint: "Interact with the app, then call stop_recording to finalize and get the .trace path.",
            },
            null,
            2
          )
        );
      })
  );

  // ── stop_recording ──────────────────────────────────────────────────────────
  server.registerTool(
    "stop_recording",
    {
      title: "Stop Recording",
      description:
        "Finalize an interactive recording by sending SIGINT to xctrace. " +
        "xctrace flushes buffered data and exits cleanly before this call returns. " +
        "Returns the .trace path — pass it to open_trace to start navigating results. " +
        "Safe to call on a time-limited recording that has already auto-stopped. " +
        "⚠️ Not for checking status without stopping — use get_recording_status for non-destructive polling.",
      inputSchema: {
        recordingId: z
          .string()
          .describe("The recordingId returned by start_recording."),
      },
    },
    async ({ recordingId }) =>
      safeToolWithLog("stop_recording", { recordingId }, async () => {
        const result = await stopSession(recordingId);
        const opened = await tryOpenTrace(result.tracePath);
        const sessionId = "session" in opened ? opened.session.sessionId : undefined;
        return text(
          JSON.stringify(
            {
              ...result,
              ...opened,
              nextAction: sessionId ? "list_instruments" : "open_trace",
              nextArgs: sessionId ? { sessionId } : { path: result.tracePath },
            },
            null,
            2
          )
        );
      })
  );

  // ── get_recording_status ────────────────────────────────────────────────────
  server.registerTool(
    "get_recording_status",
    {
      title: "Get Recording Status",
      description:
        "Check the current status of an interactive recording without stopping it. " +
        'Status values: "recording" (in progress), "finalizing" (SIGINT sent, flushing), ' +
        '"done" (finished cleanly — call open_trace), "failed" (non-zero exit). ' +
        "Useful for polling time-limited recordings to know when they auto-complete. " +
        "⚠️ Not for stopping a recording — use stop_recording to finalize and get the .trace path.",
      inputSchema: {
        recordingId: z
          .string()
          .describe("The recordingId returned by start_recording."),
      },
    },
    async ({ recordingId }) =>
      safeToolWithLog("get_recording_status", { recordingId }, async () => {
        const result = getRecordingStatus(recordingId);
        const isDone = result.status === "done" || result.status === "failed";
        return text(
          JSON.stringify(
            {
              ...result,
              ...(isDone
                ? { nextAction: "open_trace", nextArgs: { path: result.tracePath } }
                : { nextAction: "stop_recording", nextArgs: { recordingId } }),
            },
            null,
            2
          )
        );
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`${SERVER_NAME} failed to start:`, err);
    process.exit(1);
  });
}
