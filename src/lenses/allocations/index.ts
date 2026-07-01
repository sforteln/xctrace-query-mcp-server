// Tool description format: see the comment above createServer() in src/index.ts.
// Enforced by tests/driftGuard.test.ts — verb-led openers, ⚠️ Not for blocks, no stale identifiers.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Lens, QuickStart } from "../types.js";
import type { NextAction } from "../../core/response.js";
import { hintFor } from "../../engine/roleHints.js";

const ALLOCATIONS_LIST_SCHEMA = "Allocations/Allocations List";
const ALLOCATIONS_STATS_SCHEMA = "Allocations/Statistics";
// Pinned in roleHints.ts — read from there instead of re-hardcoding the
// mnemonic here, so a future column rename only needs updating in one place.
const LIST_WEIGHT = hintFor(ALLOCATIONS_LIST_SCHEMA)!.primaryWeight!;
const STATS_WEIGHT = hintFor(ALLOCATIONS_STATS_SCHEMA)!.primaryWeight!;

const allocationsLens: Lens = {
  instruments: [ALLOCATIONS_LIST_SCHEMA, ALLOCATIONS_STATS_SCHEMA],

  registerTools(_server: McpServer): void {
    // No lens-specific tools — core verbs (query, aggregate, find) work directly on these schemas.
  },

  nextActions(sessionId: string, schema: string, run: number, _allSchemas: string[]): NextAction[] {
    if (schema === ALLOCATIONS_LIST_SCHEMA) {
      return [
        {
          tool: "aggregate",
          args: {
            sessionId,
            schema: ALLOCATIONS_LIST_SCHEMA,
            run,
            groupBy: "responsible-library",
            measure: LIST_WEIGHT,
            op: "sum",
            topN: 20,
          },
          description:
            "Group allocations by owning library — shows which frameworks and your own code are responsible for the most bytes allocated.",
        },
        {
          tool: "aggregate",
          args: {
            sessionId,
            schema: ALLOCATIONS_STATS_SCHEMA,
            run,
            groupBy: "category",
            measure: STATS_WEIGHT,
            op: "sum",
            topN: 20,
          },
          description:
            "Switch to the Statistics schema for the live persistent footprint by category — persistent-bytes shows only what is still retained, not total allocated. Faster than Allocations-List for this summary.",
        },
      ];
    }
    if (schema === ALLOCATIONS_STATS_SCHEMA) {
      return [
        {
          tool: "aggregate",
          args: {
            sessionId,
            schema: ALLOCATIONS_LIST_SCHEMA,
            run,
            groupBy: "category",
            measure: LIST_WEIGHT,
            op: "sum",
            topN: 20,
          },
          description:
            "Drill into Allocations-List for per-object detail — size here is total bytes allocated (including freed), useful for finding allocation churn alongside the persistent footprint in Statistics.",
        },
      ];
    }
    return [];
  },

  quickStart(schemas: string[], sessionId: string, run: number): QuickStart | null {
    if (!schemas.includes(ALLOCATIONS_LIST_SCHEMA)) return null;
    return {
      schema: ALLOCATIONS_LIST_SCHEMA,
      tool: "aggregate",
      args: {
        sessionId,
        schema: ALLOCATIONS_LIST_SCHEMA,
        run,
        groupBy: "category",
        measure: LIST_WEIGHT,
        op: "sum",
        topN: 10,
      },
      hint: "Allocations trace — aggregate size by category shows which object types consume the most memory; filter live=true to see only retained allocations, or groupBy responsible-library to attribute by framework",
    };
  },
};

export default allocationsLens;
