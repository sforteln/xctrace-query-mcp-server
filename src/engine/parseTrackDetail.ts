/**
 * Track-detail XML parser.
 *
 * xctrace exposes Allocations and Leaks under /tracks/track/details/detail,
 * a format structurally different from the /data/table schema-table format:
 *
 *   - Each <row> carries its values as XML ATTRIBUTES, no <schema><col> block.
 *   - No id/ref indirection on row values (attributes are plain strings).
 *   - An optional <backtrace> child carries ALREADY-SYMBOLICATED frames as
 *     <frame name="funcName" addr="0x..."><binary name="..." path="..."/></frame>.
 *     Binary elements reuse id/ref within the same detail node.
 *   - Attribute sets vary per detail and even per row (rows without a backtrace
 *     simply omit the <backtrace> child).
 *
 * Output: the same ParsedTable / NormalizedRow / Cell types produced by the
 * schema-table parser — so the universal verbs (query, aggregate, find, getRow)
 * and role-inference pipeline work on Allocations/Leaks without modification.
 *
 * SchemaCol[] is synthesised from the union of attributes seen across all rows.
 * Engineering types are inferred from values (all-digit → "uint-64",
 * "timestamp" attr → "start-time", everything else → "string").
 */
import { XMLParser } from "fast-xml-parser";
// Default import — see the comment in parseTable.ts for why `import * as sax`
// resolves to an empty namespace object at runtime under NodeNext/ESM output.
import sax from "sax";
import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";
import type { DatabaseSync } from "node:sqlite";
import { MiniXmlBuilder, PERCENT_PLACEHOLDER } from "./saxTreeBuilder.js";
import { XctraceError } from "./xctrace.js";
import { assertMemoryBudget, MEMORY_CHECK_INTERVAL } from "./memoryGuard.js";
import { SqliteTableWriter } from "./sqliteStore.js";
import type { Cell, NormalizedRow, SchemaCol, ParsedTable, ResolvedFrame, SchemaMeta } from "./parseTable.js";

// ─── XML parser ───────────────────────────────────────────────────────────────

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  parseAttributeValue: false,
  allowBooleanAttributes: true,
});

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Mirror parseTable.ts coerceRaw: all-digit → number, else string — except a
 * value past Number.MAX_SAFE_INTEGER stays the exact digit string instead of
 * silently rounding (see parseTable.ts's coerceRaw for the verified uint64
 * sentinel precision-loss case this guards against; PMT:loam-merlin).
 */
export function coerceRaw(s: string): number | string {
  const trimmed = s.trim();
  if (!/^\d+$/.test(trimmed)) return trimmed;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? n : trimmed;
}

/** Engineering-types that carry a time value — mirrors session.ts's TIME_ENGINEERING_TYPES. */
const TIME_ENG_TYPES = new Set(["start-time", "sample-time", "start", "timestamp"]);

/**
 * Parse Instruments' fixed-width `MM:SS.mmm.µµµ` (or `HH:MM:SS.mmm.µµµ`) time
 * string to nanoseconds, or null if it isn't that shape. Precision is
 * microseconds — all the formatted string carries (schema-table's element-text
 * raw keeps the sub-µs nanoseconds the fmt drops; track-detail only ever gives
 * us the fmt), which is orders of magnitude finer than any timeRange/join
 * window. Verified against schema-table pairs: fmt "00:06.181.618" ↔ raw
 * 6181618125 ns → this returns 6181618000 (the µs-truncation). See PMT:light-reed.
 */
function parseInstrumentsTimeToNs(s: string): number | null {
  const dot = s.indexOf(".");
  if (dot === -1) return null;
  const frac = /^(\d{3})\.(\d{3})$/.exec(s.slice(dot + 1));
  if (!frac) return null;
  const clock = s.slice(0, dot).split(":");
  if (clock.length < 2 || clock.length > 3 || !clock.every((c) => /^\d+$/.test(c))) return null;
  const n = clock.map(Number);
  const seconds = n.length === 2 ? n[0] * 60 + n[1] : (n[0] * 60 + n[1]) * 60 + n[2];
  return seconds * 1_000_000_000 + Number(frac[1]) * 1_000_000 + Number(frac[2]) * 1_000;
}

