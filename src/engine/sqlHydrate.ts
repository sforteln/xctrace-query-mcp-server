/**
 * Shared SQL query/hydration helpers for PMT:dusk-floe — the SQL-backed
 * counterparts of the JS-array scans query/aggregate/find/get_row used to do
 * directly against ParsedTable.rows.
 *
 * Scope note (see PMT:dusk-floe): every mnemonic referenced here is a
 * TOP-LEVEL column — the existing predicate DSL never supported nested
 * compound fields (thread.tid) even in the old JS implementation, so this
 * only maps mnemonics to the plain "mnemonic"/"mnemonic__fmt" columns
 * PMT:gravel-cape created. PMT:tall-bench's promoted nested-path columns are
 * untouched here — PMT:bare-shoal exposes those separately.
 */
import type { DatabaseSync } from "node:sqlite";
import type { SchemaCol, NormalizedRow, Cell, ResolvedFrame } from "./parseTable.js";
import { createHash } from "node:crypto";
import { isBacktraceCol, quoteIdent, ROW_IDX_COLUMN, isInternSentinel, internSentinelId, INTERN_SENTINEL } from "./sqliteStore.js";
import { isNodeEncoded, decodeNodeSequence } from "./hierarchyEncode.js";

// ─── Regex UDF ────────────────────────────────────────────────────────────────

/**
 * Registers the UDF find()'s "regex" op compiles to — SQLite has no native
 * REGEXP. Call once per DB connection (session.ts's getSessionDb), not per
 * query. Mirrors testCondition's regex behavior: case-insensitive, a bad
 * pattern is validated by the caller before this ever runs, so this defends
 * defensively (returns false) rather than throwing mid-query.
 */
export function registerRegexpUdf(db: DatabaseSync): void {
  db.function("mcp_regexp", (pattern: unknown, text: unknown): number => {
    if (text === null || text === undefined) return 0;
    try {
      return new RegExp(String(pattern), "i").test(String(text)) ? 1 : 0;
    } catch {
      return 0;
    }
  });
}

// ─── Percentile aggregate UDFs ─────────────────────────────────────────────────

/**
 * The percentile custom aggregates the aggregate() verb's p50/p90/p95/p99/median
 * ops compile to — SQLite has no built-in percentile function (PMT:round-rime).
 * Registered once per connection, alongside registerRegexpUdf.
 *
 * Uses the nearest-rank method (no interpolation): for a group's N non-null
 * values sorted ascending, the p-th percentile is the value at 1-based rank
 * ceil(p*N), clamped to [1, N]. A defensible, standard definition — chosen
 * over linear interpolation because it always returns an ACTUAL observed value
 * (a p95 hang duration that a real hang actually had), never a synthesized
 * between-samples number, which is the more useful answer for the profiling
 * questions these serve. Requires Node >=22.16 for DatabaseSync.aggregate
 * (the package engine floor is >=22 for node:sqlite itself; percentiles
 * specifically need the slightly newer aggregate API).
 *
 * The step function accumulates every value into an array (bounded by GROUP
 * size, not table size), so a single enormous group is the one case this
 * holds a lot in memory — acceptable for the group counts real aggregate
 * calls produce, and no worse than any exact-percentile implementation, which
 * fundamentally needs all a group's values to pick one.
 */
const PERCENTILES: Record<string, number> = {
  mcp_p50: 0.5,
  mcp_p90: 0.9,
  mcp_p95: 0.95,
  mcp_p99: 0.99,
};

export function registerPercentileUdfs(db: DatabaseSync): void {
  for (const [name, p] of Object.entries(PERCENTILES)) {
    // @types/node's AggregateOptions<T> constrains the accumulator T to
    // SQLInputValue (number|string|bigint|Uint8Array|null), which excludes a
    // JS array — but node:sqlite passes the accumulator object through between
    // step() calls unchanged at runtime, so an array accumulator works fine
    // (verified live). Cast through unknown to satisfy the over-strict type def.
    const options = {
      start: (): number[] => [],
      step: (acc: number[], val: unknown): number[] => {
        if (val !== null && val !== undefined) {
          const n = typeof val === "number" ? val : Number(val);
          if (isFinite(n)) acc.push(n);
        }
        return acc;
      },
      result: (acc: number[]): number | null => {
        if (acc.length === 0) return null;
        acc.sort((a, b) => a - b);
        const rank = Math.min(acc.length, Math.max(1, Math.ceil(p * acc.length)));
        return acc[rank - 1];
      },
    };
    db.aggregate(name, options as unknown as Parameters<DatabaseSync["aggregate"]>[1]);
  }
}

