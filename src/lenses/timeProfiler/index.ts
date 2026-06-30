// Tool description format: see the comment above createServer() in src/index.ts.
// Enforced by tests/driftGuard.test.ts — verb-led openers, ⚠️ Not for blocks, no stale identifiers.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Lens, QuickStart } from "../types.js";
import type { NextAction } from "../../core/response.js";

const TIME_SAMPLE_SCHEMA = "time-sample";
const TIME_PROFILE_SCHEMA = "time-profile";

const timeProfilerLens: Lens = {
  instruments: [TIME_SAMPLE_SCHEMA, TIME_PROFILE_SCHEMA],

  registerTools(_server: McpServer): void {
    // No lens-specific tools — core verbs (query, aggregate, call_tree) work directly on these schemas.
  },

  nextActions(_sessionId: string, schema: string, _run: number): NextAction[] {
    if (schema !== TIME_SAMPLE_SCHEMA && schema !== TIME_PROFILE_SCHEMA) return [];
    return [];
  },

  quickStart(schemas: string[], sessionId: string, run: number): QuickStart | null {
    if (!schemas.includes(TIME_SAMPLE_SCHEMA) && !schemas.includes(TIME_PROFILE_SCHEMA)) {
      return null;
    }

    if (schemas.includes(TIME_SAMPLE_SCHEMA)) {
      return {
        schema: TIME_SAMPLE_SCHEMA,
        tool: "aggregate",
        args: {
          sessionId,
          schema: TIME_SAMPLE_SCHEMA,
          run,
          groupBy: "thread",
          op: "count",
          topN: 5,
        },
        hint: "Time Profiler trace — aggregate by thread shows hottest threads by sample count; call call_tree on the busiest thread for the full symbolicated stack",
      };
    }

    // time-profile present without time-sample (unusual but possible): steer to call_tree directly.
    return {
      schema: TIME_PROFILE_SCHEMA,
      tool: "call_tree",
      args: {
        sessionId,
        schema: TIME_PROFILE_SCHEMA,
        run,
        topN: 8,
      },
      hint: "Time Profiler trace — call_tree builds the folded call tree weighted by sample duration",
    };
  },
};

export default timeProfilerLens;
