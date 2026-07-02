/**
 * describeSchema — the first universal verb that exposes inferred column roles.
 *
 * Given a schema (and optional run, defaulting to the most recent), it reads
 * column shape + a row count ONLY (never materializes row data — see
 * getSchemaMeta), classifies every column via the override→heuristic
 * pipeline, and returns a description rich enough that an agent can form a
 * query or aggregate call without any further schema knowledge: each
 * column's role, the canonical primaryTime / primaryWeight to target, and a
 * by-role grouping of column mnemonics.
 */
import { getSchemaMeta, lastRun, getSchemaModel } from "../engine/session.js";
import { findOne, findSchemaTableEntries } from "../engine/schemaModel.js";
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
  run?: number,
  position?: number
): Promise<SchemaDescription> {
  const resolvedRun = run ?? lastRun(sessionId);
  // Never materializes row data — describeSchema only ever needs column
  // shape + a count, so this avoids forcing a full parse+cache of a huge
  // table (e.g. swiftui-updates at 700K+ rows) just to answer "what columns
  // does this have," which was a contributing factor to a real OOM crash
  // during live testing. See PMT:copper-duck.
  const meta = await getSchemaMeta(sessionId, resolvedRun, schema, position);

  const classified = classifyWithHints(schema, meta.cols);
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

  // When the schema has multiple TOC instances, pick the one matching the
  // resolved position (getSchemaMeta already rejected an ambiguous fetch with
  // no position) rather than findOne's first-match, so documentation/TOC
  // metadata reflects the instance actually fetched.
  const model = getSchemaModel(sessionId);
  const docEntry =
    position !== undefined
      ? findSchemaTableEntries(model, resolvedRun, schema)[position - 1]
      : findOne(model, resolvedRun, schema);

  return {
    schema,
    run: resolvedRun,
    instrument: hint?.instrument ?? schema,
    pinned: hint !== undefined,
    documentation: docEntry?.toc.documentation ?? null,
    rowCount: meta.rowCount,
    primaryTime,
    primaryWeight,
    columns,
    rolesSummary,
  };
}
