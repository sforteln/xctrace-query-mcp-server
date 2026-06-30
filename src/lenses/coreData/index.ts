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
    // No lens-specific tools — core verbs (query, aggregate, find) work directly on these schemas.
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

    if (schemas.includes(REL_FAULT_SCHEMA)) {
      return {
        schema: REL_FAULT_SCHEMA,
        tool: "aggregate",
        args: {
          sessionId,
          schema: REL_FAULT_SCHEMA,
          run,
          groupBy: "relationship",
          op: "count",
          topN: 10,
        },
        hint: "Core Data trace — aggregate relationship faults by relationship name shows which associations are traversed most lazily; high counts suggest adding a prefetch key path",
      };
    }

    if (schemas.includes(SAVE_SCHEMA)) {
      return {
        schema: SAVE_SCHEMA,
        tool: "query",
        args: {
          sessionId,
          schema: SAVE_SCHEMA,
          run,
          sort: { by: "duration", dir: "desc" },
          limit: 20,
        },
        hint: "Core Data trace — save operations sorted by duration shows the slowest commits; check the backtrace column to find call sites causing expensive saves",
      };
    }

    return null;
  },
};

export default coreDataLens;