/** The SQL function name for a percentile op, or null if the op isn't a percentile. */
export function percentileFnFor(op: string): string | null {
  const map: Record<string, string> = {
    p50: "mcp_p50", median: "mcp_p50",
    p90: "mcp_p90", p95: "mcp_p95", p99: "mcp_p99",
  };
  return map[op] ?? null;
}

// ─── Physical column names ────────────────────────────────────────────────────

export function rawCol(mnemonic: string): string {
  return mnemonic;
}
export function fmtCol(mnemonic: string): string {
  return `${mnemonic}__fmt`;
}
export function childrenCol(mnemonic: string): string {
  return `${mnemonic}__children`;
}
export function backtraceIdCol(mnemonic: string): string {
  return `${mnemonic}__backtrace_id`;
}

/** Compute the display fmt string for a backtrace cell from its frames — matches parseTable.ts's parseCell formula exactly. */
export function backtraceFmtFromFrames(frames: ResolvedFrame[]): string {
  const topName = frames[0]?.name ?? "";
  return frames.length > 0 ? `${frames.length} frames, top: ${topName}` : "0 frames";
}

// ─── Window functions (query's `window` option, PMT:round-rime) ─────────────────

export type WindowOp = "running-total" | "delta" | "rank" | "row-number";

export interface WindowSpec {
  /**
   * running-total: cumulative SUM of `measure` in `orderBy` order (a
   *   growth-over-time curve). delta: this row's value minus the previous
   *   row's, in `orderBy` order (inter-arrival time when orderBy is a time
   *   column) — diffs `measure` if given, else `orderBy` itself. rank /
   *   row-number: position within the partition, ordered by `orderBy`.
   */
  op: WindowOp;
  /** Mnemonic that orders the window (usually a time column). */
  orderBy: string;
  /** Optional mnemonic to partition/reset the window by (usually a thread/process identity). */
  partitionBy?: string;
  /** Column to accumulate (running-total) or diff (delta). Required for running-total; optional for delta (defaults to orderBy); ignored for rank/row-number. */
  measure?: string;
}

/**
 * Build the SQL window expression for query's `window` option. Numeric
 * accumulate/diff/order use the raw column; partition uses the fmt column
 * (a partition is an identity like a thread name, keyed by its display value,
 * consistent with how aggregate/correlate key identities off fmt).
 */
export function buildWindowExpr(spec: WindowSpec): string {
  const orderRaw = `CAST(${quoteIdent(rawCol(spec.orderBy))} AS REAL)`;
  const partition = spec.partitionBy ? `PARTITION BY ${quoteIdent(fmtCol(spec.partitionBy))} ` : "";
  const orderClause = `ORDER BY ${quoteIdent(rawCol(spec.orderBy))}`;
  const over = `OVER (${partition}${orderClause})`;

  switch (spec.op) {
    case "running-total": {
      const m = `CAST(${quoteIdent(rawCol(spec.measure!))} AS REAL)`;
      return `SUM(${m}) ${over}`;
    }
    case "delta": {
      const col = spec.measure ? `CAST(${quoteIdent(rawCol(spec.measure))} AS REAL)` : orderRaw;
      return `(${col} - LAG(${col}) ${over})`;
    }
    case "rank":
      return `RANK() ${over}`;
    case "row-number":
      return `ROW_NUMBER() ${over}`;
  }
}

export interface DisplaySelectPlan {
  /** SQL select fragments with "AS __out_<ref>" aliases, ready to join into a SELECT list. */
  selectCols: string[];
  /** Which requested refs are backtrace-typed — their __out_ value is a raw
   *  __backtrace_id (number|null), not a display string, and needs a post-fetch
   *  pass (see backtraceFmtFromFrames) before being shown to a caller. */
  backtraceMnemonics: string[];
}

/** A field to display: its caller ref (mnemonic or dot-path), physical base column, and whether it's a backtrace column. */
export interface DisplayField {
  ref: string;
  base: string;
  isBacktrace: boolean;
}

/**
 * Build a "give me the display value" SELECT list for query/find, aware that
 * a backtrace-typed column has no __fmt column at all (only __backtrace_id —
 * see sqliteStore.ts's header comment) — selecting a nonexistent "<base>__fmt"
 * for a backtrace column is a real SQL error, not just a wrong value, so this
 * must branch per-column rather than assume every field has the same shape.
 * Fields are pre-resolved (PMT:bare-shoal) so a dot-path column displays the
 * value at its physical base column, keyed by the caller's original ref.
 */
