/**
 * SQLite ingestion sink — the on-disk counterpart of tableCache's old
 * "accumulate NormalizedRow[] in a JS array" behavior. One SQLite DB file per
 * session; one SQL table per (run,schema) inside it, named by the same cache
 * key session.ts already used for the JS Map (`${run}:${schema}`), so the
 * table-naming scheme carries over unchanged.
 *
 * Column shape, per non-backtrace mnemonic:
 *   "<mnemonic>"           — raw value (number|string), on an untyped column
 *                             (SQLite NONE affinity — no CREATE TABLE type
 *                             given) so it stores exactly whatever a Cell's
 *                             `raw` holds without a lossy coercion decision
 *                             made ahead of seeing any real data
 *   "<mnemonic>__fmt"      — the human-readable fmt string (duration/size
 *                             formatting etc. isn't always reconstructable
 *                             from raw alone)
 *   "<mnemonic>__children" — JSON of a compound cell's FULL children (thread,
 *                             process, kperf-bt, ...), else NULL — kept as a
 *                             fully-faithful fallback even though scalar
 *                             children also get promoted (below), since a
 *                             compound child (nesting two levels deep) is
 *                             never promoted and would otherwise be lossy.
 *   "<mnemonic>__<path>", "<mnemonic>__<path>__fmt" — nested-field promotion:
 *                             promotion of a compound cell's descendants at
 *                             ANY depth (not capped at one level — see
 *                             below), so common fields (thread's
 *                             tid, but also thread.process.pid two levels
 *                             down) are directly queryable/indexable via
 *                             plain SQL instead of trapped in the
 *                             __children JSON blob — the whole reason for
 *                             moving to SQL in the first place. A one-level
 *                             cap seemed sufficient at first (thread-info
 *                             happens to also expose `process` as its own
 *                             independent top-level column, so nothing was
 *                             lost there) but kdebug's `thread` column
 *                             nests a `process` with NO independent sibling
 *                             column anywhere in the row — confirmed live —
 *                             so `thread.process.pid` was only reachable via
 *                             JSON, not SQL, until this became recursive.
 *                             For a path to a SCALAR descendant, both
 *                             "<mnemonic>__<path>" (raw) and the __fmt
 *                             sibling are promoted. For a path to a
 *                             COMPOUND intermediate node (e.g. thread's own
 *                             `process`, one step before its scalar
 *                             children), only the __fmt sibling is promoted
 *                             (its own summary string) — matching the one
 *                             existing consumer of nested compound data
 *                             (getRow.ts's childValues, which only ever
 *                             wants a direct child's .fmt regardless of
 *                             whether that child is itself compound).
 *                             Recursion stops at a defensive max-depth cap
 *                             (not expected to be hit by any real schema
 *                             seen so far), not an arbitrary one-level rule.
 *
 *                             Column shape here is only knowable from actual
 *                             row data (a column's compound-ness and its
 *                             child-key set aren't declared anywhere in the
 *                             XML <schema> block) — so the base table (no
 *                             promoted columns) is created immediately in
 *                             the constructor, and promotion happens
 *                             incrementally as rows arrive via ALTER TABLE
 *                             ADD COLUMN, uniformly whether the first
 *                             compound value shows up on row 1 or row
 *                             500,000 (no special-casing "the first row",
 *                             and a genuinely zero-row schema still gets a
 *                             real, queryable empty table).
 *
 * A backtrace-bearing column (engineering-type "backtrace"/"text-backtrace",
 * or track-detail's fixed "backtrace" mnemonic — the same detection every
 * existing parser already hardcodes) gets ONE column instead:
 *   "<mnemonic>__backtrace_id" — FK into the shared `frames` table.
 * Frames are deduped by JSON content across the WHOLE session db, not just
 * one table — the same stack commonly recurs across schemas in one trace,
 * matching the dedup value xctrace's own id/ref XML scheme already provided.
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { createHash } from "node:crypto";
import type { SchemaCol, NormalizedRow, Cell, ResolvedFrame } from "./parseTable.js";
import { MEMORY_CHECK_INTERVAL } from "./memoryGuard.js";
import { ColumnStatsAccumulator, decideInternColumns } from "./columnStats.js";
import { encodeNodeSequence } from "./hierarchyEncode.js";

/** A defensive backstop against pathological data, not a real design limit — no real schema seen so far nests anywhere close to this deep. */
const MAX_PROMOTION_DEPTH = 6;

/**
 * Accumulates ref-identity among a row's SCALAR cells across the whole ingest
 * so duplicate dot-paths that reach the SAME value collapse to one
 * canonical path (thread-info exposes thread.process.pid AND
 * name.thread.process.pid as the exact same value — same XML ref).
 *
 * The key fact making this a direct OBSERVATION, not a risky inference: a
 * `<thing ref="N"/>` resolves through the per-node RefCache to the SAME Cell
 * OBJECT as the `<thing id="N">` it points at (see parseTable.ts's parseCell).
 * So two columns landing on the identical object in one parsed row are provably
 * ref-shared — the same value — for that row (object identity can't collide by
 * coincidence the way value-equality can). RefCache is node-scoped (ids restart
 * per <node>), so identity is only compared WITHIN a row; a pair is declared
 * identical only if it holds in EVERY row where both columns are present (any
 * counterexample breaks it), which is airtight across nodes.
 *
 * Cost is bounded: singletons (the overwhelming majority — every distinct value
 * is its own object) never form a pair, so `candidates` only ever grows to the
 * handful of genuinely ref-shared column pairs, and the per-row break check
 * iterates just those.
 */
class ColumnIdentityTracker {
  /** Pairs (base-name "a b", a<b) seen same-object in ≥1 row. */
  private readonly candidates = new Set<string>();
  /** Candidate pairs later contradicted (both present, different objects) — no longer identical. */
  private readonly broken = new Set<string>();

  private static pairKey(a: string, b: string): string {
    return a < b ? `${a} ${b}` : `${b} ${a}`;
  }

