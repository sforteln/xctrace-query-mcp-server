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
import type { Cell } from "../engine/parseTable.js";
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
   * Parsed kperf-bt summary for backtrace columns. Full symbolicated stacks
   * require the call_tree tool which aggregates across samples.
   */
  backtrace?: {
    topPc: string | null;
    frameCount: number | null;
    process: string | null;
    note: string;
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

  if (!cell.children || Object.keys(cell.children).length === 0) {
    return base;
  }

  // Backtrace compound cell.
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
  opts: { run?: number } = {}
): Promise<GetRowResult> {
  const run = opts.run ?? sessionLastRun(sessionId);
  const table = await getTable(sessionId, run, schema);

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
