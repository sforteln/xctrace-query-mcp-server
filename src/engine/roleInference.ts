/**
 * Column-role classifier.
 *
 * Classifies each column into one of a small set of ROLES so the universal
 * verbs (query, aggregate, callTree, getRow) can work on any instrument
 * without per-schema code:
 *
 *   time      — a start/timestamp (the x-axis; used for timeRange windows)
 *   weight    — a measure to aggregate (ns, bytes, count, cycles) — what
 *               "top N by weight" sums; the workhorse signal
 *   backtrace — a stack id that resolves to frames (getRow / callTree)
 *   thread    — a who-dimension: thread / process / core / tid / pid
 *   label     — a what-dimension: name / category / type / state / concept
 *   detail    — everything else (verbose content, ids, opaque blobs) — the
 *               safe default so an unrecognised column is never mis-tagged
 *
 * Classification is layered by confidence:
 *   1. engineering-type   (high)   — the declared xctrace type, most reliable
 *   2. mnemonic heuristic (medium) — name patterns for generic string/uint64
 *   3. default → detail   (low)    — never guess a structural role
 *
 * This is the heuristic layer. Hard-coded per-instrument role hints for the
 * top ~6 instruments (which override these heuristics) are added in the next
 * prompt; this classifier is the fallback that guarantees coverage for
 * instruments we haven't special-cased — including ones Apple ships later.
 */
import type { SchemaCol } from "./parseTable.js";

export type ColumnRole = "time" | "weight" | "backtrace" | "thread" | "label" | "detail";

/** Unit hint for weight columns — lets aggregate format/label measures sensibly. */
export type WeightUnit = "nanoseconds" | "bytes" | "count" | "cycles" | "unknown";

export type RoleSource = "override" | "engineering-type" | "mnemonic" | "default";

export interface RoleInfo {
  role: ColumnRole;
  /** Present only when role is "weight". */
  unit?: WeightUnit;
  confidence: "high" | "medium" | "low";
  source: RoleSource;
}

/** A schema column annotated with its inferred role. */
export interface ClassifiedColumn extends SchemaCol {
  roleInfo: RoleInfo;
}

// ─── Engineering-type → role (high confidence) ────────────────────────────────
// The declared xctrace engineering-type is the most reliable signal. Keys are
// matched case-insensitively against the exact engineering-type string.

interface TypeRule {
  role: ColumnRole;
  unit?: WeightUnit;
}

const ENGINEERING_TYPE_ROLES: Record<string, TypeRule> = {
  // time
  "start-time": { role: "time" },
  "sample-time": { role: "time" },
  "event-time": { role: "time" },
  "timestamp": { role: "time" },
  "mach-timestamp": { role: "time" },

  // weight (measures) — carry a unit
  "duration": { role: "weight", unit: "nanoseconds" },
  "network-size-in-bytes": { role: "weight", unit: "bytes" },
  "size-in-bytes": { role: "weight", unit: "bytes" },
  "byte-count": { role: "weight", unit: "bytes" },
  "event-count": { role: "weight", unit: "count" },
  "cycle-count": { role: "weight", unit: "cycles" },

  // backtrace
  "kperf-bt": { role: "backtrace" },
  "text-backtrace": { role: "backtrace" },
  "backtrace": { role: "backtrace" },

  // thread / process / core (who)
  "thread": { role: "thread" },
  "tid": { role: "thread" },
  "pid": { role: "thread" },
  "process": { role: "thread" },
  "core": { role: "thread" },

  // label / category (what)
  "event-concept": { role: "label" },
  "time-sample-kind": { role: "label" },
  "thread-state": { role: "label" },
  "event-type": { role: "label" },
  // cfrunloop-result: Apple documents a 5-value enum ("Finished", "Timed Out",
  // …) — a groupable end-reason category, not opaque detail (Engineering Type
  // Reference audit, typeAudit/A mismatch #1).
  "cfrunloop-result": { role: "label" },
  // domain-name: a hostname — the canonical groupable identity on network
  // schemas; heuristics landed it on detail (typeAudit/A, shipping-wrong case).
  "domain-name": { role: "label" },
  "signpost-name": { role: "label" },
  "subsystem": { role: "label" },
  "category": { role: "label" },
  "network-protocol": { role: "label" },
  "network-interface": { role: "label" },
  "thread-name": { role: "label" },
  "process-name": { role: "label" },
  "formatted-label": { role: "label" },
  "sockaddr": { role: "label" },

  // detail — explicitly opaque/verbose/flag types
  "os-signpost-identifier": { role: "detail" },
  "packed-identifier": { role: "detail" },
  "os-log-metadata": { role: "detail" },
  "return-location": { role: "detail" },
  "format-string": { role: "detail" },
  "narrative": { role: "detail" },
  // A boolean is a flag, never a structural role — pin it to detail so generic
  // mnemonic heuristics (e.g. "main-thread" matching /thread/) can't mis-tag it.
  "boolean": { role: "detail" },
};

// ─── Mnemonic heuristics (medium confidence) ──────────────────────────────────
// Applied only when the engineering-type is generic (string / uint64 / etc.) and
// didn't resolve to a role. Ordered by priority — weight before thread before
// time before backtrace before label — so the most specific signal wins.

interface MnemonicRule {
  test: RegExp;
  role: ColumnRole;
  unit?: WeightUnit;
}