  /** Feed one row's scalar cells as (base-column-name, Cell) pairs. */
  observeRow(scalarCells: Array<[string, Cell]>): void {
    if (scalarCells.length < 2) return;
    const colToObj = new Map<string, Cell>();
    const byObj = new Map<Cell, string[]>();
    for (const [name, cell] of scalarCells) {
      colToObj.set(name, cell);
      const arr = byObj.get(cell);
      if (arr) arr.push(name);
      else byObj.set(cell, [name]);
    }
    // Break any existing candidate whose two columns are both present this row
    // but no longer land on the same object.
    for (const key of this.candidates) {
      if (this.broken.has(key)) continue;
      const sep = key.indexOf(" ");
      const a = key.slice(0, sep);
      const b = key.slice(sep + 1);
      const oa = colToObj.get(a);
      const ob = colToObj.get(b);
      if (oa !== undefined && ob !== undefined && oa !== ob) this.broken.add(key);
    }
    // Register (or re-affirm) pairs that share an object this row.
    for (const names of byObj.values()) {
      if (names.length < 2) continue;
      for (let i = 0; i < names.length; i++) {
        for (let j = i + 1; j < names.length; j++) {
          const key = ColumnIdentityTracker.pairKey(names[i], names[j]);
          if (!this.broken.has(key)) this.candidates.add(key);
        }
      }
    }
  }

  /** Connected components of columns that are provably identical (union-find over surviving pairs). */
  finalizeGroups(): string[][] {
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let root = x;
      while (parent.get(root) !== root && parent.get(root) !== undefined) root = parent.get(root)!;
      return root;
    };
    const union = (a: string, b: string): void => {
      if (!parent.has(a)) parent.set(a, a);
      if (!parent.has(b)) parent.set(b, b);
      parent.set(find(a), find(b));
    };
    for (const key of this.candidates) {
      if (this.broken.has(key)) continue;
      const sep = key.indexOf(" ");
      union(key.slice(0, sep), key.slice(sep + 1));
    }
    const groups = new Map<string, string[]>();
    for (const col of parent.keys()) {
      const root = find(col);
      const arr = groups.get(root);
      if (arr) arr.push(col);
      else groups.set(root, [col]);
    }
    return [...groups.values()].filter((g) => g.length > 1);
  }
}

/** A discoverable promoted path into a compound cell's descendants. */
interface PromotablePath {
  /** Ordered child keys from the cell's own .children down to this descendant. */
  path: string[];
  /**
   * scalar: a scalar leaf (promote raw+fmt). compound: a compound intermediate
   * node (promote fmt only). backtrace: a nested pre-symbolicated stack — folded
   * into the shared backtraces/frames tables and promoted as a __backtrace_id FK,
   * getting the same DB-wide dedup a top-level backtrace column already gets.
   */
  kind: "scalar" | "compound" | "backtrace";
}

function pathKey(path: string[]): string {
  return JSON.stringify(path);
}

/**
 * Recursively find every promotable descendant of `children`: scalar leaves
 * (raw+fmt), compound intermediate nodes (fmt only — matching getRow.ts's
 * childValues, which only wants a direct child's .fmt regardless of whether it
 * is itself compound), and nested backtraces (resolvedFrames at depth > 0) —
 * these fold into the shared frames/backtraces tables via a __backtrace_id FK
 * instead of leaving them re-encoded per row inside the parent's __children
 * JSON. A null child is the only thing left un-promotable —
 * it carries no column, and survives in the small residual __children blob
 * (residualChildrenBlob) so getRow's childValues can still show it.
 */
function collectPromotablePaths(
  children: Record<string, Cell | null>,
  prefix: string[],
  depth: number
): PromotablePath[] {
  if (depth > MAX_PROMOTION_DEPTH) return [];
  const found: PromotablePath[] = [];
  for (const [key, child] of Object.entries(children)) {
    if (child === null) continue; // null child → residual blob, no promoted column
    const path = [...prefix, key];
    if (child.resolvedFrames) {
      // A nested stack — do NOT recurse into it; it becomes one deduped FK.
      found.push({ path, kind: "backtrace" });
    } else if (child.children) {
      found.push({ path, kind: "compound" });
      found.push(...collectPromotablePaths(child.children, path, depth + 1));
    } else {
      found.push({ path, kind: "scalar" });
    }
  }
  return found;
}

/** Walk a cell's .children down `path`, returning the descendant cell (or null if any step is missing). */
function resolveCellAtPath(cell: Cell | null | undefined, path: string[]): Cell | null {
  let current: Cell | null | undefined = cell;
  for (const key of path) {
    current = current?.children?.[key];
  }
  return current ?? null;
}

/**
 * The __children blob's sole consumer (getRow.ts's childValues /
 * extractKperfBt) only reads each IMMEDIATE child's fmt, and every non-null
 * immediate child is now reconstructable from a promoted column:
 * scalars/compounds from <mnemonic>__<child>__fmt, and nested backtraces from
 * a __backtrace_id FK (the same backtrace dedup FK used for top-level
 * backtrace columns). So the only thing the blob still needs to carry is null
 * immediate children (a `<sentinel/>` placeholder that has no column). Store
 * just those — a tiny residual object, e.g. {"sentinel":null} — and NULL when
 * there are none. hydrateCell merges promoted + FK + this residual back into
 * the shallow children map. This is what lets a compound whose bulk was a
 * nested stack (cause-graph-node: string + a 28-frame backtrace + a null
 * sentinel) drop from a per-row JSON re-encode to one FK + a ~15-byte residual.
 */
function residualChildrenBlob(cell: Cell | null | undefined): string | null {
  if (!cell?.children) return null;
  const residual: Record<string, null> = {};
  for (const [key, child] of Object.entries(cell.children)) {
    if (child === null) residual[key] = null;
  }
  return Object.keys(residual).length > 0 ? JSON.stringify(residual) : null;
}

const BACKTRACE_ENGINEERING_TYPES = new Set(["backtrace", "text-backtrace", "tagged-backtrace"]);