export function buildDisplaySelect(fields: DisplayField[]): DisplaySelectPlan {
  const selectCols: string[] = [];
  const backtraceMnemonics: string[] = [];
  for (const f of fields) {
    if (f.isBacktrace) {
      selectCols.push(`${quoteIdent(backtraceIdCol(f.base))} AS ${quoteIdent(`__out_${f.ref}`)}`);
      backtraceMnemonics.push(f.ref);
    } else {
      selectCols.push(`${quoteIdent(fmtCol(f.base))} AS ${quoteIdent(`__out_${f.ref}`)}`);
    }
  }
  return { selectCols, backtraceMnemonics };
}

/**
 * Post-process a page of SQL rows in place, replacing each backtrace
 * mnemonic's raw __backtrace_id value with its computed display fmt string.
 * Mutates and returns the same array (rows are freshly-built plain objects
 * from a .all() call, safe to mutate).
 */
export function resolveBacktraceDisplayValues(
  sqlRows: Record<string, unknown>[],
  backtraceMnemonics: string[],
  getFrames: (id: number | null) => ResolvedFrame[]
): Record<string, unknown>[] {
  if (backtraceMnemonics.length === 0) return sqlRows;
  for (const row of sqlRows) {
    for (const m of backtraceMnemonics) {
      const key = `__out_${m}`;
      const id = row[key] as number | null;
      row[key] = id === null || id === undefined ? null : backtraceFmtFromFrames(getFrames(id));
    }
  }
  return sqlRows;
}

// ─── Frame lookup ─────────────────────────────────────────────────────────────

/**
 * A small memoized backtrace lookup, shared across a batch of hydrations —
 * reads the normalized frame ROWS (PMT:elm-swamp) for a backtrace_id and
 * rebuilds the ResolvedFrame[] in leaf-first order (frame_index ASC = the
 * order the parsers produced), the same shape the old JSON blob returned.
 */
export function makeFrameLookup(db: DatabaseSync): (id: number | null) => ResolvedFrame[] {
  const stmt = db.prepare(
    // Frame content lives in `symbols` (deduped); join to rebuild it (PMT:tidy-warbler).
    "SELECT s.name AS name, s.binary AS binary, s.binary_path AS binary_path, f.addr AS addr " +
      "FROM frames f JOIN symbols s ON f.symbol_id = s.id WHERE f.backtrace_id = ? ORDER BY f.frame_index ASC"
  );
  const cache = new Map<number, ResolvedFrame[]>();
  return (id: number | null): ResolvedFrame[] => {
    if (id === null || id === undefined) return [];
    const cached = cache.get(id);
    if (cached) return cached;
    const rows = stmt.all(id) as Array<{ name: string; binary: string | null; binary_path: string | null; addr: string | null }>;
    const frames: ResolvedFrame[] = rows.map((r) => ({
      name: r.name,
      addr: r.addr ?? "",
      binaryName: r.binary,
      binaryPath: r.binary_path,
    }));
    cache.set(id, frames);
    return frames;
  };
}

// ─── Interned-value resolution (PMT:lime-bluff) ────────────────────────────────

/**
 * A memoized resolver for interned large values: given a stored column value,
 * returns the original content if it's an intern sentinel token, else the value
 * unchanged. Small values (numbers, labels) pass straight through, so this is
 * cheap to apply everywhere a stored value is read back for display/hydration.
 * Content is cached by id across a batch of reads (a big blob resolves once).
 */
export function makeInternResolver(db: DatabaseSync): (v: unknown) => unknown {
  const resolve = makeInternedContentResolver(db);
  return (v: unknown): unknown => (isInternSentinel(v) ? resolve(internSentinelId(v)) : v);
}

/**
 * Resolve an interned_values id to its ORIGINAL content, decoding a PMT:dry-glen
 * node-encoded chain value (a sequence of hierarchy_nodes ids) back to its exact
 * string. Memoized by id; the hierarchy_nodes map is loaded once, lazily (only
 * if some value is actually node-encoded), so a trace with no chains pays
 * nothing. Shared by makeInternResolver (display) and the mcp_unintern UDF
 * (content predicates).
 */
