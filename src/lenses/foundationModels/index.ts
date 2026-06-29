import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Lens } from "../types.js";
import type { NextAction } from "../../core/response.js";
import { envelope, toMcpText } from "../../core/response.js";
import { safeTool, text } from "../../core/toolUtils.js";
import { listFmRequests, FM_SCHEMA } from "./listRequests.js";
import { getFmRequest, getFmResponse, getFmEvents, getFmPrompt } from "./getRequest.js";

const fmLens: Lens = {
  instruments: [FM_SCHEMA],

  registerTools(server: McpServer): void {
    // ── list_fm_requests ────────────────────────────────────────────────────
    server.registerTool(
      "list_fm_requests",
      {
        title: "List FM Requests",
        description:
          "List Foundation Models inference requests as compact one-liners: " +
          "start time, duration, agent name, prompt snippet (80 chars), token counts, " +
          "error flag, and resolve phase. " +
          "Each user request generates two rows — a Yellow 'Prompt' inference and an " +
          "Orange 'Resolve' step; the resolve field ('1Prompt', '1Resolve', …) encodes " +
          "which phase and which request number. " +
          "Use get_row(tableIndex) for full detail on any row. " +
          "`run` defaults to the most recent run.",
        inputSchema: {
          sessionId: z.string().describe("The sessionId returned by open_trace."),
          run: z.number().int().optional().describe("Run number. Optional — defaults to the most recent run."),
          limit: z.number().int().min(1).max(200).optional().describe("Rows to return (default 50, max 200)."),
          offset: z.number().int().min(0).optional().describe("Rows to skip for pagination (default 0)."),
        },
      },
      async ({ sessionId, run, limit, offset }) =>
        safeTool(async () => {
          const result = await listFmRequests(sessionId, { run, limit, offset });
          const actions: NextAction[] = [
            {
              tool: "get_row",
              args: { sessionId, schema: FM_SCHEMA, run: result.run, rowIndex: 0 },
              description: "Fetch full detail for a specific request row (replace rowIndex with tableIndex from results).",
            },
            {
              tool: "find_fm_requests",
              args: { sessionId, run: result.run },
              description: "Filter requests by predicate — hasError, minDuration, emptyContext, needsReformulation.",
            },
            {
              tool: "aggregate",
              args: { sessionId, schema: FM_SCHEMA, run: result.run, groupBy: "agent-name", measure: "duration", op: "sum", topN: 10 },
              description: "Total duration by agent to find which agent spent the most time.",
            },
          ];
          if (result.hasMore) {
            actions.unshift({
              tool: "list_fm_requests",
              args: { sessionId, run: result.run, offset: result.offset + result.returnedRows, limit: result.limit },
              description: "Fetch the next page of requests.",
            });
          }
          return text(toMcpText(envelope(result, actions)));
        })
    );

    // ── get_fm_request ──────────────────────────────────────────────────────
    server.registerTool(
      "get_fm_request",
      {
        title: "Get FM Request Detail",
        description:
          "Full detail for one FM inference row by its tableIndex (from list_fm_requests). " +
          "Returns timing, agent, full prompt, parsed response JSON, token breakdown, " +
          "resolve phase, error info. " +
          "instruction/instructions columns are intentionally omitted — they contain the " +
          "full system prompt which can be several KB. Use get_fm_prompt when you need it explicitly. " +
          "`run` defaults to the most recent run.",
        inputSchema: {
          sessionId: z.string().describe("The sessionId returned by open_trace."),
          rowIndex: z.number().int().min(0).describe("tableIndex from list_fm_requests."),
          run: z.number().int().optional().describe("Run number. Optional — defaults to the most recent run."),
        },
      },
      async ({ sessionId, rowIndex, run }) =>
        safeTool(async () => {
          const result = await getFmRequest(sessionId, rowIndex, { run });
          const actions: NextAction[] = [
            {
              tool: "get_fm_response",
              args: { sessionId, rowIndex, run: result.resolve ? undefined : run },
              description: "Read the parsed response JSON for this row.",
            },
            {
              tool: "get_fm_events",
              args: { sessionId, rowIndex, run: result.resolve ? undefined : run },
              description: "See all phases (Prompt → Resolve) for this request.",
            },
            {
              tool: "get_fm_prompt",
              args: { sessionId, rowIndex, run: result.resolve ? undefined : run },
              description: "Read the full system prompt/instructions for this row (large — only when needed).",
            },
            {
              tool: "list_fm_requests",
              args: { sessionId, run },
              description: "Return to the request list.",
            },
          ];
          return text(toMcpText(envelope(result, actions)));
        })
    );

    // ── get_fm_response ─────────────────────────────────────────────────────
    server.registerTool(
      "get_fm_response",
      {
        title: "Get FM Response",
        description:
          "Return the parsed response body for one FM inference row. " +
          "The response column contains JSON (body, needsReformulation, referencedSections, …); " +
          "this tool parses it so the agent reads structured data instead of an escaped JSON string. " +
          "`run` defaults to the most recent run.",
        inputSchema: {
          sessionId: z.string().describe("The sessionId returned by open_trace."),
          rowIndex: z.number().int().min(0).describe("tableIndex from list_fm_requests."),
          run: z.number().int().optional().describe("Run number. Optional — defaults to the most recent run."),
        },
      },
      async ({ sessionId, rowIndex, run }) =>
        safeTool(async () => {
          const result = await getFmResponse(sessionId, rowIndex, { run });
          const actions: NextAction[] = [
            {
              tool: "get_fm_request",
              args: { sessionId, rowIndex, run },
              description: "Full request detail (timing, tokens, error info).",
            },
            {
              tool: "get_fm_events",
              args: { sessionId, rowIndex, run },
              description: "All phases for this request.",
            },
          ];
          return text(toMcpText(envelope(result, actions)));
        })
    );

    // ── get_fm_events ───────────────────────────────────────────────────────
    server.registerTool(
      "get_fm_events",
      {
        title: "Get FM Request Events",
        description:
          "Return the ordered event timeline for one FM request — all rows sharing the " +
          "same model-request-id (Prompt phase, Resolve phase, …) with timing, resolve phase, " +
          "and content summary. Useful for understanding multi-step request flow. " +
          "`run` defaults to the most recent run.",
        inputSchema: {
          sessionId: z.string().describe("The sessionId returned by open_trace."),
          rowIndex: z.number().int().min(0).describe("tableIndex of any row in the request."),
          run: z.number().int().optional().describe("Run number. Optional — defaults to the most recent run."),
        },
      },
      async ({ sessionId, rowIndex, run }) =>
        safeTool(async () => {
          const result = await getFmEvents(sessionId, rowIndex, { run });
          const actions: NextAction[] = [
            {
              tool: "get_fm_request",
              args: { sessionId, rowIndex, run },
              description: "Full detail for the anchor row.",
            },
            {
              tool: "list_fm_requests",
              args: { sessionId, run },
              description: "Return to the full request list.",
            },
          ];
          return text(toMcpText(envelope(result, actions)));
        })
    );

    // ── get_fm_prompt ───────────────────────────────────────────────────────
    server.registerTool(
      "get_fm_prompt",
      {
        title: "Get FM System Prompt",
        description:
          "Return the full system prompt (instruction/instructions columns) for one FM inference row. " +
          "This is a deliberate, explicit-only call — the instructions blob can be several KB " +
          "and is excluded from all other FM tools to preserve token efficiency. " +
          "Only call this when you specifically need to read the system prompt. " +
          "Returns both `instruction` (with header line) and `instructions` (text only) " +
          "plus character counts so you can decide how much context you need. " +
          "`run` defaults to the most recent run.",
        inputSchema: {
          sessionId: z.string().describe("The sessionId returned by open_trace."),
          rowIndex: z.number().int().min(0).describe("tableIndex from list_fm_requests."),
          run: z.number().int().optional().describe("Run number. Optional — defaults to the most recent run."),
        },
      },
      async ({ sessionId, rowIndex, run }) =>
        safeTool(async () => {
          const result = await getFmPrompt(sessionId, rowIndex, { run });
          const actions: NextAction[] = [
            {
              tool: "get_fm_request",
              args: { sessionId, rowIndex, run },
              description: "Full request detail (timing, tokens, response — without the prompt).",
            },
          ];
          return text(toMcpText(envelope(result, actions)));
        })
    );
  },

  nextActions(sessionId: string, schema: string, run: number): NextAction[] {
    if (schema !== FM_SCHEMA) return [];
    return [
      {
        tool: "list_fm_requests",
        args: { sessionId, run },
        description: "List all FM inference requests as compact one-liners (prompt, duration, tokens, errors).",
      },
    ];
  },
};

export default fmLens;