/** Same backtrace detection every existing parser (parseTable.ts, parseTrackDetail.ts) already hardcodes. */
export function isBacktraceCol(col: SchemaCol): boolean {
  return BACKTRACE_ENGINEERING_TYPES.has(col.engineeringType) || col.mnemonic === "backtrace";
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Stable, 0-based, sequential row index — the SQL-backed counterpart of the
 * old ParsedTable.rows array-index contract get_row relies on (query/find's
 * `tableIndex` is a public contract: get_row re-fetches `table.rows[rowIndex]`
 * from the FULL, unfiltered table). Deliberately an explicit column, not
 * SQLite's own implicit rowid — rowid starts at 1 by default and this keeps
 * the contract exactly 0-based regardless of any SQLite internals.
 */
export const ROW_IDX_COLUMN = "_row_idx";

/**
 * Value interning. A stored value ≥ INTERN_THRESHOLD_BYTES is
 * replaced in its physical column by a tiny sentinel token: INTERN_SENTINEL
 * (a control char that never appears in xctrace's text) followed by the decimal
 * interned_values.id. Reads detect the prefix and resolve id → content.
 *
 * Threshold rationale: interning adds a small per-value cost (the sentinel +
 * a row in interned_values + its hash index), so it only pays for genuinely
 * large values — where even modest cross-row sharing wins big, and the
 * dominant blowup lives (KB-scale view-hierarchy / cause-graph / prompt blobs).
 * Small values stay inline, so numeric/label columns (filtered, grouped,
 * sorted) are untouched. A large value that happens to be unique costs one
 * extra small row + sentinel vs. inline — a negligible loss next to the
 * order-of-magnitude win on the shared blobs.
 */
export const INTERN_SENTINEL = String.fromCharCode(1); // SOH — never present in xctrace text
export const INTERN_THRESHOLD_BYTES = 256;
/**
 * Bumped whenever the persisted on-disk shape changes incompatibly (a table's
 * columns, a side table's structure) so a persisted trace-cache .db written by
 * an older build isn't silently reused against new-code reads. traceCache
 * stores this in the .db's _meta and treats a mismatch like an mtime-stale
 * cache: wipe + re-ingest (re-export). No in-place migration.
 * History: 1 = pre-symbols frames(name,binary,binary_path); 2 = frames.symbol_id
 * + the deduped `symbols` table (see the symbol-content dedup described in
 * openSessionDb); 3 = backtraces.fingerprint is a sha256 hash, not raw-stack
 * JSON — an old .db's JSON fingerprints would never match the new hash keys,
 * so a re-ingest into it would double-store every stack; a version bump forces
 * a clean rebuild.
 * 4 = large interned chain values are node-encoded into `hierarchy_nodes` —
 * reads decode per-value, so a mixed old/new .db would work, but a bump keeps
 * every .db in one clean shape.
 */
export const INGEST_SCHEMA_VERSION = "4";
/**
 * Flavor-2 interning: for a column classified (by the look-ahead sample below)
 * as low-distinct / high-repeat, values this size or larger are interned (well
 * below the 256B flavor-1 floor used for every other column) — a 20-byte
 * category repeated 275k× is pure duplication. Below this even N copies aren't
 * worth a side-table row + hash-index entry. Interning stays CONSISTENT (every
 * occurrence of a value → the same content-hash sentinel), so GROUP BY / JOIN /
 * eq are unaffected.
 */
export const FLAVOR2_INTERN_FLOOR_BYTES = 16;
/**
 * Single-pass look-ahead: buffer this many rows to decide which columns get
 * the flavor-2 treatment above before writing any. Enough to read a column's
 * repeat/distinct character (a ratio, so a sample suffices) while bounding the
 * buffered-row memory. Small tables never reach it — they flush at finish().
 */
export const FLAVOR2_SAMPLE_ROWS = 20_000;

/** True if a stored column value is an intern sentinel token (not literal content). */
export function isInternSentinel(v: unknown): v is string {
  return typeof v === "string" && v.length > 1 && v.charCodeAt(0) === 1;
}

/** The interned_values.id encoded in a sentinel token. */
export function internSentinelId(token: string): number {
  return Number(token.slice(1));
}

/**
 * Open (or create) the one SQLite DB file backing a whole session.
 *
 * journalMode "wal" (default) avoids readers blocking on a writer mid-ingest.
 * The persisted, colocated trace cache (engine/traceCache.ts) passes "default"
 * instead — WAL only earns its keep for concurrent reader/writer access, and
 * that DB is write-once-during-ingest then READ-ONLY (no concurrent writer
 * ever touches a schema after it loads), so WAL there is pure downside: it
 * leaves `.db-wal`/`.db-shm` sidecar files next to the .trace, defeating the
 * "one obvious file to manage" tidiness the whole feature is built around. The
 * default rollback journal leaves only a transient `-journal` during a write
 * transaction, deleted by SQLite on commit — see engine/traceCache.ts.
 */
export function openSessionDb(dbPath: string, opts: { journalMode?: "wal" | "default" } = {}): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  if ((opts.journalMode ?? "wal") === "wal") {
    db.exec("PRAGMA journal_mode = WAL");
  }
  // Generic key-value metadata — currently used for the persisted trace
  // cache's source_mtime_ms/source_path staleness check (see engine/traceCache.ts).
  // A single small table rather than a bespoke one-row schema per fact, since
  // more sessions-worth of small facts may accumulate here over time.
  db.exec("CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT)");
  // Persisted column metadata (mnemonic/name/engineering-type) per ingested
  // (run,schema) table. A physical SQLite table only has column NAMES
  // (thread__process__pid, ...); engineeringType (needed to rebuild a real
  // SchemaCol[]) is otherwise only known transiently, from the live XML TOC's
  // <schema> block or a track-detail discovery pass. Recording it here is what
  // makes cross-PROCESS reuse of an already-ingested table possible — a
  // brand-new process can rebuild `cols` from this table alone, with zero
  // xctrace calls, instead of only ever reusing within one process's lifetime
  // the way the in-memory schemaModel/tableCache do.
  db.exec(
    "CREATE TABLE IF NOT EXISTS _ingested_schema (table_name TEXT, mnemonic TEXT, name TEXT, engineering_type TEXT)"
  );
  // Backtraces are stored as QUERYABLE FRAME ROWS, not a JSON blob —
  // the whole point of the SQLite engine is queryable data, and call_tree folds from
  // frame rows. `backtraces` dedups by fingerprint (a sha256 of the frame sequence —
  // the same stack recurs across thousands of rows and schemas, so dedup is a real win;
  // it's hashed rather than storing the raw-stack JSON, which was a 6+ GB
  // third copy of the frame content on backtrace-heavy traces — see backtraceIdFor);
  // each distinct backtrace's frames live in `frames`, one row per frame,
  // leaf-first (frame_index 0 = deepest call, matching the leaf-first XML order both
  // parsers produce; consumers reverse for a root-first tree).
  //
  // The backtrace fold above dedups STACK IDENTITY, but a stack-rich trace
  // still explodes the frame ROWS — a real 347k-row Allocations trace had 126k distinct
  // backtraces expand to 16 M frame rows, each storing its full name/binary/binary_path
  // strings even though only ~23,744 distinct names / 215 binaries underlie them (~2 GB
  // of ~677x-redundant text). So the frame CONTENT is deduped one level deeper: distinct
  // (name, binary, binary_path) tuples live once in `symbols`, and each frame row stores
  // a small `symbol_id` FK + its per-instance `addr`. The old idx_frames_name (a name
  // index over every frame row) is gone — no query filtered frames by name (both readers
  // fold by backtrace_id); a name lookup, if ever needed, is on the tiny symbols table.
  db.exec("CREATE TABLE IF NOT EXISTS backtraces (id INTEGER PRIMARY KEY, fingerprint TEXT UNIQUE)");
  db.exec(
    "CREATE TABLE IF NOT EXISTS symbols (id INTEGER PRIMARY KEY, name TEXT, binary TEXT, binary_path TEXT)"
  );
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_symbols_content ON symbols(name, binary, binary_path)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name)");
  db.exec(
    "CREATE TABLE IF NOT EXISTS frames (backtrace_id INTEGER, frame_index INTEGER, symbol_id INTEGER, addr TEXT)"
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_frames_backtrace ON frames(backtrace_id)");
  // Interned large/repeated cell values — the same dedup discipline `frames`
  // gives backtraces, extended to ordinary large text.
  // xctrace's XML already dedups a repeated big value (a view-hierarchy chain,
  // a cause-graph-node) to one `id` + cheap `<ref>`s; our parser resolves every
  // ref to the full value, so without this the writer would serialize that
  // value into EVERY row that shares it (852k-row swiftui-updates → ~28 GB db,
  // confirmed against a real trace). Instead a value ≥ the intern threshold is
  // stored ONCE here (deduped by content hash) and the row column holds a tiny
  // sentinel token; reads resolve it (see INTERN_SENTINEL / resolveInterned).
  // `hash` is a content hash so the UNIQUE index stays small regardless of blob
  // size; collision would merge distinct values, so it must be a strong hash
  // (sha256) where that is not a realistic risk.
  db.exec("CREATE TABLE IF NOT EXISTS interned_values (id INTEGER PRIMARY KEY, hash TEXT UNIQUE, content TEXT)");
  // Distinct view-hierarchy / cause NODES (the ~5-20k shared view
  // types like LazyVStack). A large interned value that is a delimited chain has
  // its content stored node-encoded (a sequence of these ids), collapsing the
  // ~2.4 GB of distinct-but-node-redundant text; reads decode via this table.
  db.exec("CREATE TABLE IF NOT EXISTS hierarchy_nodes (id INTEGER PRIMARY KEY, name TEXT UNIQUE)");
  // Dot-path metadata, one row-set per ingested (run,schema) table:
  //   promoted_column — every DSL-usable nested SCALAR path promoted by the
  //     nested-field promotion scheme described in this file's header comment,
  //     mapping its dot-path (thread.process.pid) to the physical base column
  //     (thread__process__pid). Stored explicitly rather than reverse-parsing
  //     physical names, since a mnemonic could itself contain "__" and
  //     splitting would be ambiguous.
  //   column_identity — for each base column proven ref-identical to a shorter
  //     canonical one (see ColumnIdentityTracker), base_column -> canonical.
  //     Absence of a row means "this column IS canonical" (or unique). The
  //     dot-path resolver canonicalizes through this; describe_schema hides
  //     any promoted path that has a canonical entry, so an agent is offered
  //     exactly ONE way to reach each distinct value.
  db.exec(
    "CREATE TABLE IF NOT EXISTS promoted_column (table_name TEXT, base_column TEXT, dotpath TEXT)"
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS column_identity (table_name TEXT, base_column TEXT, canonical_column TEXT)"
  );
  return db;
}

