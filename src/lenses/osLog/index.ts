// Tool description format: see the comment above createServer() in src/index.ts.
// Enforced by tests/driftGuard.test.ts — verb-led openers, ⚠️ Not for blocks, no stale identifiers.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Lens, QuickStart } from "../types.js";
import type { NextAction } from "../../core/response.js";

const OS_LOG_SCHEMA = "os-log";

/**
 * The confirmed watchlist (audited across 19 real traces of one app — see
 * adviceCaptureLog.md for the full os_log investigation) — the subsystem/
 * category pair a real Hangs-bundling template (SwiftUI, Time Profiler, Swift
 * Concurrency, Animation Hitches) scopes its own os-log capture to. NOT
 * confirmed universal/exhaustive across apps with different framework
 * dependencies — treat this as the best confirmed approximation today, not a
 * guarantee.
 *
 * Confirmed live (2026-07-10) straight from a real trace's own TOC: a full
 * Hangs template's xctrace export ALREADY materializes this exact scope as a
 * dedicated os-log table instance (`<table message-type="Fault" schema="os-log"
 * category="&quot;Hang Risk&quot; &quot;Severe Hang Risk&quot; CFNetwork Contacts
 * CoreML" subsystem="&quot;com.apple.runtime-issues&quot;"/>`) — so `message-
 * type: "Fault"` (capital F) is the real, exact value, not a guess.
 */
const RUNTIME_ISSUES_SUBSYSTEM = "com.apple.runtime-issues";
const RUNTIME_ISSUES_MESSAGE_TYPE = "Fault";
const RUNTIME_ISSUES_CATEGORIES = ["Hang Risk", "Severe Hang Risk", "CFNetwork", "Contacts", "CoreML"];

/**
 * Bare os_log (however it ended up in the recording — the Hangs-fidelity
 * mitigation, or a caller's own explicit composition) comes back completely
 * UNSCOPED on subsystem/category — confirmed live, real
 * traces show it mixed with unrelated system logging (com.apple.network,
 * com.apple.iCloudQuota, com.apple.DesktopServices in one 30s test). A real
 * template's own os-log capture is ALREADY scoped to one of a handful of
 * per-template watchlists (this one for Hangs; Points of Interest, Foundation
 * Models, and Network each have their own DIFFERENT confirmed scope, not
 * covered by this lens) — filtering to this watchlist is therefore safe to
 * default to regardless of how os-log arrived: a no-op against an already-scoped
 * template capture, and an APPROXIMATION (not an exact match — xctrace gives
 * no way to apply a template's exact scope to a bare instrument) against an
 * unscoped bare one.
 *
 * IMPORTANT — this is the FALLBACK path, not the primary one: a real Hangs
 * template already produces a dedicated `hang-risks` schema (confirmed live —
 * its own TOC entry, own columns: time/process/message/severity/event-type/
 * backtrace/thread) that IS Apple's already-fully-processed output — fault-
 * filtered, main-thread-gated (via System Trace's runloop-events `is-main`,
 * see aidocs/appleModelerHarvest.md §3), and severity-labeled, with zero
 * approximation needed. `hang-risks` only fails to populate when Hangs was
 * composed BARE (see queryHints.ts's note on this schema) — THAT's the one
 * case this function's raw-os-log approximation actually earns its keep.
 * Prefer querying `hang-risks` directly whenever it's present in the trace;
 * this function does not (yet) check for that itself — see the caller.
 *
 * This approximation still can't replicate the main-thread gate at all (no
 * join against runloop-events implemented here — and that schema may not
 * even be present unless System Trace-family instrumentation was recorded
 * too), so even with the subsystem/message-type/category filter tightened to
 * match Apple's real rule, this can still surface non-main-thread rows that
 * the real `hang-risks` schema would have excluded. Documented limitation,
 * not fixed here.
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
        { col: "message-type", op: "eq", val: RUNTIME_ISSUES_MESSAGE_TYPE },
        { anyOf: RUNTIME_ISSUES_CATEGORIES.map((category) => ({ col: "category", op: "eq", val: category })) },
      ],
    },
    description:
      `Approximates a real Hangs-bundling template's own curated os-log scope: subsystem ` +
      `"${RUNTIME_ISSUES_SUBSYSTEM}", message-type "${RUNTIME_ISSUES_MESSAGE_TYPE}", and category in ` +
      `[${RUNTIME_ISSUES_CATEGORIES.join(", ")}] — the confirmed watchlist for main-thread hang risk / ` +
      "framework misuse (Hang Risk, Severe Hang Risk, CFNetwork, Contacts, CoreML). If schema 'hang-risks' " +
      "is present in this trace, query that directly instead — it's Apple's own already-processed output " +
      "(fault-filtered AND main-thread-gated), not an approximation. This filter can't replicate the main-" +
      "thread gate (no join against runloop-events), so it may over-include non-main-thread rows. NOT " +
      "confirmed exhaustive across every app (audited against one app's traces) — call find/query on " +
      "'os-log' with no filter to see everything actually captured if this comes back empty and a hang is " +
      "still suspected.",
  };
}

const osLogLens: Lens = {
  instruments: [OS_LOG_SCHEMA],

  registerTools(_server: McpServer): void {
    // No lens-specific tools — the confirmed watchlist above is expressed as
    // curated args to the existing find() verb, not new tool surface; see
    // howLensesWork.md's `registerTools` section for when a lens does vs.
    // doesn't need its own tools.
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