export function makeInternedContentResolver(db: DatabaseSync): (id: number) => string {
  const stmt = db.prepare("SELECT content FROM interned_values WHERE id = ?");
  const cache = new Map<number, string>();
  let nodes: Map<number, string> | null = null;
  return (id: number): string => {
    const cached = cache.get(id);
    if (cached !== undefined) return cached;
    const row = stmt.get(id) as { content: string } | undefined;
    let content = row?.content ?? "";
    if (isNodeEncoded(content)) {
      if (nodes === null) {
        nodes = new Map();
        for (const r of db.prepare("SELECT id, name FROM hierarchy_nodes").all() as Array<{ id: number; name: string }>) {
          nodes.set(r.id, r.name);
        }
      }
      content = decodeNodeSequence(content, (nid) => nodes!.get(nid) ?? "");
    }
    cache.set(id, content);
    return content;
  };
}

/**
 * Registers mcp_unintern(id) — the SQL entry point to the same interned-content
 * resolver, so internResolved()'s CASE can reconstruct a node-encoded value for
 * content predicates (contains/regex). One per DB connection (session.ts's
 * getSessionDb), alongside registerRegexpUdf.
 */
export function registerInternDecodeUdf(db: DatabaseSync): void {
  const resolve = makeInternedContentResolver(db);
  db.function("mcp_unintern", (id: unknown) => resolve(Number(id)));
}

/** No-op resolver — for callers that know a table has no interned values, or to keep a signature satisfied. */
export const identityResolver = (v: unknown): unknown => v;

/**
 * Resolve a filter TARGET to its stored form for equality comparison
 * (PMT:ruddy-owl). If the value was interned (its content hash is in
 * interned_values), rows store the sentinel token, not the literal — so eq/ne
 * must compare against that token. Returns the sentinel token when the value is
 * interned, else the value unchanged. One indexed hash lookup per distinct
 * target (memoized), then a plain indexed `col = ?` — far cheaper than a
 * per-row resolve of the column, and correct for interned values of ANY size
 * (so this replaces lime-bluff's ≥256B-gated column-side resolve for equality).
 */
export function makeInternTargetResolver(db: DatabaseSync): (v: string) => string {
  const stmt = db.prepare("SELECT id FROM interned_values WHERE hash = ?");
  const cache = new Map<string, string>();
  return (v: string): string => {
    const cached = cache.get(v);
    if (cached !== undefined) return cached;
    const hash = createHash("sha256").update(v).digest("hex");
    const row = stmt.get(hash) as { id: number } | undefined;
    const form = row ? INTERN_SENTINEL + row.id : v;
    cache.set(v, form);
    return form;
  };
}

/**
 * Resolve intern sentinels in a page of display rows in place — each row's
 * `__out_<ref>` value, if it's a sentinel, becomes its original content. Only
 * sentinels are touched (small display values pass straight through), so this
 * is cheap to call unconditionally on every query/find/paginate page. Mirrors
 * resolveBacktraceDisplayValues (which runs first and yields plain strings that
 * this then leaves untouched).
 */
export function resolveInternedDisplayValues(
  sqlRows: Record<string, unknown>[],
  refs: string[],
  unintern: (v: unknown) => unknown
): Record<string, unknown>[] {
  for (const row of sqlRows) {
    for (const ref of refs) {
      const key = `__out_${ref}`;
      if (isInternSentinel(row[key])) row[key] = unintern(row[key]);
    }
  }
  return sqlRows;
}

// ─── Hydration: SQL row -> Cell / NormalizedRow ───────────────────────────────

/**
 * Rebuild one Cell from a hydrated SQL row's physical columns for `col`,
 * matching the exact shape the original XML parser produced. `type` comes
 * from the column's known engineeringType (SchemaCol), not per-row storage
 * (PMT:arid-buck's note — type was always redundant per-row, this is where
 * that gets resolved). A backtrace cell's fmt/raw are recomputed from the
 * joined frames array using the identical formula parseTable.ts's parseCell
 * uses at ingestion time — never stored separately, since they're fully
 * derivable and storing them would just be a second, driftable copy.
 */