/**
 * The raw (machine) value for a track-detail attribute. For a time-role
 * attribute (only `timestamp` today, engineering-type "start-time"), the XML
 * gives us ONLY a formatted `MM:SS.mmm.µµµ` string — unlike schema-table time
 * columns, whose element text is the nanosecond integer. Left as a string it
 * can't be timeRange-filtered, range-joined (relate/correlate), timeline-
 * merged, or numerically ordered against a schema-table time column — worse,
 * SQLite sorts every number before every string, so a string timestamp makes
 * those numeric comparisons SILENTLY wrong (no error, just wrong rows). So a
 * time-role attribute is parsed to ns here; everything else keeps coerceRaw's
 * all-digit→number behavior. Keyed on engineering-type (not a value-shape
 * guess) so a non-time string that happens to look like a clock is never
 * mis-converted; and a hypothetical future track-detail schema that emits a
 * plain-integer timestamp still works (parse returns null → coerceRaw). (PMT:light-reed)
 */
function coerceTrackDetailRaw(engType: string, strVal: string): number | string {
  if (TIME_ENG_TYPES.has(engType)) {
    const ns = parseInstrumentsTimeToNs(strVal);
    if (ns !== null) return ns;
  }
  return coerceRaw(strVal);
}

/**
 * Infer engineering type from an attribute name and its observed values.
 * Drives role classification in roleInference (time/weight/detail roles).
 */
function inferEngType(attrName: string, sampleValues: string[]): string {
  if (attrName === "timestamp") return "start-time";
  const nonEmpty = sampleValues.filter((v) => v.length > 0 && v !== "(null)");
  if (nonEmpty.length > 0 && nonEmpty.every((v) => /^\d+$/.test(v))) return "uint-64";
  return "string";
}

// ─── Backtrace parsing ────────────────────────────────────────────────────────

/** Per-node cache mapping id → binary metadata. */
type BinaryCache = Map<number, { name: string | null; path: string | null }>;

function parseBinary(
  node: Record<string, any>,
  cache: BinaryCache
): { name: string | null; path: string | null } {
  const ref = node["@_ref"];
  if (ref !== undefined) {
    const id = Number(ref);
    return cache.get(id) ?? { name: null, path: null };
  }
  const id = node["@_id"];
  const entry = {
    name: node["@_name"] ? String(node["@_name"]) : null,
    path: node["@_path"] ? String(node["@_path"]) : null,
  };
  if (id !== undefined) cache.set(Number(id), entry);
  return entry;
}

/** Per-node cache mapping id → a fully-resolved frame. */
type FrameCache = Map<number, ResolvedFrame>;

/**
 * A recurring call-site frame (malloc, class_createInstance, objc runtime
 * entry points, etc.) is emitted once with an `id` and referenced by every
 * later occurrence as a bare `<frame ref="N"/>` with no name/addr of its
 * own — the same id/ref dedup scheme `parseBinary` already handles for
 * <binary> children, just one level up. Verified live against a real
 * Allocations recording: a `ref`-only frame carries neither `@_name` nor
 * `@_addr`, so without this cache it silently resolved to `{name: "", addr:
 * ""}` instead of the real frame — and because these ref'd call-site frames
 * dominate real backtraces (most non-leaf frames after the first occurrence
 * are refs), the practical effect was ~14 of 15 frames in a typical
 * Allocations backtrace coming back blank. See PMT:spare-cairn / PMT:tundra-mallard.
 */