/**
 * Streams NormalizedRows into one SQLite table, batching inserts inside a
 * transaction every {@link MEMORY_CHECK_INTERVAL} rows (mirrors the existing
 * memory-guard check cadence in the callers of this class) rather than one
 * transaction per row, which would be prohibitively slow at real trace sizes.
 */
export class SqliteTableWriter {
  private readonly db: DatabaseSync;
  private readonly tableName: string;
  private readonly cols: SchemaCol[];
  private readonly backtraceCols: Set<string>;
  private readonly btLookupStmt: StatementSync;
  private readonly btInsertStmt: StatementSync;
  private readonly frameInsertStmt: StatementSync;
  private readonly frameCacheIds = new Map<string, number>();
  /** Distinct (name,binary,binary_path) frame content -> symbols.id (the shared-symbols dedup described in openSessionDb), memoized. */
  private readonly symbolLookupStmt: StatementSync;
  private readonly symbolInsertStmt: StatementSync;
  private readonly symbolCache = new Map<string, number>();
  /** Distinct view-hierarchy/cause node name -> hierarchy_nodes.id (the hierarchy-node interning described in openSessionDb), memoized. */
  private readonly nodeLookupStmt: StatementSync;
  private readonly nodeInsertStmt: StatementSync;
  private readonly nodeCache = new Map<string, number>();
  /** Value interning: content hash -> sentinel token, memoized across rows. */
  private readonly internLookupStmt: StatementSync;
  private readonly internInsertStmt: StatementSync;
  private readonly internCache = new Map<string, string>();
  /** mnemonic -> ordered list of promoted descendant paths, discovered from data. */
  private readonly promotedPaths = new Map<string, PromotablePath[]>();
  /** Ref-identity accumulation across rows for dot-path collapsing (see ColumnIdentityTracker above). */
  private readonly identity = new ColumnIdentityTracker();
  /** base column name -> its dot-path + segment count, for canonical selection at finish. */
  private readonly baseInfo = new Map<string, { dotpath: string; segCount: number }>();
  private insertStmt: StatementSync;
  private rowCount = 0;
  private inTxn = false;

  /**
   * Mnemonics flagged as flavor-2 (low-distinct / high-repeat) — their values
   * intern at the small FLAVOR2 floor rather than the 256B flavor-1 floor.
   * Decided from a bounded sample of the first `sampleSize` rows (a
   * single-pass look-ahead, no second export), or injected up front (tests).
   */
  private internColumns: Set<string>;
  private decided: boolean;
  private readonly sampleSize: number;
  private sampleStats: ColumnStatsAccumulator | null = null;
  private sampleBuffer: NormalizedRow[] = [];

