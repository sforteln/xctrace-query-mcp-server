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
import { MiniXmlBuilder, PERCENT_PLACEHOLDER } from "./saxTreeBuilder.js";
import { XctraceError } from "./xctrace.js";
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

/** Mirror parseTable.ts coerceRaw: all-digit → number, else string. */
function coerceRaw(s: string): number | string {
  return /^\d+$/.test(s.trim()) ? Number(s.trim()) : s.trim();
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

function parseBacktrace(
  backtraceNode: Record<string, any>,
  binaryCache: BinaryCache
): ResolvedFrame[] {
  const frames: ResolvedFrame[] = [];
  for (const frame of asArray<Record<string, any>>(backtraceNode?.frame)) {
    const name = String(frame["@_name"] ?? "");
    const addr = String(frame["@_addr"] ?? "");
    // Frame may have zero or one <binary> child.
    const binaryNodes = asArray<Record<string, any>>(frame?.binary);
    const binary =
      binaryNodes.length > 0
        ? parseBinary(binaryNodes[0], binaryCache)
        : { name: null, path: null };
    frames.push({ name, addr, binaryName: binary.name, binaryPath: binary.path });
  }
  return frames;
}

// ─── Column discovery ─────────────────────────────────────────────────────────

const BACKTRACE_MNEMONIC = "backtrace";

/**
 * Walk all rows across all nodes to discover the union of attribute names
 * and whether any row has a <backtrace>. Returns ordered column list and
 * per-attribute sample values for type inference.
 */
function discoverColumns(
  nodes: Array<Record<string, any>>
): { attrOrder: string[]; attrSamples: Map<string, string[]>; hasBacktrace: boolean } {
  const attrOrder: string[] = [];
  const attrSet = new Set<string>();
  const attrSamples = new Map<string, string[]>();
  let hasBacktrace = false;

  for (const node of nodes) {
    for (const row of asArray<Record<string, any>>(node?.row)) {
      // fast-xml-parser puts XML attributes under "@_name" keys and child
      // elements under plain "name" keys. We want only attribute keys here.
      for (const [key, val] of Object.entries(row)) {
        if (!key.startsWith("@_")) continue;
        const attrName = key.slice(2);
        if (!attrSet.has(attrName)) {
          attrSet.add(attrName);
          attrOrder.push(attrName);
          attrSamples.set(attrName, []);
        }
        const samples = attrSamples.get(attrName)!;
        if (samples.length < 20) samples.push(String(val));
      }
      if (row?.[BACKTRACE_MNEMONIC] !== undefined) hasBacktrace = true;
    }
  }

  return { attrOrder, attrSamples, hasBacktrace };
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
    // Binary id cache is per-node (ids restart in each <node>).
    const binaryCache: BinaryCache = new Map();

    for (const rowNode of asArray<Record<string, any>>(node?.row)) {
      const row: NormalizedRow = {};

      // Attribute cells.
      for (const attrName of attrOrder) {
        const raw = rowNode[`@_${attrName}`];
        if (raw === undefined) {
          row[attrName] = null;
        } else {
          const strVal = String(raw);
          row[attrName] = {
            type: cols.find((c) => c.mnemonic === attrName)?.engineeringType ?? "string",
            fmt: strVal,
            raw: coerceRaw(strVal),
          };
        }
      }

      // Backtrace cell (if column exists).
      if (hasBacktrace) {
        const btNode = rowNode?.[BACKTRACE_MNEMONIC];
        if (btNode !== undefined && btNode !== null) {
          const frames = parseBacktrace(
            btNode as Record<string, any>,
            binaryCache
          );
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

      rows.push(row);
    }
  }

  return { schema: syntheticSchema, cols, rows };
}

/**
 * Column shape + row count only, with no row-level Cell materialization or
 * backtrace resolution at all — for callers like describe_schema that never
 * touch a single row. Column discovery is still a full pass over every row's
 * raw attributes (track-detail has no upfront <schema> block the way
 * schema-table does — the attribute union can only be known after seeing
 * every row), but this skips buildParsedTable's much heavier second pass
 * (per-cell type coercion, backtrace frame resolution) and never holds a
 * `rows` array at all.
 */
function buildSchemaMeta(nodes: Array<Record<string, any>>): SchemaMeta {
  if (nodes.length === 0) return { cols: [], rowCount: 0 };

  const { attrOrder, attrSamples, hasBacktrace } = discoverColumns(nodes);
  const cols: SchemaCol[] = attrOrder.map((attrName) => ({
    mnemonic: attrName,
    name: attrName.replace(/-/g, " "),
    engineeringType: inferEngType(attrName, attrSamples.get(attrName) ?? []),
  }));
  if (hasBacktrace) {
    cols.push({ mnemonic: BACKTRACE_MNEMONIC, name: "Backtrace", engineeringType: "backtrace" });
  }

  const rowCount = nodes.reduce((n, node) => n + asArray<Record<string, any>>(node?.row).length, 0);
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

/**
 * Streams and reconstructs every <node>'s row mini-DOMs — shared by
 * {@link parseTrackDetailStream} and {@link parseTrackDetailStreamMeta}, which
 * differ only in what they build from the result (a full ParsedTable via
 * {@link buildParsedTable}, or column-shape-only via {@link buildSchemaMeta}).
 * Column discovery is inherently two-pass regardless (the attribute set is
 * only known after seeing every row), so both callers need every row's mini-
 * DOM collected here first — small, compact objects via {@link MiniXmlBuilder},
 * NOT the raw XML string and NOT a full generic DOM tree of the whole
 * document.
 *
 * @throws {XctraceError} "empty-result" if no <node> was ever seen, "parse-error"
 *         on malformed XML.
 */
function collectTrackDetailNodes(stdout: Readable): Promise<Array<Record<string, any>>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settleReject = (err: XctraceError) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const settleResolve = (nodes: Array<Record<string, any>>) => {
      if (settled) return;
      settled = true;
      resolve(nodes);
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
          currentNodeRows!.push(activeBuilder.result!);
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
      settleResolve(nodes);
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
  const nodes = await collectTrackDetailNodes(stdout);
  return buildParsedTable(nodes, syntheticSchema);
}

/**
 * Column shape + row count only, with no row-level Cell materialization or
 * backtrace resolution at all — for callers like describe_schema that never
 * touch a single row. See {@link buildSchemaMeta}.
 */
export async function parseTrackDetailStreamMeta(stdout: Readable): Promise<SchemaMeta> {
  const nodes = await collectTrackDetailNodes(stdout);
  return buildSchemaMeta(nodes);
}