function parseBacktrace(
  backtraceNode: Record<string, any>,
  binaryCache: BinaryCache,
  frameCache: FrameCache
): ResolvedFrame[] {
  const frames: ResolvedFrame[] = [];
  for (const frame of asArray<Record<string, any>>(backtraceNode?.frame)) {
    const ref = frame["@_ref"];
    if (ref !== undefined) {
      const cached = frameCache.get(Number(ref));
      if (cached) {
        frames.push(cached);
        continue;
      }
      // Defensive fallback — a ref should always have a prior id in the same
      // node; if xctrace ever emits one without, fall through and resolve
      // whatever attributes (if any) this element actually carries rather
      // than silently dropping the frame.
    }
    const name = String(frame["@_name"] ?? "");
    const addr = String(frame["@_addr"] ?? "");
    // Frame may have zero or one <binary> child.
    const binaryNodes = asArray<Record<string, any>>(frame?.binary);
    const binary =
      binaryNodes.length > 0
        ? parseBinary(binaryNodes[0], binaryCache)
        : { name: null, path: null };
    const resolved: ResolvedFrame = { name, addr, binaryName: binary.name, binaryPath: binary.path };
    const id = frame["@_id"];
    if (id !== undefined) frameCache.set(Number(id), resolved);
    frames.push(resolved);
  }
  return frames;
}

// ─── Column discovery ─────────────────────────────────────────────────────────

const BACKTRACE_MNEMONIC = "backtrace";

/**
 * Incremental column-discovery state, one row at a time — shared by the
 * batch path (discoverColumns, walking an already-collected `nodes` array)
 * and the streaming meta path (parseTrackDetailStreamMeta), which observes
 * each row as it completes and discards it immediately rather than
 * collecting the whole table first. Keeping this logic in one place means
 * both paths agree on column shape/ordering by construction.
 */
class ColumnDiscovery {
  attrOrder: string[] = [];
  private attrSet = new Set<string>();
  attrSamples = new Map<string, string[]>();
  hasBacktrace = false;

  observeRow(row: Record<string, any>): void {
    // fast-xml-parser puts XML attributes under "@_name" keys and child
    // elements under plain "name" keys. We want only attribute keys here.
    for (const [key, val] of Object.entries(row)) {
      if (!key.startsWith("@_")) continue;
      const attrName = key.slice(2);
      if (!this.attrSet.has(attrName)) {
        this.attrSet.add(attrName);
        this.attrOrder.push(attrName);
        this.attrSamples.set(attrName, []);
      }
      const samples = this.attrSamples.get(attrName)!;
      if (samples.length < 20) samples.push(String(val));
    }
    if (row?.[BACKTRACE_MNEMONIC] !== undefined) this.hasBacktrace = true;
  }
}

/**
 * Walk all rows across all nodes to discover the union of attribute names
 * and whether any row has a <backtrace>. Returns ordered column list and
 * per-attribute sample values for type inference.
 */
function discoverColumns(
  nodes: Array<Record<string, any>>
): { attrOrder: string[]; attrSamples: Map<string, string[]>; hasBacktrace: boolean } {
  const discovery = new ColumnDiscovery();
  for (const node of nodes) {
    for (const row of asArray<Record<string, any>>(node?.row)) {
      discovery.observeRow(row);
    }
  }
  return { attrOrder: discovery.attrOrder, attrSamples: discovery.attrSamples, hasBacktrace: discovery.hasBacktrace };
}

// ─── Shared build step (nodes → ParsedTable) ──────────────────────────────────

/**
 * Build a ParsedTable from already-assembled node objects, each shaped
 * `{ row: [...] }` matching fast-xml-parser's output for a track-detail
 * <node>. Shared by the string-based and streaming entrypoints below so both
 * produce identical output from identical discovery/row-building logic —
 * only how `nodes` gets assembled differs (one full DOM parse vs. SAX-built
 * per-row mini-DOMs).
 */
