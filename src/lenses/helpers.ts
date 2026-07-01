/**
 * Lens helper utilities — project role-classified rows into domain vocabulary.
 *
 * A lens is mostly a column-name → domain-name mapping plus presentation logic.
 * These helpers let a lens author avoid re-implementing role lookup or parsing:
 *
 *   const domain = projectRow(row, classified,
 *     { time: "startTime", weight: "duration", label: "name", thread: "thread" },
 *     { "error-count": "errorCount", "input-tokens": "promptTokens" }
 *   );
 *   // → { startTime: "12.34 ms", duration: "1.23 s", name: "chat/completions",
 *   //     thread: "main (tid 0x1234)", errorCount: "0", promptTokens: "128" }
 */
import type { Cell, NormalizedRow } from "../engine/parseTable.js";
import type { ClassifiedColumn, ColumnRole } from "../engine/roleInference.js";
import { firstWithRole, preferredThreadColumn } from "../engine/roleInference.js";

// ─── Single-cell accessors ────────────────────────────────────────────────────

/**
 * Return the Cell for the first column matching a role, or null.
 *
 * For "thread" specifically, prefers the most specific "who" column
 * (thread/tid over process/pid, excluding core/cpu) rather than whichever
 * comes first in column order — a schema can carry both a process column
 * and a specific-thread column (confirmed on swiftui-update-groups), and
 * "same thread" vs. "same process" are not interchangeable matches. See
 * roleInference.ts's preferredThreadColumn for why.
 */
export function roleCell(
  row: NormalizedRow,
  classified: ClassifiedColumn[],
  role: ColumnRole
): Cell | null {
  const col = role === "thread" ? preferredThreadColumn(classified) : firstWithRole(classified, role);
  if (!col) return null;
  return row[col.mnemonic] ?? null;
}

/** Return the fmt string for the first column matching a role, or null. */
export function roleFmt(
  row: NormalizedRow,
  classified: ClassifiedColumn[],
  role: ColumnRole
): string | null {
  return roleCell(row, classified, role)?.fmt ?? null;
}

/** Return the raw value for the first column matching a role, or null. */
export function roleRaw(
  row: NormalizedRow,
  classified: ClassifiedColumn[],
  role: ColumnRole
): string | number | null {
  const cell = roleCell(row, classified, role);
  return cell !== null ? cell.raw : null;
}

/** Return the fmt string for a specific mnemonic, or null. */
export function mnemonicFmt(row: NormalizedRow, mnemonic: string): string | null {
  return row[mnemonic]?.fmt ?? null;
}

/** Return the raw value for a specific mnemonic, or null. */
export function mnemonicRaw(row: NormalizedRow, mnemonic: string): string | number | null {
  const cell = row[mnemonic];
  return cell !== null && cell !== undefined ? cell.raw : null;
}

// ─── Row projection ───────────────────────────────────────────────────────────

/**
 * Project a row into a domain object by mapping column roles to field names.
 * Each entry maps the fmt value of the first column with that role.
 *
 * Use for generic fields that transfer across schemas (time, weight, thread…).
 */
export function projectByRole(
  row: NormalizedRow,
  classified: ClassifiedColumn[],
  mapping: Partial<Record<ColumnRole, string>>
): Record<string, string | null> {
  const result: Record<string, string | null> = {};
  for (const [role, fieldName] of Object.entries(mapping) as [ColumnRole, string][]) {
    result[fieldName] = roleFmt(row, classified, role);
  }
  return result;
}

/**
 * Project a row into a domain object using explicit mnemonic → field name mapping.
 * Use for schema-specific columns not captured by role inference.
 */
export function projectByMnemonic(
  row: NormalizedRow,
  mapping: Record<string, string>
): Record<string, string | null> {
  const result: Record<string, string | null> = {};
  for (const [mnemonic, fieldName] of Object.entries(mapping)) {
    result[fieldName] = row[mnemonic]?.fmt ?? null;
  }
  return result;
}

/**
 * Primary projection helper for lenses.
 *
 * Merges role-based and mnemonic-based projections into one domain object.
 * Role mappings handle generic columns (time, weight, thread); mnemonic
 * mappings handle schema-specific columns (input-tokens, error-count, …).
 * Mnemonic mappings win on key collision.
 *
 * Example:
 *   projectRow(row, classified,
 *     { time: "startTime", weight: "duration", thread: "thread" },
 *     { "input-tokens": "promptTokens", "output-tokens": "completionTokens" }
 *   )
 *   → { startTime: "0.45 ms", duration: "1.23 s", thread: "main",
 *       promptTokens: "128", completionTokens: "512" }
 */
export function projectRow(
  row: NormalizedRow,
  classified: ClassifiedColumn[],
  roleMapping: Partial<Record<ColumnRole, string>>,
  mnemonicMapping: Record<string, string> = {}
): Record<string, string | null> {
  return {
    ...projectByRole(row, classified, roleMapping),
    ...projectByMnemonic(row, mnemonicMapping),
  };
}
