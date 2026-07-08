/**
 * queryHints (PMT:faint-trout) — describe_schema's four-part orientation:
 * gross form / edges / correlation / gotchas. describe_schema is the low-
 * frequency, one-schema ORIENTATION call the AI reads right before querying,
 * so its noise budget is HIGH (scratchpad 008) — the right home for per-schema
 * advice that would bloat open_trace (which must stay compact — the ruddy-elk
 * constraint). Until now that advice lived only as roleHints code comments,
 * never surfaced to the AI.
 *
 * Two-layer, per the aidocs/howHintsWork.md auto-derived-vs-curated axis:
 *  - AUTO-DERIVED: grain, size tier, load-bearing columns, the join graph
 *    (from the PMT:rust-gravel registry), carries-own-backtrace, and the
 *    computable gotchas (thread/time-role counts, the START/END point-event
 *    shape) — recomputed live, version-proof, no drift guard needed.
 *  - CURATED-STATIC: the handful of semantic gotchas you can't compute from
 *    shape alone (view-name is blank for View Body rows → group by
 *    description; sort by duration not downstream-cost) — referentially
 *    guarded against the committed fixtures, exactly like the schemaEdges
 *    curated layer.
 *
 * Stays CHEAP: metadata-only. The join graph is derived from roleHints pins +
 * already-inspected siblings' columns — never an xctrace call per sibling.
 * Row-data-derived facts (a blank-column %) are deliberately OUT of scope here
 * to preserve the no-forced-ingest contract (see schema.ts / getSchemaMeta).
 */
import type { SchemaCol } from "../engine/parseTable.js";
import { classifyWithHints, hintFor } from "../engine/roleHints.js";
import { preferredThreadColumn, type ClassifiedColumn } from "../engine/roleInference.js";
import {
  connectionsFor,
  carriesOwnBacktrace,
  type SchemaEdge,
} from "../engine/schemaEdges.js";

export interface QueryHints {
  /** Part 1: what IS a row here + size tier + the load-bearing role columns. */
  grossForm: string;
  /** Part 2: how to join this schema to siblings PRESENT in the trace (incl. negative "don't join" edges). */
  edges: string[];
  /** Part 2b: absent siblings worth a re-record if you hit a dead end whose cause lives in their domain (latent). */
  recovery: string[];
  /** Part 3: does this schema carry its OWN backtrace (call_tree it) or point at work elsewhere (join to get the stack)? */
  correlation: string;
  /** Part 4: traps that make a naive query silently lie. */
  gotchas: string[];
}

// ─── Curated gotchas (referentially guarded) ─────────────────────────────────────

/** A semantic gotcha you can't compute from shape alone. `column`, when set, is referentially guarded against the fixtures. */
export interface CuratedGotcha {
  /** The column the gotcha is about — checked against the committed fixture (drift guard). */
  column?: string;
  note: string;
}

/**
 * The curated per-schema gotchas — the "you can't derive this from the column
 * shape" residue. Every schema key MUST have a committed fixture and every
 * `column` MUST exist in it (tests/driftGuard.test.ts enforces both).
 */
export const CURATED_GOTCHAS: Readonly<Record<string, readonly CuratedGotcha[]>> = {
  "swiftui-updates": [
    {
      column: "view-name",
      note: "view-name is BLANK for View Body Update rows — they carry their identity in 'description'; Layout Update rows use view-name instead. Group View Body rows by 'description', or an aggregate silently buckets them all under \"\".",
    },
    {
      column: "duration",
      note: "For a stutter, sort by 'duration' (the inclusive main-thread time of the update — the stutter itself), NOT 'downstream-cost' (the size of the invalidation cascade to OTHER views — a related but different question).",
    },
  ],
  SwiftUIFilteredUpdates: [
    {
      column: "view-name",
      note: "Same as swiftui-updates: view-name is blank for View Body rows (identity is in 'description'); group View Body rows by 'description'.",
    },
  ],
  hitches: [
    {
      column: "duration",
      note: "A hitch's 'duration' is an ENTRY POINT, not a verdict — a long hitch with no on-CPU main-thread sample in its window is an off-CPU held frame (GPU/compositor-bound), not a compute problem. Classify (correlate against time-sample) before concluding.",
    },
  ],
};

// ─── Auto-derived: gross form ────────────────────────────────────────────────────

function sizeTier(rowCount: number): string {
  if (rowCount === 0) return "empty (0 rows)";
  if (rowCount < 1_000) return `tiny (${rowCount.toLocaleString("en-US")} rows)`;
  if (rowCount < 50_000) return `small (${rowCount.toLocaleString("en-US")} rows)`;
  if (rowCount < 500_000) return `large (${rowCount.toLocaleString("en-US")} rows — filter/timeRange before an unbounded scan)`;
  return `a firehose (${rowCount.toLocaleString("en-US")} rows — never scan unfiltered; always filter/timeRange/aggregate)`;
}

