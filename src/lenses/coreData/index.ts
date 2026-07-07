// Tool description format: see the comment above createServer() in src/index.ts.
// Enforced by tests/driftGuard.test.ts — verb-led openers, ⚠️ Not for blocks, no stale identifiers.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Lens, QuickStart } from "../types.js";
import type { NextAction } from "../../core/response.js";
import { hintFor } from "../../engine/roleHints.js";

const FAULT_SCHEMA = "core-data-fault";
const FETCH_SCHEMA = "core-data-fetch";
const SAVE_SCHEMA = "core-data-save";
const REL_FAULT_SCHEMA = "core-data-relationship-fault";

const CORE_DATA_SCHEMAS = [FAULT_SCHEMA, FETCH_SCHEMA, SAVE_SCHEMA, REL_FAULT_SCHEMA];

// Pinned in roleHints.ts. core-data-fault/core-data-relationship-fault name
// their weight column "fault-duration"; core-data-fetch/core-data-save use
// plain "duration" — reading both from roleHints instead of hardcoding
// avoids silently aggregating on a column that doesn't exist on that schema.
const FAULT_WEIGHT = hintFor(FAULT_SCHEMA)!.primaryWeight!;
const FETCH_WEIGHT = hintFor(FETCH_SCHEMA)!.primaryWeight!;
const SAVE_WEIGHT = hintFor(SAVE_SCHEMA)!.primaryWeight!;
const REL_FAULT_WEIGHT = hintFor(REL_FAULT_SCHEMA)!.primaryWeight!;

// SwiftData has no instrumentation of its own — it's built on Core Data's
// persistence engine, so a SwiftData app's activity shows up under these
// same core-data-* schemas. Say so in every hint rather than "Core Data
// trace" alone, which could read as irrelevant to a SwiftData-only reader.
const TRACE_LABEL = "Core Data / SwiftData trace";

const coreDataLens: Lens = {
  instruments: CORE_DATA_SCHEMAS,

  registerTools(_server: McpServer): void {
    // No lens-specific tools — core verbs (query, aggregate, find) work directly on these schemas.
  },

  nextActions(sessionId: string, schema: string, run: number, allSchemas: string[]): NextAction[] {
    if (schema === FAULT_SCHEMA) {
      const actions: NextAction[] = [
        {
          tool: "aggregate",
          args: { sessionId, schema: FAULT_SCHEMA, run, groupBy: "fault-object", measure: FAULT_WEIGHT, op: "sum", topN: 10 },
          description: `Total ${FAULT_WEIGHT} by fault-object — total time cost per entity, complementing the count-based view.`,
        },
      ];
      if (allSchemas.includes(REL_FAULT_SCHEMA)) {
        actions.push({
          tool: "aggregate",
          args: { sessionId, schema: REL_FAULT_SCHEMA, run, groupBy: "relationship", op: "count", topN: 10 },
          description: "Relationship faults are a related but distinct perf issue — check which relationships are traversed most lazily.",
        });
      }
      return actions;
    }
    if (schema === FETCH_SCHEMA) {
      return [
        {
          tool: "aggregate",
          args: { sessionId, schema: FETCH_SCHEMA, run, groupBy: "fetch-entity", measure: FETCH_WEIGHT, op: "sum", topN: 10 },
          description: `Total ${FETCH_WEIGHT} by fetch-entity — total time cost per entity, vs. the per-request slowest-fetch view.`,
        },
      ];
    }
    if (schema === SAVE_SCHEMA) {
      return [
        {
          tool: "aggregate",
          args: { sessionId, schema: SAVE_SCHEMA, run, groupBy: "thread", measure: SAVE_WEIGHT, op: "sum", topN: 10 },
          description: "Total save time by thread — saves clustered on the main thread are a common cause of UI hitches.",
        },
      ];
    }
    if (schema === REL_FAULT_SCHEMA) {
      const actions: NextAction[] = [
        {
          tool: "aggregate",
          args: { sessionId, schema: REL_FAULT_SCHEMA, run, groupBy: "relationship", measure: REL_FAULT_WEIGHT, op: "sum", topN: 10 },
          description: `Total ${REL_FAULT_WEIGHT} by relationship — total time cost per association, complementing the count-based view.`,
        },
      ];
      if (allSchemas.includes(FAULT_SCHEMA)) {
        actions.push({
          tool: "aggregate",
          args: { sessionId, schema: FAULT_SCHEMA, run, groupBy: "fault-object", op: "count", topN: 10 },
          description: "Object faults are a related but distinct perf issue — check which entity types fault most often.",
        });
      }
      return actions;
    }
    return [];
  },

  quickStart(schemas: string[], sessionId: string, run: number): QuickStart | null {
    if (schemas.includes(FAULT_SCHEMA)) {
      return {
        schema: FAULT_SCHEMA,
        tool: "aggregate",
        args: { sessionId, schema: FAULT_SCHEMA, run, groupBy: "fault-object", op: "count", topN: 10 },
        hint: `${TRACE_LABEL} — aggregate faults by fault-object shows which entity types fault most often; high counts on a single entity suggest a missing relationship prefetch`,
      };
    }

    if (schemas.includes(FETCH_SCHEMA)) {
      // Bounded-by-construction (PMT:spare-goat) — a raw sorted query forces
      // a full-table scan regardless of size, and quickStart runs from
      // schema names alone (no row count known yet). aggregate by
      // fetch-entity (same call this lens's own nextActions already offers
      // for this schema) answers "which entity's fetches cost the most
      // total time" instead of "the single slowest fetch" — a related,
      // similarly actionable question that stays bounded on a huge trace.
      return {
        schema: FETCH_SCHEMA,
        tool: "aggregate",
        args: { sessionId, schema: FETCH_SCHEMA, run, groupBy: "fetch-entity", measure: FETCH_WEIGHT, op: "sum", topN: 10 },
        hint: `${TRACE_LABEL} — total ${FETCH_WEIGHT} by fetch-entity shows which entity's fetches cost the most; query with sort:{by:"${FETCH_WEIGHT}",dir:"desc"} for the single slowest individual fetch`,
      };
    }

    if (schemas.includes(REL_FAULT_SCHEMA)) {
      return {
        schema: REL_FAULT_SCHEMA,
        tool: "aggregate",
        args: { sessionId, schema: REL_FAULT_SCHEMA, run, groupBy: "relationship", op: "count", topN: 10 },
        hint: `${TRACE_LABEL} — aggregate relationship faults by relationship name shows which associations are traversed most lazily; high counts suggest adding a prefetch key path`,
      };
    }

    if (schemas.includes(SAVE_SCHEMA)) {
      // Bounded-by-construction (PMT:spare-goat) — same reasoning as
      // FETCH_SCHEMA above; aggregate by thread (already offered by this
      // lens's own nextActions for this schema) surfaces the common "saves
      // clustered on the main thread" cause without an unbounded full scan.
      return {
        schema: SAVE_SCHEMA,
        tool: "aggregate",
        args: { sessionId, schema: SAVE_SCHEMA, run, groupBy: "thread", measure: SAVE_WEIGHT, op: "sum", topN: 10 },
        hint: `${TRACE_LABEL} — total ${SAVE_WEIGHT} by thread shows whether saves are clustered on the main thread (a common cause of UI hitches); query with sort:{by:"${SAVE_WEIGHT}",dir:"desc"} for the single slowest individual save`,
      };
    }

    return null;
  },
};

export default coreDataLens;
