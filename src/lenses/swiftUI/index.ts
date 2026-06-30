// Tool description format: see the comment above createServer() in src/index.ts.
// Enforced by tests/driftGuard.test.ts — verb-led openers, ⚠️ Not for blocks, no stale identifiers.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Lens, QuickStart } from "../types.js";
import type { NextAction } from "../../core/response.js";

const SWIFTUI_UPDATES_SCHEMA = "swiftui-updates";

const swiftUILens: Lens = {
  instruments: [SWIFTUI_UPDATES_SCHEMA],

  registerTools(_server: McpServer): void {
    // SwiftUI lens tools are added in a follow-up prompt.
    // The quickStart() hook below handles initial navigation from open_trace.
  },

  nextActions(_sessionId: string, schema: string, _run: number): NextAction[] {
    if (schema !== SWIFTUI_UPDATES_SCHEMA) return [];
    return [];
  },

  quickStart(schemas: string[], sessionId: string, run: number): QuickStart | null {
    if (!schemas.includes(SWIFTUI_UPDATES_SCHEMA)) return null;
    return {
      schema: SWIFTUI_UPDATES_SCHEMA,
      tool: "describe_schema",
      args: { sessionId, schema: SWIFTUI_UPDATES_SCHEMA, run },
      hint: "SwiftUI trace — describe_schema reveals column names and roles; then aggregate by a label column to find the most frequently updated views",
    };
  },
};

export default swiftUILens;
