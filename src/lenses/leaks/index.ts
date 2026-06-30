// Tool description format: see the comment above createServer() in src/index.ts.
// Enforced by tests/driftGuard.test.ts — verb-led openers, ⚠️ Not for blocks, no stale identifiers.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Lens, QuickStart } from "../types.js";
import type { NextAction } from "../../core/response.js";

const LEAKS_SCHEMA = "Leaks/Leaks";

const leaksLens: Lens = {
  instruments: [LEAKS_SCHEMA],

  registerTools(_server: McpServer): void {
    // Leaks lens tools (list_leaks, etc.) are added in a follow-up prompt.
    // The quickStart() hook below handles initial navigation from open_trace.
  },

  nextActions(_sessionId: string, schema: string, _run: number): NextAction[] {
    if (schema !== LEAKS_SCHEMA) return [];
    return [];
  },

  quickStart(schemas: string[], sessionId: string, run: number): QuickStart | null {
    if (!schemas.includes(LEAKS_SCHEMA)) return null;
    return {
      schema: LEAKS_SCHEMA,
      tool: "query",
      args: {
        sessionId,
        schema: LEAKS_SCHEMA,
        run,
        sort: { by: "size", dir: "desc" },
        limit: 20,
      },
      hint: "Leaks trace — query sorted by size shows all leaks largest-first; zero rows means no leaks detected",
    };
  },
};

export default leaksLens;