export function hydrateCell(
  col: SchemaCol,
  sqlRow: Record<string, unknown>,
  getFrames: (id: number | null) => ResolvedFrame[],
  unintern: (v: unknown) => unknown = identityResolver
): Cell | null {
  if (isBacktraceCol(col)) {
    const btId = sqlRow[backtraceIdCol(col.mnemonic)];
    if (btId === null || btId === undefined) return null;
    const frames = getFrames(btId as number);
    const topName = frames[0]?.name ?? "";
    return {
      type: col.engineeringType,
      fmt: frames.length > 0 ? `${frames.length} frames, top: ${topName}` : "0 frames",
      raw: frames.length,
      resolvedFrames: frames,
    };
  }

  // A large stored value is an intern sentinel (PMT:lime-bluff) — resolve it
  // back to the original content before rebuilding the Cell. Small values pass
  // through unchanged. NULL still reliably means "the cell itself was null".
  const fmt = unintern(sqlRow[fmtCol(col.mnemonic)]);
  // fmt is always a real string for a non-null Cell (never optional in the
  // Cell interface) — SQL NULL here reliably means the cell itself was null
  // (a <sentinel/>), not a legitimate empty-string/zero value.
  if (fmt === null || fmt === undefined) return null;

  // PMT:live-fawn + muddy-frost: a compound cell's children are reconstructed
  // from its promoted columns — <mnemonic>__<child>__fmt (scalars/compounds) and
  // <mnemonic>__<child>__backtrace_id (nested stacks, folded into frames tables)
  // — merged with the small residual __children blob, which now carries ONLY the
  // un-promotable null children. get_row's childValues/extractKperfBt read each
  // immediate child's .fmt (and, for a nested backtrace, its resolved frames),
  // all faithfully rebuilt here.
  const residualJson = unintern(sqlRow[childrenCol(col.mnemonic)]) as string | null;
  const residual = residualJson ? (JSON.parse(residualJson) as Record<string, Cell | null>) : undefined;
  const children = reconstructShallowChildren(col.mnemonic, sqlRow, unintern, getFrames, residual);

  return {
    type: col.engineeringType,
    fmt: fmt as string,
    raw: (unintern(sqlRow[rawCol(col.mnemonic)]) as number | string | null) ?? "",
    ...(children ? { children } : {}),
  };
}

/**
 * Rebuild the shallow children map get_row consumes (each IMMEDIATE child tag →
 * a Cell carrying its fmt, plus resolved frames for a nested backtrace) from a
 * compound cell's promoted columns and its residual __children blob
 * (PMT:live-fawn + muddy-frost). Three sources, merged:
 *   - `<mnemonic>__<child>__fmt`         → scalar / compound child (fmt only)
 *   - `<mnemonic>__<child>__backtrace_id`→ nested stack, frames from the FK
 *   - residual blob                      → null children (the only un-promotable
 *                                          case; a `<sentinel/>` placeholder)
 * get_row's childValues and extractKperfBt only read a direct child's `.fmt`
 * (and a nested backtrace's frames), so this rebuild is byte-identical to the
 * old whole-blob JSON path for those consumers. Returns undefined for a genuine
 * scalar cell (no promoted child columns and no residual).
 */
function reconstructShallowChildren(
  mnemonic: string,
  sqlRow: Record<string, unknown>,
  unintern: (v: unknown) => unknown,
  getFrames: (id: number | null) => ResolvedFrame[],
  residual: Record<string, Cell | null> | undefined
): Record<string, Cell | null> | undefined {
  const prefix = `${mnemonic}__`;
  let children: Record<string, Cell | null> | undefined;
  for (const key of Object.keys(sqlRow)) {
    if (!key.startsWith(prefix)) continue;
    if (key.endsWith("__fmt")) {
      const middle = key.slice(prefix.length, key.length - "__fmt".length);
      // "" → the cell's own __fmt; a middle containing "__" → a deeper path,
      // not an immediate child. Skip both.
      if (middle.length === 0 || middle.includes("__")) continue;
      const childFmt = unintern(sqlRow[key]);
      if (childFmt === null || childFmt === undefined) continue; // child absent on this row
      (children ??= {})[middle] = { type: "", fmt: childFmt as string, raw: "" };
    } else if (key.endsWith("__backtrace_id")) {
      const middle = key.slice(prefix.length, key.length - "__backtrace_id".length);
      if (middle.length === 0 || middle.includes("__")) continue; // top-level FK / deeper path
      const id = sqlRow[key];
      if (id === null || id === undefined) continue; // no nested stack on this row
      const frames = getFrames(id as number);
      (children ??= {})[middle] = {
        type: "",
        fmt: backtraceFmtFromFrames(frames),
        raw: frames.length,
        resolvedFrames: frames,
      };
    }
  }
  if (residual) {
    for (const [key, val] of Object.entries(residual)) (children ??= {})[key] = val;
  }
  return children;
}

/** Rebuild a full NormalizedRow (every column) from one hydrated SQL row. */
export function hydrateNormalizedRow(
  cols: SchemaCol[],
  sqlRow: Record<string, unknown>,
  getFrames: (id: number | null) => ResolvedFrame[],
  unintern: (v: unknown) => unknown = identityResolver
): NormalizedRow {
  const row: NormalizedRow = {};
  for (const col of cols) {
    row[col.mnemonic] = hydrateCell(col, sqlRow, getFrames, unintern);
  }
  return row;
}

