/**
 * callSummary (PMT:thick-haze) — a compact, one-line, HONEST echo of what an
 * investigative call effectively did + its headline result, so the AI's
 * "show your work" narration is grounded in the query that actually ran
 * rather than a paraphrase that drifts. The intent ("what I'm looking for")
 * lives in the AI's head and is narrated per the SERVER_INSTRUCTIONS
 * convention; THIS is the verifiable "what ran → what came back" half.
 *
 * Deliberately a presentation-layer concern (rendered at the tool site from
 * the params + result already in hand), not baked into each core verb's
 * return type — keeps the core verbs unchanged and the format in one place.
 * Reuses counts each verb already computes; no new work.
 */
import type { ConditionGroup } from "./find.js";

const num = (n: number) => n.toLocaleString("en-US");

/** Render a shallow condition tree compactly: a leaf as "col op val", groups as "(a AND/OR b)". */
function renderWhere(where: ConditionGroup[]): string {
  const one = (g: ConditionGroup): string => {
    if ("col" in g) {
      if (g.compareCol !== undefined) return `${g.col} ${g.op} ${g.compareCol}`;
      if (g.val !== undefined) return `${g.col} ${g.op} ${g.val}`;
      return `${g.col} ${g.op}`;
    }
    if ("allOf" in g) return `(${g.allOf.map(one).join(" AND ")})`;
    return `(${g.anyOf.map(one).join(" OR ")})`;
  };
  return where.map(one).join(" AND ");
}

function renderFilter(filter?: Record<string, string | number>): string {
  if (!filter || Object.keys(filter).length === 0) return "";
  return Object.entries(filter).map(([k, v]) => `${k}=${v}`).join(", ");
}

function windowClause(timeRange?: { startNs?: number; endNs?: number }): string {
  if (!timeRange || (timeRange.startNs === undefined && timeRange.endNs === undefined)) return "";
  const lo = timeRange.startNs !== undefined ? `${(timeRange.startNs / 1e6).toFixed(1)}ms` : "…";
  const hi = timeRange.endNs !== undefined ? `${(timeRange.endNs / 1e6).toFixed(1)}ms` : "…";
  return ` in [${lo}, ${hi}]`;
}

export function summarizeQuery(
  schema: string,
  a: { filter?: Record<string, string | number>; timeRange?: { startNs?: number; endNs?: number } },
  r: { totalRows: number; returnedRows: number },
): string {
  const filter = renderFilter(a.filter);
  const scope = [filter ? `where ${filter}` : "", windowClause(a.timeRange)].filter(Boolean).join("");
  return `query ${schema}${scope ? ` ${scope.trim()}` : ""} → ${num(r.returnedRows)} of ${num(r.totalRows)} rows`;
}

export function summarizeFind(
  schema: string,
  a: { where: ConditionGroup[]; timeRange?: { startNs?: number; endNs?: number } },
  r: { matchCount: number },
): string {
  const w = renderWhere(a.where);
  return `find ${schema}${w ? ` where ${w}` : ""}${windowClause(a.timeRange)} → ${num(r.matchCount)} match${r.matchCount === 1 ? "" : "es"}`;
}

export function summarizeAggregate(
  schema: string,
  a: { groupBy: string | string[]; measure?: string | null; op: string },
  r: { totalGroups: number; groups: Array<{ key: string; valueFmt: string }> },
): string {
  const by = Array.isArray(a.groupBy) ? a.groupBy.join("+") : a.groupBy;
  const measure = a.op === "count" ? "count" : `${a.op} ${a.measure ?? ""}`.trim();
  const top = r.groups[0] ? `, top: ${r.groups[0].key || "\"\""}=${r.groups[0].valueFmt}` : "";
  return `aggregate ${schema} by ${by} (${measure}) → ${num(r.totalGroups)} group${r.totalGroups === 1 ? "" : "s"}${top}`;
}

export function summarizeCorrelate(
  r: {
    intervalsSchema: string; eventsSchema: string; matchThread: boolean;
    totalMatchedEvents: number; totalGroups: number;
  },
): string {
  return (
    `correlate ${r.intervalsSchema} ⊃ ${r.eventsSchema} (time-window${r.matchThread ? ", same-thread" : ""}) → ` +
    `${num(r.totalMatchedEvents)} matched event${r.totalMatchedEvents === 1 ? "" : "s"} across ${num(r.totalGroups)} group${r.totalGroups === 1 ? "" : "s"}`
  );
}

export function summarizeRelate(
  r: {
    schemaA: string; schemaB: string; joinCondition: string; polarity: string;
    totalMatches: number; totalA: number; totalGroups: number;
  },
): string {
  const rel = `${r.joinCondition}/${r.polarity}`;
  const headline =
    r.polarity === "not-exists"
      ? `${num(r.totalA - r.totalMatches)} of ${num(r.totalA)} ${r.schemaA} rows had NO match`
      : `${num(r.totalMatches)} matches across ${num(r.totalGroups)} group${r.totalGroups === 1 ? "" : "s"}`;
  return `relate ${r.schemaA} ${rel} ${r.schemaB} → ${headline}`;
}

export function summarizeCallTree(
  r: { schema: string; view: string; threadFilter: string | null; totalSamples: number },
  timeRange?: { startNs?: number; endNs?: number },
): string {
  const thread = r.threadFilter ? ` thread=${r.threadFilter}` : "";
  return `call_tree ${r.schema} (${r.view})${thread}${windowClause(timeRange)} → ${num(r.totalSamples)} sample${r.totalSamples === 1 ? "" : "s"}`;
}

export function summarizeTimeline(
  r: { schemas: string[]; returnedRows: number; totalInWindow: number; timeRange: { startNs?: number; endNs?: number } },
): string {
  return `timeline ${r.schemas.join("+")}${windowClause(r.timeRange)} → ${num(r.returnedRows)} of ${num(r.totalInWindow)} events`;
}
