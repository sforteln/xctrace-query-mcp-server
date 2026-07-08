// Tool description format: see the comment above createServer() in src/index.ts.
// Enforced by tests/driftGuard.test.ts — verb-led openers, ⚠️ Not for blocks, no stale identifiers.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Lens, QuickStart } from "../types.js";
import type { NextAction } from "../../core/response.js";

const OS_LOG_SCHEMA = "os-log";

/**
 * PMT:full-trace's confirmed watchlist (audited across 19 real traces of ONE
 * app, PromptManager) — the subsystem/category pair a real Hangs-bundling
 * template (SwiftUI, Time Profiler, Swift Concurrency, Animation Hitches)
 * scopes its own os-log capture to. NOT confirmed universal/exhaustive across
 * apps with different framework dependencies (full-trace item 7, still open)
 * — treat this as the best confirmed approximation today, not a guarantee.
 */
const RUNTIME_ISSUES_SUBSYSTEM = "com.apple.runtime-issues";
const RUNTIME_ISSUES_CATEGORIES = ["Hang Risk", "Severe Hang Risk", "CFNetwork", "Contacts", "CoreML"];

/**
 * PMT:birch-river: bare os_log (however it ended up in the recording — the
 * Hangs-fidelity mitigation, or a caller's own explicit composition) comes
 * back completely UNSCOPED on subsystem/category — confirmed live, real
 * traces show it mixed with unrelated system logging (com.apple.network,
 * com.apple.iCloudQuota, com.apple.DesktopServices in one 30s test). A real
 * template's own os-log capture is ALREADY scoped to one of a handful of
 * per-template watchlists (this one for Hangs; Points of Interest, Foundation
 * Models, and Network each have their own DIFFERENT scope per full-trace's
 * mapping) — filtering to this watchlist is therefore safe to default to
 * regardless of how os-log arrived: a no-op against an already-scoped
 * template capture, and an APPROXIMATION (not an exact match — xctrace gives
 * no way to apply a template's exact scope to a bare instrument) against an
 * unscoped bare one.
 */
function runtimeIssuesFinder(sessionId: string, run: number): NextAction {
  return {
    tool: "find",
    args: {
      sessionId,
      schema: OS_LOG_SCHEMA,
      run,
      where: [
        { col: "subsystem", op: "eq", val: RUNTIME_ISSUES_SUBSYSTEM },
        { anyOf: RUNTIME_ISSUES_CATEGORIES.map((category) => ({ col: "category", op: "eq", val: category })) },
      ],
    },
    description:
      `Approximates a real Hangs-bundling template's own curated os-log scope: subsystem ` +
      `"${RUNTIME_ISSUES_SUBSYSTEM}" and category in [${RUNTIME_ISSUES_CATEGORIES.join(", ")}] — the confirmed ` +
      "watchlist for main-thread hang risk / framework misuse (Hang Risk, Severe Hang Risk, CFNetwork, " +
      "Contacts, CoreML). NOT confirmed exhaustive across every app (audited against one app's traces) — " +
      "call find/query on 'os-log' with no filter to see everything actually captured if this comes back empty " +
      "and a hang is still suspected.",
  };
}

const osLogLens: Lens = {
  instruments: [OS_LOG_SCHEMA],

  registerTools(_server: McpServer): void {
    // No lens-specific tools — this is a curated find() default, not new tool surface (PMT:full-trace item 2).
  },

  nextActions(
    sessionId: string,
    schema: string,
    run: number
  ): NextAction[] {
    if (schema !== OS_LOG_SCHEMA) return [];
    return [runtimeIssuesFinder(sessionId, run)];
  },

  quickStart(schemas: string[], sessionId: string, run: number): QuickStart | null {
    if (!schemas.includes(OS_LOG_SCHEMA)) return null;
    const action = runtimeIssuesFinder(sessionId, run);
    return {
      schema: OS_LOG_SCHEMA,
      tool: action.tool,
      args: action.args,
      hint: action.description,
    };
  },
};

export default osLogLens;
