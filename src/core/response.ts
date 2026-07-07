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
  /**
   * Set on the single best-guess pick, when there is one (PMT:spare-goat).
   * Never fabricate a strict ranking of the whole list otherwise — at most
   * ONE entry carries this flag; every other entry is a plain, unranked
   * alternative. Absent (not `false`) on every non-recommended entry.
   */
  recommended?: true;
}

/**
 * Merge a single best-guess recommendation into a plain alternatives list,
 * flagging it `recommended: true` — the one-ranked-list shape PMT:spare-goat
 * replaced `suggestedStart` + a separate `nextActions` with. Collapsing these
 * into one array removes the old "is suggestedStart the top of nextActions,
 * or a different thing?" reconciliation cost for the caller, while keeping
 * the "one clear pick + a menu of alternatives" value the split used to
 * provide (recommended IS the single winner — see PMT:pure-hail for how a
 * fired detector becomes this same entry). `recommended` may be null (no
 * lens/detector had a pick for this trace/schema) — in that case this is a
 * plain passthrough of `alternatives`, matching mcp-server-design's "don't
 * fabricate a ranking you can't justify."
 */
export function withRecommended(recommended: NextAction | null, alternatives: NextAction[]): NextAction[] {
  if (!recommended) return alternatives;
  return [{ ...recommended, recommended: true }, ...alternatives];
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
      description: "List all schemas with documentation and cross-run diffs — use when no nextAction is flagged recommended or none match your goal.",
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

/** Actions available after describing a schema — pre-filled with the schema's
 *  own role-derived suggestions so the agent can query/aggregate immediately. */
export function actionsAfterDescribeSchema(
  sessionId: string,
  schema: string,
  run: number,
  opts: { primaryWeight: string | null; groupByCandidate: string | null; hasBacktrace: boolean }
): NextAction[] {
  // Both candidates below are already bounded-by-construction regardless of
  // table size (query: LIMIT 20, no sort; aggregate: bounded by distinct
  // group count) — there's no risky unbounded-sort shape to guard against
  // here (unlike a lens quickStart's own recommendation; see PMT:spare-goat).
  // The pick is about which is more ACTIONABLE: a real weight column makes
  // "top N by weight" answerable (this project's own stated workhorse
  // question), so aggregate wins when primaryWeight is known; otherwise a
  // plain page is the more useful default.
  const queryAction: NextAction = {
    tool: "query",
    args: { sessionId, schema, run, limit: 20 },
    description: "Fetch a bounded first page of rows (summaries first).",
  };
  const aggregateAction: NextAction = {
    tool: "aggregate",
    args: {
      sessionId,
      schema,
      run,
      groupBy: opts.groupByCandidate ?? "<label-mnemonic>",
      measure: opts.primaryWeight ?? "<weight-mnemonic>",
      op: opts.primaryWeight ? "sum" : "count",
      topN: 10,
    },
    description: opts.primaryWeight
      ? `Top N by weight: sum ${opts.primaryWeight} grouped by ${opts.groupByCandidate ?? "a label column"}.`
      : `Top N by count grouped by ${opts.groupByCandidate ?? "a label column"} (no measure column — counts rows).`,
  };
  const [recommended, alternative] = opts.primaryWeight
    ? [aggregateAction, queryAction]
    : [queryAction, aggregateAction];
  const actions: NextAction[] = withRecommended(recommended, [alternative]);

  if (opts.hasBacktrace) {
    actions.push({
      tool: "call_tree",
      args: { sessionId, schema, run },
      description: "Build a folded call tree from the resolved backtraces (sample-based instruments).",
    });
  }
  actions.push({
    tool: "get_row",
    args: { sessionId, schema, run, rowIndex: 0 },
    description: opts.hasBacktrace
      ? "Fetch one row's full detail including resolved backtrace."
      : "Fetch one row's full detail (this schema has no backtrace column).",
  });
  return actions;
}

/** Actions available after an aggregate call — drill into a specific group. */
export function actionsAfterAggregate(
  sessionId: string,
  schema: string,
  run: number,
  groupBy: string | string[],
  topKey: string | null,
  hasBacktrace: boolean
): NextAction[] {
  // A composite groupBy's topKey is a " / "-joined string across every key
  // part (aggregate.ts's AggregateGroup.key) — not a single field's value, so
  // it can't safely pre-fill a single-field equality filter the way a plain
  // string groupBy's topKey can. Only pre-fill for the single-column case.
  const singleGroupBy = typeof groupBy === "string" ? groupBy : null;
  const actions: NextAction[] = [
    {
      tool: "query",
      args: {
        sessionId,
        schema,
        run,
        ...(singleGroupBy && topKey ? { filter: { [singleGroupBy]: topKey } } : {}),
        limit: 20,
      },
      description: singleGroupBy && topKey
        ? `Query rows for the top group "${topKey}" to see individual samples.`
        : "Query all rows in this table.",
    },
    {
      tool: "aggregate",
      args: { sessionId, schema, run, groupBy: "<different-mnemonic>", measure: "<mnemonic>", op: "sum", topN: 10 },
      description: "Re-aggregate by a different column to slice the data another way.",
    },
  ];
  if (hasBacktrace) {
    actions.push({
      tool: "call_tree",
      args: { sessionId, schema, run },
      description: "Build a folded call tree aggregating all samples.",
    });
  }
  return actions;
}

/** Actions available after getting full row detail. */
export function actionsAfterGetRow(
  sessionId: string,
  schema: string,
  run: number,
  rowIndex: number,
  totalRows: number,
  hasBacktrace: boolean
): NextAction[] {
  const actions: NextAction[] = [
    {
      tool: "query",
      args: { sessionId, schema, run, limit: 20 },
      description: "Return to the paginated row list.",
    },
    {
      tool: "aggregate",
      args: { sessionId, schema, run, groupBy: "<mnemonic>", measure: "<mnemonic>", op: "sum", topN: 10 },
      description: "Summarise the whole table — find heaviest rows by weight.",
    },
  ];
  if (rowIndex + 1 < totalRows) {
    actions.push({
      tool: "get_row",
      args: { sessionId, schema, run, rowIndex: rowIndex + 1 },
      description: "Fetch the next row's full detail.",
    });
  }
  if (hasBacktrace) {
    actions.push({
      tool: "call_tree",
      args: { sessionId, schema, run },
      description: "Build a folded call tree aggregating all samples in this table.",
    });
  }
  return actions;
}

/** Actions available after querying or aggregating a table. */
export function actionsAfterQuery(
  sessionId: string,
  schema: string,
  run: number,
  hasMore: boolean,
  hasBacktrace: boolean
): NextAction[] {
  const actions: NextAction[] = [
    {
      tool: "get_row",
      args: { sessionId, schema, run, rowIndex: 0 },
      description: hasBacktrace
        ? "Fetch the full detail for a specific row including resolved backtrace."
        : "Fetch the full detail for a specific row (this schema has no backtrace column).",
    },
    {
      tool: "aggregate",
      args: { sessionId, schema, run, groupBy: "<mnemonic>", measure: "<mnemonic>", op: "sum", topN: 10 },
      description: "Summarise by grouping — find hot functions, biggest allocations, slowest intervals.",
    },
    {
      tool: "find",
      args: {
        sessionId,
        schema,
        run,
        where: [{ col: "<mnemonic>", op: "eq", val: "<value>" }],
      },
      description: "Filter rows with richer predicates (eq/gt/contains/regex/is-null…).",
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

/** Actions available after a find call — drill into matches or refine. */
export function actionsAfterFind(
  sessionId: string,
  schema: string,
  run: number,
  matchCount: number,
  hasMore: boolean,
  firstTableIndex: number | null
): NextAction[] {
  const actions: NextAction[] = [];
  if (hasMore) {
    actions.push({
      tool: "find",
      args: {
        sessionId,
        schema,
        run,
        where: "<same-where>",
        offset: "<next-offset>",
      },
      description: "Fetch the next page of matching rows.",
    });
  }
  if (firstTableIndex !== null) {
    actions.push({
      tool: "get_row",
      args: { sessionId, schema, run, rowIndex: firstTableIndex },
      description: "Fetch full detail for the first matching row.",
    });
  }
  actions.push(
    {
      tool: "aggregate",
      args: { sessionId, schema, run, groupBy: "<mnemonic>", measure: "<mnemonic>", op: "sum", topN: 10 },
      description: "Summarise the matching rows by any column — group by error type, thread, etc.",
    },
    {
      tool: "query",
      args: { sessionId, schema, run, limit: 20 },
      description: "Browse all rows without a predicate filter.",
    }
  );
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
