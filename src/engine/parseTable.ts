/**
 * XML → normalized rows.
 *
 * Parses the verbose xctrace --xpath table XML into clean typed rows,
 * resolving Apple's ref-id indirection (shared scalars, nested objects, and
 * backtrace addresses are all referenced by id rather than re-emitted) and
 * collapsing the per-cell triplication (tag=type, fmt=display, text=raw).
 *
 * What this does NOT do (deferred to later layers):
 *   - Backtrace symbolication (addresses → function names)
 *   - Column role classification (time/weight/backtrace/thread/…) → src/engine/roleInference.ts
 *   - Cross-call caching keyed by (tracePath, run, schema) → src/engine/session.ts
 */
// Default import, not `import * as sax` — sax is a CJS module whose exports
// (createStream etc.) are assigned inside an IIFE that Node's static
// named-export detection can't see, so a namespace import resolves to an
// empty object at runtime under NodeNext/ESM output. A default import always
// gets the whole module.exports object regardless of static analysis.
import sax from "sax";
import type { Readable } from "node:stream";
import type { DatabaseSync } from "node:sqlite";
import { MiniXmlBuilder } from "./saxTreeBuilder.js";
import { XctraceError } from "./xctrace.js";
import { assertMemoryBudget, MEMORY_CHECK_INTERVAL } from "./memoryGuard.js";
import { SqliteTableWriter } from "./sqliteStore.js";

/** A resolved call frame from a track-detail inline backtrace. */
export interface ResolvedFrame {
  /** Function name (already symbolicated) or hex address when unknown. */
  name: string;
  addr: string;
  binaryName: string | null;
  binaryPath: string | null;
}

/** A single typed cell value in a normalized row. */
export interface Cell {
  /** The engineering-type tag name from the XML (e.g. "string", "duration", "thread"). */
  type: string;
  /** The human-readable formatted value from the `fmt` attribute. */
  fmt: string;
  /** The raw value: a number when the text is all-digits, otherwise a string. */
  raw: number | string;
  /** Nested child cells, keyed by their tag name (for compound types like thread, process). */
  children?: Record<string, Cell | null>;
  /**
   * Resolved call frames from an inline pre-symbolicated backtrace (already
   * symbolicated — no separate symbolicate step needed). Present on
   * track-detail backtrace cells (Allocations/Leaks) AND on schema-table
   * "backtrace"-engineering-type columns that use the same inline
   * <frame name=... addr=...><binary .../></frame> shape (e.g.
   * core-data-fetch's "Caller" column) — NOT present on the older kperf-bt
   * raw-address format, which needs call_tree's cross-row symbolication.
   */
  resolvedFrames?: ResolvedFrame[];
}

/** One normalized row: mnemonic → cell (or null for sentinel / missing columns). */
export type NormalizedRow = Record<string, Cell | null>;

/** Column descriptor extracted from the table schema. */
export interface SchemaCol {
  mnemonic: string;
  name: string;
  engineeringType: string;
}

/** Parsed table: schema + normalized rows. */
export interface ParsedTable {
  schema: string;
  cols: SchemaCol[];
  rows: NormalizedRow[];
}

/**
 * A cache of already-resolved cell values keyed by their ref-id integer.
 * Shared across all rows in one table parse; the session layer hands a
 * per-(tracePath,run,schema) cache in for cross-call reuse.
 */
export type RefCache = Map<number, Cell | null>;

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

// ─── Schema parsing ───────────────────────────────────────────────────────────

function parseSchemaCols(schemaNode: Record<string, any>): SchemaCol[] {
  return asArray<Record<string, any>>(schemaNode?.col).map((col) => ({
    mnemonic: String(col.mnemonic ?? ""),
    name: String(col.name ?? ""),
    engineeringType: String(col["engineering-type"] ?? ""),
  }));
}

// ─── Cell parsing with ref-id resolution ─────────────────────────────────────

