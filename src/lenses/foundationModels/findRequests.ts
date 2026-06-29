/**
 * findFmRequests — named predicate finders over the FM inference table.
 *
 * Each named predicate compiles to one or more conditions for the generic
 * find() verb (src/core/find.ts), proving the lens-finder pattern:
 * lens-specific ergonomics are just preset predicates over core find().
 *
 * Predicates:
 *   minDuration (ns)     → duration ≥ minDuration (raw nanoseconds)
 *   hasError             → error-count > 0 (or == 0 when false)
 *   needsReformulation   → response contains '"needsReformulation": true'
 *   emptyContext         → response contains '"referencedSections": []'
 *                          (no help sections were retrieved for the request)
 *
 * emptyContext is the flagship: it surfaces the Help-AI bug (requests
 * processed with zero retrieved context) in one call.
 */
import { findRows } from "../../core/find.js";
import type { Condition } from "../../core/find.js";
import { FM_SCHEMA } from "./listRequests.js";
import type { FmRequestRow } from "./listRequests.js";

export interface FindFmRequestsOptions {
  run?: number;
  /** Minimum duration in nanoseconds (inclusive). */
  minDuration?: number;
  /** true → only errored requests; false → only clean requests. */
  hasError?: boolean;
  /** true → response.needsReformulation is true. */
  needsReformulation?: boolean;
  /** true → response.referencedSections is empty (no context retrieved). */
  emptyContext?: boolean;
  limit?: number;
  offset?: number;
}

export interface FindFmRequestsResult {
  schema: typeof FM_SCHEMA;
  run: number;
  /** Human-readable summary of which predicates were applied. */
  appliedPredicates: string[];
  /** Raw conditions passed to generic find(). */
  conditions: Condition[];
  matchCount: number;
  returnedRows: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  requests: FmRequestRow[];
}

// ─── Predicate → Condition mapping ───────────────────────────────────────────

function buildConditions(opts: FindFmRequestsOptions): { conditions: Condition[]; labels: string[] } {
  const conditions: Condition[] = [];
  const labels: string[] = [];

  if (opts.minDuration !== undefined) {
    conditions.push({ col: "duration", op: "gte", val: opts.minDuration });
    labels.push(`duration ≥ ${opts.minDuration} ns`);
  }

  if (opts.hasError === true) {
    conditions.push({ col: "error-count", op: "gt", val: 0 });
    labels.push("has error");
  } else if (opts.hasError === false) {
    conditions.push({ col: "error-count", op: "eq", val: 0 });
    labels.push("no error");
  }

  if (opts.needsReformulation === true) {
    conditions.push({ col: "response", op: "contains", val: '"needsReformulation": true' });
    labels.push("needsReformulation");
  } else if (opts.needsReformulation === false) {
    conditions.push({ col: "response", op: "not-contains", val: '"needsReformulation": true' });
    labels.push("!needsReformulation");
  }

  if (opts.emptyContext === true) {
    conditions.push({ col: "response", op: "contains", val: '"referencedSections": []' });
    labels.push("emptyContext (no sections retrieved)");
  } else if (opts.emptyContext === false) {
    conditions.push({ col: "response", op: "not-contains", val: '"referencedSections": []' });
    labels.push("hasContext");
  }

  return { conditions, labels };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function findFmRequests(
  sessionId: string,
  opts: FindFmRequestsOptions = {}
): Promise<FindFmRequestsResult> {
  const { conditions, labels } = buildConditions(opts);
  const limit = Math.min(opts.limit ?? 50, 200);

  // Route through the generic find() verb.
  const found = await findRows(sessionId, FM_SCHEMA, {
    run: opts.run,
    where: conditions,
    limit,
    offset: opts.offset ?? 0,
  });

  // Project FindRow cells → compact FmRequestRow one-liners.
  const requests: FmRequestRow[] = found.rows.map((r, i) => {
    const cells = r.cells;
    const errorCountStr = cells["error-count"] ?? "0";
    const errorCount = parseInt(errorCountStr, 10) || 0;
    const errorMessage = cells["error-message"];

    const promptFmt = cells["prompt"] ?? null;
    const SNIPPET = 80;
    const promptSnippet = promptFmt
      ? promptFmt.length > SNIPPET ? promptFmt.slice(0, SNIPPET) + "…" : promptFmt
      : null;

    return {
      index: (opts.offset ?? 0) + i,
      tableIndex: r.tableIndex,
      startTime: cells["start"] ?? null,
      duration: cells["duration"] ?? null,
      agentName: cells["agent-name"] ?? null,
      promptSnippet,
      totalTokens: cells["total-tokens"] ?? null,
      promptTokens: cells["prompt-tokens"] ?? null,
      responseTokens: cells["response-tokens"] ?? null,
      errorCount,
      hasError: errorCount > 0,
      resolve: cells["resolve"] ?? null,
      color: cells["color"] ?? null,
    };
  });

  return {
    schema: FM_SCHEMA,
    run: found.run,
    appliedPredicates: labels,
    conditions,
    matchCount: found.matchCount,
    returnedRows: requests.length,
    offset: found.offset,
    limit: found.limit,
    hasMore: found.hasMore,
    requests,
  };
}
