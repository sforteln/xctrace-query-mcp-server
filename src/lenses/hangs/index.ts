// Tool description format: see the comment above createServer() in src/index.ts.
// Enforced by tests/driftGuard.test.ts — verb-led openers, ⚠️ Not for blocks, no stale identifiers.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Lens, QuickStart } from "../types.js";
import type { NextAction } from "../../core/response.js";
import { hintFor } from "../../engine/roleHints.js";

const HANGS_SCHEMA = "potential-hangs";
const HITCHES_SCHEMA = "hitches";
const HANG_RISKS_SCHEMA = "hang-risks";

// Pinned in roleHints.ts — read from there instead of re-hardcoding the mnemonic.
const HANGS_WEIGHT = hintFor(HANGS_SCHEMA)!.primaryWeight!;

const HANGS_SCHEMAS = [HANGS_SCHEMA, HITCHES_SCHEMA, HANG_RISKS_SCHEMA];

const hangsLens: Lens = {
  instruments: HANGS_SCHEMAS,

  registerTools(_server: McpServer): void {
    // No lens-specific tools — core verbs (query, aggregate, find) work directly on these schemas.
  },

  nextActions(_sessionId: string, schema: string, _run: number, _allSchemas: string[]): NextAction[] {
    if (!HANGS_SCHEMAS.includes(schema)) return [];
    return [];
  },

  quickStart(schemas: string[], sessionId: string, run: number): QuickStart | null {
    if (schemas.includes(HANGS_SCHEMA)) {
      return {
        schema: HANGS_SCHEMA,
        tool: "query",
        args: {
          sessionId,
          schema: HANGS_SCHEMA,
          run,
          sort: { by: HANGS_WEIGHT, dir: "desc" },
          limit: 20,
        },
        hint: `Hangs & Hitches trace — potential-hangs sorted by ${HANGS_WEIGHT} shows the worst hangs first; check hang-type (main-thread vs. background) and thread for root-cause clues`,
      };
    }

    if (schemas.includes(HITCHES_SCHEMA)) {
      return {
        schema: HITCHES_SCHEMA,
        tool: "aggregate",
        args: {
          sessionId,
          schema: HITCHES_SCHEMA,
          run,
          groupBy: "is-system",
          op: "count",
          topN: 10,
        },
        hint: "Hitches trace — aggregate by is-system splits hitches into app-owned vs. system-owned; focus on is-system=false rows to find app regressions",
      };
    }

    return null;
  },
};

export default hangsLens;
