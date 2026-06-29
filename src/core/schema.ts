/**
 * describeSchema — the first universal verb that exposes inferred column roles.
 *
 * Given a schema (and optional run, defaulting to the most recent), it fetches
 * the table once (cached on the session), classifies every column via the
 * override→heuristic pipeline, and returns a description rich enough that an
 * agent can form a query or aggregate call without any further schema knowledge:
 * each column's role, the canonical primaryTime / primaryWeight to target, and a
 * by-role grouping of column mnemonics.
 */
import { getTable, lastRun, getSchemaModel } from "../engine/session.js";
import { findOne } from "../engine/schemaModel.js";
import { classifyWithHints, hintFor } from "../engine/roleHints.js";
import {
  ColumnRole,
  WeightUnit,
  firstWithRole,
} from "../engine/roleInference.js";

export interface DescribedColumn {
  mnemonic: string;
  name: string;
  engineeringType: string;
  role: ColumnRole;
  unit?: WeightUnit;
  confidence: "high" | "medium" | "low";
  source: "override" | "engineering-type" | "mnemonic" | "default";
}

export interface SchemaDescription {
  schema: string;
  run: number;
  /** Friendly instrument name (from the hint table) or the raw schema name. */
  instrument: string;
  /** Whether this schema is pinned in the override table. */
  pinned: boolean;
  /** Human-readable description from the TOC, if any. */
  documentation: string | null;
  rowCount: number;
  /** Canonical time column to use for timeRange filtering (null if none). */
  primaryTime: string | null;
  /** Canonical measure column for aggregate (null → aggregate counts rows). */
  primaryWeight: string | null;
  columns: DescribedColumn[];
  /** Column mnemonics grouped by role — a compact map for forming queries. */
  rolesSummary: Record<ColumnRole, string[]>;
}

/**
 * Describe a schema's columns with inferred roles.
 * @throws {XctraceError} empty-result if the table doesn't exist / has no rows
 *         (an empty table carries no column schema to describe).
 */
export async function describeSchema(
  sessionId: string,
  schema: string,
  run?: number
): Promise<SchemaDescription> {
  const resolvedRun = run ?? lastRun(sessionId);
  const table = await getTable(sessionId, resolvedRun, schema);

  const classified = classifyWithHints(schema, table.cols);
  const hint = hintFor(schema);

  const columns: DescribedColumn[] = classified.map((c) => ({
    mnemonic: c.mnemonic,
    name: c.name,
    engineeringType: c.engineeringType,
    role: c.roleInfo.role,
    ...(c.roleInfo.unit ? { unit: c.roleInfo.unit } : {}),
    confidence: c.roleInfo.confidence,
    source: c.roleInfo.source,
  }));

  // primaryTime / primaryWeight: pinned hint wins, else first column of that role.
  const primaryTime =
    hint?.primaryTime ?? firstWithRole(classified, "time")?.mnemonic ?? null;
  const primaryWeight =
    hint?.primaryWeight ?? firstWithRole(classified, "weight")?.mnemonic ?? null;

  // Group mnemonics by role for a compact at-a-glance map.
  const rolesSummary: Record<ColumnRole, string[]> = {
    time: [], weight: [], backtrace: [], thread: [], label: [], detail: [],
  };
  for (const c of classified) rolesSummary[c.roleInfo.role].push(c.mnemonic);

  const docEntry = findOne(getSchemaModel(sessionId), resolvedRun, schema);

  return {
    schema,
    run: resolvedRun,
    instrument: hint?.instrument ?? schema,
    pinned: hint !== undefined,
    documentation: docEntry?.toc.documentation ?? null,
    rowCount: table.rows.length,
    primaryTime,
    primaryWeight,
    columns,
    rolesSummary,
  };
}
