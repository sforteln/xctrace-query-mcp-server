import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NextAction } from "../core/response.js";
import type { CellDetail } from "../core/getRow.js";

/**
 * Structured entry-point recommendation returned by a lens's quickStart() hook.
 * Folded into the open_trace response's `nextActions` as the single entry
 * flagged `recommended: true` (`core/response.ts`'s `withRecommended`) so the
 * agent can make the right second call without any intermediate navigation,
 * without a separate `suggestedStart` field that used to duplicate the top
 * of that same list. See howLensesWork.md's `quickStart` section for why the
 * two fields were merged.
 */
export interface QuickStart {
  /** Schema the agent should focus on. */
  schema: string;
  /** MCP tool to call next. */
  tool: string;
  /** Ready-to-use args for that tool (sessionId and run already filled in). */
  args: Record<string, unknown>;
  /** One-line explanation for the agent: what this call surfaces and why. */
  hint: string;
  /**
   * The run number this suggestion targets (same as args.run).
   * Stamped by the registry from the run parameter — lenses omit this field.
   * If the user or agent wants to inspect a different run, discard this
   * recommendation and call list_instruments with the desired run number instead.
   */
  forRun?: number;
}

/**
 * A lens is optional ergonomic sugar over the universal core verbs.
 *
 * Each lens declares which Instruments schema names it handles (e.g.
 * ["ModelInferenceTable"] for the Foundation Models lens). It registers its
 * own MCP tools at startup via registerTools(), and contributes domain-specific
 * nextAction suggestions that are appended to every core verb response for its
 * schemas.
 *
 * Lenses are purely additive — schemas with no lens fall through to the core
 * and always remain navigable.
 */
export interface Lens {
  /** Schema/instrument names this lens handles. */
  readonly instruments: readonly string[];

  /**
   * Register this lens's MCP tools on the server. Called once at startup
   * before the server connects its transport.
   */
  registerTools(server: McpServer): void;

  /**
   * Domain-specific next actions to append to any core verb response when
   * the active schema matches this lens. Keep these brief — the core verbs
   * already provide the generic options.
   */
  /**
   * All schema names present in `run` — enables cross-instrument suggestions
   * (e.g. Leaks offering Allocations queries only when Allocations is present).
   *
   * `row` is present only when called from get_row (a specific row was just
   * fetched) — absent from query/aggregate/find, which have no single row in
   * context. Use it to pre-fill a concrete next call with a real value from
   * this row (e.g. joining a leak's `address` into an Allocations filter)
   * instead of a generic schema-level suggestion.
   */
  nextActions(
    sessionId: string,
    schema: string,
    run: number,
    allSchemas: string[],
    row?: Record<string, CellDetail | null>
  ): NextAction[];

  /**
   * Optional: return a cheap entry-point recommendation for open_trace based
   * on schema names alone — no data fetch, no xctrace calls. The registry
   * calls this for every registered lens and returns the first non-null
   * result, folded into open_trace's `nextActions` as the one entry flagged
   * `recommended: true`.
   *
   * Because this runs from schema names alone, before any row count is known,
   * prefer a call that's bounded-by-construction regardless of table size
   * (an aggregate/lens tool) over a raw sorted query with no filter/timeRange
   * bound — a full-table ORDER BY is a real latency (and, in an earlier version
   * of this server before verbs read via SQL against an ingested table instead
   * of a JS array, an OOM) risk on a large table, and this hook has no cheap
   * way to tell big from small up front. This isn't hypothetical: swiftUI's own
   * quickStart used to recommend exactly this raw-sort shape, and that schema
   * is the one that crashed the server at 736,282 rows in production — see
   * howLensesWork.md's `quickStart` section for the full story and the list of
   * lenses (swiftUI, coreData, hangs, thermal, leaks) that follow this rule.
   *
   * Implement this when the lens can identify its instrument from schema names
   * and knows a single tool call that surfaces the key finding immediately.
   * Return null when this lens's schemas are not present.
   */
  quickStart?(schemas: string[], sessionId: string, run: number): QuickStart | null;
}
