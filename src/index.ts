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
import { listDevices } from "./core/listDevices.js";
import { queryTable } from "./core/query.js";
import { getRow } from "./core/getRow.js";
import { aggregateTable } from "./core/aggregate.js";
import { correlate } from "./core/correlate.js";
import { relate } from "./core/relate.js";
import { timeline } from "./core/timeline.js";
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
import thermalLens from "./lenses/thermal/index.js";
import { getConfig, updateConfig, configPath, defaultFallbackCacheDir } from "./config.js";
import { getServerInfo } from "./core/serverInfo.js";
import { listTraces, findTrace } from "./core/discovery.js";
import {
  RECORDING_INTENTS,
  tryOpenTrace,
  resolveTemplateName,
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
  withRecommended,
} from "./core/response.js";
import type { NextAction } from "./core/response.js";
import { eagerSweep } from "./detectors/surface.js";

const SERVER_NAME = "instruments-mcp-server";
const SERVER_VERSION = "0.1.0";

// ─── Heap guard ─────────────────────────────────────────────────────────────
//
// As of PMT:gravel-cape, session.tableCache holds a lightweight
// SqliteTableHandle (column metadata + a row count), not a fully-parsed
// table — ingested rows live in an on-disk SQLite DB, not this process's
// heap (see howSessionsWork.md's "Large-table hardening" section). This
// ceiling is still real insurance, not dead weight: ref/id resolution
// caches (RefCache, binaryCache, frameCache) are still retained per-parse,
// column-role classification and response serialization still need
// headroom, and query/aggregate/find/get_row/call_tree (once PMT:dusk-floe/
// PMT:elm-swamp rewire them to read via SQL) will still process real
// result sets in memory — just bounded by result size now, not table size.
// Re-exec with a larger heap if the launch config (Xcode's MCP
// registration, `claude mcp add`, etc.) didn't already request one, rather
// than requiring every possible launcher to know to pass this flag.
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
  thermalLens,
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
/**
 * Always-loaded, once-per-session usage guidance — the MCP protocol's
 * top-level `instructions` field (returned in `initialize`, distinct from any
 * one tool's description). This is the right layer for the SHAPE of a whole
 * session across many tool calls, not any single tool's own behavior — see
 * `aidocs/howHintsWork.md`'s proactive/reactive split. Concretely: an agent
 * that opens a trace, answers the question, and stops has no natural signal
 * telling it the session is "done" (no tool response can know that), so this
 * can't be fixed with a `nextAction` hint the way most workflow steps are —
 * it has to be stated up front instead.
 */
const SERVER_INSTRUCTIONS =
  "Two standard workflows, both ending in close_trace:\n\n" +
  "1. Record a new trace: start_recording → exercise the app (or ask the user to) → " +
  "stop_recording (this auto-opens the resulting trace and returns a sessionId, so you can " +
  "go straight into analysis) → analyze via list_instruments/describe_schema/query/aggregate/" +
  "get_row/call_tree/find/relate/correlate/timeline and any per-instrument lens tools, following " +
  "each response's nextActions (one entry is flagged `recommended: true` when a lens has a strong " +
  "pick for this trace — the rest are plain alternatives, not a ranking) → close_trace once you " +
  "have your answer.\n\n" +
  "2. Analyze an existing trace: open_trace → analyze (same verbs) → close_trace once you " +
  "have your answer.\n\n" +
  "Don't stop at one schema in isolation — many real findings only show up by JOINING schemas. " +
  "If a question is exploratory (\"what actually happened, in order, across subsystems, around " +
  "this event\"), use timeline() to merge 2+ schemas into one time-ordered stream before forming a " +
  "hypothesis. Once you have a specific hypothesis (\"does this interval CONTAIN that event\", " +
  "\"was this allocation ever freed\", \"is there a stretch with NO activity\"), use relate() (or its " +
  "friendlier correlate() preset) to confirm/quantify it over the full population, not just the " +
  "window you happened to look at. A schema with no backtrace/thread/process column of its own " +
  "(Leaks/Leaks, Hangs, Thermal State) almost always needs a join into a companion schema to answer " +
  "WHY, not just WHEN — check each response's nextActions for one already suggested before assuming " +
  "a single-schema query is the whole answer.\n\n" +
  "Always call close_trace when you're done analyzing a session, even if nothing prompts you " +
  "to. Sessions are cached for the life of the server process and are never evicted " +
  "automatically — an agent that opens a trace, answers the question, and stops without " +
  "closing leaves it (and any large tables it loaded) resident in memory indefinitely. See " +
  "close_trace's own description for when it's safe to call.";

