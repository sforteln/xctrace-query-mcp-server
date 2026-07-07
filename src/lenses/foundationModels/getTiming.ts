/**
 * getFmTiming — prefill/generation split and cache stats from FMEventTable.
 *
 * ModelInferenceTable exposes one duration per phase row, which hides the
 * split that matters for on-device inference latency: prefill (time to
 * first token) vs. generation. FMEventTable carries this as discrete
 * request_start / response_start / response_complete events, correlated to
 * a ModelInferenceTable row via the shared request id — model-request-id
 * equals the 3rd comma-separated field in FMEventTable's message column
 * (format: "TAG,eventId,requestId,turnId,sessionId::{jsonPayload}").
 * cachedTokenCount/consumedTokenCount/generatedTokenCount/deltasCount live
 * only in the response_complete event's JSON payload.
 */
import { getTable, getDb, lastRun as sessionLastRun } from "../../engine/session.js";
import { fmtCol, rawCol, makeInternResolver } from "../../engine/sqlHydrate.js";
import { quoteIdent } from "../../engine/sqliteStore.js";
import { FM_SCHEMA } from "./listRequests.js";
import { fetchHydratedRow } from "./getRequest.js";

const EVENT_SCHEMA = "FMEventTable";

export interface FmTimingResult {
  rowIndex: number;
  requestId: string | null;
  /** ms from request_start to response_start (time to first token). */
  prefillMs: number | null;
  /** ms from response_start to response_complete. */
  generationMs: number | null;
  totalMs: number | null;
  cachedTokenCount: number | null;
  consumedTokenCount: number | null;
  generatedTokenCount: number | null;
  deltasCount: number | null;
  note: string;
}

interface ParsedEvent {
  requestId: string;
  timestampNs: number;
  event: string | null;
  data: Record<string, unknown> | null;
}

const COLD_START_NOTE =
  "Cold start shows up as elevated prefillMs on the first request, not in ModelLoadingTable " +
  "— attach-mode recordings often only capture asset teardown there, with no load event to compare against.";

function parseEventMessage(fmt: string, timestampNs: number): ParsedEvent | null {
  const sep = fmt.indexOf("::");
  if (sep === -1) return null;
  const fields = fmt.slice(0, sep).split(",");
  const requestId = fields[2];
  if (!requestId) return null;
  let parsed: { event?: string; data?: Record<string, unknown> } | null = null;
  try {
    parsed = JSON.parse(fmt.slice(sep + 2));
  } catch {
    // PMT/TSC/ΔTF transcript events aren't needed here and aren't always valid
    // standalone JSON after truncation elsewhere in the pipeline — skip them.
  }
  return {
    requestId,
    timestampNs,
    event: parsed?.event ?? null,
    data: parsed?.data ?? null,
  };
}

function numOrNull(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return isFinite(n) ? n : null;
}

export async function getFmTiming(
  sessionId: string,
  rowIndex: number,
  opts: { run?: number } = {}
): Promise<FmTimingResult> {
  const run = opts.run ?? sessionLastRun(sessionId);
  const inferenceHandle = await getTable(sessionId, run, FM_SCHEMA);

  if (rowIndex < 0 || rowIndex >= inferenceHandle.rowCount) {
    throw new Error(`rowIndex ${rowIndex} out of range (0–${inferenceHandle.rowCount - 1})`);
  }

  const db = await getDb(sessionId);
  const inferenceRow = fetchHydratedRow(db, inferenceHandle, rowIndex);
  const requestId = inferenceRow["model-request-id"]?.fmt ?? null;
  const empty = {
    rowIndex, requestId, prefillMs: null, generationMs: null, totalMs: null,
    cachedTokenCount: null, consumedTokenCount: null, generatedTokenCount: null, deltasCount: null,
    note: COLD_START_NOTE,
  };
  if (!requestId) return empty;

  const eventsHandle = await getTable(sessionId, run, EVENT_SCHEMA);

  // A scoped SELECT instead of fetchAllRowsHydrated's whole-table fetch
  // (PMT:warm-mica) — FMEventTable can carry many more rows than this one
  // request cares about. The message format is "TAG,eventId,requestId,
  // turnId,sessionId::{json}" (see this file's header), so requestId is
  // always bounded by a comma on both sides — INSTR(...) is a correctness-
  // preserving PRE-FILTER (a literal substring match, no LIKE wildcard risk),
  // narrowing to candidate rows before the same exact parseEventMessage +
  // strict requestId equality check the original ran over every row.
  const table = quoteIdent(eventsHandle.tableName);
  const msgCol = quoteIdent(fmtCol("message"));
  const requestIdMarker = `,${requestId},`;
  // A large message is stored as an intern sentinel (PMT:lime-bluff), so the
  // INSTR pre-filter can't see its content — widen the pre-filter to ALSO admit
  // every sentinel row (SUBSTR = char(1)), then resolve + re-check in JS. Inline
  // messages still get the cheap INSTR narrowing; interned ones are never missed.
  const candidateRows = db
    .prepare(
      `SELECT ${quoteIdent(rawCol("timestamp"))} AS ts, ${msgCol} AS msg ` +
        `FROM ${table} WHERE INSTR(${msgCol}, ?) > 0 OR SUBSTR(${msgCol}, 1, 1) = char(1)`
    )
    .all(requestIdMarker) as Array<{ ts: number | string | null; msg: string | null }>;

  const unintern = makeInternResolver(db);
  const events: ParsedEvent[] = [];
  for (const row of candidateRows) {
    const msg = unintern(row.msg) as string | null;
    if (msg === null || row.ts === null) continue;
    const timestampNs = typeof row.ts === "number" ? row.ts : Number(row.ts);
    if (!isFinite(timestampNs)) continue;
    const parsed = parseEventMessage(msg, timestampNs);
    if (parsed && parsed.requestId === requestId) events.push(parsed);
  }

  const requestStart = events.find((e) => e.event === "request_start");
  const responseStart = events.find((e) => e.event === "response_start");
  const responseComplete = events.find((e) => e.event === "response_complete");

  const prefillMs =
    requestStart && responseStart ? (responseStart.timestampNs - requestStart.timestampNs) / 1e6 : null;
  const generationMs =
    responseStart && responseComplete ? (responseComplete.timestampNs - responseStart.timestampNs) / 1e6 : null;
  const totalMs =
    requestStart && responseComplete ? (responseComplete.timestampNs - requestStart.timestampNs) / 1e6 : null;

  const data = responseComplete?.data ?? {};

  return {
    rowIndex,
    requestId,
    prefillMs,
    generationMs,
    totalMs,
    cachedTokenCount: numOrNull(data["cachedTokenCount"]),
    consumedTokenCount: numOrNull(data["consumedTokenCount"]),
    generatedTokenCount: numOrNull(data["generatedTokenCount"]),
    deltasCount: numOrNull(data["deltasCount"]),
    note: COLD_START_NOTE,
  };
}
