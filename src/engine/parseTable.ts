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
 *   - Column role classification (time/weight/backtrace/thread/…) → FTR:silver-mica
 *   - Cross-call caching keyed by (tracePath, run, schema) → next prompt / session layer
 */
import { XMLParser } from "fast-xml-parser";

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
 * @param tableXml  The full XML string returned by exportXPath().
 * @param cache     Optional pre-populated RefCache for cross-call reuse. If
 *                  omitted a fresh cache is created (single-call resolution).
 */
export function parseTableXml(
  tableXml: string,
  cache: RefCache = new Map()
): ParsedTable {
  const doc = parser.parse(tableXml) as Record<string, any>;
  const node = doc?.["trace-query-result"]?.node;
  if (!node) {
    return { schema: "", cols: [], rows: [] };
  }

  const schemaNode = node.schema as Record<string, any>;
  const schemaName = String(schemaNode?.["@_name"] ?? "");
  const cols = parseSchemaCols(schemaNode);

  const rawRows = asArray<Record<string, any>>(node.row);
  const rows = rawRows.map((r) => parseRow(r, cols, cache));

  return { schema: schemaName, cols, rows };
}
