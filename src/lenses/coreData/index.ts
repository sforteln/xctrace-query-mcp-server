// Tool description format: see the comment above createServer() in src/index.ts.
// Enforced by tests/driftGuard.test.ts — verb-led openers, ⚠️ Not for blocks, no stale identifiers.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Lens, QuickStart } from "../types.js";
import type { NextAction } from "../../core/response.js";

const FAULT_SCHEMA = "core-data-fault";
const FETCH_SCHEMA = "core-data-fetch";
const SAVE_SCHEMA = "core-data-save";
const REL_FAULT_SCHEMA = "core-data-relationship-fault";

const CORE_DATA_SCHEMAS = [FAULT_SCHEMA, FETCH_SCHEMA, SAVE_SCHEMA, REL_FAULT_SCHEMA];

const coreDataLens: Lens = {
  instruments: CORE_DATA_SCHEMAS,

  registerTools(_server: McpServer): void {
    // Core Data / SwiftData lens tools are added in a follow-up prompt.
    // The quickStart() hook below handles initial navigation from open_trace.
  },

  nextActions(_sessionId: string, schema: string, _run: number): NextAction[] {
    if (!CORE_DATA_SCHEMAS.includes(schema)) return [];
    return [];
  },

  quickStart(schemas: string[], sessionId: string, run: number): QuickStart | null {
    if (schemas.includes(FAULT_SCHEMA)) {
      return {
        schema: FAULT_SCHEMA,
        tool: "aggregate",
        args: {
          sessionId,
          schema: FAULT_SCHEMA,
          run,
          groupBy: "fault-object",
          op: "count",
          topN: 10,
        },
        hint: "Core Data trace — aggregate faults by fault-object shows which entity types fault most often; high counts on a single entity suggest a missing relationship prefetch",
      };
    }

    if (schemas.includes(FETCH_SCHEMA)) {
      return {
        schema: FETCH_SCHEMA,
        tool: "query",
        args: {
          sessionId,
          schema: FETCH_SCHEMA,
          run,
          sort: { by: "duration", dir: "desc" },
          limit: 20,
        },
        hint: "Core Data trace — fetch requests sorted by duration shows the slowest fetches; inspect the predicate and result count to identify missing indexes",
      };
    }

    return null;
  },
};

export default coreDataLens;
