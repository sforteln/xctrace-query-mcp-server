/**
 * Dot-path field references — the AI-facing complement to this codebase's
 * nested-column promotion.
 *
 * Promotion made nested values queryable by promoting them to real SQL columns
 * (thread.process.pid -> physical column thread__process__pid). This layer lets
 * an agent REACH them by a clean dot-path ("thread.process.pid") without ever
 * seeing the physical "__" column names, and — critically — collapses provably
 * ref-identical duplicate paths (thread-info's thread.process.pid AND
 * name.thread.process.pid are the same value, same XML ref) to ONE canonical
 * path, so an agent is never handed two equally-valid ways to name one value.
 *
 * The identity is a recorded FACT from ingestion (ColumnIdentityTracker's
 * object-identity observation, persisted to column_identity), not a runtime
 * re-inference from lossy leftovers — see howSessionsWork.md's "Nested fields
 * are addressable by dot-path" note for how that observation is made.
 *
 * Physical naming makes resolution mostly mechanical: a dot-path a.b.c maps to
 * base column a__b__c, and sqlHydrate's fmtCol/rawCol already append __fmt / use
 * the base directly. So this module's real jobs are VALIDATION (reject an
 * unknown path with an actionable error listing the real ones) and
 * CANONICALIZATION (route every ref to its group's canonical column).
 *
 * Scope: dot-paths address nested SCALAR leaves only. A compound intermediate
 * (thread.process as a whole) isn't a filter field — the error for one guides
 * to its scalar children. Top-level mnemonics resolve exactly as before
 * (including compound ones, filterable by their summary), so this is purely
 * additive to the existing DSL.
 */
import type { DatabaseSync } from "node:sqlite";
import type { SchemaCol } from "./parseTable.js";
import { isBacktraceCol, loadPromotedColumns, loadColumnIdentity } from "./sqliteStore.js";

export interface ResolvedField {
  /** The original caller reference (mnemonic or dot-path), for error/echo purposes. */
  ref: string;
  /** Physical base column name to build raw/fmt clauses against (already canonicalized). */
  base: string;
  /** True for a backtrace-typed top-level column — has no comparable raw/fmt value. */
  isBacktrace: boolean;
  /** True when the ref was a nested dot-path rather than a plain top-level mnemonic. */
  isNested: boolean;
}

/** A canonical filterable/groupable field for describe_schema surfacing. */
export interface FieldListing {
  /** Dot-path (mnemonic, or mnemonic.child.grandchild) an agent can pass as a col/groupBy/filter key. */
  path: string;
  /** True for nested (promoted) paths — helps an agent see the flat vs nested split at a glance. */
  nested: boolean;
}

export class FieldResolver {
  private readonly colByMnemonic: Map<string, SchemaCol>;
  /** dot-path -> physical base column, for nested scalar fields. */
  private readonly baseByDotpath: Map<string, string>;
  /** base column -> canonical base column (only present for non-canonical duplicates). */
  private readonly canonicalByBase: Map<string, string>;

  constructor(cols: SchemaCol[], promoted: Array<{ dotpath: string; base: string }>, identity: Map<string, string>) {
    this.colByMnemonic = new Map(cols.map((c) => [c.mnemonic, c]));
    this.baseByDotpath = new Map(promoted.map((p) => [p.dotpath, p.base]));
    this.canonicalByBase = identity;
  }

  private canonical(base: string): string {
    return this.canonicalByBase.get(base) ?? base;
  }

  /**
   * Resolve a caller field reference (top-level mnemonic OR nested dot-path) to
   * its physical base column. Throws an actionable error for an unknown path,
   * listing the real canonical fields (failure-as-onboarding — the same
   * structured-miss principle the discovery layer uses).
   */
  resolve(ref: string): ResolvedField {
    if (!ref.includes(".")) {
      const col = this.colByMnemonic.get(ref);
      if (!col) {
        throw new Error(
          `Unknown field "${ref}". Available fields: ${this.listFieldPaths().join(", ")}.`
        );
      }
      return { ref, base: this.canonical(ref), isBacktrace: isBacktraceCol(col), isNested: false };
    }

    const base = this.baseByDotpath.get(ref);
    if (base === undefined) {
      const mnemonic = ref.slice(0, ref.indexOf("."));
      const underMnemonic = [...this.baseByDotpath.keys()].filter(
        (p) => p.startsWith(`${mnemonic}.`) && this.canonicalByBase.get(this.baseByDotpath.get(p)!) === undefined
      );
      const hint =
        underMnemonic.length > 0
          ? `Nested fields under "${mnemonic}": ${underMnemonic.join(", ")}.`
          : this.colByMnemonic.has(mnemonic)
            ? `"${mnemonic}" has no queryable nested scalar fields (it may be a compound with only a summary value, or a leaf).`
            : `"${mnemonic}" is not a column in this schema.`;
      throw new Error(`Unknown nested field "${ref}". ${hint}`);
    }
    return { ref, base: this.canonical(base), isBacktrace: false, isNested: true };
  }

  /**
   * The declared engineering-type of a TOP-LEVEL mnemonic, or undefined for
   * nested dot-paths (promoted children carry no declared type) and unknown
   * refs. Used by sentinel-aware consumers (find's is-sentinel/not-sentinel);
   * an undefined here means "no type claim", never "no sentinel".
   */
  engineeringTypeOf(ref: string): string | undefined {
    if (ref.includes(".")) return undefined;
    return this.colByMnemonic.get(ref)?.engineeringType;
  }

  /** Resolve, or null if the ref is unknown — for display-column filtering, which drops unknowns silently (matching the old columns.filter behavior). */
  tryResolve(ref: string): ResolvedField | null {
    try {
      return this.resolve(ref);
    } catch {
      return null;
    }
  }

  /**
   * Guard used before building any WHERE/GROUP BY/ORDER BY clause — a backtrace
   * column has no comparable value (only a frames FK), so referencing one there
   * is a clear error, never a raw SQL crash or a silent no-op (mirrors the old
   * assertNotBacktraceMnemonic; nested dot-paths are never backtrace).
   */
  resolveComparable(ref: string, context: string): ResolvedField {
    const field = this.resolve(ref);
    if (field.isBacktrace) {
      throw new Error(
        `"${ref}" is a backtrace column — it has no comparable display/raw value to ${context}. ` +
        `Use get_row to inspect it, or call_tree for cross-row backtrace analysis.`
      );
    }
    return field;
  }

  /** Canonical field paths an agent may filter/group/sort by — top-level columns plus canonical nested scalars. */
  listFields(): FieldListing[] {
    const fields: FieldListing[] = [];
    for (const [mnemonic, col] of this.colByMnemonic) {
      if (!isBacktraceCol(col)) fields.push({ path: mnemonic, nested: false });
    }
    for (const [dotpath, base] of this.baseByDotpath) {
      // Hide any nested path that is a non-canonical duplicate — only its
      // canonical representative (top-level column or shorter path) is offered.
      if (this.canonicalByBase.get(base) === undefined) fields.push({ path: dotpath, nested: true });
    }
    return fields;
  }

  private listFieldPaths(): string[] {
    return this.listFields().map((f) => f.path);
  }
}

/** Build a resolver for one ingested (run,schema) table — reads the promoted_column/column_identity metadata this file's header describes, persisted at ingestion. */
export function buildFieldResolver(db: DatabaseSync, tableName: string, cols: SchemaCol[]): FieldResolver {
  return new FieldResolver(cols, loadPromotedColumns(db, tableName), loadColumnIdentity(db, tableName));
}