/** Infer what a single row IS from the column signature — grain confusion is a top misread (a sample count ≠ an event count; START/END rows double-count intervals). */
function inferGrain(cols: SchemaCol[], classified: ClassifiedColumn[]): string {
  const hasEngType = (et: string) => cols.some((c) => c.engineeringType === et);
  const hasRole = (r: string) => classified.some((c) => c.roleInfo.role === r);
  const hasNsDuration =
    hasEngType("duration") || classified.some((c) => c.roleInfo.role === "weight" && c.roleInfo.unit === "nanoseconds");

  if (hasEngType("tagged-backtrace")) {
    return "a stack SAMPLE — each row is one sampled backtrace; call_tree aggregates them, and a bare row count is a SAMPLE count, not an event count.";
  }
  if (hasEngType("kdebug-func") && hasRole("time")) {
    return "a START-or-END point event — rows come in begin/end PAIRS; counting rows DOUBLE-COUNTS intervals. Use the interval-form sibling schema (if present) for spans.";
  }
  if (hasRole("time") && hasNsDuration) {
    return "an INTERVAL / span — a row covers [start, start+duration]; overlapping rows can be on-screen/active at once, so don't assume they partition time.";
  }
  if (cols.some((c) => c.mnemonic === "address") && classified.some((c) => c.roleInfo.unit === "bytes")) {
    return "an ALLOCATION — one row per allocation event (address + size).";
  }
  if (hasRole("time")) {
    return "a point event — an instantaneous timestamped row with no duration.";
  }
  return "a plain record — no time/duration/backtrace signature.";
}

// ─── Auto-derived: the join graph (from the rust-gravel registry) ────────────────

/** Reconstruct a pinned schema's columns from its roleHints entry — classifyWithHints re-applies the pin, so the synthetic engineering-type is irrelevant. Lets us derive a sibling's edges with ZERO xctrace cost when it's a curated instrument. */
function colsFromHint(schema: string): SchemaCol[] | null {
  const hint = hintFor(schema);
  if (!hint) return null;
  return Object.keys(hint.columns).map((m) => ({ mnemonic: m, name: m, engineeringType: "string" }));
}

/** POSITIVE join kinds — the ones that actually get you related rows (used for correlation / dedup). */
const POSITIVE_KINDS = new Set<SchemaEdge["kind"]>(["equi", "time-window", "tuple", "contains", "contained-by"]);

/** One human line per edge, oriented from the schema being described. */
function renderEdge(e: SchemaEdge): string {
  const cols = e.on.map((p) => `${p.fromCol}↔${p.toCol}`).join(" + ");
  switch (e.kind) {
    case "negative":
      return `✗ ${e.to}: ${e.note}`;
    case "equi":
      return `→ ${e.to} (equality on ${cols}): ${e.note}`;
    case "time-window":
      return `→ ${e.to} (time-window / correlate): ${e.note}`;
    case "tuple":
      return `→ ${e.to} (same-thread + time-window — the causal join): ${e.note}`;
    case "contains":
      return `⊃ ${e.to} (this schema's interval CONTAINS ${e.to} events): ${e.note}`;
    case "contained-by":
      return `⊂ ${e.to} (this schema's rows fall INSIDE ${e.to}'s intervals): ${e.note}`;
    case "excludes":
      return `∌ ${e.to} (anti-join — this interval with NO ${e.to} inside): ${e.note}`;
    case "excluded-by":
      return `⊄ ${e.to} (this schema's rows that fall in NO ${e.to} interval): ${e.note}`;
  }
}

/**
 * Collapse the derived time-window + tuple pair to the SAME sibling into one
 * line — the tuple (causal) edge already says "falls back to the plain
 * time-window", so a separate time-window line is noise. Keeps every other
 * edge (negative, curated, equi) untouched.
 */
function dedupTimeWindowWhenTuple(edges: SchemaEdge[]): SchemaEdge[] {
  const tupleTargets = new Set(edges.filter((e) => e.kind === "tuple").map((e) => e.to));
  return edges.filter((e) => !(e.kind === "time-window" && tupleTargets.has(e.to)));
}

// ─── Public API ──────────────────────────────────────────────────────────────────

export interface QueryHintsInput {
  schema: string;
  cols: SchemaCol[];
  rowCount: number;
  primaryTime: string | null;
  primaryWeight: string | null;
  /** Every schema name present in this run's TOC (for edge scoping). */
  presentSchemas: string[];
  /** Real columns for siblings already inspected this session (schema → cols); pinned siblings are reconstructed from their hint. */
  knownCols?: Map<string, SchemaCol[]>;
}