  constructor(
    db: DatabaseSync,
    tableName: string,
    cols: SchemaCol[],
    opts: { internColumns?: Set<string>; sampleSize?: number } = {}
  ) {
    this.db = db;
    this.tableName = tableName;
    this.cols = cols;
    this.sampleSize = opts.sampleSize ?? FLAVOR2_SAMPLE_ROWS;
    if (opts.internColumns) {
      // Decision injected — write immediately, no sampling (tests / a caller
      // that already knows the flavor-2 columns).
      this.internColumns = opts.internColumns;
      this.decided = true;
    } else {
      // Self-sample: buffer the first `sampleSize` rows to decide, then flush.
      this.internColumns = new Set();
      this.decided = false;
      this.sampleStats = new ColumnStatsAccumulator();
    }
    this.backtraceCols = new Set(cols.filter(isBacktraceCol).map((c) => c.mnemonic));
    this.btLookupStmt = db.prepare("SELECT id FROM backtraces WHERE fingerprint = ?");
    this.btInsertStmt = db.prepare("INSERT INTO backtraces (fingerprint) VALUES (?)");
    this.frameInsertStmt = db.prepare(
      "INSERT INTO frames (backtrace_id, frame_index, symbol_id, addr) VALUES (?, ?, ?, ?)"
    );
    // IS (not =) so a null binary/binary_path matches an existing null symbol
    // (SQL `= NULL` is never true) — content dedup must treat two null-binary
    // frames of the same name as one symbol (the shared symbols-table dedup).
    this.symbolLookupStmt = db.prepare(
      "SELECT id FROM symbols WHERE name IS ? AND binary IS ? AND binary_path IS ?"
    );
    this.symbolInsertStmt = db.prepare("INSERT INTO symbols (name, binary, binary_path) VALUES (?, ?, ?)");
    this.nodeLookupStmt = db.prepare("SELECT id FROM hierarchy_nodes WHERE name = ?");
    this.nodeInsertStmt = db.prepare("INSERT INTO hierarchy_nodes (name) VALUES (?)");
    this.internLookupStmt = db.prepare("SELECT id FROM interned_values WHERE hash = ?");
    this.internInsertStmt = db.prepare("INSERT INTO interned_values (hash, content) VALUES (?, ?)");

    // Base table, no promoted columns yet — a column's compound-ness/child-key
    // set is only knowable from actual row data (never declared in the XML
    // <schema> block), so promotion happens incrementally via
    // maybeExtendSchema as rows arrive (uniformly for row 1 and row N — no
    // special-casing "the first row"). Creating the base table unconditionally
    // here (rather than deferring until some row arrives) also means a
    // genuinely zero-row schema still gets a real, queryable (empty) table
    // instead of none at all.
    const colDefs: string[] = [`${quoteIdent(ROW_IDX_COLUMN)} INTEGER`];
    for (const col of this.cols) {
      if (this.backtraceCols.has(col.mnemonic)) {
        colDefs.push(`${quoteIdent(`${col.mnemonic}__backtrace_id`)} INTEGER`);
      } else {
        colDefs.push(
          quoteIdent(col.mnemonic),
          quoteIdent(`${col.mnemonic}__fmt`),
          quoteIdent(`${col.mnemonic}__children`)
        );
      }
    }

    // Defensive, not load-bearing today: session-scoped ingestion only ever
    // writes a (run,schema) table once per session (tableCache in session.ts
    // gates re-ingestion), but a stale table from a differently-shaped prior
    // ingestion of the same name must never silently mismatch this writer's
    // column list.
    db.exec(`DROP TABLE IF EXISTS ${quoteIdent(tableName)}`);
    db.exec(`CREATE TABLE ${quoteIdent(tableName)} (${colDefs.join(", ")})`);
    // Clear any stale dot-path/ref-identity metadata (promoted_column,
    // column_identity) for this table_name from a prior differently-shaped
    // ingestion (mirrors the DROP TABLE above).
    db.prepare("DELETE FROM promoted_column WHERE table_name = ?").run(tableName);
    db.prepare("DELETE FROM column_identity WHERE table_name = ?").run(tableName);
    // persistIngestedSchemaCols is written at finish(), NOT here — see finish()'s
    // own comment for why: writing it here, eagerly, before any row is
    // inserted, silently marked an ABORTED table-too-large ingest as "fully
    // ingested, safe to reuse" — verified live, a genuine data-integrity bug,
    // not hypothetical.

    const insertCols = this.insertColumnNames();
    this.insertStmt = db.prepare(
      `INSERT INTO ${quoteIdent(tableName)} (${insertCols.map(quoteIdent).join(", ")}) ` +
        `VALUES (${insertCols.map(() => "?").join(", ")})`
    );
  }

  /**
   * If `v` is a string worth interning, store it once in interned_values
   * (deduped by content hash) and return a tiny sentinel token to store in the
   * row column instead; otherwise return `v` unchanged. The size threshold is
   * per-column: a mnemonic the sampling pass flagged as flavor-2
   * (low-distinct/high-repeat) interns at the small FLAVOR2 floor; every other
   * column keeps the standard 256B flavor-1 floor. Interning is CONSISTENT — a given value
   * always maps to the same sentinel — so a column that mixes interned and
   * inline values across DIFFERENT values still groups/joins/compares correctly
   * (each distinct value has exactly one stored form). Numbers, sub-floor
   * strings, and already-sentinel values pass through unchanged.
   */
  private internValue(v: string | number | null, mnemonic: string): string | number | null {
    if (typeof v !== "string") return v;
    if (v.charCodeAt(0) === 1) return v; // already a sentinel
    const floor = this.internColumns.has(mnemonic) ? FLAVOR2_INTERN_FLOOR_BYTES : INTERN_THRESHOLD_BYTES;
    if (v.length < floor) return v;
    const cached = this.internCache.get(v);
    if (cached !== undefined) return cached;
    const hash = createHash("sha256").update(v).digest("hex");
    const existing = this.internLookupStmt.get(hash) as { id: number } | undefined;
    let id: number;
    if (existing) {
      id = existing.id;
    } else {
      // Node-encode a delimited chain (view-hierarchy / cause list) before
      // storing — its content becomes a sequence of hierarchy_nodes ids,
      // collapsing the shared-node redundancy. Non-chain values store raw (encode
      // returns null). Dedup is still keyed on the ORIGINAL content hash, so the
      // set of interned values is unchanged; reads decode transparently.
      const stored = encodeNodeSequence(v, (name) => this.nodeIdFor(name)) ?? v;
      id = Number(this.internInsertStmt.run(hash, stored).lastInsertRowid);
    }
    const token = INTERN_SENTINEL + id;
    this.internCache.set(v, token);
    return token;
  }