/**
 * Coerce a raw text string to a number if it looks like one, else keep as
 * string. We only coerce all-digit strings (no floats — fmt already carries the
 * human-readable form; raw is the machine value).
 *
 * PMT:loam-merlin: an all-digit value past Number.MAX_SAFE_INTEGER (e.g. a
 * uint64 sentinel like error-code's "no error" = 2^64-1 =
 * 18446744073709551615) silently rounds to a nearby-but-wrong double if
 * coerced — verified live against a real HTTPTraffic trace: it came back as
 * 18446744073709552000, off by 385. Keep those as the exact digit string
 * instead; fmt already carries the human-readable form and a caller doing a
 * sentinel/equality comparison should compare the string, not a rounded
 * float. Every legitimate small-enough value (durations, counts, ns
 * timestamps within a sane trace length) is unaffected.
 */
export function coerceRaw(text: string): number | string {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return trimmed;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? n : trimmed;
}

/**
 * Parse one inline resolved <frame name=... addr=...> or <binary name=...
 * path=.../> element into a synthetic Cell, caching it under `cache` the
 * same way any other cell is cached. Frame/binary ids share the same
 * per-node id space as every other cell in the document (confirmed against
 * real traces — a later backtrace can reference an earlier frame's id
 * directly, e.g. `<backtrace><frame ref="6"/>...`), so reusing the existing
 * RefCache instead of a separate frame-scoped cache resolves repeats
 * correctly with no new cache plumbing.
 *
 * This is the schema-table counterpart of parseTrackDetail.ts's
 * parseBacktrace/parseBinary — same XML shape, different document format
 * (core-data-fetch's "Caller" column uses this despite being schema-table,
 * not track-detail).
 */
function parseFrameOrBinaryCell(
  type: "frame" | "binary",
  node: Record<string, any>,
  cache: RefCache
): Cell {
  const refAttr = node["@_ref"];
  if (refAttr !== undefined) {
    const cached = cache.get(Number(refAttr));
    if (cached) return cached;
  }
  const idAttr = node["@_id"];
  const cell: Cell =
    type === "frame"
      ? {
          type,
          fmt: String(node["@_name"] ?? ""),
          raw: String(node["@_addr"] ?? ""),
          ...(asArray<Record<string, any>>(node?.binary).length > 0
            ? { children: { binary: parseFrameOrBinaryCell("binary", asArray<Record<string, any>>(node.binary)[0], cache) } }
            : {}),
        }
      : { type, fmt: String(node["@_name"] ?? ""), raw: String(node["@_path"] ?? "") };
  if (idAttr !== undefined) cache.set(Number(idAttr), cell);
  return cell;
}

/** Extract every <frame> under a resolved-shape <backtrace> element, in order. */
function parseResolvedFrames(backtraceNode: Record<string, any>, cache: RefCache): ResolvedFrame[] {
  return asArray<Record<string, any>>(backtraceNode.frame).map((frameNode) => {
    const frameCell = parseFrameOrBinaryCell("frame", frameNode, cache);
    const binaryCell = frameCell.children?.binary;
    return {
      name: frameCell.fmt,
      addr: String(frameCell.raw),
      binaryName: binaryCell?.fmt || null,
      binaryPath: (binaryCell?.raw as string) || null,
    };
  });
}

/**
 * Parse one XML element (a single cell or nested compound node) into a Cell,
 * resolving any `ref` attribute against `cache` and registering new `id`s.
 *
 * @param tagName   The XML element's tag name (= engineering-type for top-level cells).
 * @param node      The fast-xml-parser node object for this element.
 * @param cache     Shared ref-id resolution map; mutated in place.
 */
