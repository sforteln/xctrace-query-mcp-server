// Tool description format: see the comment above createServer() in src/index.ts.
// Enforced by tests/driftGuard.test.ts — verb-led openers, ⚠️ Not for blocks, no stale identifiers.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Lens, QuickStart } from "../types.js";
import type { NextAction } from "../../core/response.js";

const NETWORK_STATS_SCHEMA = "NetworkConnectionStats";
const NETWORK_UPDATE_SCHEMA = "network-connection-update";
const NETWORK_DETECTED_SCHEMA = "network-connection-detected";

const NETWORK_SCHEMAS = [NETWORK_STATS_SCHEMA, NETWORK_UPDATE_SCHEMA, NETWORK_DETECTED_SCHEMA];

const networkLens: Lens = {
  instruments: NETWORK_SCHEMAS,

  registerTools(_server: McpServer): void {
    // No lens-specific tools — core verbs (query, aggregate, find) work directly on these schemas.
  },

  nextActions(_sessionId: string, schema: string, _run: number, _allSchemas: string[]): NextAction[] {
    if (!NETWORK_SCHEMAS.includes(schema)) return [];
    return [];
  },

  quickStart(schemas: string[], sessionId: string, run: number): QuickStart | null {
    if (schemas.includes(NETWORK_STATS_SCHEMA)) {
      return {
        schema: NETWORK_STATS_SCHEMA,
        tool: "aggregate",
        args: {
          sessionId,
          schema: NETWORK_STATS_SCHEMA,
          run,
          groupBy: "process",
          measure: "bytes-in",
          op: "sum",
          topN: 10,
        },
        hint: "Network trace — aggregate bytes-in by process shows which apps received the most data; also try groupBy remote-address to see traffic by host, or measure bytes-out for send traffic",
      };
    }

    if (schemas.includes(NETWORK_UPDATE_SCHEMA)) {
      return {
        schema: NETWORK_UPDATE_SCHEMA,
        tool: "aggregate",
        args: {
          sessionId,
          schema: NETWORK_UPDATE_SCHEMA,
          run,
          groupBy: "connection-serial",
          measure: "rx-bytes",
          op: "sum",
          topN: 10,
        },
        hint: "Network trace — aggregate rx-bytes by connection shows which connections transferred the most data; use NetworkConnectionStats if available for host and process info",
      };
    }

    if (schemas.includes(NETWORK_DETECTED_SCHEMA)) {
      return {
        schema: NETWORK_DETECTED_SCHEMA,
        tool: "query",
        args: { sessionId, schema: NETWORK_DETECTED_SCHEMA, run, limit: 20 },
        hint: "Network trace — query lists detected connections; use describe_schema to see available columns for filtering",
      };
    }

    return null;
  },
};

export default networkLens;
