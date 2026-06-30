import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NextAction } from "../core/response.js";

/**
 * Structured entry-point recommendation returned by a lens's quickStart() hook.
 * Placed in the open_trace response as `suggestedStart` so the agent can make
 * the right second call without any intermediate navigation.
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
  nextActions(sessionId: string, schema: string, run: number): NextAction[];

  /**
   * Optional: return a cheap entry-point recommendation for open_trace based
   * on schema names alone — no data fetch, no xctrace calls. The registry
   * calls this for every registered lens and returns the first non-null result
   * as `suggestedStart` in the open_trace response.
   *
   * Implement this when the lens can identify its instrument from schema names
   * and knows a single tool call that surfaces the key finding immediately.
   * Return null when this lens's schemas are not present.
   */
  quickStart?(schemas: string[], sessionId: string, run: number): QuickStart | null;
}