function parseCell(
  tagName: string,
  node: Record<string, any>,
  cache: RefCache
): Cell | null {
  // ── Sentinel: <sentinel/> means this column is null for this row ──────────
  if (tagName === "sentinel") return null;

  const attrs = node;

  // ── ref: resolve from cache ────────────────────────────────────────────────
  const refAttr = attrs["@_ref"];
  if (refAttr !== undefined) {
    const refId = Number(refAttr);
    // Return the cached value (may be null for a sentinel that was cached).
    // If somehow missing from cache, fall through to parse as a new value.
    if (cache.has(refId)) return cache.get(refId) ?? null;
  }

  // ── New value: parse and register under its id ────────────────────────────
  const idAttr = attrs["@_id"];
  const id = idAttr !== undefined ? Number(idAttr) : undefined;
  const fmt = String(attrs["@_fmt"] ?? "");

  // ── backtrace with inline resolved frames (schema-table variant of the
  // shape parseTrackDetail.ts handles for Allocations/Leaks) — extract every
  // frame, not just the first. Distinct from the older kperf-bt raw-address
  // shape (different children: text-address/process), which falls through
  // to the generic compound handling below unchanged. Also matches
  // "text-backtrace" (Swift Concurrency's engineering-type for creation/
  // suspend backtraces, e.g. SwiftTaskCreationEvent/SwiftParallelRunningTasks)
  // — the tag name varies by schema, but `attrs.frame !== undefined` is the
  // real discriminator either way: present → extract real frames; absent →
  // falls through unchanged to the kperf-bt path below, so this is safe to
  // check regardless of which shape a given "text-backtrace" column actually
  // uses (not independently confirmed live which shape Swift Concurrency's
  // columns carry in practice — this generalizes correctly either way).
  // "tagged-backtrace" (time-profile/cpu-profile sample stacks, PMT:elm-swamp)
  // has the SAME <frame name addr><binary></frame> shape as "backtrace" — the
  // only reason call_tree used a separate buffered parser was fast-xml-parser
  // collapsing the repeated <frame> siblings, which the streaming MiniXmlBuilder
  // (used here) arrays correctly. A ref-only <tagged-backtrace ref="N"/> is
  // already resolved by parseCell's ref check above (returns the cached cell)
  // before reaching here, so this branch only sees a real frame-bearing one.
  if ((tagName === "backtrace" || tagName === "text-backtrace" || tagName === "tagged-backtrace") && attrs.frame !== undefined) {
    const frames = parseResolvedFrames(attrs, cache);
    const topName = frames[0]?.name ?? "";
    const cell: Cell = {
      type: tagName,
      fmt: frames.length > 0 ? `${frames.length} frames, top: ${topName}` : "0 frames",
      raw: frames.length,
      resolvedFrames: frames,
    };
    if (id !== undefined) cache.set(id, cell);
    return cell;
  }

  // Collect child nodes (anything not starting with @_ is either a child tag
  // or the "#text" key for text content). __childOrder is MiniXmlBuilder's
  // own bookkeeping (PMT:black-jay), not a real XML child — excluding it
  // here matters: left in, it's an array of tag-name strings that this
  // branch would try to recurse into as if it were compound cell data,
  // eventually recursing into individual characters of a string and blowing
  // the call stack (verified live: every compound-cell fixture, e.g.
  // swiftui-layout-updates, hit "Maximum call stack size exceeded").
  const childKeys = Object.keys(attrs).filter(
    (k) => !k.startsWith("@_") && k !== "#text" && k !== "__childOrder"
  );

  let raw: number | string;
  let children: Record<string, Cell | null> | undefined;

  if (childKeys.length > 0) {
    // Compound node (e.g. thread, process, kperf-bt) — recurse into children.
    // raw = fmt (the compound's formatted summary).
    raw = fmt;
    children = {};
    for (const childTag of childKeys) {
      const childNodes = asArray<Record<string, any>>(attrs[childTag]);
      // For repeated child tags (e.g. multiple text-address), take first.
      children[childTag] = childNodes.length > 0
        ? parseCell(childTag, childNodes[0], cache)
        : null;
    }
  } else {
    // Scalar node: text content is the machine value.
    const text = String(attrs["#text"] ?? "");
    raw = coerceRaw(text || fmt);
  }

  const cell: Cell = {
    type: tagName,
    fmt,
    raw,
    ...(children ? { children } : {}),
  };

  if (id !== undefined) {
    cache.set(id, cell);
  }

  return cell;
}

// ─── Row parsing ──────────────────────────────────────────────────────────────