function buildParsedTable(
  nodes: Array<Record<string, any>>,
  syntheticSchema: string
): ParsedTable {
  if (nodes.length === 0) {
    return { schema: syntheticSchema, cols: [], rows: [] };
  }

  // ── Column discovery (first pass over all rows) ────────────────────────────
  const { attrOrder, attrSamples, hasBacktrace } = discoverColumns(nodes);

  const cols: SchemaCol[] = attrOrder.map((attrName) => ({
    mnemonic: attrName,
    name: attrName.replace(/-/g, " "),
    engineeringType: inferEngType(attrName, attrSamples.get(attrName) ?? []),
  }));

  if (hasBacktrace) {
    cols.push({
      mnemonic: BACKTRACE_MNEMONIC,
      name: "Backtrace",
      engineeringType: "backtrace",
    });
  }

  // ── Row parsing (second pass) ──────────────────────────────────────────────
  const rows: NormalizedRow[] = [];

  for (const node of nodes) {
    // Binary and frame id caches are per-node (ids restart in each <node>) —
    // a ref can point at an id defined in an EARLIER row within the same
    // node, so this must persist across the whole node's rows, not reset
    // per-row.
    const binaryCache: BinaryCache = new Map();
    const frameCache: FrameCache = new Map();

    for (const rowNode of asArray<Record<string, any>>(node?.row)) {
      rows.push(buildRow(rowNode, attrOrder, hasBacktrace, cols, binaryCache, frameCache));
    }
  }

  return { schema: syntheticSchema, cols, rows };
}

/**
 * Build one NormalizedRow from an already-assembled row node — shared by
 * {@link buildParsedTable}'s two-pass (discover-then-build) path and
 * {@link collectTrackDetailNodesToSqlite}'s single-pass streaming path (which
 * takes already-known `cols`/`hasBacktrace` from a prior discovery-only call
 * instead of discovering them from a collected `nodes` array).
 */
function buildRow(
  rowNode: Record<string, any>,
  attrOrder: string[],
  hasBacktrace: boolean,
  cols: SchemaCol[],
  binaryCache: BinaryCache,
  frameCache: FrameCache
): NormalizedRow {
  const row: NormalizedRow = {};

  for (const attrName of attrOrder) {
    const raw = rowNode[`@_${attrName}`];
    if (raw === undefined) {
      row[attrName] = null;
    } else {
      const strVal = String(raw);
      const engType = cols.find((c) => c.mnemonic === attrName)?.engineeringType ?? "string";
      row[attrName] = {
        type: engType,
        fmt: strVal,
        raw: coerceTrackDetailRaw(engType, strVal),
      };
    }
  }

  if (hasBacktrace) {
    const btNode = rowNode?.[BACKTRACE_MNEMONIC];
    if (btNode !== undefined && btNode !== null) {
      const frames = parseBacktrace(btNode as Record<string, any>, binaryCache, frameCache);
      const topName = frames[0]?.name ?? "";
      row[BACKTRACE_MNEMONIC] = {
        type: "backtrace",
        fmt: frames.length > 0 ? `${frames.length} frames, top: ${topName}` : "0 frames",
        raw: frames.length,
        resolvedFrames: frames,
      };
    } else {
      row[BACKTRACE_MNEMONIC] = null;
    }
  }

  return row;
}

/**
 * Column shape + row count only, with no row-level Cell materialization or
 * backtrace resolution at all — for callers like describe_schema that never
 * touch a single row. Built from an already-populated {@link ColumnDiscovery}
 * (streamed incrementally, one row at a time, never holding a full row array
 * — see {@link collectTrackDetailNodes}'s countOnly mode) rather than from a
 * batch `nodes` array the way the full parse path's discovery does.
 */
