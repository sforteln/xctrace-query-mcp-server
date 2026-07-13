/**
 * listFmRequests — compact one-liner per FM inference row.
 *
 * Each user request to the Foundation Models instrument generates two rows:
 *   - Yellow (color) / "NPrompt" (resolve): the initial inference for the prompt
 *   - Orange (color) / "NResolve" (resolve): the resolution/tool-call step
 *
 * listRequests surfaces both rows as one-liners so the agent can quickly scan
 * which requests were slow, had errors, or triggered re-prompting.
 */
import { getTable, getDb, lastRun as sessionLastRun } from "../../engine/session.js";
import { fmtCol, rawCol, resolveInternedDisplayValues, makeInternResolver } from "../../engine/sqlHydrate.js";
import { quoteIdent, ROW_IDX_COLUMN } from "../../engine/sqliteStore.js";

export const FM_SCHEMA = "ModelInferenceTable";

const PROMPT_SNIPPET_LEN = 80;

export interface FmRequestRow {
  /** Position in returned page. */
  index: number;
  /** Raw table index — pass to get_row for full detail. */
  tableIndex: number;
  startTime: string | null;
  duration: string | null;
  agentName: string | null;
  /** First 80 chars of the prompt column. */
  promptSnippet: string | null;
  totalTokens: string | null;
  promptTokens: string | null;
  responseTokens: string | null;
  /** Tokens served from cache instead of re-encoded — 0 here is a missed-caching signal. */
  cachedTokens: string | null;
  /** Numeric error count — >0 means hasError. */
  errorCount: number;
  hasError: boolean;
  /** Phase indicator: "1Prompt", "1Resolve", "2Prompt", … */
  resolve: string | null;
  /** Instruments timeline colour: "Yellow" = prompt phase, "Orange" = resolve phase. */
  color: string | null;
}

export interface ListFmRequestsResult {
  schema: typeof FM_SCHEMA;
  run: number;
  totalRows: number;
  returnedRows: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  requests: FmRequestRow[];
}

export interface ListFmRequestsOptions {
  run?: number;
  limit?: number;
  offset?: number;
}

export async function listFmRequests(
  sessionId: string,
  opts: ListFmRequestsOptions = {}
): Promise<ListFmRequestsResult> {
  const run = opts.run ?? sessionLastRun(sessionId);
  const offset = opts.offset ?? 0;
  const limit = Math.min(opts.limit ?? 50, 200);

  const handle = await getTable(sessionId, run, FM_SCHEMA);
  const db = await getDb(sessionId);
  const totalRows = handle.rowCount;

  // A direct scoped page — SELECT only the fmt/raw columns this one-liner
  // needs, LIMIT/OFFSET at the SQL layer — instead of fetchAllRowsHydrated's
  // whole-table fetch (see howLensesWork.md's "Lenses use bespoke scoped SQL"
  // note). Natural table order (no sort param here), so tableIndex is exactly
  // _row_idx, matching the prior offset+pageIdx.
  const FMT_FIELDS = ["start", "duration", "agent-name", "prompt", "total-tokens", "prompt-tokens", "response-tokens", "cached-tokens", "resolve", "color"];
  const selectCols = [
    quoteIdent(ROW_IDX_COLUMN),
    ...FMT_FIELDS.map((m) => `${quoteIdent(fmtCol(m))} AS ${quoteIdent(`__out_${m}`)}`),
    `${quoteIdent(rawCol("error-count"))} AS __raw_error_count`,
  ];
  const pageStmt = db.prepare(
    `SELECT ${selectCols.join(", ")} FROM ${quoteIdent(handle.tableName)} ` +
      `ORDER BY ${quoteIdent(ROW_IDX_COLUMN)} ASC LIMIT ? OFFSET ?`
  );
  let page = pageStmt.all(limit, offset) as Record<string, unknown>[];
  // prompt (and other one-liner fields) can be a large interned value: a large
  // repeated blob (e.g. prompt text) is stored on disk as a short sentinel
  // token pointing into a dedup side table rather than the literal string, to
  // avoid duplicating it across every row that shares it. Resolve the display
  // columns back to their real content before snippeting, or the snippet would
  // be the literal token instead of the prompt text.
  page = resolveInternedDisplayValues(page, FMT_FIELDS, makeInternResolver(db));

  const requests: FmRequestRow[] = page.map((row, pageIdx) => {
    const errorRaw = row.__raw_error_count;
    const errorCount = typeof errorRaw === "number" ? errorRaw : Number(errorRaw ?? 0);

    const promptFmt = row.__out_prompt as string | null;
    const promptSnippet = promptFmt
      ? promptFmt.length > PROMPT_SNIPPET_LEN
        ? promptFmt.slice(0, PROMPT_SNIPPET_LEN) + "…"
        : promptFmt
      : null;

    return {
      index: offset + pageIdx,
      tableIndex: row[ROW_IDX_COLUMN] as number,
      startTime: row.__out_start as string | null,
      duration: row.__out_duration as string | null,
      agentName: row["__out_agent-name"] as string | null,
      promptSnippet,
      totalTokens: row["__out_total-tokens"] as string | null,
      promptTokens: row["__out_prompt-tokens"] as string | null,
      responseTokens: row["__out_response-tokens"] as string | null,
      cachedTokens: row["__out_cached-tokens"] as string | null,
      errorCount,
      hasError: errorCount > 0,
      resolve: row.__out_resolve as string | null,
      color: row.__out_color as string | null,
    };
  });

  return {
    schema: FM_SCHEMA,
    run,
    totalRows,
    returnedRows: requests.length,
    offset,
    limit,
    hasMore: offset + requests.length < totalRows,
    requests,
  };
}