/**
 * Parse one <row> element into a NormalizedRow, mapping children onto the
 * schema columns by TRUE DOCUMENT POSITION (PMT:black-jay) — there is always
 * exactly one XML child per schema column, in schema-declaration order, and
 * that child is either the column's real engineering-type tag or `sentinel`
 * (null). `rowNode.__childOrder` (stamped by MiniXmlBuilder.onCloseTag) is
 * that position → tag-name sequence.
 *
 * The bug this replaces: the old algorithm bucketed a row's children by
 * ENGINEERING-TYPE TAG into shared FIFO queues, then walked columns pulling
 * "whatever's next in this type's queue." A `<sentinel/>` doesn't share a
 * type's queue (it has its own "sentinel" tag), so it was invisible to that
 * check — an EARLIER column sharing a type with a LATER one, when the
 * earlier was null, would silently steal the queue slot that document-order-
 * wise belonged to the later column. Verified live, twice: CFNetwork's
 * http-path came back as a boolean ("Yes"/"No") stolen from the unrelated
 * later `successful` column; fetch-type came back as a duration string
 * stolen from one of nine duration-typed columns. Position-based walking
 * doesn't need a "does the tag match what I expected" check or a fallback at
 * all — the tag AT that position tells us directly which real queue (if any)
 * to pull the value from, or that this column is genuinely null.
 */