export function createServer(): McpServer {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    { instructions: SERVER_INSTRUCTIONS }
  );

  registry.registerAll(LENSES, server);

  // ── server_info ─────────────────────────────────────────────────────────────
  server.registerTool(
    "server_info",
    {
      title: "Server Info",
      description:
        "Report which build of this MCP server process is actually running — call this if a " +
        "call is taking far longer than expected, or before relying on a just-shipped fix. Node " +
        "doesn't hot-reload: a long-lived server process keeps executing whatever code was in " +
        "memory when it started, even after `npm run build` writes newer code to dist/ or a new " +
        "commit lands. Compare `distBuildTime` (on-disk mtime of the running code — the ground " +
        "truth for what's actually loaded) and `processStartedAt` against when a known fix was " +
        "built/committed; if the process started before that, it's running stale code and needs " +
        "to be restarted by whatever spawned it (this server can't restart itself). `gitCommit`/" +
        "`gitDirty` are best-effort (null outside a git checkout, e.g. a published npm install) " +
        "and reflect the repo at process startup — useful for cross-referencing a specific " +
        "commit hash, not authoritative on their own if commits happened without a rebuild. " +
        "⚠️ Not for checking trace or session state — that's summary/list_instruments. Not for " +
        "polling an in-flight call's progress — this reports the server's own build, not what a " +
        "currently-running tool call is doing.",
      inputSchema: {},
    },
    async () =>
      safeToolWithLog("server_info", {}, async () => {
        return text(toMcpText(envelope(getServerInfo(), [])));
      })
  );

  // ── open_trace ─────────────────────────────────────────────────────────────
  server.registerTool(
    "open_trace",
    {
      title: "Open Trace",
      description:
        "Load an Instruments .trace file and return a sessionId for subsequent calls. " +
        "The trace is loaded once and cached — all later tools reuse this session. " +
        "Returns runs with `recordedAt` timestamps so the agent can identify 'the run I just created'; " +
        "instruments (schemas); and, in `nextActions`, one entry flagged `recommended: true` when a " +
        "lens recognises the trace type, or a detector fired over a small eager-ingested set of bounded " +
        "schemas (so even a cold trace surfaces a real finding, not just navigational defaults) — follow " +
        "it to reach first real data in 2 calls total; the rest of `nextActions` are unranked " +
        "alternatives. Also returns `schemaInventory`, one line per schema present (warm/estimated size, " +
        "kind, detector result, correlate hint) so the agent can reason over the full trace without " +
        "opening every schema, plus `sweepNote` summarizing what the eager sweep checked (present even " +
        "when nothing fired — a clean sweep is direction, not silence). " +
        "Always call this first. Call close_trace on this sessionId once you're done analyzing — " +
        "sessions are never evicted automatically, so nothing else will free it. " +
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
        // PMT:spare-goat: a lens's quickStart becomes the single `recommended:
        // true` nextAction (was a separate `suggestedStart` payload field that
        // duplicated the top of nextActions) — one ranked list, not two
        // overlapping fields to reconcile.
        const quickStart = registry.quickStart(lastRunSchemas, result.sessionId, lastRunNum);
        const quickStartAction: NextAction | null = quickStart
          ? { tool: quickStart.tool, args: quickStart.args, description: quickStart.hint }
          : null;
        // PMT:ruddy-elk: eager-ingest a curated bounded-schema allowlist (so a
        // cold trace has something to fire on, not just a re-opened one whose
        // tables the .db already held) and sweep EVERY detector — cheap AND
        // expensive — whose schemas are now ingested. A FIRED finding becomes
        // the single `recommended` pick, demoting the navigational quickStart
        // to a plain alternative; nothing fired (or nothing eager-ingestible
        // was present) → quickStart stays recommended (unchanged).
        const sweep = await eagerSweep(result.sessionId);
        const recommended: NextAction | null = sweep.recommended ?? quickStartAction;
        const alternatives: NextAction[] = sweep.recommended
          ? [...sweep.alternatives, ...(quickStartAction ? [quickStartAction] : []), ...actionsAfterOpen(result.sessionId)]
          : actionsAfterOpen(result.sessionId);
        const payload = {
          ...result,
          ...(versionWarning && { versionWarning }),
          schemaInventory: sweep.inventory,
          ...(sweep.sweepNote ? { sweepNote: sweep.sweepNote } : {}),
        };
        const response = envelope(payload, withRecommended(recommended, alternatives));
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
        "Returns schema names, row counts, schema documentation, " +
        "and a crossRunDiff note when runs differ — e.g. 'run 3 adds: time-sample, context-switch-sample'. " +
        "rowCount is `null` until that table is actually fetched (via query/aggregate/find/get_row), " +
        "then becomes a real number — `0` means genuinely fetched and confirmed empty, not unfetched; " +
        "don't read `null` as \"no rows\". " +
        "Cheap: no xctrace calls. " +
        "Use this when open_trace's nextActions had no entry flagged recommended, when you need cross-run comparison, " +
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

  // ── list_devices ─────────────────────────────────────────────────────────────
  server.registerTool(
    "list_devices",
    {
      title: "List Devices",
      description:
        "List recordable targets — the host Mac, physical iOS devices, and booted/shutdown Simulators — " +
        "so you can pick a `device` value for start_recording (by name or UDID) instead of knowing a UDID out-of-band. " +
        "Each entry carries kind (mac/device/simulator), os, and state (online/offline/booted/shutdown). " +
        "LIVE: runs `xctrace list devices` FRESH on every call — never cached — so if a device was offline and the dev " +
        "just plugged it in, unlocked it, and trusted this Mac, simply call again to see it come online. " +
        "An OFFLINE physical device is recoverable (connect + unlock + trust), not absent — the `note` says how. " +
        "⚠️ Not for listing a trace's instruments — that's list_instruments (a schema inventory of an already-open trace).",
      inputSchema: {},
    },
    async () =>
      safeToolWithLog("list_devices", {}, async () => {
        const result = await listDevices();
        return text(toMcpText(envelope(result, [])));
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
        "`nestedFields` lists queryable nested scalar values as dot-paths (e.g. " +
        "\"thread.process.pid\" to filter/group by process) — usable anywhere a " +
        "mnemonic is; it populates once the schema has been queried at least once. " +
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
        "timeRange window, sort, pagination, and a per-row window function (running total, " +
        "inter-arrival delta, rank). Returns summary rows (formatted display values — no raw " +
        "numbers or backtrace frames). Use `window` to answer growth-over-time (\"running-total\" " +
        "of a size/weight column) or storm-detection (\"delta\" between consecutive timestamps — " +
        "tiny gaps next to each other mean temporal clustering, not just a high count) questions in " +
        "one call instead of hand-accumulating across pages. Use get_row for full detail on a " +
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
          .describe("Equality filter: { field: value }. Rows must match ALL entries. Values compared against fmt (display) and raw. A field is a column mnemonic OR a nested dot-path (e.g. \"thread.process.pid\" to filter by process) — see describe_schema.nestedFields for the available nested paths."),
        columns: z
          .array(z.string())
          .optional()
          .describe("Fields to include — column mnemonics and/or nested dot-paths. Omit for all columns."),
        timeRange: z
          .object({
            startNs: z.number().optional().describe("Earliest timestamp (nanoseconds, inclusive)."),
            endNs: z.number().optional().describe("Latest timestamp (nanoseconds, inclusive)."),
          })
          .optional()
          .describe("Restrict rows to a time window. Applied to the primary time column for this schema."),
        sort: z
          .object({
            by: z.string().describe("Field to sort by — a column mnemonic or a nested dot-path."),
            dir: z.enum(["asc", "desc"]).optional().describe("Sort direction. Default: asc."),
          })
          .optional()
          .describe("Sort rows by a column value."),
        limit: z.number().int().min(1).max(500).optional().describe("Rows to return (default 20, max 500)."),
        offset: z.number().int().min(0).optional().describe("Rows to skip for pagination (default 0)."),
        window: z
          .object({
            op: z.enum(["running-total", "delta", "rank", "row-number"]).describe(
              "\"running-total\": cumulative sum of `measure` in `orderBy` order (a growth-over-time curve — requires measure). " +
              "\"delta\": this row's value minus the previous row's in `orderBy` order (inter-arrival time when orderBy is a time column) — diffs `measure` if given, else `orderBy` itself; tiny deltas next to each other reveal temporal clustering (a \"storm\"), not just a high count. " +
              "\"rank\"/\"row-number\": position within the partition, ordered by `orderBy`."
            ),
            orderBy: z.string().describe("Field that orders the window — a column mnemonic or nested dot-path, usually a time column."),
            partitionBy: z.string().optional().describe("Field to partition/reset the window by (e.g. a label or thread column) — a column mnemonic or nested dot-path."),
            measure: z.string().optional().describe("Field to accumulate (running-total) or diff (delta) — a column mnemonic or nested dot-path. Required for running-total; optional for delta (defaults to orderBy); ignored for rank/row-number."),
          })
          .optional()
          .describe(
            "Compute a per-row window function value (running total, inter-arrival delta, rank, or row-number), added as each row's `window` field. Computed over the FULL filtered set before limit/offset, so a running total stays correct across pages. When set with no explicit `sort`, rows default to ordering by `window.orderBy` ascending."
          ),
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
    async ({ sessionId, schema, run, filter, columns, timeRange, sort, limit, offset, window, position }) =>
      safeToolWithLog("query", { sessionId, schema, run, filter, columns, timeRange, sort, limit, offset, window, position }, async () => {
        const result = await queryTable(sessionId, schema, { run, filter, columns, timeRange, sort, limit, offset, window, position });
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
        "Group rows by any label or thread column (or several, for a composite key) and aggregate a " +
        "weight column by sum/count/avg/min/max/median/p50/p90/p95/p99 — the workhorse for most " +
        "profiling questions. Returns the top N groups sorted heaviest-first with values formatted " +
        "in the correct unit (s/ms/µs, MB/KB/B, count). " +
        "Examples: top threads by sample count (Time Profiler), total duration per agent " +
        "(Foundation Models), largest allocation groups, p95/p99 hitch duration for a real " +
        "distribution instead of just min/max/sum. Pass an array to `groupBy` for a composite key " +
        "(e.g. [\"view-name\", \"thread\"] for \"hot view broken down by thread\") — a row is excluded " +
        "if ANY groupBy field is null for it. Use `having` to filter to only the groups that matter " +
        "(e.g. minRowCount to find storms/hotspots — many occurrences of the same thing — not just " +
        "the single heaviest group). A `note` fires if the top group's key is " +
        "empty — a plausible-looking but wrong result on schemas that split row identity across " +
        "more than one column by row type (e.g. swiftui-updates); try a different groupBy. Also " +
        "fires on a handful of schemas (e.g. hitches-renders' frame-color) whose groupBy column is " +
        "a verified overlapping label, not a partition — sum/avg across it double-counts. " +
        "`run` defaults to the most recent run. " +
        "⚠️ Not for reading individual rows — use query or find to access specific rows.",
      inputSchema: {
        sessionId: z.string().describe("The sessionId returned by open_trace."),
        schema: z.string().describe("Schema/table name."),
        groupBy: z
          .union([z.string(), z.array(z.string())])
          .describe(
            "Field(s) to group by (typically a label or thread column) — a column mnemonic or a nested " +
            "dot-path (e.g. \"thread.process.pid\" to group by process; see describe_schema.nestedFields). " +
            "Pass an array for a composite key across several fields (e.g. [\"view-name\",\"thread\"])."
          ),
        measure: z
          .string()
          .optional()
          .describe("Weight field to aggregate — a column mnemonic or nested dot-path. Required for every op except count; ignored for count."),
        op: z
          .enum(["sum", "count", "avg", "min", "max", "median", "p50", "p90", "p95", "p99"])
          .optional()
          .describe(
            "Aggregation operation (default: sum). The percentile ops (p50/p90/p95/p99, median = p50 " +
            "alias) return an ACTUAL observed value via nearest-rank, not an interpolated number — use " +
            "these for a real distribution (\"what's the worst-case hitch, ignoring one outlier\") instead " +
            "of only ever seeing min/max/sum."
          ),
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
          .describe("Pre-filter rows before grouping: { field: value } (field = mnemonic or nested dot-path)."),
        timeRange: z
          .object({
            startNs: z.number().optional(),
            endNs: z.number().optional(),
          })
          .optional()
          .describe("Restrict to a time window (nanoseconds) before grouping."),
        having: z
          .object({
            minValue: z.number().optional().describe("Keep only groups whose computed value is at least this."),
            maxValue: z.number().optional().describe("Keep only groups whose computed value is at most this."),
            minRowCount: z.number().optional().describe("Keep only groups with at least this many rows — e.g. minRowCount:100 to find storms/hotspots, not just the single heaviest occurrence."),
            maxRowCount: z.number().optional().describe("Keep only groups with at most this many rows."),
          })
          .optional()
          .describe("Post-aggregation filter on each group's computed value or row count, applied before topN."),
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
    async ({ sessionId, schema, groupBy, measure, op, topN, run, filter, timeRange, having, position }) =>
      safeToolWithLog("aggregate", { sessionId, schema, groupBy, measure, op, topN, run, filter, timeRange, having, position }, async () => {
        const result = await aggregateTable(sessionId, schema, {
          run, groupBy, measure, op, topN, filter, timeRange, having, position,
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
        "pass matchThread:false to correlate on time alone (weaker evidence). A " +
        "threadMismatchWarning field flags when matchThread:true finds zero matches despite " +
        "temporal candidates existing — historically caused by picking the wrong thread-role " +
        "column on a schema exposing more than one (e.g. process vs thread), now resolved " +
        "generically, but the warning stays as a safety net for any future case. Grouped by an " +
        "intervals-schema label column (e.g. view-name) so the result reads as a direct " +
        "answer — 'SidebarView.body contained 445 Feature fetches' — not a raw per-interval " +
        "dump. Both schemas must already be in the SAME trace on the SAME clock — use " +
        "start_recording's `instruments` param to compose them into one recording; two " +
        "separate recordings can never be correlated this way. Points of Interest's signpost " +
        "schemas (os-signpost, OSSignpostIntervals, PointsOfInterestEvents) pair especially " +
        "well here if the app calls os_signpost around its own operations — correlate them " +
        "against whatever's being investigated to see which named app operation was active. " +
        "Pass timeRange to narrow both schemas to a window BEFORE fetching — real streaming " +
        "narrowing (discarded during the parse, not after), the difference between a fast call " +
        "and a full materialization on a huge intervals schema like swiftui-updates. " +
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
        timeRange: z
          .object({
            startNs: z.number().optional().describe("Earliest timestamp (nanoseconds, inclusive)."),
            endNs: z.number().optional().describe("Latest timestamp (nanoseconds, inclusive)."),
          })
          .optional()
          .describe(
            "Restrict both schemas to a time window before fetching. Applied to each schema's " +
            "own primary time column. A raw start/duration/timestamp value read from any other " +
            "schema's row is directly usable here with no conversion."
          ),
        run: z.number().int().optional().describe("Run number. Optional — defaults to the most recent run."),
      },
    },
    async ({ sessionId, intervalsSchema, eventsSchema, groupBy, measure, matchThread, intervalsFilter, eventsFilter, topN, timeRange, run }) =>
      safeToolWithLog(
        "correlate",
        { sessionId, intervalsSchema, eventsSchema, groupBy, measure, matchThread, intervalsFilter, eventsFilter, topN, timeRange, run },
        async () => {
          const result = await correlate(sessionId, intervalsSchema, eventsSchema, {
            run, groupBy, measure, matchThread, intervalsFilter, eventsFilter, topN, timeRange,
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

  // ── relate ────────────────────────────────────────────────────────────────
  server.registerTool(
    "relate",
    {
      title: "Relate Two Schemas (generic join)",
      description:
        "Join rows of schema A against schema B to answer four cross-instrument questions from two " +
        "knobs — joinCondition (how A and B match) × polarity (whether you want matches or non-matches):\n" +
        "  • equality + not-exists → LEAK: A rows (e.g. allocations) with NO matching B row (e.g. a free) — on:[{a:\"address\",b:\"address\"}]\n" +
        "  • equality + exists → A rows that DID have a match (e.g. allocations that were freed)\n" +
        "  • time-range + not-exists → an A interval with NO B event inside it (idle / GPU-bound window)\n" +
        "  • time-range + exists → causality: an A interval that CONTAINS B events — this is what the friendlier `correlate` tool presets\n" +
        "Groups A rows by an A label column; per group reports how many A rows matched vs didn't, total match " +
        "multiplicity, and a measure sum (over matched B for exists, over unmatched A for not-exists, e.g. total " +
        "leaked bytes). Pass listRows:true to also get the actual matched/unmatched A rows (with their tableIndex " +
        "for get_row drill-down), not just counts. Both schemas must be in the SAME trace on the SAME clock. " +
        "`run` defaults to the most recent run.\n" +
        "⚠️ Not for the common causality case — use `correlate`, the friendly time-range/exists preset with " +
        "interval/event vocabulary. ⚠️ Not for aggregating within ONE schema — use `aggregate`.",
      inputSchema: {
        sessionId: z.string().describe("The sessionId returned by open_trace."),
        schemaA: z.string().describe("The 'left' schema whose rows are classified as matched/unmatched (e.g. \"Allocations/Allocations List\")."),
        schemaB: z.string().describe("The 'right' schema searched for matches (e.g. a free/dealloc schema, or an events schema)."),
        joinCondition: z.enum(["equality", "time-range"]).describe(
          "\"equality\": A and B match on shared key column(s) via `on`. \"time-range\": B's timestamp falls inside A's [start, start+duration] window."
        ),
        polarity: z.enum(["exists", "not-exists"]).describe(
          "\"exists\": A rows WITH a match. \"not-exists\": A rows with NO match (the anti-join — leaks, idle windows)."
        ),
        groupBy: z.string().describe("Mnemonic of an schemaA label column to group results by."),
        on: z.array(z.object({ a: z.string(), b: z.string() }))
          .optional()
          .describe("equality only (required): A↔B column pairs to match on (AND semantics), e.g. [{a:\"address\", b:\"address\"}]."),
        matchThread: z.boolean().optional().describe(
          "time-range only: require the matched B row to be on the same thread as A (default true; the discriminator that turns temporal overlap into provable causation)."
        ),
        measure: z.string().optional().describe(
          "A measure column to sum: on schemaB summed over matched pairs (exists), or on schemaA summed over the unmatched rows (not-exists, e.g. total leaked bytes)."
        ),
        aFilter: z.record(z.union([z.string(), z.number()])).optional().describe("Pre-filter schemaA before joining: { mnemonic: value }."),
        bFilter: z.record(z.union([z.string(), z.number()])).optional().describe("Pre-filter schemaB before joining: { mnemonic: value }."),
        timeRange: z.object({
          startNs: z.number().optional().describe("Earliest timestamp (nanoseconds, inclusive)."),
          endNs: z.number().optional().describe("Latest timestamp (nanoseconds, inclusive)."),
        }).optional().describe("Restrict both schemas to a time window on each's own primary time column."),
        topN: z.number().int().min(1).max(100).optional().describe("Max groups to return (default 10)."),
        listRows: z.boolean().optional().describe("Also return the actual matched (exists) / unmatched (not-exists) schemaA rows, with tableIndex for get_row drill-down."),
        listLimit: z.number().int().min(1).max(200).optional().describe("Max rows to return when listRows is set (default 20, max 200)."),
        run: z.number().int().optional().describe("Run number. Optional — defaults to the most recent run."),
      },
    },
    async ({ sessionId, schemaA, schemaB, joinCondition, polarity, groupBy, on, matchThread, measure, aFilter, bFilter, timeRange, topN, listRows, listLimit, run }) =>
      safeToolWithLog(
        "relate",
        { sessionId, schemaA, schemaB, joinCondition, polarity, groupBy, on, matchThread, measure, aFilter, bFilter, timeRange, topN, listRows, listLimit, run },
        async () => {
          const result = await relate(sessionId, schemaA, schemaB, {
            run, joinCondition, polarity, groupBy, on, matchThread, measure, aFilter, bFilter, timeRange, topN, listRows, listLimit,
          });
          const topKey = result.groups[0]?.key ?? null;
          const actions = [
            {
              tool: "query",
              args: { sessionId, schema: schemaA, run: result.run, ...(topKey ? { filter: { [groupBy]: topKey } } : {}), limit: 20 },
              description: topKey ? `Read the individual "${topKey}" ${schemaA} rows.` : `Query ${schemaA} directly.`,
            },
          ];
          return text(toMcpText(envelope(result, actions)));
        }
      )
  );

  // ── timeline ───────────────────────────────────────────────────────────────
  server.registerTool(
    "timeline",
    {
      title: "Timeline (time-ordered merge across schemas)",
      description:
        "Merge rows from 2+ schemas into ONE time-ordered stream, each row tagged with its origin schema — " +
        "\"what actually happened, in order, across subsystems\", the EXPLORATORY companion to `relate`/`correlate`'s " +
        "CONFIRMATORY \"did X cause Y\". Use timeline FIRST to see an interleaving and form a hypothesis " +
        "(e.g. \"an enqueue at 00:03.065 right before a view body eval at 00:03.067 — are these related?\"), then " +
        "`relate`/`correlate` to confirm/quantify containment over the full population. Each row is a compact " +
        "{origin, time, dur, label, rowId} projection — NOT full row detail; call get_row(schema: origin, " +
        "rowIndex: rowId) to drill into any one event. `dur` is populated only when a schema has a genuine " +
        "nanoseconds-shaped duration column (null for point events like signposts/log lines) — intervals and " +
        "instants sort together by start time. Requires a bounded `timeRange` (startNs and/or endNs) — this " +
        "is a lens over an indexed range scan per schema, not a free full-table merge; pick a window (e.g. " +
        "around a signpost or an event you already found) before calling. `run` defaults to the most recent run. " +
        "⚠️ Not for confirming causality/containment with a count — use `relate`/`correlate` for that. ⚠️ Not for " +
        "full row detail — this only returns the common merged fields, use get_row per event.",
      inputSchema: {
        sessionId: z.string().describe("The sessionId returned by open_trace."),
        schemas: z.array(z.string()).min(1).describe(
          "Schema names to merge (e.g. [\"swiftui-updates\", \"SwiftTaskCreationEvent\", \"core-data-fetch\"]) — like choosing lanes in the Instruments UI. Pick the schemas relevant to your hypothesis rather than merging everything (kdebug/tick-style schemas would flood the stream)."
        ),
        timeRange: z.object({
          startNs: z.number().optional().describe("Earliest timestamp (nanoseconds, inclusive)."),
          endNs: z.number().optional().describe("Latest timestamp (nanoseconds, inclusive)."),
        }).describe("Required — bounds the merge to a window. At least one of startNs/endNs must be set."),
        limit: z.number().int().min(1).max(1000).optional().describe("Max merged rows to return, in time order (default 100, max 1000)."),
        run: z.number().int().optional().describe("Run number. Optional — defaults to the most recent run."),
      },
    },
    async ({ sessionId, schemas, timeRange, limit, run }) =>
      safeToolWithLog("timeline", { sessionId, schemas, timeRange, limit, run }, async () => {
        const result = await timeline(sessionId, schemas, { run, timeRange, limit });
        const first = result.events[0];
        const actions = first
          ? [
              {
                tool: "get_row",
                args: { sessionId, schema: first.origin, run: result.run, rowIndex: first.rowId },
                description: `Fetch full detail for the first event (${first.origin}).`,
              },
              {
                tool: "relate",
                args: { sessionId, schemaA: first.origin, schemaB: schemas.find((s) => s !== first.origin) ?? schemas[0], joinCondition: "time-range", polarity: "exists", groupBy: "<mnemonic>", run: result.run },
                description: "Once you've spotted an interleaving here, confirm/quantify it with relate (containment/causality across the full population).",
              },
            ]
          : [
              {
                tool: "describe_schema",
                args: { sessionId, schema: schemas[0], run: result.run },
                description: "No events in this window — check the schemas' time ranges via describe_schema/list_instruments.",
              },
            ];
        return text(toMcpText(envelope(result, actions)));
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
        "Three views via `view`: \"tree\" (default) groups frames root-to-leaf with total/self weight, " +
        "sample count, and % of total, but truncates at maxDepth — a real hot frame can end up past the " +
        "cap with only childrenOmitted as a clue it's missing. \"hot\" instead returns a flat list of " +
        "functions ranked by self-time (with inclusive/total time alongside, for \"which subsystem " +
        "dominates\"), summed across every call site, immune to depth truncation — use this for \"where " +
        "did the time actually go\". \"spine\" returns the single heaviest root-to-leaf path with no depth " +
        "cap — deliberately compact (name/binary/%-of-total/%-of-parent only, no per-frame weight detail; " +
        "use \"hot\" for magnitude) since a GUI main-thread spine can run 100+ frames deep. A note fires " +
        "where %-of-parent first drops below 80% (the path stops being clearly dominant beyond that depth) " +
        "— use this for \"what's the one path that matters\" instead of manually re-deriving it from a " +
        "truncated tree. Both \"hot\" and \"spine\" flag known wait/blocking frames (isWait), but only when " +
        "that frame's OWN self-time dominates its own total — a wait-named frame with heavy children (e.g. " +
        "a run-loop callout doing real nested work) is a callout, not idle, so isWait is false there; a " +
        "true isWait means the thread was actually blocked, not CPU-bound, and Time Profiler shows the " +
        "wait but never what it's blocked on. \"spine\" also returns appCodeStartsAtDepth: on a main " +
        "thread the run-loop entry chain (NSApplicationMain → ... → RunCurrentEventLoopInMode → ...) is " +
        "mandatory scaffolding in every sample, idle or busy, so it carries no signal on its own — this " +
        "marks the depth where the sample's own distinguishing work actually starts (spine itself is " +
        "never trimmed, this is just a pointer into it). When timeRange is a window (both bounds set), " +
        "a note fires if the captured CPU time is far less than the window's own span — e.g. scoping to " +
        "a slow frame/hitch and getting back a sparse sample count does NOT mean nothing happened; the " +
        "gap is likely render/GPU work, scheduling delay, or waiting on another thread, none of which " +
        "CPU sampling captures. " +
        "Filter by thread name/id substring to focus on one thread. " +
        "`run` defaults to the most recent run. " +
        "Also works on schema \"Allocations/Allocations List\" — folds each allocation's resolved " +
        "backtrace the same way, but weighted by allocated BYTES (the size attribute) instead of sample " +
        "duration, so totalWeightFmt/selfWeightFmt read in KB/MB/GB there, not time. `thread`/`timeRange` " +
        "are not supported for that schema (no comparable columns to filter on) — passing them fires a " +
        "note instead of silently applying. " +
        "⚠️ Not for schemas without a backtrace column at all — e.g. Leaks/Leaks has none by design " +
        "(Instruments cross-references leaked objects by address into Allocations/Allocations List " +
        "instead; join by address, or call call_tree on that schema directly).",
      inputSchema: {
        sessionId: z.string().describe("The sessionId returned by open_trace."),
        schema: z
          .string()
          .describe(
            "Schema with a backtrace column to fold. Use 'time-profile' for Time Profiler (tagged-" +
            "backtrace, weighted by duration) or 'Allocations/Allocations List' for allocation call " +
            "trees (weighted by bytes)."
          ),
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
          .describe(
            "Restrict samples to a time window (nanoseconds). Every schema in a session shares one " +
            "clock — a raw start/duration/timestamp value read from any other schema's row (via " +
            "get_row or query) is directly usable here with no conversion."
          ),
        view: z
          .enum(["tree", "hot", "spine"])
          .optional()
          .describe(
            '"tree" (default): branching, depth-capped tree for browsing structure. ' +
            '"hot": flat, ranked-by-self-time function list — answers "where did the time go" directly, ' +
            "no depth cap. \"spine\": the single heaviest root-to-leaf path, no depth cap — answers " +
            '"what\'s the one path that matters".'
          ),
        maxDepth: z
          .number()
          .int()
          .min(1)
          .max(40)
          .optional()
          .describe("Max tree depth (default 6). Only applies to view \"tree\" — \"spine\" always walks to a true leaf."),
        topN: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Max children shown per node (\"tree\", default 8) or max ranked entries returned (\"hot\", default 20). Ignored for \"spine\"."),
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
    async ({ sessionId, schema, run, thread, timeRange, view, maxDepth, topN, position }) =>
      safeToolWithLog("call_tree", { sessionId, schema, run, thread, timeRange, view, maxDepth, topN, position }, async () => {
        const result = await callTree(sessionId, schema, { run, thread, timeRange, view, maxDepth, topN, position });
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
  const findConditionSchema = z.object({
    col: z.string().describe("Field to test — a column mnemonic or a nested dot-path (e.g. \"thread.process.pid\"; see describe_schema.nestedFields)."),
    op: z
      .enum(["eq", "ne", "gt", "gte", "lt", "lte", "contains", "not-contains", "regex", "is-null", "not-null"])
      .describe("Comparison operator."),
    val: z
      .union([z.string(), z.number()])
      .optional()
      .describe("Value to compare against. Not needed for is-null / not-null. Mutually exclusive with compareCol."),
    compareCol: z
      .string()
      .optional()
      .describe(
        "Compare `col` against this other column on the same row instead of `val` (see the tool " +
        "description for an example). Only valid with eq/ne/gt/gte/lt/lte. Mutually exclusive with val."
      ),
  });
  const findConditionGroupSchema: z.ZodType<any> = z.lazy(() =>
    z.union([
      findConditionSchema,
      z.object({ allOf: z.array(findConditionGroupSchema).describe("Every nested condition/group must match (AND).") }),
      z.object({ anyOf: z.array(findConditionGroupSchema).describe("At least one nested condition/group must match (OR).") }),
    ])
  );
  server.registerTool(
    "find",
    {
      title: "Find Rows",
      description:
        "Filter rows in any instrument table by a compound predicate. Supports richer operators than " +
        "query's equality filter: eq, ne, gt, gte, lt, lte, contains, not-contains, regex, is-null, not-null. " +
        "The top-level `where` array is AND'd, same as always. Nest {allOf: [...]} / {anyOf: [...]} groups to " +
        "mix in OR logic — e.g. find rows matching any of several patterns: " +
        "{anyOf: [{col:\"name\",op:\"contains\",val:\"foo\"},{col:\"name\",op:\"contains\",val:\"bar\"}]}. " +
        "A condition's `compareCol` compares two columns on the same row instead of a literal — e.g. " +
        "{col:\"downstream-cost\",op:\"gt\",compareCol:\"direct-cost\"} finds rows where downstream-cost exceeds " +
        "direct-cost. Returns summary rows (fmt values) with tableIndex for follow-up get_row calls. " +
        "Lens-specific finders like find_fm_requests are preset predicates built on top of this tool. " +
        "`run` defaults to the most recent run. " +
        "⚠️ Not for counting or grouping — use aggregate for that. Not a general expression evaluator — " +
        "no arbitrary functions or code run against row data, only this structured, parameterized condition set.",
      inputSchema: {
        sessionId: z.string().describe("The sessionId returned by open_trace."),
        schema: z.string().describe("Schema/table name (e.g. 'time-sample', 'ModelInferenceTable')."),
        run: z.number().int().optional().describe("Run number. Optional — defaults to the most recent run."),
        where: z
          .array(findConditionGroupSchema)
          .describe(
            "Conditions, AND'd by default. Each entry is a condition or a nested {allOf:[...]} / {anyOf:[...]} " +
            "group — see the tool description for OR-logic and cross-column examples."
          ),
        columns: z
          .array(z.string())
          .optional()
          .describe("Fields to include in results — column mnemonics and/or nested dot-paths. Omit for all columns."),
        sort: z
          .object({
            by: z.string().describe("Field to sort by — a column mnemonic or a nested dot-path."),
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

  // ── set_cache_dir ──────────────────────────────────────────────────────────
  server.registerTool(
    "set_cache_dir",
    {
      title: "Set Fallback Cache Directory",
      description:
        "Set (or reset) the fallback directory used to persist a trace's SQLite cache when the " +
        "trace's own directory isn't writable (a read-only mount, permissions, an Xcode-managed " +
        "autosave directory) — PMT:ruby-peak. Every trace's cache is normally colocated right next " +
        "to the .trace file itself (same basename, .db extension); this fallback directory is only " +
        "used for the traces that can't do that, and serves many traces at once (each keyed by a " +
        "hash of its absolute path). Omit `path` to reset to the OS-convention default. " +
        "⚠️ Not for search roots (where .trace files are FOUND) — use add_search_root/remove_search_root for that.",
      inputSchema: {
        path: z.string().optional().describe("Absolute or ~ path to use as the fallback cache directory. Omit to reset to the default."),
      },
    },
    async ({ path: rawPath }) =>
      safeToolWithLog("set_cache_dir", { path: rawPath }, async () => {
        const { resolve } = await import("node:path");
        const { homedir } = await import("node:os");

        let absPath: string | null = null;
        if (rawPath) {
          const expanded = rawPath.startsWith("~") ? rawPath.replace("~", homedir()) : rawPath;
          absPath = resolve(expanded);
        }

        const config = await updateConfig((c) => ({ ...c, fallbackCacheDir: absPath }));
        return text(JSON.stringify({
          fallbackCacheDir: config.fallbackCacheDir ?? defaultFallbackCacheDir(),
          isDefault: config.fallbackCacheDir === null,
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
  // Most intents just need their label here — full nuance lives in intent.note,
  // surfaced in the response after the call. leaks-backtraces gets a short
  // caveat inline instead, since attach-vs-launch is decided in THIS SAME call
  // (alongside `type`) — by the time intent.note comes back in the response,
  // the choice is already made and can't be changed without restarting.
  const INTENT_UPFRONT_CAVEATS: Partial<Record<string, string>> = {
    "leaks-backtraces": " (prefer launch over attach if you need to see WHERE a leak came from — attach can't symbolicate objects already live before it attached)",
  };
  const intentDescriptions = Object.entries(RECORDING_INTENTS)
    .map(([k, v]) => `"${k}" → ${v.label}${INTENT_UPFRONT_CAVEATS[k] ?? ""}`)
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
        "BARE extra instruments to compose on top of the base template, recorded exactly as " +
        "named — never expanded, even if the name is also a template. Use this for a " +
        "standalone instrument with no template of its own (e.g. \"GCD Performance\", " +
        "\"Data Fetches\"), or when you deliberately want only that instrument's raw signal. " +
        "Names must match `xcrun xctrace list instruments` exactly. If you name something " +
        "that IS also a richer template (e.g. \"Time Profiler\", \"SwiftUI\"), you get only " +
        "its bare instrument, not the bundle — the response's compositionNote will point you " +
        "at `templates` instead if that's what you meant. Use `templates`, not this, to " +
        "compose a whole second template."
      ),
    templates: z
      .array(z.string())
      .optional()
      .describe(
        "One or more WHOLE templates to compose into one recording, each expanded to its full " +
        "bundled instrument set plus any recording options it bakes in. Two ways to use this: " +
        "(1) alongside `type`/`template` — composes ADDITIONAL templates on top of that base, " +
        "e.g. templates: [\"SwiftUI\"] on type: \"core-data\" attributes SwiftData fetches to " +
        "the triggering SwiftUI update AND records SwiftUI's own Hangs + Time Profiler bundle " +
        "and layout tracing, not just a bare instrument; (2) ALONE, with no `type`/`template` " +
        "at all — a flat, symmetric list of 2+ templates with no privileged \"base\", e.g. " +
        "templates: [\"Swift Concurrency\", \"SwiftUI\"] to start both together directly. " +
        "Entries are normally the REAL xctrace template name, properly cased/spaced (\"Swift " +
        "Concurrency\", \"SwiftUI\", \"Time Profiler\") — matching `xcrun xctrace list " +
        "templates` — but a `type` enum key (e.g. \"swift-concurrency\") also works here and " +
        "resolves to its real template automatically, so don't worry about getting the exact " +
        "spelling/casing right for anything already covered by `type`. For a template `type` " +
        "doesn't cover, use the exact name from `xcrun xctrace list templates`. " +
        "Check the response's compositionNote for exactly what each name expanded to, and its " +
        "fidelityAtRisk list for which composed instruments were added bare (no template backing " +
        "them) — their tuned configuration and any template-only behavior (e.g. a Hangs " +
        "threshold, os-log's subsystem/category scope) isn't guaranteed to match a real template " +
        "recording. Composing onto a base that already covers the same instruments (e.g. " +
        "templates: [\"SwiftUI\"] on type: \"swift-concurrency\", since Swift Concurrency's own " +
        "bundle already includes Hangs) keeps full fidelity for free — fidelityAtRisk is only " +
        "non-empty when there's no such overlap."
      ),
    template: z
      .string()
      .optional()
      .describe(
        "Raw `--template <name|path>` override for a custom or uncurated template `type` " +
        "doesn't cover. Overrides the base template while keeping type's other behavior " +
        "(privacy notice, launchRequired) when both are given. Provide this, `type`, or a " +
        "`templates` array (used alone) — one of the three is required."
      ),
    attach: z
      .string()
      .optional()
      .describe(
        "PID, CFBundleIdentifier, or process name of an ALREADY-RUNNING process to attach to. " +
          "For a device/Simulator target, prefer the CFBundleIdentifier (e.g. \"com.acme.MyApp\") — far-swan " +
          "resolves it to the live PID, because attach-by-NAME doesn't resolve on a device/sim and the process " +
          "name is CFBundleExecutable, NOT the display name shown on the Home Screen / in Instruments. The app " +
          "must already be running (start it in Xcode) — far-swan attaches, it never launches or deploys."
      ),
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
        "Pass `instruments` to compose bare extra instruments onto `type`'s base template " +
        "(e.g. cross-instrument causation questions like \"did this SwiftUI update cause " +
        "this SwiftData fetch\"), `templates` to compose one or more WHOLE templates — " +
        "either on top of `type`/`template`, or used ALONE (no `type` needed) to start two " +
        "or more templates together, e.g. templates: [\"Swift Concurrency\", \"SwiftUI\"] — " +
        "or `template` for a single fully custom/uncurated base template. `templates` entries " +
        "are normally real xctrace template names (\"Swift Concurrency\", properly cased/" +
        "spaced) — a `type` enum key (\"swift-concurrency\") also works there and resolves " +
        "automatically, so don't worry about exact spelling for anything `type` already covers.\n\n" +
        'Use list_instruments after opening to see which schemas are available, ' +
        "then describe_schema on any schema to learn its columns before querying. " +
        "⚠️ Not for opening an existing .trace file — use open_trace instead.",
      inputSchema: INTERACTIVE_RECORD_INPUTS,
    },
    async ({ type, instruments, templates, template, attach, launch, timeLimit, device }) =>
      safeToolWithLog(
        "start_recording",
        { type, instruments, templates, template, attach, launch, timeLimit, device },
        async () => {
          // `templates` alone (no type/template) is valid too — the flat,
          // symmetric "start with N templates" shape, no privileged base.
          // xctrace itself still needs exactly one --template value, so the
          // first entry fills that role; the rest are additional templates
          // to compose on top, same as if they'd been passed alongside a
          // real `type`/`template`.
          if (type === undefined && template === undefined && (!templates || templates.length === 0)) {
            return text(
              JSON.stringify({
                error: "one of `type`, `template`, or `templates` is required",
                hint: `Pass type (one of: ${intentKeys.join(", ")}), a raw template name/path, or templates: [...] with at least one real template name.`,
              })
            );
          }
          const usingTemplatesAsBase = type === undefined && template === undefined;
          // resolveTemplateName tolerates a `type` key landing here by mistake
          // (e.g. "swift-concurrency" instead of "Swift Concurrency") — same
          // normalization expandTemplates() applies to every other entry.
          const baseTemplate = template ?? (usingTemplatesAsBase ? resolveTemplateName(templates![0]) : undefined);
          const additionalTemplates = usingTemplatesAsBase ? templates!.slice(1) : templates;
          const intent =
            type !== undefined
              ? RECORDING_INTENTS[type as keyof typeof RECORDING_INTENTS]
              : { label: baseTemplate!, template: baseTemplate!, launchRequired: false };
          const result = await startSession({
            intent,
            instruments,
            templates: additionalTemplates,
            template,
            attach,
            launch,
            device,
            timeLimit,
          });
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
        }
      )
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
        "xctrace can exit non-zero during finalize even when it wrote a complete, valid trace — " +
        "in that case status is still \"done\" but a finalizeWarning field is included (alongside " +
        "exitCode, and finalizeOutput — the tail of xctrace's console output — when it printed any, " +
        "so you can diagnose the exit rather than reasoning from the warning string alone); check it " +
        "before trusting an empty schema as \"ran and found nothing\" rather than \"write interrupted\". " +
        "Also eager-ingests a small set of bounded schemas and sweeps every detector over them, so the " +
        "response can include `recommended` (a fired finding, if any), `schemaInventory` (one line per " +
        "present schema), and `sweepNote` (what was checked, even when the sweep came back clean) right " +
        "after the recording finishes — not just after a separate open_trace/list_instruments round trip. " +
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
        // PMT:ruddy-elk: run the eager bounded-schema sweep right here — this
        // is the exact moment (nothing ingested yet) the old detector sweep
        // always returned empty for. Best-effort: the sweep itself must never
        // stop stop_recording from returning the .trace path it just finalized.
        let sweep: Awaited<ReturnType<typeof eagerSweep>> | null = null;
        if (sessionId) {
          try {
            sweep = await eagerSweep(sessionId);
          } catch {
            sweep = null;
          }
        }
        return text(
          JSON.stringify(
            {
              ...result,
              ...opened,
              ...(sweep
                ? {
                    schemaInventory: sweep.inventory,
                    ...(sweep.sweepNote ? { sweepNote: sweep.sweepNote } : {}),
                    ...(sweep.recommended ? { recommended: sweep.recommended } : {}),
                  }
                : {}),
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
        '"done" (finished cleanly, or exited non-zero but the trace bundle still exists — ' +
        'check finalizeWarning from stop_recording), "failed" (non-zero exit with no usable trace). ' +
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
