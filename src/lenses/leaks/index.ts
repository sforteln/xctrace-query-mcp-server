// Tool description format: see the comment above createServer() in src/index.ts.
// Enforced by tests/driftGuard.test.ts — verb-led openers, ⚠️ Not for blocks, no stale identifiers.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Lens, QuickStart } from "../types.js";
import type { NextAction } from "../../core/response.js";

const LEAKS_SCHEMA = "Leaks/Leaks";

const leaksLens: Lens = {
  instruments: [LEAKS_SCHEMA],

  registerTools(_server: McpServer): void {
    // No lens-specific tools — core verbs (query, aggregate, find) work directly on these schemas.
  },

  nextActions(sessionId: string, schema: string, run: number, allSchemas: string[]): NextAction[] {
    if (schema !== LEAKS_SCHEMA) return [];
    const actions: NextAction[] = [
      {
        tool: "aggregate",
        args: {
          sessionId,
          schema: LEAKS_SCHEMA,
          run,
          groupBy: "responsible-library",
          measure: "size",
          op: "sum",
          topN: 20,
        },
        description:
          "Group leaks by owning library — shows whether leaked bytes are app-owned or framework-owned.",
      },
    ];
    if (allSchemas.includes("Allocations/Allocations-List")) {
      actions.push({
        tool: "aggregate",
        args: {
          sessionId,
          schema: "Allocations/Allocations-List",
          run,
          groupBy: "category",
          measure: "persistent-bytes",
          op: "sum",
          topN: 20,
        },
        description:
          "Summarise persistent memory by category alongside the leaks — persistent-bytes is the live footprint grouped by framework or class name.",
      });
    }
    if (allSchemas.includes("Allocations/Statistics")) {
      actions.push({
        tool: "aggregate",
        args: {
          sessionId,
          schema: "Allocations/Statistics",
          run,
          groupBy: "category",
          measure: "persistent-bytes",
          op: "sum",
          topN: 20,
        },
        description:
          "Pre-summarised Allocations view — same persistent-bytes breakdown as Allocations-List but faster. Try this if Allocations-List is slow or empty.",
      });
    }
    return actions;
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
