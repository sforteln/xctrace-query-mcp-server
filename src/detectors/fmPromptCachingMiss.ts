/**
 * Corpus detector #8 — Foundation Models prompt-caching
 * misses.
 *
 * ModelInferenceTable rows carry a `cached-tokens` count — how many of the
 * request's tokens were served from the model's KV cache instead of
 * recomputed. A request with cached-tokens = 0 despite a non-trivial
 * total-tokens count is a missed cache-reuse opportunity (a fresh prefill when
 * one could plausibly have reused a previous turn's prefix) — costly in both
 * latency and compute. Fires when both the raw miss count and the miss RATE
 * (misses / requests-above-the-token-floor) cross their bands, so a handful
 * of misses among thousands of tiny requests doesn't trip it.
 *
 * cost: CHEAP — a single-table WHERE + COUNT aggregate (no join, no window, no
 * percentile), the same intrinsically-bounded shape as the template detector.
 *
 * Not validated against a real trace — no Foundation Models recording was
 * available in ~/Documents/traces or the recordings dir at authoring time.
 * Unit-tested against a synthetic ModelInferenceTable only.
 */
import { quoteIdent, ROW_IDX_COLUMN } from "../engine/sqliteStore.js";
import { rawCol } from "../engine/sqlHydrate.js";
import type { Detector } from "./types.js";

const MODEL_INFERENCE_SCHEMA = "ModelInferenceTable";
const MIN_TOKENS_FOR_RELEVANCE = 32; // ignore trivially small requests
const MISS_COUNT_THRESHOLD = 10;
const MISS_RATE_THRESHOLD = 0.5; // fraction of relevant requests with zero cache reuse

export const fmPromptCachingMiss: Detector = {
  id: "fm-prompt-caching-miss",
  title: "Foundation Models prompt-caching misses",
  requiredSchemas: [MODEL_INFERENCE_SCHEMA],
  cost: "cheap",
  run(ctx) {
    const table = quoteIdent(ctx.tableName(MODEL_INFERENCE_SCHEMA));
    const cachedRaw = quoteIdent(rawCol("cached-tokens"));
    const totalRaw = quoteIdent(rawCol("total-tokens"));

    const row = ctx.db
      .prepare(
        `SELECT COUNT(*) AS n, COUNT(CASE WHEN CAST(${cachedRaw} AS REAL) = 0 THEN 1 END) AS misses ` +
          `FROM ${table} WHERE ${totalRaw} IS NOT NULL AND CAST(${totalRaw} AS REAL) > ?`
      )
      .get(MIN_TOKENS_FOR_RELEVANCE) as { n: number; misses: number } | undefined;
    if (!row || row.n === 0) return null;

    const missRate = row.misses / row.n;
    if (row.misses <= MISS_COUNT_THRESHOLD || missRate <= MISS_RATE_THRESHOLD) return null;

    const heaviest = ctx.db
      .prepare(
        `SELECT ${quoteIdent(ROW_IDX_COLUMN)} AS idx FROM ${table} WHERE ${cachedRaw} IS NOT NULL AND CAST(${cachedRaw} AS REAL) = 0 ` +
          `AND ${totalRaw} IS NOT NULL ORDER BY CAST(${totalRaw} AS REAL) DESC LIMIT 1`
      )
      .get() as { idx: number } | undefined;

    return {
      summary:
        `${row.misses.toLocaleString("en-US")} of ${row.n.toLocaleString("en-US")} Foundation Models requests (${(missRate * 100).toFixed(0)}%) ` +
        "had zero KV-cache reuse — a missed prompt-caching opportunity",
      firing: [
        { metric: "cache-miss count", value: row.misses, threshold: MISS_COUNT_THRESHOLD, direction: "over" },
        { metric: "cache-miss rate", value: Math.round(missRate * 100) / 100, threshold: MISS_RATE_THRESHOLD, direction: "over" },
      ],
      callSpec: {
        verb: "aggregate",
        schema: MODEL_INFERENCE_SCHEMA,
        args: { groupBy: "agent-name", op: "count", filter: { "cached-tokens": 0 }, topN: 10 },
      },
      handles: heaviest
        ? [{ kind: "row", schema: MODEL_INFERENCE_SCHEMA, rowIndex: heaviest.idx, label: "largest zero-cache-reuse request" }]
        : [],
    };
  },
};
