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
import { XMLParser } from "fast-xml-parser";
// Default import, not `import * as sax` — sax is a CJS module whose exports
// (createStream etc.) are assigned inside an IIFE that Node's static
// named-export detection can't see, so a namespace import resolves to an
// empty object at runtime under NodeNext/ESM output. A default import always
// gets the whole module.exports object regardless of static analysis.
import sax from "sax";
import type { Readable } from "node:stream";
import { MiniXmlBuilder } from "./saxTreeBuilder.js";
import { XctraceError } from "./xctrace.js";

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

// ─── XML parser ──────────────────────────────────────────────────────────────

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // Preserve tag names as-is; we need the engineering-type tag name per cell.
  parseTagValue: false,
  // Keep text content; we'll coerce numerics ourselves.
  parseAttributeValue: false,
  // Don't collapse single-child arrays — we handle asArray() ourselves.
  isArray: () => false,
  // Preserve all nodes including sentinel (empty elements).
  allowBooleanAttributes: true,
});

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
 */
function coerceRaw(text: string): number | string {
  return /^\d+$/.test(text.trim()) ? Number(text.trim()) : text.trim();
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
  // to the generic compound handling below unchanged.
  if (tagName === "backtrace" && attrs.frame !== undefined) {
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
  // or the "#text" key for text content).
  const childKeys = Object.keys(attrs).filter(
    (k) => !k.startsWith("@_") && k !== "#text"
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
 * Parse one <row> element into a NormalizedRow, mapping children positionally
 * onto the schema columns.
 */
function parseRow(
  rowNode: Record<string, any>,
  cols: SchemaCol[],
  cache: RefCache
): NormalizedRow {
  // fast-xml-parser gives us the row's child elements as keys on rowNode.
  // Children map positionally to cols, so we need them in document order.
  // We reconstruct order by collecting all non-@ keys and iterating cols.
  //
  // Strategy: build an ordered list of (tagName, node) pairs by walking cols
  // and consuming matching keys in order. Because the same tag can appear
  // multiple times (e.g. two sentinels, two strings), we track a per-tag index.

  const tagCounts: Record<string, number> = {};
  const tagQueues: Record<string, Array<Record<string, any>>> = {};

  for (const key of Object.keys(rowNode).filter((k) => !k.startsWith("@_"))) {
    tagQueues[key] = asArray<Record<string, any>>(rowNode[key]);
  }

  const result: NormalizedRow = {};

  for (const col of cols) {
    // The XML tag for a column is its engineering-type, not its mnemonic.
    // We don't have that here directly, but the engineering-type is stored in
    // col.engineeringType. However xctrace uses the engineering-type as the
    // XML element tag name with one caveat: some types have hyphens and map
    // directly (e.g. "start-time" → <start-time>). We look for that first,
    // then fall back to iterating remaining tags in order.
    const expectedTag = col.engineeringType;
    const queue = tagQueues[expectedTag];

    if (queue && queue.length > 0) {
      const node = queue.shift()!;
      result[col.mnemonic] = parseCell(expectedTag, node, cache);
    } else {
      // Tag not found by engineering-type name — try positional fallback:
      // pick the first non-empty remaining queue in key order.
      const fallbackKey = Object.keys(tagQueues).find(
        (k) => tagQueues[k].length > 0
      );
      if (fallbackKey) {
        const node = tagQueues[fallbackKey].shift()!;
        result[col.mnemonic] = parseCell(fallbackKey, node, cache);
      } else {
        result[col.mnemonic] = null;
      }
    }
  }

  return result;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Parse the raw --xpath table XML into a {@link ParsedTable}.
 *
 * A schema can appear as more than one `<table>` in a single run (e.g. `tick`
 * at frequency 1 and 10, or `os-signpost` filtered by different subsystems), so
 * an xpath addressing a schema can return multiple `<node>` elements. We use the
 * first node's columns (all share the same schema) and UNION the rows across
 * nodes into one logical table.
 *
 * Ref-id namespaces are scoped PER NODE — ids restart at 1 in each `<node>` —
 * so every node gets its own fresh RefCache. (This is why there is no
 * cross-call/shared cache: the meaningful cache is the parsed-table cache the
 * session holds, not the transient ref map.)
 *
 * @param tableXml  The full XML string returned by exportXPath().
 */
export function parseTableXml(tableXml: string): ParsedTable {
  const doc = parser.parse(tableXml) as Record<string, any>;
  const nodes = asArray<Record<string, any>>(doc?.["trace-query-result"]?.node);
  if (nodes.length === 0) {
    return { schema: "", cols: [], rows: [] };
  }

  const schemaNode = nodes[0].schema as Record<string, any>;
  const schemaName = String(schemaNode?.["@_name"] ?? "");
  const cols = parseSchemaCols(schemaNode);

  const rows: NormalizedRow[] = [];
  for (const node of nodes) {
    // Fresh ref cache per node — ids are node-local.
    const cache: RefCache = new Map();
    for (const r of asArray<Record<string, any>>(node.row)) {
      rows.push(parseRow(r, cols, cache));
    }
  }

  return { schema: schemaName, cols, rows };
}

/**
 * Streaming counterpart to {@link parseTableXml} — consumes xctrace's stdout
 * directly via a SAX parser instead of buffering the whole document into one
 * string and building a full DOM tree of it. Reconstructs one <schema> or one
 * <row> subtree at a time via {@link MiniXmlBuilder} (each is small — a few
 * dozen cells at most) and feeds it through the SAME parseSchemaCols/parseRow
 * used by the string-based path, so output is byte-for-byte equivalent.
 *
 * Same multi-node union behavior as parseTableXml: the first node's columns
 * win, and rows from every node are concatenated (ref-ids are node-scoped, so
 * the cache resets per node).
 *
 * @throws {XctraceError} "empty-result" if no <node> was ever seen (xpath
 *         matched nothing), "parse-error" on malformed XML.
 */
export function parseTableStream(stdout: Readable): Promise<ParsedTable> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settleReject = (err: XctraceError) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const settleResolve = (table: ParsedTable) => {
      if (settled) return;
      settled = true;
      resolve(table);
    };

    const saxStream = sax.createStream(true, { trim: false, normalize: false });

    const pathStack: string[] = [];
    let activeBuilder: MiniXmlBuilder | null = null;
    let sawNode = false;
    let schemaName = "";
    let cols: SchemaCol[] = [];
    const rows: NormalizedRow[] = [];
    let cache: RefCache = new Map();

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
          } else if (tag === "row") {
            rows.push(parseRow(builtNode, cols, cache));
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
      settleResolve({ schema: schemaName, cols, rows });
    });

    stdout.on("error", (err: Error) => {
      settleReject(new XctraceError("export-failed", `stdout error: ${err.message}`, {}));
    });

    stdout.pipe(saxStream);
  });
}
