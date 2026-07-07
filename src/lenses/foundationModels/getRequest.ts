/**
 * FM drill-down tools: getRequest, getResponse, getEvents.
 *
 * All three take a rowIndex (tableIndex from listRequests) and look up the
 * model-request-id to find related rows in the same request.
 *
 * getRequest — full row detail minus the instructions blob (which can be
 *   several KB of system prompt and drowns the actual inference data).
 *   Use getPrompt() when you explicitly need the instructions.
 *
 * getResponse — parsed response JSON for cleaner reading than the raw string.
 *
 * getEvents — all rows sharing the same model-request-id, ordered by start,
 *   showing the multi-phase timeline (Prompt → Resolve → …).
 */
import type { DatabaseSync } from "node:sqlite";
import { getTable, getDb, lastRun as sessionLastRun } from "../../engine/session.js";
import { fmtCol, rawCol, hydrateNormalizedRow, makeFrameLookup, makeInternResolver } from "../../engine/sqlHydrate.js";
import { quoteIdent, ROW_IDX_COLUMN } from "../../engine/sqliteStore.js";
import type { SqliteTableHandle } from "../../engine/session.js";
import type { NormalizedRow } from "../../engine/parseTable.js";
import { FM_SCHEMA } from "./listRequests.js";

/**
 * A single hydrated row by _row_idx — the same scoped WHERE _row_idx=? lookup
 * get_row.ts uses, NOT fetchAllRowsHydrated's whole-table fetch (PMT:warm-mica).
 * Each of getRequest/getResponse/getPrompt needs exactly one row; there's no
 * reason to hydrate every other row in the table (fmt/raw/children/frame
 * lookups) just to discard all but one.
 */
export function fetchHydratedRow(db: DatabaseSync, handle: SqliteTableHandle, rowIndex: number): NormalizedRow {
  const sqlRow = db
    .prepare(`SELECT * FROM ${quoteIdent(handle.tableName)} WHERE ${quoteIdent(ROW_IDX_COLUMN)} = ?`)
    .get(rowIndex) as Record<string, unknown> | undefined;
  if (!sqlRow) throw new Error(`rowIndex ${rowIndex} out of range (0–${handle.rowCount - 1})`);
  // FM tables hold large interned values (instructions/response/content) —
  // resolve them back on hydration (PMT:lime-bluff).
  return hydrateNormalizedRow(handle.cols, sqlRow, makeFrameLookup(db), makeInternResolver(db));
}

/** Columns excluded from getRequest — the instructions blob. */
const EXCLUDED_FROM_REQUEST = new Set(["instruction", "instructions"]);

export interface FmRequestDetail {
  rowIndex: number;
  requestId: string | null;
  startTime: string | null;
  duration: string | null;
  agentName: string | null;
  turnIndex: string | null;
  sessionIndex: string | null;
  plotLabel: string | null;
  /** Full prompt (not truncated). */
  prompt: string | null;
  /** Parsed response object if JSON, otherwise raw string. */
  response: unknown;
  content: string | null;
  modelInformation: string | null;
  tokens: string | null;
  totalTokens: string | null;
  promptTokens: string | null;
  responseTokens: string | null;
  cachedTokens: string | null;
  resolve: string | null;
  color: string | null;
  errorCount: number;
  hasError: boolean;
  errorMessage: string | null;
  note: string;
}

export interface FmResponseDetail {
  rowIndex: number;
  requestId: string | null;
  resolve: string | null;
  /** Parsed JSON if possible, otherwise the raw string. */
  response: unknown;
}

export interface FmEventRow {
  rowIndex: number;
  startTime: string | null;
  duration: string | null;
  resolve: string | null;
  color: string | null;
  content: string | null;
  errorCount: number;
  hasError: boolean;
}

