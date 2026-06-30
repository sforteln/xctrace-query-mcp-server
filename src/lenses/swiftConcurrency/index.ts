// Tool description format: see the comment above createServer() in src/index.ts.
// Enforced by tests/driftGuard.test.ts — verb-led openers, ⚠️ Not for blocks, no stale identifiers.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Lens, QuickStart } from "../types.js";
import type { NextAction } from "../../core/response.js";

const TASK_LIFETIME_SCHEMA = "SwiftTaskLifetime";
const TASK_STATE_SCHEMA = "SwiftTaskStateTable";
const TASKS_INFO_SCHEMA = "SwiftTasksInfoTable";

const CONCURRENCY_SCHEMAS = [TASK_LIFETIME_SCHEMA, TASK_STATE_SCHEMA, TASKS_INFO_SCHEMA];

const swiftConcurrencyLens: Lens = {
  instruments: CONCURRENCY_SCHEMAS,

  registerTools(_server: McpServer): void {
    // No lens-specific tools — core verbs (query, aggregate, find) work directly on these schemas.
  },

  nextActions(_sessionId: string, schema: string, _run: number): NextAction[] {
    if (!CONCURRENCY_SCHEMAS.includes(schema)) return [];
    return [];
  },

  quickStart(schemas: string[], sessionId: string, run: number): QuickStart | null {
    if (!schemas.some((s) => CONCURRENCY_SCHEMAS.includes(s))) return null;

    const schema = schemas.includes(TASK_LIFETIME_SCHEMA)
      ? TASK_LIFETIME_SCHEMA
      : schemas.includes(TASK_STATE_SCHEMA)
        ? TASK_STATE_SCHEMA
        : TASKS_INFO_SCHEMA;

    return {
      schema,
      tool: "aggregate",
      args: {
        sessionId,
        schema,
        run,
        groupBy: "process",
        op: "count",
        topN: 10,
      },
      hint: "Swift Concurrency trace — aggregate by process counts tasks spawned per process; follow up with query sorted by duration to find long-running or blocked tasks",
    };
  },
};

export default swiftConcurrencyLens;