/**
 * Fetch and hydrate an ENTIRE table into NormalizedRow[] — a last-resort
 * escape hatch, not a default (PMT:warm-mica). Every lens site that used to
 * reach for this as its normal path (leaks/network hint checks, swiftUI's
 * paginateTable, the three Foundation Models drill-down files) has been
 * rewritten to a scoped SQL query — a single-row lookup, a bounded page, a
 * direct join/aggregate — because pulling a whole table into JS just to read
 * one row or compute one scalar reintroduces, at the lens layer, the exact
 * full-table-scan-into-JS cost this entire feature exists to eliminate at
 * the core-verb layer. Zero callers remain in this codebase as of warm-mica.
 *
 * Kept (deliberately, not deleted) for the rare, genuine case a lens needs
 * every row at once and there is no honest way to express that as a bounded
 * SQL query — that should be a deliberate, documented decision at the call
 * site (say why a scoped query doesn't work), not a reflexive default. New
 * lens code should reach for a base verb or hand-written scoped SQL first;
 * see src/lenses/example.ts for both patterns demonstrated side by side.
 */
export function fetchAllRowsHydrated(db: DatabaseSync, tableName: string, cols: SchemaCol[]): NormalizedRow[] {
  const getFrames = makeFrameLookup(db);
  const unintern = makeInternResolver(db);
  const sqlRows = db
    .prepare(`SELECT * FROM ${quoteIdent(tableName)} ORDER BY ${quoteIdent(ROW_IDX_COLUMN)} ASC`)
    .all() as Record<string, unknown>[];
  return sqlRows.map((sqlRow) => hydrateNormalizedRow(cols, sqlRow, getFrames, unintern));
}

// ─── WHERE-clause building ────────────────────────────────────────────────────

export interface SqlCondition {
  clause: string;
  params: Array<string | number>;
}

/**
 * SQL that yields a column's ORIGINAL content whether it's stored inline or as
 * an intern sentinel (PMT:lime-bluff) — so content predicates (contains/regex,
 * and equality against a large value) match interned rows too, not just inline
 * ones. Resolution goes through the mcp_unintern UDF (not a raw subquery on
 * interned_values.content) because a PMT:dry-glen value is stored node-encoded
 * and must be DECODED to its original text before a substring/regex match; the
 * UDF also memoizes, so a repeated sentinel resolves once. The CASE
 * short-circuits on the cheap SUBSTR check, so a column with no interned values
 * is just `col` plus a per-row char test. Requires registerInternDecodeUdf on
 * the connection.
 */
export function internResolved(colSql: string): string {
  return (
    `(CASE WHEN SUBSTR(${colSql},1,1)=char(1) ` +
    `THEN mcp_unintern(CAST(SUBSTR(${colSql},2) AS INTEGER)) ` +
    `ELSE ${colSql} END)`
  );
}
// The backtrace-column guard that used to live here (assertNotBacktraceMnemonic)
// is now FieldResolver.resolveComparable in engine/fieldRef.ts — folded into
// dot-path resolution so a single call both resolves a field and rejects a
// backtrace column with the same clear "use get_row / call_tree" message.

/**
 * query.ts's simple equality filter: mnemonic -> expected fmt or raw value.
 * `internTarget` (PMT:ruddy-owl) resolves a string target to its stored form —
 * the sentinel token when the value was interned, else the literal — so the
 * comparison stays a plain indexed `col = ?` that matches interned rows too.
 */
export function buildEqualityFilter(
  filter: Record<string, string | number>,
  internTarget?: (v: string) => string
): SqlCondition {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  for (const [mnemonic, expected] of Object.entries(filter)) {
    const raw = quoteIdent(rawCol(mnemonic));
    const fmt = quoteIdent(fmtCol(mnemonic));
    if (typeof expected === "number") {
      // Matches matchesFilter's "raw === expected || Number(raw) === expected" —
      // a text-affinity match on the numeric string form covers the coercion case.
      clauses.push(`(${raw} = ? OR CAST(${raw} AS TEXT) = ?)`);
      params.push(expected, String(expected));
    } else {
      const stored = internTarget ? internTarget(expected) : expected;
      clauses.push(`(${fmt} = ? OR CAST(${raw} AS TEXT) = ?)`);
      params.push(stored, stored);
    }
  }
  return { clause: clauses.join(" AND "), params };
}

