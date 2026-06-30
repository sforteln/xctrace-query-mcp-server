import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Lens, QuickStart } from "./types.js";
import type { NextAction } from "../core/response.js";

export class LensRegistry {
  private readonly byInstrument = new Map<string, Lens>();
  private readonly allLenses: Lens[] = [];

  /**
   * Register a lens. Its schema names are indexed for fast lookup.
   * Does not call registerTools — do that separately against the McpServer.
   */
  register(lens: Lens): void {
    this.allLenses.push(lens);
    for (const instrument of lens.instruments) {
      this.byInstrument.set(instrument, lens);
    }
  }

  /** Return the lens for a schema, or null if none is registered. */
  get(schema: string): Lens | null {
    return this.byInstrument.get(schema) ?? null;
  }

  /**
   * Register all known lenses and their MCP tools in one call.
   * Call this in createServer() before connecting the transport.
   */
  registerAll(lenses: Lens[], server: McpServer): void {
    for (const lens of lenses) {
      this.register(lens);
      lens.registerTools(server);
    }
  }

  /**
   * Return lens-specific nextActions for a schema, or [] if no lens is
   * registered for it. Safe to spread into any nextActions array.
   */
  nextActions(sessionId: string, schema: string, run: number): NextAction[] {
    return this.get(schema)?.nextActions(sessionId, schema, run) ?? [];
  }

  /**
   * Return a suggestedStart from the first lens that recognises the given
   * schema names, or null if no lens matches. Used by open_trace to give the
   * agent a cheap, pre-filled next call without any intermediate navigation.
   */
  quickStart(schemas: string[], sessionId: string, run: number): QuickStart | null {
    for (const lens of this.allLenses) {
      const result = lens.quickStart?.(schemas, sessionId, run);
      if (result) return { ...result, forRun: run };
    }
    return null;
  }
}

/** Process-wide singleton — import this everywhere. */
export const registry = new LensRegistry();
