/**
 * getRow — full cell detail for a single table row.
 *
 * Progressive disclosure partner to query: query returns fmt-only summaries;
 * getRow returns every column's type, fmt, raw, and compound children so the
 * agent can read multi-level cells (thread+process hierarchy, nested compound
 * values) without the full XML.
 *
 * Backtrace columns (kperf-bt): schema-table format stores call frames as
 * binary fragments referenced by ID — not pre-symbolicated text. getRow
 * surfaces the top-of-stack PC, frame count, and calling process from the
 * parsed kperf-bt children, and tells the agent to use call_tree for a full
 * aggregated + symbolicated call tree across all samples.
 *
 * PMT:dusk-floe: fetches the one SQL row by _row_idx and hydrates it into the
 * same Cell shape the old JS-array path produced (buildCellDetail/
 * extractKperfBt below are UNCHANGED — they always operated on Cell objects,
 * not the array itself, so hydrateCell from sqlHydrate.ts slots in as a drop-
 * in row source).
 */
import { getTable, getDb, lastRun as sessionLastRun } from "../engine/session.js";
import { classifyWithHints } from "../engine/roleHints.js";
import { hydrateNormalizedRow, makeFrameLookup, makeInternResolver } from "../engine/sqlHydrate.js";
import { quoteIdent, ROW_IDX_COLUMN } from "../engine/sqliteStore.js";
import type { Cell, ResolvedFrame } from "../engine/parseTable.js";
import type { ColumnRole, WeightUnit } from "../engine/roleInference.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CellDetail {
  /** Engineering-type tag name from the XML. */
  type: string;
  /** Human-readable formatted value. */
  fmt: string;
  /** Machine value: number for all-digit strings, otherwise string. */
  raw: string | number;
  /** Inferred role of this column. */
  role: ColumnRole;
  /** Unit hint, present only for weight columns. */
  unit?: WeightUnit;
  /**
   * Present when `fmt`/`raw` were cut to MAX_CELL_CHARS — some cells resolve
   * to an unbounded blob (e.g. a base64-encoded image body pulled through the
   * interned-value ref scheme; verified live against a real HTTPTraffic trace,
   * up to 342 KB for one cell) with no size relationship to the rest of the
   * row. `originalLength` is the untruncated character count, so the agent
   * knows how much was cut without re-fetching.
   */
  truncated?: boolean;
  originalLength?: number;
  /**
   * Simplified child values for compound cells (thread, process, etc.).
   * Keys are child tag names, values are their fmt strings.
   */
  childValues?: Record<string, string | null>;
  /**
   * Backtrace summary. For schema-table (kperf-bt) columns this is address-only
   * — use call_tree for full symbolicated stacks. For track-detail (Allocations/
   * Leaks) columns the frames are already symbolicated and included directly.
   */
  backtrace?: {
    topPc: string | null;
    frameCount: number | null;
    process: string | null;
    note: string;
    /** Resolved frames (present only for track-detail backtraces). */
    resolvedFrames?: ResolvedFrame[];
  };
}

export interface GetRowResult {
  schema: string;
  run: number;
  /** Raw table index (matches `tableIndex` in QueryRow). */
  rowIndex: number;
  /** Total rows in this table (for bounds checking). */
  totalRows: number;
  /** Full cell detail for every column, keyed by mnemonic. */
  cells: Record<string, CellDetail | null>;
}

// ─── Backtrace extraction ──────────────────────────────────────────────────────

const FRAME_COUNT_RE = /(\d+)\s+frames?/;

function extractKperfBt(cell: Cell): CellDetail["backtrace"] {
  // Top PC from text-address child.
  const topPcCell = cell.children?.["text-address"];
  const topPc = topPcCell?.fmt || null;

  // Frame count from the fmt string: "PC:0x..., N frames, ...".
  const frameMatch = FRAME_COUNT_RE.exec(cell.fmt);
  const frameCount = frameMatch ? parseInt(frameMatch[1], 10) : null;

  // Process from process child.
  const processCell = cell.children?.["process"];
  const process = processCell?.fmt || null;

  return {
    topPc,
    frameCount,
    process,
    note: "Full symbolicated call tree available via call_tree tool (aggregates all samples).",
  };
}