function buildSchemaMetaFromDiscovery(discovery: ColumnDiscovery, rowCount: number): SchemaMeta {
  const cols: SchemaCol[] = discovery.attrOrder.map((attrName) => ({
    mnemonic: attrName,
    name: attrName.replace(/-/g, " "),
    engineeringType: inferEngType(attrName, discovery.attrSamples.get(attrName) ?? []),
  }));
  if (discovery.hasBacktrace) {
    cols.push({ mnemonic: BACKTRACE_MNEMONIC, name: "Backtrace", engineeringType: "backtrace" });
  }
  return { cols, rowCount };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Parse track-detail XML (from exportXPath on a track-detail path) into a
 * ParsedTable — same shape as parseTableXml() output.
 *
 * @param xml            Raw XML string from exportXPath.
 * @param syntheticSchema The synthesized schema name ("Allocations/Allocations List", etc.)
 */
export function parseTrackDetailXml(xml: string, syntheticSchema: string): ParsedTable {
  const doc = parser.parse(xml) as Record<string, any>;
  const nodes = asArray<Record<string, any>>(doc?.["trace-query-result"]?.node);
  return buildParsedTable(nodes, syntheticSchema);
}

/**
 * Rewrites every literal `%` OUTSIDE a quoted attribute value to
 * {@link PERCENT_PLACEHOLDER} before the bytes reach sax's STRICT tokenizer.
 *
 * Confirmed live against a real VM Tracker recording: Regions Map exports a
 * plain, unquoted attribute NAME containing `%` (`resident-%="100.00"`) —
 * `%` is not a legal XML NameChar, so sax's strict mode throws "Invalid
 * attribute name" the instant it reads that byte, before ever emitting an
 * opentag event we could patch after the fact. fast-xml-parser (the
 * non-streaming path, parseTrackDetailXml) tolerates this fine — Apple ships
 * it and Instruments.app reads it, so this is a strict-tokenizer-specific
 * gap, not genuinely malformed data. `%` inside a QUOTED attribute value
 * (e.g. a percentage string like "16.5%") was never the problem — quoted
 * content already parses fine — so this only rewrites the unquoted regions
 * where attribute/tag names live, tracked with a single quote-state flag
 * that persists correctly across chunk boundaries. MiniXmlBuilder reverses
 * the substitution back to `%` once sax hands back parsed names/text.
 */
class PercentAttributeNameSanitizer extends Transform {
  private decoder = new StringDecoder("utf8");
  private inQuote: '"' | "'" | null = null;

  _transform(chunk: Buffer, _encoding: string, callback: (error?: Error | null, data?: string) => void): void {
    const text = this.decoder.write(chunk);
    let out = "";
    for (const ch of text) {
      if (this.inQuote) {
        if (ch === this.inQuote) this.inQuote = null;
        out += ch;
      } else if (ch === '"' || ch === "'") {
        this.inQuote = ch;
        out += ch;
      } else if (ch === "%") {
        out += PERCENT_PLACEHOLDER;
      } else {
        out += ch;
      }
    }
    callback(null, out);
  }

  _flush(callback: (error?: Error | null, data?: string) => void): void {
    callback(null, this.decoder.end());
  }
}

interface CollectResult {
  /** Full per-row mini-DOMs, grouped by <node> — empty when countOnly (never collected). */
  nodes: Array<Record<string, any>>;
  /** Populated incrementally when countOnly — see the mode split below. */
  discovery: ColumnDiscovery;
  rowCount: number;
}

/**
 * Streams every <node>'s rows — shared by {@link parseTrackDetailStream} and
 * {@link parseTrackDetailStreamMeta}, which differ in what they need kept
 * around afterward, not in how the XML is walked.
 *
 * `countOnly` is the important split: when false (the full-parse path),
 * every row's mini-DOM (small, compact objects via {@link MiniXmlBuilder} —
 * NOT the raw XML string, NOT a full generic DOM tree) is retained in
 * `nodes` for {@link buildParsedTable}'s later two-pass discovery+build.
 * When true, each row is fed to a running {@link ColumnDiscovery} the MOMENT
 * its mini-DOM completes and then DISCARDED — never appended to any array —
 * so memory stays flat regardless of row count. This matters: an earlier
 * version of this function always collected every row's full mini-DOM
 * first and ran discovery as a second pass over that array, meaning even
 * the "meta-only" path held the ENTIRE table's backtrace/binary data in
 * memory before ever getting to skip the heavier per-row Cell build —
 * confirmed live to still OOM (V8 heap exhaustion, ~4 GB) on a real,
 * large Allocations+Leaks recording. See PMT:copper-duck / PMT:spare-cairn.
 *
 * @throws {XctraceError} "empty-result" if no <node> was ever seen, "parse-error"
 *         on malformed XML.
 */
function collectTrackDetailNodes(stdout: Readable, countOnly: boolean, schemaLabel: string): Promise<CollectResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settleReject = (err: XctraceError) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const settleResolve = (result: CollectResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    // See the matching comment in parseTable.ts's parseTableStream — sax's
    // 64 KB default MAX_BUFFER_LENGTH (a global, not per-instance) rejects
    // oversized single attribute values; raised here too since it's a
    // process-wide sax module property and either streaming parser could
    // run first.
    (sax as unknown as { MAX_BUFFER_LENGTH: number }).MAX_BUFFER_LENGTH = 32 * 1024 * 1024;
    const saxStream = sax.createStream(true, { trim: false, normalize: false });

    const pathStack: string[] = [];
    let activeBuilder: MiniXmlBuilder | null = null;
    let sawNode = false;
    const nodes: Array<Record<string, any>> = [];
    let currentNodeRows: Array<Record<string, any>> | null = null;
    const discovery = new ColumnDiscovery();
    let rowCount = 0;

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
        currentNodeRows = [];
        nodes.push({ row: currentNodeRows });
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
          const result = activeBuilder.result!;
          rowCount++;
          if (countOnly) {
            discovery.observeRow(result);
            // Deliberately not appended anywhere — this is the whole point.
          } else {
            currentNodeRows!.push(result);
            // See memoryGuard.ts — a fatal V8 OOM aborts the ENTIRE process,
            // not just this call, so this must fire well before that point.
            if (rowCount % MEMORY_CHECK_INTERVAL === 0) {
              try {
                assertMemoryBudget(rowCount, schemaLabel);
              } catch (err) {
                settleReject(err as XctraceError);
                // sax's stream wrapper predates .destroy() (built on the
                // legacy Stream base, not Writable/Duplex) — stopping the
                // SOURCE is enough: no more writes reach saxStream, so it
                // goes inert and is garbage-collected with nothing else to
                // release. The sanitizer sits between the two — destroying
                // stdout stops it from feeding the sanitizer, which stops
                // feeding saxStream.
                stdout.destroy();
                activeBuilder = null;
                return;
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
        new XctraceError("parse-error", `Failed to parse streamed track-detail XML: ${err.message}`, {})
      );
    });

    saxStream.on("end", () => {
      if (!sawNode) {
        settleReject(
          new XctraceError("empty-result", "xctrace --xpath matched no nodes.", {})
        );
        return;
      }
      settleResolve({ nodes, discovery, rowCount });
    });

    stdout.on("error", (err: Error) => {
      settleReject(new XctraceError("export-failed", `stdout error: ${err.message}`, {}));
    });

    const sanitizer = new PercentAttributeNameSanitizer();
    sanitizer.on("error", (err: Error) => {
      settleReject(new XctraceError("export-failed", `stdout error: ${err.message}`, {}));
    });
    stdout.pipe(sanitizer).pipe(saxStream);
  });
}