export interface FmEventsResult {
  requestId: string | null;
  totalEvents: number;
  events: FmEventRow[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tryParseJson(s: string | null): unknown {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return s; }
}

// ─── getRequest ───────────────────────────────────────────────────────────────

export async function getFmRequest(
  sessionId: string,
  rowIndex: number,
  opts: { run?: number } = {}
): Promise<FmRequestDetail> {
  const run = opts.run ?? sessionLastRun(sessionId);
  const handle = await getTable(sessionId, run, FM_SCHEMA);

  if (rowIndex < 0 || rowIndex >= handle.rowCount) {
    throw new Error(`rowIndex ${rowIndex} out of range (0–${handle.rowCount - 1})`);
  }

  const db = await getDb(sessionId);
  const row = fetchHydratedRow(db, handle, rowIndex);

  const errorRaw = row["error-count"]?.raw;
  const errorCount = typeof errorRaw === "number" ? errorRaw : Number(errorRaw ?? 0);
  const errorMessage = row["error-message"]?.fmt ?? null;

  return {
    rowIndex,
    requestId: row["model-request-id"]?.fmt ?? null,
    startTime: row["start"]?.fmt ?? null,
    duration: row["duration"]?.fmt ?? null,
    agentName: row["agent-name"]?.fmt ?? null,
    turnIndex: row["turn-index"]?.fmt ?? null,
    sessionIndex: row["session-index"]?.fmt ?? null,
    plotLabel: row["plot-label"]?.fmt ?? null,
    prompt: row["prompt"]?.fmt ?? null,
    response: tryParseJson(row["response"]?.fmt ?? null),
    content: row["content"]?.fmt ?? null,
    modelInformation: row["model-information"]?.fmt ?? null,
    tokens: row["tokens"]?.fmt ?? null,
    totalTokens: row["total-tokens"]?.fmt ?? null,
    promptTokens: row["prompt-tokens"]?.fmt ?? null,
    responseTokens: row["response-tokens"]?.fmt ?? null,
    cachedTokens: row["cached-tokens"]?.fmt ?? null,
    resolve: row["resolve"]?.fmt ?? null,
    color: row["color"]?.fmt ?? null,
    errorCount,
    hasError: errorCount > 0,
    errorMessage: errorMessage === "N/A" ? null : errorMessage,
    note: "instruction/instructions columns omitted — use get_fm_prompt to read the full system prompt.",
  };
}

// ─── getResponse ──────────────────────────────────────────────────────────────

export async function getFmResponse(
  sessionId: string,
  rowIndex: number,
  opts: { run?: number } = {}
): Promise<FmResponseDetail> {
  const run = opts.run ?? sessionLastRun(sessionId);
  const handle = await getTable(sessionId, run, FM_SCHEMA);

  if (rowIndex < 0 || rowIndex >= handle.rowCount) {
    throw new Error(`rowIndex ${rowIndex} out of range (0–${handle.rowCount - 1})`);
  }

  const db = await getDb(sessionId);
  const row = fetchHydratedRow(db, handle, rowIndex);
  return {
    rowIndex,
    requestId: row["model-request-id"]?.fmt ?? null,
    resolve: row["resolve"]?.fmt ?? null,
    response: tryParseJson(row["response"]?.fmt ?? null),
  };
}

// ─── getEvents ────────────────────────────────────────────────────────────────

export async function getFmEvents(
  sessionId: string,
  rowIndex: number,
  opts: { run?: number } = {}
): Promise<FmEventsResult> {
  const run = opts.run ?? sessionLastRun(sessionId);
  const handle = await getTable(sessionId, run, FM_SCHEMA);

  if (rowIndex < 0 || rowIndex >= handle.rowCount) {
    throw new Error(`rowIndex ${rowIndex} out of range (0–${handle.rowCount - 1})`);
  }

  const db = await getDb(sessionId);
  const table = quoteIdent(handle.tableName);

  // Anchor's model-request-id, via a single scoped row lookup — not a
  // full-table hydration just to read one column of one row (PMT:warm-mica).
  const anchorRow = db
    .prepare(`SELECT ${quoteIdent(fmtCol("model-request-id"))} AS rid FROM ${table} WHERE ${quoteIdent(ROW_IDX_COLUMN)} = ?`)
    .get(rowIndex) as { rid: string | null } | undefined;
  if (!anchorRow) throw new Error(`rowIndex ${rowIndex} out of range (0–${handle.rowCount - 1})`);
  const requestId = anchorRow.rid;

  // All rows sharing the same model-request-id — a scoped SELECT (indexed-or-
  // not, but bounded to the matching rows only, unlike hydrating the whole
  // table), ordered by _row_idx ASC to match the original filter-preserving-
  // array-order behavior.
  const matchRows = db
    .prepare(
      `SELECT ${quoteIdent(ROW_IDX_COLUMN)} AS idx, ${quoteIdent(fmtCol("start"))} AS start, ` +
        `${quoteIdent(fmtCol("duration"))} AS duration, ${quoteIdent(fmtCol("resolve"))} AS resolve, ` +
        `${quoteIdent(fmtCol("color"))} AS color, ${quoteIdent(fmtCol("content"))} AS content, ` +
        `${quoteIdent(rawCol("error-count"))} AS errorRaw ` +
        `FROM ${table} WHERE ${quoteIdent(fmtCol("model-request-id"))} IS ? ORDER BY ${quoteIdent(ROW_IDX_COLUMN)} ASC`
    )
    .all(requestId) as Array<{
      idx: number; start: string | null; duration: string | null; resolve: string | null;
      color: string | null; content: string | null; errorRaw: number | string | null;
    }>;

  const unintern = makeInternResolver(db);
  const events: FmEventRow[] = matchRows.map((row) => {
    const errorCount = typeof row.errorRaw === "number" ? row.errorRaw : Number(row.errorRaw ?? 0);
    return {
      rowIndex: row.idx,
      startTime: row.start,
      duration: row.duration,
      resolve: row.resolve,
      color: row.color,
      content: unintern(row.content) as string | null, // content may be interned (PMT:lime-bluff)
      errorCount,
      hasError: errorCount > 0,
    };
  });

  return { requestId, totalEvents: events.length, events };
}

// ─── getPrompt ────────────────────────────────────────────────────────────────

export interface FmPromptDetail {
  rowIndex: number;
  requestId: string | null;
  resolve: string | null;
  /** The instruction column — includes header line ("Instructions:\n…"). */
  instruction: string | null;
  /** The instructions column — system prompt text only, no header. */
  instructions: string | null;
  /** Character counts so the agent can decide how much to read. */
  instructionLength: number | null;
  instructionsLength: number | null;
}

/**
 * Return the full system prompt for one FM inference row.
 *
 * Deliberately a separate call — the instructions blob can be several KB and
 * is excluded from getRequest/listRequests to preserve token efficiency. Call
 * this only when the agent explicitly needs to read the prompt.
 */
export async function getFmPrompt(
  sessionId: string,
  rowIndex: number,
  opts: { run?: number } = {}
): Promise<FmPromptDetail> {
  const run = opts.run ?? sessionLastRun(sessionId);
  const handle = await getTable(sessionId, run, FM_SCHEMA);

  if (rowIndex < 0 || rowIndex >= handle.rowCount) {
    throw new Error(`rowIndex ${rowIndex} out of range (0–${handle.rowCount - 1})`);
  }

  const db = await getDb(sessionId);
  const row = fetchHydratedRow(db, handle, rowIndex);
  const instruction = row["instruction"]?.fmt ?? null;
  const instructions = row["instructions"]?.fmt ?? null;

  return {
    rowIndex,
    requestId: row["model-request-id"]?.fmt ?? null,
    resolve: row["resolve"]?.fmt ?? null,
    instruction,
    instructions,
    instructionLength: instruction !== null ? instruction.length : null,
    instructionsLength: instructions !== null ? instructions.length : null,
  };
}

// Re-export for external use
export { EXCLUDED_FROM_REQUEST };