  /**
   * Intern one view-hierarchy/cause NODE name into the shared,
   * DB-wide-deduped hierarchy_nodes table, returning its id. Memoized per ingest;
   * same lookup-then-insert-on-miss discipline as symbolIdFor / interning.
   */
  private nodeIdFor(name: string): number {
    const cached = this.nodeCache.get(name);
    if (cached !== undefined) return cached;
    const existing = this.nodeLookupStmt.get(name) as { id: number } | undefined;
    const id = existing ? existing.id : Number(this.nodeInsertStmt.run(name).lastInsertRowid);
    this.nodeCache.set(name, id);
    return id;
  }

  private backtraceIdFor(frames: ResolvedFrame[]): number {
    // Fingerprint = a sha256 of the frame sequence's serialization, used ONLY as
    // the dedup key (the UNIQUE column on backtraces) — never read back; the
    // frames themselves are stored as real symbol-backed rows below.
    //
    // This hashing scheme replaced an earlier version that stored the raw
    // JSON here. On a backtrace-heavy trace (a real Allocations trace: 126k
    // distinct stacks, ~127 frames deep) the raw-JSON fingerprint + its UNIQUE
    // index was 6.35 GB — a full THIRD copy of the frame content, carried purely
    // as a dedup key. Hashing collapses it to 64 chars/backtrace (a few MB
    // total). The trade is the same astronomically-unlikely sha256 collision
    // assumption interned_values already accepts; and since the key is never
    // read back, a collision (not silent corruption of displayed data) is the
    // only possible failure. The hash covers the identical frame identity
    // (name+binary+binary_path+addr, in order) the JSON did, so the set of
    // distinct backtraces is unchanged.
    const fingerprint = createHash("sha256").update(JSON.stringify(frames)).digest("hex");
    const cached = this.frameCacheIds.get(fingerprint);
    if (cached !== undefined) return cached;

    // Check the shared backtraces table too, not just this writer's own cache
    // — an identical stack may already have been registered by an earlier
    // table's writer in the same session db (backtraces are deduped DB-wide).
    const existing = this.btLookupStmt.get(fingerprint) as { id: number } | undefined;
    if (existing) {
      this.frameCacheIds.set(fingerprint, existing.id);
      return existing.id;
    }

    const id = Number(this.btInsertStmt.run(fingerprint).lastInsertRowid);
    // One frames row per frame, leaf-first (frame_index 0 = deepest), matching
    // the leaf-first order the parsers produce; consumers reverse for a tree.
    // The frame's content (name/binary/binary_path) is deduped into `symbols`
    // and the row stores only its symbol_id + per-instance addr (the shared
    // symbols-table dedup, see openSessionDb).
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      this.frameInsertStmt.run(id, i, this.symbolIdFor(f.name, f.binaryName, f.binaryPath), f.addr);
    }
    this.frameCacheIds.set(fingerprint, id);
    return id;
  }

  /**
   * Intern one frame's content — a (name, binary, binary_path)
   * tuple — into the shared, DB-wide-deduped `symbols` table and return its id.
   * Memoized per ingest (symbolCache) and checked against the table (symbolLookupStmt,
   * IS-based so nulls dedup) so a symbol shared across millions of frame rows and
   * across a session's schemas is stored ONCE. Same lookup-then-insert-on-miss
   * discipline as backtraceIdFor / internIfLarge.
   */
  private symbolIdFor(name: string, binary: string | null, binaryPath: string | null): number {
    const key = JSON.stringify([name, binary, binaryPath]);
    const cached = this.symbolCache.get(key);
    if (cached !== undefined) return cached;
    const existing = this.symbolLookupStmt.get(name, binary, binaryPath) as { id: number } | undefined;
    const id = existing ? existing.id : Number(this.symbolInsertStmt.run(name, binary, binaryPath).lastInsertRowid);
    this.symbolCache.set(key, id);
    return id;
  }

  /** Promotable descendant paths of `row`'s cell for `mnemonic` not already in `promotedPaths`. */
  private newPromotablePaths(row: NormalizedRow, mnemonic: string): PromotablePath[] {
    const cell = row[mnemonic];
    if (!cell?.children) return [];
    const already = new Set((this.promotedPaths.get(mnemonic) ?? []).map((p) => pathKey(p.path)));
    return collectPromotablePaths(cell.children, [], 0).filter((p) => !already.has(pathKey(p.path)));
  }

  /** All insert column names, in `this.cols` order, given the current promotedPaths state. */
  private insertColumnNames(): string[] {
    const names: string[] = [ROW_IDX_COLUMN];
    for (const col of this.cols) {
      if (this.backtraceCols.has(col.mnemonic)) {
        names.push(`${col.mnemonic}__backtrace_id`);
      } else {
        names.push(col.mnemonic, `${col.mnemonic}__fmt`, `${col.mnemonic}__children`);
        for (const p of this.promotedPaths.get(col.mnemonic) ?? []) {
          const base = `${col.mnemonic}__${p.path.join("__")}`;
          if (p.kind === "backtrace") {
            names.push(`${base}__backtrace_id`);
          } else {
            if (p.kind === "scalar") names.push(base);
            names.push(`${base}__fmt`);
          }
        }
      }
    }
    return names;
  }

  private rebuildInsertStmt(): void {
    const insertCols = this.insertColumnNames();
    this.insertStmt = this.db.prepare(
      `INSERT INTO ${quoteIdent(this.tableName)} (${insertCols.map(quoteIdent).join(", ")}) ` +
        `VALUES (${insertCols.map(() => "?").join(", ")})`
    );
  }

  /**
   * Add a brand-new TOP-LEVEL column mid-stream — the track-detail analog of
   * {@link maybeExtendSchema}'s nested-path extension, for when an entire
   * mnemonic (not a child of an already-known one) is seen for the first
   * time. Track-detail rows carry no upfront <schema> block, so column shape
   * is only knowable by seeing rows as they arrive — this lets ingestion
   * start immediately from an empty (or partial) `cols` list and grow it in
   * place via ALTER TABLE, instead of a separate discovery pass over the
   * whole table first (see parseTrackDetail.ts's parseTrackDetailStreamToSqlite).
   * Same ALTER-then-rebuild discipline as maybeExtendSchema: commit any open
   * transaction first (SQLite disallows DDL mid-transaction in some
   * configurations), ALTER, then rebuild the insert statement. A row already
   * inserted before this column existed reads back NULL for it — the
   * correct semantic (that row genuinely didn't carry this attribute), not
   * something that needs backfilling.
   */
  addColumn(col: SchemaCol): void {
    if (this.inTxn) {
      this.db.exec("COMMIT");
      this.inTxn = false;
    }
    if (isBacktraceCol(col)) {
      this.backtraceCols.add(col.mnemonic);
      this.db.exec(
        `ALTER TABLE ${quoteIdent(this.tableName)} ADD COLUMN ${quoteIdent(`${col.mnemonic}__backtrace_id`)}`
      );
    } else {
      this.db.exec(`ALTER TABLE ${quoteIdent(this.tableName)} ADD COLUMN ${quoteIdent(col.mnemonic)}`);
      this.db.exec(`ALTER TABLE ${quoteIdent(this.tableName)} ADD COLUMN ${quoteIdent(`${col.mnemonic}__fmt`)}`);
      this.db.exec(`ALTER TABLE ${quoteIdent(this.tableName)} ADD COLUMN ${quoteIdent(`${col.mnemonic}__children`)}`);
    }
    this.cols.push(col);
    this.rebuildInsertStmt();
  }

  /**
   * A later row introducing a child key never seen before for some mnemonic
   * is real but rare (this project's schemas are structurally stable per
   * column in practice) — fall back to ALTER TABLE ADD COLUMN rather than
   * silently dropping the new field. Requires committing any open
   * transaction first (SQLite disallows DDL with a pending write batch open
   * in some configurations) and rebuilding the insert statement afterward.
   */
  private maybeExtendSchema(row: NormalizedRow): void {
    let extended = false;
    for (const col of this.cols) {
      if (this.backtraceCols.has(col.mnemonic)) continue;
      const newPaths = this.newPromotablePaths(row, col.mnemonic);
      if (newPaths.length === 0) continue;

      if (!extended && this.inTxn) {
        this.db.exec("COMMIT");
        this.inTxn = false;
      }
      for (const p of newPaths) {
        const base = `${col.mnemonic}__${p.path.join("__")}`;
        if (p.kind === "backtrace") {
          // A nested stack folds into backtraces/frames; the row stores only its
          // deduped FK, exactly like a top-level backtrace column.
          this.db.exec(`ALTER TABLE ${quoteIdent(this.tableName)} ADD COLUMN ${quoteIdent(`${base}__backtrace_id`)}`);
          continue;
        }
        if (p.kind === "scalar") {
          this.db.exec(`ALTER TABLE ${quoteIdent(this.tableName)} ADD COLUMN ${quoteIdent(base)}`);
          // Only scalar leaves are DSL-usable dot-path fields (compound
          // intermediates guide to their children instead) — record the
          // dot-path -> base mapping for the resolver + identity canonicalization.
          this.baseInfo.set(base, {
            dotpath: `${col.mnemonic}.${p.path.join(".")}`,
            segCount: p.path.length + 1,
          });
        }
        this.db.exec(`ALTER TABLE ${quoteIdent(this.tableName)} ADD COLUMN ${quoteIdent(`${base}__fmt`)}`);
      }
      this.promotedPaths.set(col.mnemonic, [...(this.promotedPaths.get(col.mnemonic) ?? []), ...newPaths]);
      extended = true;
    }
    if (extended) this.rebuildInsertStmt();
  }

  /**
   * Single-pass look-ahead: until the flavor-2 decision is made, buffer rows
   * and fold them into the sample stats; the moment the sample is full, decide
   * and flush. Everything after writes straight through. A table smaller than
   * the sample flushes at finish(). The buffered rows reference the parser's
   * shared (RefCache-deduped) Cell objects, so buffering doesn't copy their
   * blobs.
   */
  writeRow(row: NormalizedRow): void {
    if (!this.decided) {
      this.sampleStats!.observeRow(row);
      this.sampleBuffer.push(row);
      if (this.sampleBuffer.length >= this.sampleSize) this.decideAndFlush();
      return;
    }
    this.writeRowNow(row);
  }

  /** Lock in the flavor-2 decision from the sample, then replay the buffered rows. */
  private decideAndFlush(): void {
    this.internColumns = decideInternColumns(this.sampleStats!);
    this.decided = true;
    const buffered = this.sampleBuffer;
    this.sampleBuffer = [];
    this.sampleStats = null;
    for (const row of buffered) this.writeRowNow(row);
  }

  private writeRowNow(row: NormalizedRow): void {
    // Uniform for row 1 and row N — no special-casing "the first row" (see
    // the constructor's comment on why the base table always exists already).
    this.maybeExtendSchema(row);

    if (!this.inTxn) {
      this.db.exec("BEGIN TRANSACTION");
      this.inTxn = true;
    }

    const values: Array<string | number | null> = [this.rowCount];
    // Scalar cells for this row (top-level + promoted leaves), fed to the
    // identity tracker to detect ref-shared duplicate dot-paths.
    const scalarCells: Array<[string, Cell]> = [];
    for (const col of this.cols) {
      const cell = row[col.mnemonic];
      if (this.backtraceCols.has(col.mnemonic)) {
        values.push(cell?.resolvedFrames ? this.backtraceIdFor(cell.resolvedFrames) : null);
      } else {
        // Large values are interned to a sentinel token — a
        // blob shared across N rows is stored once, not N times. Small values
        // (numbers, labels, pids) pass through unchanged, so numeric/filter/
        // sort/group columns are unaffected.
        values.push(this.internValue(cell?.raw ?? null, col.mnemonic));
        values.push(this.internValue(cell?.fmt ?? null, col.mnemonic));
        values.push(this.internValue(residualChildrenBlob(cell), col.mnemonic));
        // A top-level column with no children of its own is itself a scalar
        // filter field — include it as an identity candidate (a shorter path
        // than any nested duplicate, so it wins canonical selection).
        if (cell && !cell.children) {
          if (!this.baseInfo.has(col.mnemonic)) {
            this.baseInfo.set(col.mnemonic, { dotpath: col.mnemonic, segCount: 1 });
          }
          scalarCells.push([col.mnemonic, cell]);
        }
        for (const p of this.promotedPaths.get(col.mnemonic) ?? []) {
          const descendant = resolveCellAtPath(cell, p.path);
          if (p.kind === "backtrace") {
            // Fold the nested stack into backtraces/frames (content-hash deduped,
            // shared DB-wide), store only its FK.
            values.push(descendant?.resolvedFrames ? this.backtraceIdFor(descendant.resolvedFrames) : null);
            continue;
          }
          if (p.kind === "scalar") {
            values.push(this.internValue(descendant?.raw ?? null, col.mnemonic));
            if (descendant) scalarCells.push([`${col.mnemonic}__${p.path.join("__")}`, descendant]);
          }
          values.push(this.internValue(descendant?.fmt ?? null, col.mnemonic));
        }
      }
    }
    this.identity.observeRow(scalarCells);

    this.insertStmt.run(...values);
    this.rowCount++;
    if (this.rowCount % MEMORY_CHECK_INTERVAL === 0) {
      this.db.exec("COMMIT");
      this.inTxn = false;
    }
  }

  /** Commit any partial trailing batch and return the final row count. */
  finish(): number {
    // A table smaller than the sample never triggered the decision — decide now
    // (on its true, full row count) and flush the buffer before finalizing.
    if (!this.decided) this.decideAndFlush();
    if (this.inTxn) {
      this.db.exec("COMMIT");
      this.inTxn = false;
    }
    this.persistFieldMetadata();
    // The cross-process reuse marker (moved HERE from the constructor, see
    // openSessionDb's _ingested_schema comment). Deliberately gated on
    // reaching finish() — the
    // caller only calls finish() after the FULL row stream is consumed with
    // no exception (see parseTable.ts's saxStream "end" handler); a
    // table-too-large abort mid-stream returns without ever calling finish(),
    // so _ingested_schema correctly stays UNWRITTEN for that table_name, and a
    // later getTable() call sees no reuse-eligible entry and re-attempts a
    // full (fresh DROP + re-ingest) rather than silently serving the partial
    // row set left behind by the abort as if it were the complete table.
    // Verified live: before this fix, a real trace's swiftui-updates table sat
    // at 905,000 of ~1.2M real rows after an aborted ingest, and every
    // subsequent query/aggregate/correlate call against it silently returned
    // that partial count as `totalRows` with no error and no indication data
    // was missing — a genuine data-integrity bug, not a hypothetical.
    persistIngestedSchemaCols(this.db, this.tableName, this.cols);
    return this.rowCount;
  }

  /**
   * Persist the dot-path metadata: every nested scalar field
   * (promoted_column) and the ref-identity collapse map (column_identity).
   * Canonical = the shortest path in an identity group (a top-level column,
   * seg-count 1, always wins; ties broken lexicographically for determinism),
   * so an agent is offered the clearest single name for each distinct value.
   */
  private persistFieldMetadata(): void {
    const promotedStmt = this.db.prepare(
      "INSERT INTO promoted_column (table_name, base_column, dotpath) VALUES (?, ?, ?)"
    );
    for (const [base, info] of this.baseInfo) {
      if (info.segCount > 1) promotedStmt.run(this.tableName, base, info.dotpath);
    }

    const identityStmt = this.db.prepare(
      "INSERT INTO column_identity (table_name, base_column, canonical_column) VALUES (?, ?, ?)"
    );
    for (const group of this.identity.finalizeGroups()) {
      const canonical = group.reduce((best, col) => {
        const b = this.baseInfo.get(best)!;
        const c = this.baseInfo.get(col)!;
        if (c.segCount !== b.segCount) return c.segCount < b.segCount ? col : best;
        return col < best ? col : best;
      });
      for (const col of group) {
        if (col !== canonical) identityStmt.run(this.tableName, col, canonical);
      }
    }
  }
}

