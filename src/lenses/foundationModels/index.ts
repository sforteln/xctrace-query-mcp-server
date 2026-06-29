import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Lens } from "../types.js";
import type { NextAction } from "../../core/response.js";
import { envelope, toMcpText } from "../../core/response.js";
import { safeTool, text } from "../../core/toolUtils.js";
import { listFmRequests, FM_SCHEMA } from "./listRequests.js";

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