export function buildQueryHints(input: QueryHintsInput): QueryHints {
  const { schema, cols, rowCount, primaryTime, primaryWeight, presentSchemas, knownCols } = input;
  const classified = classifyWithHints(schema, cols);

  // Part 1 — GROSS FORM.
  const identity =
    classified.find((c) => c.roleInfo.role === "label")?.mnemonic ??
    classified.find((c) => c.roleInfo.role === "thread")?.mnemonic ??
    null;
  const loadBearing = [
    primaryTime ? `time=${primaryTime}` : null,
    primaryWeight ? `weight=${primaryWeight}` : null,
    identity ? `identity=${identity}` : null,
  ].filter(Boolean).join(", ");
  const grossForm = `A row here is ${inferGrain(cols, classified)} Size: ${sizeTier(rowCount)}.${loadBearing ? ` Load-bearing columns: ${loadBearing}.` : ""}`;

  // Part 2 — EDGES. Build the present-schema list for the registry cheaply:
  // the current schema's real cols + each present sibling reconstructed from
  // its roleHints pin (free) or its already-inspected real cols; unpinned,
  // uninspected siblings are skipped (their roles are unknown until inspected).
  const present: Array<{ schema: string; cols: SchemaCol[] }> = [{ schema, cols }];
  for (const sib of presentSchemas) {
    if (sib === schema) continue;
    const reconstructed = colsFromHint(sib) ?? knownCols?.get(sib) ?? null;
    if (reconstructed) present.push({ schema: sib, cols: reconstructed });
  }
  const conn = connectionsFor(schema, present);
  const edges = dedupTimeWindowWhenTuple(conn.edges).map(renderEdge);
  const recovery = conn.latentRecovery.map((r) => r.note);

  // Part 3 — CORRELATION (tagged-backtrace).
  let correlation: string;
  if (carriesOwnBacktrace(schema, cols)) {
    correlation = "Carries its OWN backtrace — call_tree this schema directly to see the actual call stack of the work.";
  } else {
    // Point at a present sibling that DOES carry a backtrace, reachable by a
    // POSITIVE join (never an anti-join — you can't read a stack out of an
    // absence). Prefer a keyed equi (the exact address/id link) over a
    // time-window correlate.
    const btSibling = present.find((p) => p.schema !== schema && carriesOwnBacktrace(p.schema, p.cols));
    const posEdges = btSibling ? conn.edges.filter((e) => e.to === btSibling.schema && POSITIVE_KINDS.has(e.kind)) : [];
    const best = posEdges.find((e) => e.kind === "equi") ?? posEdges[0];
    if (btSibling && best) {
      const method =
        best.kind === "equi"
          ? `join ${best.on.map((p) => `${p.fromCol}↔${p.toCol}`).join(" + ")} to ${btSibling.schema} (equality)`
          : `correlate this schema's window against ${btSibling.schema} (time-window, exists)`;
      correlation = `No backtrace of its own — the responsible stack lives in ${btSibling.schema}; ${method} to attribute the work to a real call stack.`;
    } else if (btSibling) {
      // Present bt-sibling but only a NEGATIVE/anti-join link — still correlatable by time window, just not via that curated edge.
      correlation = `No backtrace of its own — correlate this schema's window against ${btSibling.schema} (time-window) to attribute the work to a real call stack (note the ✗/∌ edge above: that link is framed as a NON-join / anti-join, so use a plain time-window correlate).`;
    } else {
      correlation = "No backtrace of its own — it records WHEN/WHAT, not the call stack. Compose a backtrace-carrying instrument (e.g. Time Profiler) and correlate by time-window to attribute the work.";
    }
  }

  // Part 4 — GOTCHAS. Auto-derived (computable from shape) + curated-static.
  const gotchas: string[] = [];
  const threadCols = classified.filter((c) => c.roleInfo.role === "thread").map((c) => c.mnemonic);
  if (threadCols.length > 1) {
    const winner = preferredThreadColumn(classified)?.mnemonic;
    gotchas.push(
      `${threadCols.length} thread-role columns (${threadCols.join(", ")}) — a bare "thread" reference resolves to "${winner}" by value-priority (thread > tid > process > pid), NOT by column order. Name the exact one if you mean a different one.`
    );
  }
  const timeCols = classified.filter((c) => c.roleInfo.role === "time").map((c) => c.mnemonic);
  if (timeCols.length > 1) {
    gotchas.push(
      `${timeCols.length} time-role columns (${timeCols.join(", ")}) — timeRange and correlate use primaryTime ("${primaryTime}"). If you need a window on a different one, say so explicitly.`
    );
  }
  for (const g of CURATED_GOTCHAS[schema] ?? []) gotchas.push(g.note);

  return { grossForm, edges, recovery, correlation, gotchas };
}
