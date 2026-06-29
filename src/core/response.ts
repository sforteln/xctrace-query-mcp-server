/**
 * Shared response envelope for every instruments-mcp-server tool.
 *
 * The envelope wraps any tool payload with a `nextActions` array so an agent
 * can navigate an unfamiliar trace without knowing its schema. Every tool
 * populates nextActions with the valid follow-up calls given the current state,
 * including which per-instrument lens verbs apply (those are injected by lenses
 * in later work — the core layer advertises the universal verbs only).
 *
 * Progressive disclosure: large payloads are summarised first (summaryOnly:true)
 * with a hint telling the agent how to request the full version. Full text is
 * only returned when explicitly asked for.
 */

/** One suggested follow-up call. */
export interface NextAction {
  /** The MCP tool name to call. */
  tool: string;
  /** Suggested argument values — partial; the agent fills in the rest. */
  args: Record<string, unknown>;
  /** One-line description of what this call does / why it is useful here. */
  description: string;
}

/** The shared envelope every tool returns. */
export interface ToolResponse<T = unknown> {
  /** The actual result payload. */
  data: T;
  /** Valid follow-up calls the agent can make from this point. */
  nextActions: NextAction[];
  /**
   * Present when this response is a summary/preview of a larger result.
   * The agent should call the `nextActions` hint to get the full version.
   */
  truncated?: true;
  /** Human-readable guidance when truncated is set. */
  truncationHint?: string;
}

// ─── nextActions builders ─────────────────────────────────────────────────────
// Each builder returns the NextAction entries relevant at a given point in the
// navigation flow. Lens verbs are injected by the lens framework later; these
// are the universal core verbs only.

/** Actions available immediately after openTrace — before any table is fetched. */
export function actionsAfterOpen(sessionId: string): NextAction[] {
  return [
    {
      tool: "list_instruments",
      args: { sessionId },
      description: "List all instruments and schemas in this trace with row counts.",
    },
    {
      tool: "describe_schema",
      args: { sessionId, schema: "<schema-name>", run: 1 },
      description: "Inspect a schema's columns and their inferred roles (time/weight/backtrace/thread/label).",
    },
    {
      tool: "query",
      args: { sessionId, schema: "<schema-name>", run: 1, limit: 20 },
      description: "Fetch rows from a table (summaries first; use getRow for full detail).",
    },
    {
      tool: "aggregate",
      args: { sessionId, schema: "<schema-name>", run: 1, groupBy: "<mnemonic>", measure: "<mnemonic>", op: "sum", topN: 10 },
      description: "Find the heaviest rows by weight (top N by sum/count/avg) — the workhorse for most profiling questions.",
    },
  ];
}

/** Actions available after listing instruments. */
export function actionsAfterListInstruments(sessionId: string, schemas: string[], run: number): NextAction[] {
  const first = schemas[0] ?? "<schema-name>";
  return [
    {
      tool: "describe_schema",
      args: { sessionId, schema: first, run },
      description: `Inspect columns and roles for ${first} (or any other listed schema).`,
    },
    {
      tool: "aggregate",
      args: { sessionId, schema: first, run, groupBy: "<mnemonic>", measure: "<mnemonic>", op: "sum", topN: 10 },
      description: "Find the heaviest rows in any schema — substitute the schema you want to drill into.",
    },
    {
      tool: "query",
      args: { sessionId, schema: first, run, limit: 20 },
      description: "Fetch raw rows from any listed schema.",
    },
  ];
}

/** Actions available after querying or aggregating a table. */
export function actionsAfterQuery(sessionId: string, schema: string, run: number, hasMore: boolean): NextAction[] {
  const actions: NextAction[] = [
    {
      tool: "get_row",
      args: { sessionId, schema, run, rowIndex: 0 },
      description: "Fetch the full detail for a specific row including resolved backtrace.",
    },
    {
      tool: "aggregate",
      args: { sessionId, schema, run, groupBy: "<mnemonic>", measure: "<mnemonic>", op: "sum", topN: 10 },
      description: "Summarise by grouping — find hot functions, biggest allocations, slowest intervals.",
    },
    {
      tool: "find",
      args: { sessionId, schema, run, where: { "<mnemonic>": "<value>" } },
      description: "Filter rows by column value.",
    },
  ];
  if (hasMore) {
    actions.unshift({
      tool: "query",
      args: { sessionId, schema, run, offset: "<next-offset>", limit: 20 },
      description: "Fetch the next page of rows.",
    });
  }
  return actions;
}

// ─── Envelope helper ──────────────────────────────────────────────────────────

/** Wrap a tool result in the standard envelope. */
export function envelope<T>(
  data: T,
  nextActions: NextAction[],
  truncation?: { truncated: true; hint: string }
): ToolResponse<T> {
  return {
    data,
    nextActions,
    ...(truncation ?? {}),
  };
}

/** Serialise a ToolResponse to the MCP text content block format. */
export function toMcpText(response: ToolResponse): string {
  return JSON.stringify(response, null, 2);
}