// ─── Size cap + header redaction ────────────────────────────────────────────────

/**
 * get_row is the "give me everything" drill-down (query/find deliberately
 * stay fmt-only summaries) — but "everything" still needs a backstop. A
 * single cell can resolve to an unbounded blob with no relationship to the
 * row's own size: verified live against a real device HTTPTraffic trace
 * (PMT:loam-merlin), an interned image response body resolved to 342 KB for
 * ONE cell, because the intern/ref scheme that keeps the trace compact on
 * disk has no size ceiling on what it dedupes. 2000 chars keeps a genuinely
 * useful amount of text (a full header block, a real error message) while
 * capping the pathological case; `truncated`/`originalLength` on CellDetail
 * tell the agent how much was cut.
 */
export const MAX_CELL_CHARS = 2000;

export function truncateText(s: string): { text: string; truncated: boolean; originalLength?: number } {
  if (s.length <= MAX_CELL_CHARS) return { text: s, truncated: false };
  return {
    text: `${s.slice(0, MAX_CELL_CHARS)} … [truncated — ${s.length.toLocaleString()} chars total]`,
    truncated: true,
    originalLength: s.length,
  };
}

/**
 * HTTP header cells (CFNetwork's request-headers/response-headers, and any
 * schema shaped like them) come back as one flattened "(Key : Value), (Key :
 * Value)" string, not a compound cell — so redaction has to pattern-match
 * pairs within that string rather than target a known child field. Verified
 * live: this exact "(Name : Value)" shape is what com-apple-cfnetwork-
 * transaction-intervals-full-info's request-headers/response-headers
 * actually produce. Scoped to mnemonics containing "header" so it never
 * touches unrelated compound cells that might coincidentally contain
 * parenthesized text.
 */
const SENSITIVE_HEADER_NAMES = new Set([
  "authorization", "proxy-authorization", "cookie", "set-cookie",
  "x-api-key", "api-key", "x-auth-token", "x-access-token", "x-session-token",
]);
const HEADER_PAIR_RE = /\(([^:()]+?)\s*:\s*([^()]*)\)/g;

export function redactSensitiveHeaders(mnemonic: string, text: string): string {
  if (!mnemonic.toLowerCase().includes("header")) return text;
  return text.replace(HEADER_PAIR_RE, (match, key: string, _value: string) =>
    SENSITIVE_HEADER_NAMES.has(key.trim().toLowerCase()) ? `(${key.trim()} : [REDACTED])` : match
  );
}

/** Apply header redaction then the size cap, in that order — redaction can
 *  only shrink a value, so running it first never changes whether a value
 *  needed truncating in a way that would hide a still-oversized blob. */
export function sanitizeCellText(mnemonic: string, s: string): { text: string; truncated: boolean; originalLength?: number } {
  return truncateText(redactSensitiveHeaders(mnemonic, s));
}

// ─── Cell detail builder ──────────────────────────────────────────────────────

