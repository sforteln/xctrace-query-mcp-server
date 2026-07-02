/**
 * Per-session memoization for exact-repeat query/aggregate/find calls.
 *
 * The underlying table is already cached once fetched (session.tableCache),
 * but filter/sort/projection still costs real time on a huge table — and
 * more importantly, an AI client's own tool-call timeout can fire while
 * xctrace export is still streaming, well before this server actually
 * finishes (confirmed live: query/describe_schema/correlate calls have taken
 * 5-13 minutes on large traces — see session logs under
 * ~/Library/Logs/instruments-mcp-server/). Nothing cancels the in-flight
 * work just because the client gave up waiting, so the call still completes
 * and its result is worth keeping: the AI's next-turn retry with the exact
 * same args should get the already-computed answer instantly instead of
 * paying the same multi-minute round trip again.
 *
 * Keyed by tool + resolved run + schema + a stable (key-sorted) JSON encoding
 * of the call's own normalized options — normalized so that an explicit
 * default (e.g. limit: 20) and an omitted one that resolves to the same
 * default hit the same entry.
 */
import { getSession } from "../engine/session.js";

export function callCacheKey(tool: string, run: number, schema: string, args: unknown): string {
  return `${tool}:${run}:${schema}:${stableStringify(args)}`;
}

export function getCachedCall<T>(sessionId: string, key: string): T | undefined {
  return getSession(sessionId).callCache.get(key) as T | undefined;
}

export function setCachedCall<T>(sessionId: string, key: string, value: T): void {
  getSession(sessionId).callCache.set(key, value);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}
