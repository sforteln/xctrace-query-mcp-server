// Tool description format: see the comment above createServer() in src/index.ts.
// Enforced by tests/driftGuard.test.ts — verb-led openers, ⚠️ Not for blocks, no stale identifiers.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Lens, QuickStart } from "../types.js";
import type { NextAction } from "../../core/response.js";

const SWIFTUI_UPDATES_SCHEMA = "swiftui-updates";
const SWIFTUI_CHANGES_SCHEMA = "swiftui-changes";
const SWIFTUI_CAUSES_SCHEMA = "swiftui-causes";
const SWIFTUI_FULL_CAUSES_SCHEMA = "swiftui-full-causes";
const SWIFTUI_LAYOUT_UPDATES_SCHEMA = "swiftui-layout-updates";
const SWIFTUI_UPDATE_GROUPS_SCHEMA = "swiftui-update-groups";

const SWIFTUI_SCHEMAS = new Set([
  SWIFTUI_UPDATES_SCHEMA,
  SWIFTUI_CHANGES_SCHEMA,
  SWIFTUI_CAUSES_SCHEMA,
  SWIFTUI_FULL_CAUSES_SCHEMA,
  SWIFTUI_LAYOUT_UPDATES_SCHEMA,
  SWIFTUI_UPDATE_GROUPS_SCHEMA,
]);

const swiftUILens: Lens = {
  instruments: [...SWIFTUI_SCHEMAS],

  registerTools(_server: McpServer): void {
    // No lens-specific tools — core verbs (query, aggregate, find) work directly on these schemas.
  },

  nextActions(_sessionId: string, schema: string, _run: number): NextAction[] {
    if (!SWIFTUI_SCHEMAS.has(schema)) return [];
    return [];
  },

  quickStart(schemas: string[], sessionId: string, run: number): QuickStart | null {
    if (schemas.includes(SWIFTUI_UPDATES_SCHEMA)) {
      // swiftui-updates has: duration, downstream-cost, view-name, severity, update-type, module, root-causes
      // Sort by downstream-cost (total impact including children) to find the most expensive updates.
      return {
        schema: SWIFTUI_UPDATES_SCHEMA,
        tool: "query",
        args: {
          sessionId,
          schema: SWIFTUI_UPDATES_SCHEMA,
          run,
          sort: { by: "downstream-cost", dir: "desc" },
          limit: 20,
        },
        hint: "SwiftUI trace — sorted by downstream-cost reveals the most expensive updates by total subtree impact; check view-name for which view, severity for importance, and root-causes for what triggered it. Follow up with swiftui-changes to see the state mutations that caused the worst offenders.",
      };
    }

    if (schemas.includes(SWIFTUI_LAYOUT_UPDATES_SCHEMA)) {
      // swiftui-layout-updates has: duration, self-duration, cached (boolean), view-name, severity
      // Uncached layout passes are the expensive ones — sort by duration to find the worst.
      return {
        schema: SWIFTUI_LAYOUT_UPDATES_SCHEMA,
        tool: "query",
        args: {
          sessionId,
          schema: SWIFTUI_LAYOUT_UPDATES_SCHEMA,
          run,
          sort: { by: "duration", dir: "desc" },
          limit: 20,
        },
        hint: "SwiftUI layout trace — sorted by duration shows the most expensive layout passes; cached=false rows are uncached (most costly); compare duration vs self-duration to see how much of the cost is from child layout vs this view alone.",
      };
    }

    return null;
  },
};

export default swiftUILens;