function buildCellDetail(
  mnemonic: string,
  cell: Cell | null,
  role: ColumnRole,
  unit?: WeightUnit
): CellDetail | null {
  if (cell === null) return null;

  const fmtSanitized = sanitizeCellText(mnemonic, cell.fmt);
  const rawSanitized = typeof cell.raw === "string" ? sanitizeCellText(mnemonic, cell.raw) : undefined;
  const anyTruncated = fmtSanitized.truncated || (rawSanitized?.truncated ?? false);

  const base: CellDetail = {
    type: cell.type,
    fmt: fmtSanitized.text,
    raw: rawSanitized ? rawSanitized.text : cell.raw,
    role,
    ...(unit ? { unit } : {}),
    ...(anyTruncated
      ? { truncated: true, originalLength: fmtSanitized.originalLength ?? rawSanitized?.originalLength }
      : {}),
  };

  // Inline pre-symbolicated backtrace: track-detail (Allocations/Leaks) or a
  // schema-table column using the same shape (e.g. core-data-fetch) — either
  // way, frames are USUALLY already resolved, no call_tree symbolication
  // needed. But "the array exists" doesn't mean "every frame actually
  // resolved" — a ref-only frame with no matching id in scope (a parser gap,
  // not normal data) comes back as {name: "", addr: ""} rather than being
  // dropped, so check for that instead of asserting "already symbolicated"
  // unconditionally (verified live: this fired confidently wrong on Allocations
  // backtraces before the frame-ref cache fix — see PMT:spare-cairn).
  if (cell.resolvedFrames) {
    const frames = cell.resolvedFrames;
    const unresolved = frames.filter((f) => f.name === "" && f.addr === "").length;
    const note =
      unresolved === 0
        ? "Already symbolicated inline — no call_tree step needed."
        : unresolved === frames.length
          ? `${frames.length} frame(s), none resolved — likely a parser gap for this schema's ` +
            "backtrace shape, not \"no symbols\"; the frames genuinely exist in the trace."
          : `${unresolved} of ${frames.length} frames unresolved (blank name/addr) — likely a ` +
            "parser gap for this schema's backtrace shape, not \"no symbols\" for those frames.";
    return {
      ...base,
      backtrace: {
        topPc: frames[0]?.name ?? null,
        frameCount: frames.length,
        process: null,
        note,
        resolvedFrames: frames,
      },
    };
  }

  // Scalar cells (no children, no resolved frames) — return early.
  if (!cell.children || Object.keys(cell.children).length === 0) {
    return base;
  }

  // Schema-table backtrace compound cell (kperf-bt / text-backtrace).
  if (cell.type === "kperf-bt" || cell.type === "text-backtrace" || cell.type === "backtrace") {
    return { ...base, backtrace: extractKperfBt(cell) };
  }

  // Generic compound cell — flatten children to childValues.
  const childValues: Record<string, string | null> = {};
  for (const [childTag, childCell] of Object.entries(cell.children)) {
    childValues[childTag] =
      childCell?.fmt !== undefined && childCell?.fmt !== null
        ? sanitizeCellText(mnemonic, childCell.fmt).text
        : null;
  }
  return { ...base, childValues };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function getRow(
  sessionId: string,
  schema: string,
  rowIndex: number,
  opts: { run?: number; position?: number } = {}
): Promise<GetRowResult> {
  const run = opts.run ?? sessionLastRun(sessionId);
  const handle = await getTable(sessionId, run, schema, opts.position);

  if (rowIndex < 0 || rowIndex >= handle.rowCount) {
    throw new RangeError(
      `rowIndex ${rowIndex} is out of bounds (table has ${handle.rowCount} rows).`
    );
  }

  const db = await getDb(sessionId);
  const sqlRow = db
    .prepare(`SELECT * FROM ${quoteIdent(handle.tableName)} WHERE ${quoteIdent(ROW_IDX_COLUMN)} = ?`)
    .get(rowIndex) as Record<string, unknown> | undefined;

  if (!sqlRow) {
    throw new RangeError(
      `rowIndex ${rowIndex} is out of bounds (table has ${handle.rowCount} rows).`
    );
  }

  const getFrames = makeFrameLookup(db);
  const row = hydrateNormalizedRow(handle.cols, sqlRow, getFrames, makeInternResolver(db));

  const classified = classifyWithHints(schema, handle.cols);
  const roleMap = new Map(classified.map((c) => [c.mnemonic, c.roleInfo]));

  const cells: Record<string, CellDetail | null> = {};
  for (const col of handle.cols) {
    const roleInfo = roleMap.get(col.mnemonic);
    cells[col.mnemonic] = buildCellDetail(
      col.mnemonic,
      row[col.mnemonic] ?? null,
      roleInfo?.role ?? "detail",
      roleInfo?.unit
    );
  }

  return {
    schema,
    run,
    rowIndex,
    totalRows: handle.rowCount,
    cells,
  };
}