/** A DSL-usable nested field: its dot-path (thread.process.pid) and physical base column (thread__process__pid). */
export interface PromotedFieldMeta {
  dotpath: string;
  base: string;
}

/** Load the nested-field (dot-path) promotion metadata for one ingested (run,schema) table. */
export function loadPromotedColumns(db: DatabaseSync, tableName: string): PromotedFieldMeta[] {
  return (
    db
      .prepare("SELECT base_column, dotpath FROM promoted_column WHERE table_name = ?")
      .all(tableName) as Array<{ base_column: string; dotpath: string }>
  ).map((r) => ({ dotpath: r.dotpath, base: r.base_column }));
}

/** Load the base_column -> canonical_column collapse map for one table (empty when nothing is ref-shared). */
export function loadColumnIdentity(db: DatabaseSync, tableName: string): Map<string, string> {
  const rows = db
    .prepare("SELECT base_column, canonical_column FROM column_identity WHERE table_name = ?")
    .all(tableName) as Array<{ base_column: string; canonical_column: string }>;
  return new Map(rows.map((r) => [r.base_column, r.canonical_column]));
}

// ─── Persisted-db metadata (_meta key-value, _ingested_schema) ───────────

/** Read one `_meta` key, or null if never set (a fresh db, or an older db predating this key). */
export function readMeta(db: DatabaseSync, key: string): string | null {
  const row = db.prepare("SELECT value FROM _meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

/** Set one `_meta` key (insert or overwrite). */
export function writeMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare("INSERT INTO _meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

/**
 * Persist one ingested table's column metadata (mnemonic/name/engineering-
 * type) — what a brand-new process needs to rebuild a real SchemaCol[] for
 * an already-ingested table with zero xctrace calls. Clears any prior rows
 * for this table_name first (mirrors the promoted_column/column_identity
 * clear-on-recreate pattern in the SqliteTableWriter constructor).
 */
export function persistIngestedSchemaCols(db: DatabaseSync, tableName: string, cols: SchemaCol[]): void {
  db.prepare("DELETE FROM _ingested_schema WHERE table_name = ?").run(tableName);
  const stmt = db.prepare(
    "INSERT INTO _ingested_schema (table_name, mnemonic, name, engineering_type) VALUES (?, ?, ?, ?)"
  );
  for (const col of cols) stmt.run(tableName, col.mnemonic, col.name, col.engineeringType);
}

/**
 * Load a previously-ingested table's column metadata, or null if this exact
 * table_name was never ingested into this db (the normal case for a schema
 * touched for the first time). A non-null result is the reuse signal
 * getTable/getSchemaMeta checks BEFORE running any xctrace export
 * — the physical table + its frames/backtraces/promoted-column metadata are
 * already sitting in this same db file, so re-ingesting would be pure waste.
 */
export function loadIngestedSchemaCols(db: DatabaseSync, tableName: string): SchemaCol[] | null {
  const rows = db
    .prepare("SELECT mnemonic, name, engineering_type FROM _ingested_schema WHERE table_name = ?")
    .all(tableName) as Array<{ mnemonic: string; name: string; engineering_type: string }>;
  if (rows.length === 0) return null;
  return rows.map((r) => ({ mnemonic: r.mnemonic, name: r.name, engineeringType: r.engineering_type }));
}