/**
 * Streaming counterpart to {@link parseTrackDetailXml} — see
 * {@link collectTrackDetailNodes} for the shared implementation.
 */
export async function parseTrackDetailStream(
  stdout: Readable,
  syntheticSchema: string
): Promise<ParsedTable> {
  const { nodes } = await collectTrackDetailNodes(stdout, false, syntheticSchema);
  return buildParsedTable(nodes, syntheticSchema);
}

/**
 * Column shape + row count only, with no row ever retained in memory at any
 * point (not just no Cell materialization — see {@link collectTrackDetailNodes}'s
 * countOnly mode) — for callers like describe_schema that never touch a
 * single row.
 */
export async function parseTrackDetailStreamMeta(stdout: Readable, syntheticSchema: string): Promise<SchemaMeta> {
  const { discovery, rowCount } = await collectTrackDetailNodes(stdout, true, syntheticSchema);
  return buildSchemaMetaFromDiscovery(discovery, rowCount);
}

/**
 * Streams rows straight into a SQLite table instead of a JS array —
 * PMT:gravel-cape's ingestion path for track-detail schemas (Allocations,
 * Leaks, VM Tracker).
 *
 * Unlike parseTable.ts's schema-table format (which has an upfront <schema>
 * block, so columns are known before any row arrives), track-detail has NO
 * such block — column shape is only knowable from the union of attributes
 * across every row, exactly what {@link parseTrackDetailStreamMeta}'s
 * discovery-only pass already computes. So this function takes `cols` as an
 * ALREADY-KNOWN parameter rather than discovering them itself: the caller
 * (session.ts) runs the cheap discovery pass first (one xctrace export,
 * bounded memory, no row data materialized), then re-exports and calls this
 * for the real ingest pass using those now-final columns. Two xctrace
 * export subprocess calls instead of one — a real, deliberate cost, traded
 * for never having to hold the whole table in memory to learn its own shape
 * (the two-pass buildParsedTable/collectTrackDetailNodes route this
 * replaces would otherwise need the exact same "see everything once" step,
 * just with a full row array retained afterward instead of discarded).
 *
 * Reuses parseBacktrace/parseBinary/buildRow unchanged — only the last step
 * (push into an array vs. INSERT) differs, via {@link SqliteTableWriter}.
 */
