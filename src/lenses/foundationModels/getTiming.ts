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
import { getTable, lastRun as sessionLastRun } from "../../engine/session.js";
import { FM_SCHEMA } from "./listRequests.js";

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
  const inferenceTable = await getTable(sessionId, run, FM_SCHEMA);

  if (rowIndex < 0 || rowIndex >= inferenceTable.rows.length) {
    throw new Error(`rowIndex ${rowIndex} out of range (0–${inferenceTable.rows.length - 1})`);
  }

  const requestId = inferenceTable.rows[rowIndex]["model-request-id"]?.fmt ?? null;
  const empty = {
    rowIndex, requestId, prefillMs: null, generationMs: null, totalMs: null,
    cachedTokenCount: null, consumedTokenCount: null, generatedTokenCount: null, deltasCount: null,
    note: COLD_START_NOTE,
  };
  if (!requestId) return empty;

  const eventsTable = await getTable(sessionId, run, EVENT_SCHEMA);

  const events: ParsedEvent[] = [];
  for (const row of eventsTable.rows) {
    const msgCell = row["message"];
    const tsCell = row["timestamp"];
    if (!msgCell || !tsCell) continue;
    const timestampNs = typeof tsCell.raw === "number" ? tsCell.raw : Number(tsCell.raw);
    if (!isFinite(timestampNs)) continue;
    const parsed = parseEventMessage(msgCell.fmt, timestampNs);
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
