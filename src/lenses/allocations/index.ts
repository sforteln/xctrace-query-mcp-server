// Tool description format: see the comment above createServer() in src/index.ts.
// Enforced by tests/driftGuard.test.ts — verb-led openers, ⚠️ Not for blocks, no stale identifiers.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Lens, QuickStart } from "../types.js";
import type { NextAction } from "../../core/response.js";

const ALLOCATIONS_SCHEMA = "Allocations/Allocations-List";

const allocationsLens: Lens = {
  instruments: [ALLOCATIONS_SCHEMA],

  registerTools(_server: McpServer): void {
    // No lens-specific tools — core verbs (query, aggregate, find) work directly on these schemas.
  },

  nextActions(_sessionId: string, schema: string, _run: number): NextAction[] {
    if (schema !== ALLOCATIONS_SCHEMA) return [];
    return [];
  },

  quickStart(schemas: string[], sessionId: string, run: number): QuickStart | null {
    if (!schemas.includes(ALLOCATIONS_SCHEMA)) return null;
    return {
      schema: ALLOCATIONS_SCHEMA,
      tool: "aggregate",
      args: {
        sessionId,
        schema: ALLOCATIONS_SCHEMA,
        run,
        groupBy: "category",
        measure: "size",
        op: "sum",
        topN: 10,
      },
      hint: "Allocations trace — aggregate size by category shows which object types consume the most memory; filter live=true to see only retained allocations, or groupBy responsible-library to attribute by framework",
    };
  },
};

export default allocationsLens;