export function parseTrackDetailStreamToSqlite(
  stdout: Readable,
  cols: SchemaCol[],
  db: DatabaseSync,
  tableName: string
): Promise<{ rowCount: number }> {
  const attrOrder = cols.filter((c) => c.mnemonic !== BACKTRACE_MNEMONIC).map((c) => c.mnemonic);
  const hasBacktrace = cols.some((c) => c.mnemonic === BACKTRACE_MNEMONIC);
  const writer = new SqliteTableWriter(db, tableName, cols);

  return new Promise((resolve, reject) => {
    let settled = false;
    const settleReject = (err: XctraceError) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const settleResolve = (result: { rowCount: number }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    // See the matching comment in collectTrackDetailNodes — sax's 64 KB
    // default MAX_BUFFER_LENGTH (a global, not per-instance) rejects
    // oversized single attribute values.
    (sax as unknown as { MAX_BUFFER_LENGTH: number }).MAX_BUFFER_LENGTH = 32 * 1024 * 1024;
    const saxStream = sax.createStream(true, { trim: false, normalize: false });

    const pathStack: string[] = [];
    let activeBuilder: MiniXmlBuilder | null = null;
    let sawNode = false;
    let rowCount = 0;
    let binaryCache: BinaryCache = new Map();
    let frameCache: FrameCache = new Map();

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
        // Binary/frame ids are node-local — fresh caches per node, same as
        // collectTrackDetailNodes/buildParsedTable.
        binaryCache = new Map();
        frameCache = new Map();
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
          if (pathStack[pathStack.length - 1] === tag) pathStack.pop();
          const builtNode = activeBuilder.result!;
          rowCount++;
          const row = buildRow(builtNode, attrOrder, hasBacktrace, cols, binaryCache, frameCache);
          writer.writeRow(row);

          // See memoryGuard.ts. RefCache-equivalent retention here is
          // binaryCache/frameCache, which are per-node and much smaller
          // than a full RefCache (only backtrace-bearing values), but the
          // same periodic check is cheap insurance regardless.
          if (rowCount % MEMORY_CHECK_INTERVAL === 0) {
            try {
              assertMemoryBudget(rowCount, tableName);
            } catch (err) {
              settleReject(err as XctraceError);
              stdout.destroy();
              activeBuilder = null;
              return;
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
        new XctraceError("parse-error", `Failed to parse streamed track-detail XML: ${err.message}`, {})
      );
    });

    saxStream.on("end", () => {
      if (!sawNode) {
        settleReject(
          new XctraceError("empty-result", "xctrace --xpath matched no nodes.", {})
        );
        return;
      }
      const finalCount = writer.finish();
      settleResolve({ rowCount: finalCount });
    });

    stdout.on("error", (err: Error) => {
      settleReject(new XctraceError("export-failed", `stdout error: ${err.message}`, {}));
    });

    const sanitizer = new PercentAttributeNameSanitizer();
    sanitizer.on("error", (err: Error) => {
      settleReject(new XctraceError("export-failed", `stdout error: ${err.message}`, {}));
    });
    stdout.pipe(sanitizer).pipe(saxStream);
  });
}
