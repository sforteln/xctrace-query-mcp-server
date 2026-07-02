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
 */
import { getTable, lastRun as sessionLastRun } from "../engine/session.js";
import { classifyWithHints } from "../engine/roleHints.js";
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

// ─── Cell detail builder ──────────────────────────────────────────────────────

function buildCellDetail(
  mnemonic: string,
  cell: Cell | null,
  role: ColumnRole,
  unit?: WeightUnit
): CellDetail | null {
  if (cell === null) return null;

  const base: CellDetail = {
    type: cell.type,
    fmt: cell.fmt,
    raw: cell.raw,
    role,
    ...(unit ? { unit } : {}),
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
    childValues[childTag] = childCell?.fmt ?? null;
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
  const table = await getTable(sessionId, run, schema, opts.position);

  if (rowIndex < 0 || rowIndex >= table.rows.length) {
    throw new RangeError(
      `rowIndex ${rowIndex} is out of bounds (table has ${table.rows.length} rows).`
    );
  }

  const row = table.rows[rowIndex];
  const classified = classifyWithHints(schema, table.cols);
  const roleMap = new Map(classified.map((c) => [c.mnemonic, c.roleInfo]));

  const cells: Record<string, CellDetail | null> = {};
  for (const col of table.cols) {
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
    totalRows: table.rows.length,
    cells,
  };
}