/** aggregate.ts/query.ts/find.ts's timeRange window against a known time column's raw (ns) value. */
export function buildTimeRangeFilter(
  timeColumn: string,
  timeRange: { startNs?: number; endNs?: number }
): SqlCondition {
  const clauses: string[] = [];
  const params: number[] = [];
  const raw = quoteIdent(rawCol(timeColumn));
  if (timeRange.startNs !== undefined) {
    clauses.push(`${raw} >= ?`);
    params.push(timeRange.startNs);
  }
  if (timeRange.endNs !== undefined) {
    clauses.push(`${raw} <= ?`);
    params.push(timeRange.endNs);
  }
  return { clause: clauses.join(" AND "), params };
}

export type ConditionOp =
  | "eq" | "ne"
  | "gt" | "gte" | "lt" | "lte"
  | "contains" | "not-contains"
  | "regex"
  | "is-null" | "not-null";

/**
 * find.ts's richer predicate DSL — mirrors testCondition's raw+fmt dual-check
 * semantics exactly. `internTarget` (PMT:ruddy-owl) resolves an eq/ne string
 * target to its stored form so equality matches interned rows; contains/regex
 * instead resolve the COLUMN per-row (they search within the value).
 *
 * PMT:narrow-ochre: pass `compareMnemonic` to compare against another column
 * on the same row instead of the literal `val` (val is ignored when
 * present) — see buildCrossColumnCondition below. Only eq/ne/gt/gte/lt/lte
 * support this; contains/not-contains/regex/is-null/not-null stay
 * literal/unary-only, since "column A's value inside column B" isn't one of
 * the two gaps this prompt closes.
 */
export function buildCondition(
  mnemonic: string,
  op: ConditionOp,
  val: string | number | undefined,
  internTarget?: (v: string) => string,
  compareMnemonic?: string
): SqlCondition {
  if (compareMnemonic !== undefined) {
    return buildCrossColumnCondition(mnemonic, op, compareMnemonic);
  }

  const raw = quoteIdent(rawCol(mnemonic));
  const fmt = quoteIdent(fmtCol(mnemonic));

  if (op === "is-null") return { clause: `${fmt} IS NULL`, params: [] };
  if (op === "not-null") return { clause: `${fmt} IS NOT NULL`, params: [] };

  // Every other op requires a non-null cell (testCondition returns false outright otherwise).
  const notNullGuard = `${fmt} IS NOT NULL`;

  switch (op) {
    case "eq": {
      if (val === undefined) return { clause: "0", params: [] };
      if (typeof val === "number") {
        return { clause: `${notNullGuard} AND (${raw} = ? OR CAST(${raw} AS REAL) = ?)`, params: [val, val] };
      }
      const stored = internTarget ? internTarget(val) : val;
      return { clause: `${notNullGuard} AND (${fmt} = ? OR CAST(${raw} AS TEXT) = ?)`, params: [stored, stored] };
    }

    case "ne": {
      if (val === undefined) return { clause: "0", params: [] };
      if (typeof val === "number") {
        return { clause: `${notNullGuard} AND ${raw} != ? AND CAST(${raw} AS REAL) != ?`, params: [val, val] };
      }
      const stored = internTarget ? internTarget(val) : val;
      return { clause: `${notNullGuard} AND ${fmt} != ? AND CAST(${raw} AS TEXT) != ?`, params: [stored, stored] };
    }

    case "gt":
      return val === undefined
        ? { clause: "0", params: [] }
        : { clause: `${notNullGuard} AND CAST(${raw} AS REAL) > ?`, params: [Number(val)] };
    case "gte":
      return val === undefined
        ? { clause: "0", params: [] }
        : { clause: `${notNullGuard} AND CAST(${raw} AS REAL) >= ?`, params: [Number(val)] };
    case "lt":
      return val === undefined
        ? { clause: "0", params: [] }
        : { clause: `${notNullGuard} AND CAST(${raw} AS REAL) < ?`, params: [Number(val)] };
    case "lte":
      return val === undefined
        ? { clause: "0", params: [] }
        : { clause: `${notNullGuard} AND CAST(${raw} AS REAL) <= ?`, params: [Number(val)] };

    // contains/not-contains/regex search WITHIN the value, so a short target can
    // match inside a large INTERNED value — always resolve the sentinel to its
    // content first (the CASE is a no-op for inline rows, PMT:lime-bluff).
    case "contains":
      if (val === undefined) return { clause: "0", params: [] };
      return {
        clause: `${notNullGuard} AND (INSTR(${internResolved(fmt)}, ?) > 0 OR INSTR(CAST(${internResolved(raw)} AS TEXT), ?) > 0)`,
        params: [String(val), String(val)],
      };
    case "not-contains":
      if (val === undefined) return { clause: "0", params: [] };
      return {
        clause: `${notNullGuard} AND INSTR(${internResolved(fmt)}, ?) = 0 AND INSTR(CAST(${internResolved(raw)} AS TEXT), ?) = 0`,
        params: [String(val), String(val)],
      };

    case "regex":
      if (val === undefined) return { clause: "0", params: [] };
      return {
        clause: `${notNullGuard} AND (mcp_regexp(?, ${internResolved(fmt)}) = 1 OR mcp_regexp(?, CAST(${internResolved(raw)} AS TEXT)) = 1)`,
        params: [String(val), String(val)],
      };

    default:
      return { clause: "0", params: [] };
  }
}

