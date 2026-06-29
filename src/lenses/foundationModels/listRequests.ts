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
import { getTable, lastRun as sessionLastRun } from "../../engine/session.js";

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

  const table = await getTable(sessionId, run, FM_SCHEMA);
  const totalRows = table.rows.length;
  const page = table.rows.slice(offset, offset + limit);

  const requests: FmRequestRow[] = page.map((row, pageIdx) => {
    const errorRaw = row["error-count"]?.raw;
    const errorCount = typeof errorRaw === "number" ? errorRaw : Number(errorRaw ?? 0);

    const promptFmt = row["prompt"]?.fmt ?? null;
    const promptSnippet = promptFmt
      ? promptFmt.length > PROMPT_SNIPPET_LEN
        ? promptFmt.slice(0, PROMPT_SNIPPET_LEN) + "…"
        : promptFmt
      : null;

    return {
      index: offset + pageIdx,
      tableIndex: offset + pageIdx,
      startTime: row["start"]?.fmt ?? null,
      duration: row["duration"]?.fmt ?? null,
      agentName: row["agent-name"]?.fmt ?? null,
      promptSnippet,
      totalTokens: row["total-tokens"]?.fmt ?? null,
      promptTokens: row["prompt-tokens"]?.fmt ?? null,
      responseTokens: row["response-tokens"]?.fmt ?? null,
      errorCount,
      hasError: errorCount > 0,
      resolve: row["resolve"]?.fmt ?? null,
      color: row["color"]?.fmt ?? null,
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