const MNEMONIC_RULES: MnemonicRule[] = [
  // weight: counts/sizes/measures expressed as generic strings or ints
  { test: /token/i, role: "weight", unit: "count" },
  { test: /(^|[-_])count$/i, role: "weight", unit: "count" },
  { test: /samples?$/i, role: "weight", unit: "count" },
  { test: /bytes?$/i, role: "weight", unit: "bytes" },
  { test: /size$/i, role: "weight", unit: "bytes" },
  { test: /memory|rss|footprint/i, role: "weight", unit: "bytes" },
  { test: /cycles?$/i, role: "weight", unit: "cycles" },
  { test: /duration|elapsed|latency|rtt|round-trip/i, role: "weight", unit: "nanoseconds" },

  // backtrace
  { test: /callstack|backtrace|(^|[-_])stack$|frames?$/i, role: "backtrace" },

  // thread / process / core
  { test: /thread|process|(^|[-_])core($|[-_])|(^|[-_])cpu($|[-_])|(^|[-_])tid$|(^|[-_])pid$/i, role: "thread" },

  // time
  { test: /^time$|timestamp|^start($|-)|^end($|-)/i, role: "time" },

  // label / category
  { test: /name$|label|category|(^|[-_])type$|(^|[-_])kind$|state$|color$|concept|status|protocol|interface/i, role: "label" },
];

// IDs are detail even though they may contain label-ish substrings — match these
// first so e.g. "model-request-id" / "connection-serial" don't become labels.
const ID_RULE = /(^|[-_])id$|(^|[-_])uuid$|serial$|identifier$|(^|[-_])index$/i;

// ─── Classification ───────────────────────────────────────────────────────────

/**
 * Classify a single column into a role using engineering-type first, then
 * mnemonic heuristics, defaulting to `detail`.
 */
export function classifyColumn(col: SchemaCol): RoleInfo {
  const et = col.engineeringType.toLowerCase().trim();

  // 1. Engineering-type — highest confidence.
  const typeRule = ENGINEERING_TYPE_ROLES[et];
  if (typeRule) {
    return {
      role: typeRule.role,
      ...(typeRule.unit ? { unit: typeRule.unit } : {}),
      confidence: "high",
      source: "engineering-type",
    };
  }

  // 2. Mnemonic heuristics — only for generic/unknown engineering-types.
  const mnemonic = col.mnemonic.toLowerCase();

  // IDs are detail regardless of label-ish substrings.
  if (ID_RULE.test(mnemonic)) {
    return { role: "detail", confidence: "medium", source: "mnemonic" };
  }

  for (const rule of MNEMONIC_RULES) {
    if (rule.test.test(mnemonic)) {
      return {
        role: rule.role,
        ...(rule.unit ? { unit: rule.unit } : {}),
        confidence: "medium",
        source: "mnemonic",
      };
    }
  }

  // 3. Default — never guess a structural role.
  return { role: "detail", confidence: "low", source: "default" };
}

/** Classify every column in a schema, returning the columns with roles attached. */
export function classifyColumns(cols: SchemaCol[]): ClassifiedColumn[] {
  return cols.map((col) => ({ ...col, roleInfo: classifyColumn(col) }));
}

/** Convenience: the first column with a given role, or undefined. */
export function firstWithRole(
  cols: ClassifiedColumn[],
  role: ColumnRole
): ClassifiedColumn | undefined {
  return cols.find((c) => c.roleInfo.role === role);
}

/** Convenience: all columns with a given role. */
export function allWithRole(
  cols: ClassifiedColumn[],
  role: ColumnRole
): ClassifiedColumn[] {
  return cols.filter((c) => c.roleInfo.role === role);
}

/**
 * The "thread" role deliberately buckets six different "who" mnemonics
 * together (thread, tid, pid, process, core, cpu — see the classifier rules
 * above), because they're all candidate join/grouping keys, but they are NOT
 * interchangeable: a thread lives inside exactly one process (containment is
 * definitional, true for any schema, not something to verify per-instrument),
 * so "same thread" is always a strictly stronger match than "same process".
 * core/cpu are a different dimension entirely (a hardware execution unit,
 * not a stable identity — work migrates across cores constantly), not a
 * finer-grained "who" than process, so they're excluded from consideration
 * here rather than ranked.
 *
 * Use this instead of firstWithRole(cols, "thread") / allWithRole(cols,
 * "thread")[0] wherever "the" thread column matters for correctness (e.g.
 * matching two rows as "same execution context") — firstWithRole just
 * returns whichever candidate appears first in column order, which silently
 * picks the wrong one when a schema carries both a process and a thread
 * column (confirmed on swiftui-update-groups).
 */
export function preferredThreadColumn(cols: ClassifiedColumn[]): ClassifiedColumn | undefined {
  // Exclude by ENGINEERING TYPE as well as mnemonic: the real core column in
  // live schemas is mnemonic "core-index" (engineering-type "core"), which the
  // mnemonic-only exclusion silently missed — the safety valve never fired
  // (Engineering Type Reference audit, typeAudit/A cross-cutting bug #1).
  const candidates = allWithRole(cols, "thread").filter(
    (c) => c.mnemonic !== "core" && c.mnemonic !== "cpu" && c.engineeringType !== "core"
  );
  if (candidates.length === 0) return undefined;
  for (const preferred of ["thread", "tid"]) {
    const match = candidates.find((c) => c.mnemonic === preferred);
    if (match) return match;
  }
  for (const fallback of ["process", "pid"]) {
    const match = candidates.find((c) => c.mnemonic === fallback);
    if (match) return match;
  }
  return candidates[0];
}