/**
 * PMT:narrow-ochre's cross-column comparison: A op B instead of A op <literal>.
 * gt/gte/lt/lte compare CAST(...AS REAL) on both sides (mirrors the literal
 * case's numeric cast — these ops are inherently numeric). eq/ne mirror the
 * literal case's raw+fmt dual-check, but two-sided: fmt is resolved through
 * internResolved on both sides (two equal-content cells intern to the SAME
 * sentinel via content-hash, but only if both columns interned it — using
 * internResolved rather than raw sentinel comparison also covers a column
 * pair where only one side crossed the intern threshold) OR'd with a raw
 * text-cast comparison (covers plain numeric/short values without invoking
 * the intern UDF at all).
 */
function buildCrossColumnCondition(mnemonic: string, op: ConditionOp, compareMnemonic: string): SqlCondition {
  const rawA = quoteIdent(rawCol(mnemonic));
  const fmtA = quoteIdent(fmtCol(mnemonic));
  const rawB = quoteIdent(rawCol(compareMnemonic));
  const fmtB = quoteIdent(fmtCol(compareMnemonic));
  const bothNotNull = `${fmtA} IS NOT NULL AND ${fmtB} IS NOT NULL`;

  switch (op) {
    case "eq":
      return { clause: `${bothNotNull} AND (${internResolved(fmtA)} = ${internResolved(fmtB)} OR CAST(${rawA} AS TEXT) = CAST(${rawB} AS TEXT))`, params: [] };
    case "ne":
      return { clause: `${bothNotNull} AND ${internResolved(fmtA)} != ${internResolved(fmtB)} AND CAST(${rawA} AS TEXT) != CAST(${rawB} AS TEXT)`, params: [] };
    case "gt":
      return { clause: `${bothNotNull} AND CAST(${rawA} AS REAL) > CAST(${rawB} AS REAL)`, params: [] };
    case "gte":
      return { clause: `${bothNotNull} AND CAST(${rawA} AS REAL) >= CAST(${rawB} AS REAL)`, params: [] };
    case "lt":
      return { clause: `${bothNotNull} AND CAST(${rawA} AS REAL) < CAST(${rawB} AS REAL)`, params: [] };
    case "lte":
      return { clause: `${bothNotNull} AND CAST(${rawA} AS REAL) <= CAST(${rawB} AS REAL)`, params: [] };
    default:
      // Unreachable for well-formed callers — resolver-level validation (find.ts)
      // rejects compareCol on contains/regex/is-null/not-null before this runs.
      return { clause: "0", params: [] };
  }
}

/** AND-joins conditions — the existing, unchanged default combinator (empty group = match-all). */
export function combineConditions(conditions: SqlCondition[]): SqlCondition {
  return combineWithOp(conditions, "AND");
}

/**
 * PMT:narrow-ochre's OR support: joins conditions with the given boolean
 * operator instead of hardcoding AND — find.ts's condition-tree compiler calls
 * this once per allOf/anyOf group. An empty AND group matches everything
 * (existing behavior, unchanged); an empty OR group matches nothing (the
 * empty disjunction is false, same as SQL's own "no branch matched").
 */
export function combineWithOp(conditions: SqlCondition[], op: "AND" | "OR"): SqlCondition {
  const nonEmpty = conditions.filter((c) => c.clause.length > 0);
  if (nonEmpty.length === 0) return { clause: op === "AND" ? "1" : "0", params: [] };
  return {
    clause: nonEmpty.map((c) => `(${c.clause})`).join(` ${op} `),
    params: nonEmpty.flatMap((c) => c.params),
  };
}
