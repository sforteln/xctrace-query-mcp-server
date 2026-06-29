import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NextAction } from "../core/response.js";

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
}