function parseRow(
  rowNode: Record<string, any>,
  cols: SchemaCol[],
  cache: RefCache
): NormalizedRow {
  const childOrder = rowNode.__childOrder as string[] | undefined;
  if (!childOrder) {
    throw new Error(
      "parseRow: rowNode is missing __childOrder — every row must come from " +
        "MiniXmlBuilder (the only XML-to-object path since PMT:black-jay " +
        "removed DOM/fast-xml-parser row parsing)."
    );
  }

  // Per-tag-name queues to pull the ACTUAL value nodes from, in the order
  // they appear under that tag — repeated tags collapse into arrays keyed by
  // tag name (both MiniXmlBuilder and fast-xml-parser's shape do this).
  // childOrder tells us WHICH queue to pull from at each position; we never
  // ask "does any queue still have something" (that guessing is the bug).
  const tagQueues: Record<string, Array<Record<string, any>>> = {};
  for (const key of Object.keys(rowNode)) {
    if (key.startsWith("@_") || key === "__childOrder") continue;
    tagQueues[key] = asArray<Record<string, any>>(rowNode[key]);
  }

  const result: NormalizedRow = {};
  for (let i = 0; i < cols.length; i++) {
    const col = cols[i];
    const tag = childOrder[i];
    // Missing position (row has fewer children than the schema has columns —
    // a genuine structural surprise, not the ordinary null-cell case, which
    // is a real "sentinel" entry in childOrder) or an explicit sentinel: null.
    if (tag === undefined || tag === "sentinel") {
      result[col.mnemonic] = null;
      continue;
    }
    const node = tagQueues[tag]?.shift();
    result[col.mnemonic] = node ? parseCell(tag, node, cache) : null;
  }

  return result;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Column definitions plus a row count, with no row data materialized at all. */
export interface SchemaMeta {
  cols: SchemaCol[];
  rowCount: number;
}

interface StreamParseResult {
  schema: string;
  cols: SchemaCol[];
  rows: NormalizedRow[];
  rowCount: number;
}

/**
 * Shared implementation behind {@link parseTableStream} and
 * {@link parseTableStreamMeta} — consumes xctrace's stdout directly via a SAX
 * parser instead of buffering the whole document into one string and
 * building a full DOM tree of it. Reconstructs one <schema> or one <row>
 * subtree at a time via {@link MiniXmlBuilder} (each is small — a few dozen
 * cells at most) and feeds it through the SAME parseSchemaCols/parseRow used
 * by the string-based path, so output is byte-for-byte equivalent.
 *
 * Same multi-node union behavior as parseTableXml: the first node's columns
 * win, and rows from every node are concatenated (ref-ids are node-scoped, so
 * the cache resets per node).
 *
 * `countOnly` skips {@link parseRow} (the expensive ref-resolution + Cell-
 * materialization step) and never accumulates a `rows` array — only a count.
 * Still walks every row's full XML subtree via MiniXmlBuilder (needed to
 * track nesting depth correctly so the next row starts capturing at the
 * right point) — this cuts the dominant MEMORY cost (a Cell object per
 * column per row, held for the table's whole lifetime) for callers that only
 * need column shape + a row count (describe_schema).
 *
 * `sqlite`, when given, streams each parsed row straight into a SQLite table
 * (PMT:gravel-cape) instead of accumulating a JS `rows` array — the real
 * ingestion path; `rows` in the resolved result stays empty.
 *
 * @throws {XctraceError} "empty-result" if no <node> was ever seen (xpath
 *         matched nothing), "parse-error" on malformed XML.
 */
function parseTableStreamInternal(
  stdout: Readable,
  opts: {
    countOnly?: boolean;
    sqlite?: { db: DatabaseSync; tableName: string };
  } = {}
): Promise<StreamParseResult> {
  const { countOnly = false, sqlite } = opts;
  return new Promise((resolve, reject) => {
    let settled = false;
    const settleReject = (err: XctraceError) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const settleResolve = (result: StreamParseResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    // sax's 64 KB default (a global, not per-instance) rejects with "Max
    // buffer length exceeded: attribValue" on a single oversized attribute
    // value — real trace data hits this on swiftui-updates/swiftui-layout-
    // updates, whose view-hierarchy/full-cause-graph-node blobs can exceed
    // it even on a small (15s/211MB) trace. Raising the ceiling is a
    // mitigation, not a fix — an even larger blob can still exceed it; the
    // real fix is projecting these known-unbounded columns out before they
    // ever reach the parser (tracked as a separate, deferred prompt: column
    // projection at parse time).
    (sax as unknown as { MAX_BUFFER_LENGTH: number }).MAX_BUFFER_LENGTH = 32 * 1024 * 1024;
    const saxStream = sax.createStream(true, { trim: false, normalize: false });

    const pathStack: string[] = [];
    let activeBuilder: MiniXmlBuilder | null = null;
    let sawNode = false;
    let schemaName = "";
    let cols: SchemaCol[] = [];
    const rows: NormalizedRow[] = [];
    let rowCount = 0;
    let cache: RefCache = new Map();
    let sqliteWriter: SqliteTableWriter | null = null;

    saxStream.on("opentag", (node) => {
      const tag = node.name;
      if (activeBuilder) {
        activeBuilder.onOpenTag(tag, node.attributes as Record<string, string>);
        return;
      }
      pathStack.push(tag);
      const path = pathStack.join(">");
      if (path === "trace-query-result>node") {
        sawNode = true;
        cache = new Map();
      } else if (path === "trace-query-result>node>schema" && cols.length === 0) {
        activeBuilder = new MiniXmlBuilder();
        activeBuilder.onOpenTag(tag, node.attributes as Record<string, string>);
      } else if (path === "trace-query-result>node>row") {
        activeBuilder = new MiniXmlBuilder();
        activeBuilder.onOpenTag(tag, node.attributes as Record<string, string>);
      }
    });

    saxStream.on("text", (text) => {
      if (activeBuilder) activeBuilder.onText(text);
    });

    saxStream.on("closetag", (tag) => {
      if (activeBuilder) {
        const finished = activeBuilder.onCloseTag(tag);
        if (finished) {
          // This tag's open also pushed onto pathStack (capture starts on the
          // SAME opentag event that pushes it) — pop it now that capture is
          // done, or pathStack stays poisoned and the next <row> never matches.
          if (pathStack[pathStack.length - 1] === tag) pathStack.pop();
          const builtNode = activeBuilder.result!;
          if (tag === "schema") {
            schemaName = String(builtNode["@_name"] ?? "");
            cols = parseSchemaCols(builtNode);
            // Column shape is only known once the <schema> block closes —
            // this is the earliest point a SqliteTableWriter can be created,
            // before any <row> arrives.
            if (sqlite) {
              sqliteWriter = new SqliteTableWriter(sqlite.db, sqlite.tableName, cols);
            }
          } else if (tag === "row") {
            rowCount++;
            if (!countOnly) {
              const row = parseRow(builtNode, cols, cache);
              // Straight swap, not a parallel path (PMT:gravel-cape) — a
              // sqlite-sink parse writes to disk instead of accumulating
              // `rows`, it never does both.
              if (sqliteWriter) sqliteWriter.writeRow(row);
              else rows.push(row);

              // See memoryGuard.ts — a fatal V8 OOM aborts the ENTIRE process,
              // not just this call, so this must fire well before that point.
              // Keyed off rowCount (not rows.length) so this still fires at
              // the same cadence in sqlite-sink mode, where `rows` never
              // grows — RefCache retention (the thing this really guards
              // against) scales with rowCount regardless of where parsed
              // rows end up.
              if (rowCount % MEMORY_CHECK_INTERVAL === 0) {
                try {
                  assertMemoryBudget(rowCount, schemaName);
                } catch (err) {
                  settleReject(err as XctraceError);
                  // sax's stream wrapper predates .destroy() (it's built on
                  // the legacy Stream base, not Writable/Duplex) — stopping
                  // the SOURCE is enough: no more writes reach saxStream, so
                  // it goes inert and is garbage-collected with nothing else
                  // to release.
                  stdout.destroy();
                  return;
                }
              }
            }
          }
          activeBuilder = null;
        }
        return;
      }
      if (pathStack[pathStack.length - 1] === tag) pathStack.pop();
    });

    saxStream.on("error", (err: Error) => {
      settleReject(
        new XctraceError("parse-error", `Failed to parse streamed table XML: ${err.message}`, {})
      );
    });

    saxStream.on("end", () => {
      if (!sawNode) {
        settleReject(
          new XctraceError("empty-result", "xctrace --xpath matched no nodes.", {})
        );
        return;
      }
      if (sqliteWriter) sqliteWriter.finish();
      settleResolve({ schema: schemaName, cols, rows, rowCount });
    });

    stdout.on("error", (err: Error) => {
      settleReject(new XctraceError("export-failed", `stdout error: ${err.message}`, {}));
    });

    stdout.pipe(saxStream);
  });
}

/**
 * Streaming counterpart to {@link parseTableXml} — see
 * {@link parseTableStreamInternal} for the shared implementation.
 */
export function parseTableStream(stdout: Readable): Promise<ParsedTable> {
  return parseTableStreamInternal(stdout).then(({ schema, cols, rows }) => ({ schema, cols, rows }));
}

/**
 * Column shape + row count only, with no row data ever materialized —
 * for callers like describe_schema that never touch a single row. See
 * {@link parseTableStreamInternal}.
 */
export function parseTableStreamMeta(stdout: Readable): Promise<SchemaMeta> {
  return parseTableStreamInternal(stdout, { countOnly: true }).then(({ cols, rowCount }) => ({ cols, rowCount }));
}

/** Column shape + row count for a table streamed into SQLite instead of a JS array. */
export interface SqliteIngestResult {
  schema: string;
  cols: SchemaCol[];
  rowCount: number;
}

/**
 * Streams a table straight into a SQLite table instead of a JS array —
 * PMT:gravel-cape's ingestion path. Reuses parseRow/parseCell/RefCache
 * unchanged; only the last step (push into `rows` vs. INSERT) differs, via
 * {@link SqliteTableWriter}. `rows` in the resolved result is always empty —
 * callers of this function must read data back out via SQL, not `.rows`.
 */
export function parseTableStreamToSqlite(
  stdout: Readable,
  db: DatabaseSync,
  tableName: string
): Promise<SqliteIngestResult> {
  return parseTableStreamInternal(stdout, { sqlite: { db, tableName } }).then(
    ({ schema, cols, rowCount }) => ({ schema, cols, rowCount })
  );
}
