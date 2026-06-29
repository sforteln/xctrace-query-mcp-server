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
import {
  envelope,
  actionsAfterOpen,
  actionsAfterDescribeSchema,
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
