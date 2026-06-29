/**
 * Xcode version → schema rules resolution.
 *
 * VERSION_BASE maps each known Xcode version to the rules-version it uses by
 * default. A version listed here will not trigger a versionWarning.
 *
 * VERSION_SCHEMA_OVERRIDES handles the case where one schema changed between
 * Xcode releases while everything else stayed the same — only the affected
 * schema gets a new rules-version; all others inherit from VERSION_BASE.
 *
 * resolveRules(xcodeVersion, schema) is the single resolution path shared by
 * the parser, the version warning layer (PMT:coal-stag), and list_instruments
 * annotations. It returns { rulesVersion, confidence } where:
 *   "verified" — the (rulesVersion, schema) pair has a fixture in tests/fixtures/
 *   "nearest"  — we fell back to a close-but-unverified version
 *
 * Adding a new Xcode version:
 *   1. Add an entry to VERSION_BASE.
 *   2. Add any per-schema overrides to VERSION_SCHEMA_OVERRIDES.
 *   3. Export fixtures, add to tests/fixtures/<rulesVersion>/, baseline snapshots.
 *   4. Add the new (rulesVersion, schema) pairs to VERIFIED_PAIRS below.
 * See Update_for_your_version_and_submit_a_PR.md for the full workflow.
 */

// ─── Version tables ───────────────────────────────────────────────────────────

/**
 * Maps each known Xcode version to its default rules-version.
 * Minor versions that changed nothing can point at their parent:
 *   "27.1": "27.0"  // inherits 27.0 for all schemas unless overridden
 */
export const VERSION_BASE: Record<string, string> = {
  "27.0": "27.0",
};

/**
 * Per-(xcodeVersion, schema) overrides — used when one schema's format
 * changed in a release while everything else was unchanged.
 *
 * Example (not real — shown for illustration):
 *   "27.1": { "ModelInferenceTable": "27.1" }
 */
export const VERSION_SCHEMA_OVERRIDES: Record<string, Record<string, string>> = {};

// ─── Coverage manifest ────────────────────────────────────────────────────────

/**
 * All (rulesVersion, schema) pairs that have a corresponding fixture XML file.
 * Key format: `${rulesVersion}:${schema}`
 *
 * Update this set whenever fixtures are added or removed.
 * Each entry corresponds to a file at:
 *   tests/fixtures/xcode-<rulesVersion>/schema-table/<schema>.xml   (schema-table)
 *   tests/fixtures/xcode-<rulesVersion>/track-detail/<encoded>.xml  (track-detail)
 */
const VERIFIED_PAIRS = new Set<string>([
  // ── xcode-27.0 schema-table ──────────────────────────────────────────────
  "27.0:core-data-fault",
  "27.0:core-data-fetch",
  "27.0:core-data-relationship-fault",
  "27.0:core-data-save",
  "27.0:FMEventTable",
  "27.0:hang-risks",
  "27.0:hitches",
  "27.0:InstructionsTable",
  "27.0:ModelInferenceTable",
  "27.0:ModelLoadingTable",
  "27.0:network-connection-detected",
  "27.0:network-connection-update",
  "27.0:NetworkConnectionStats",
  "27.0:potential-hangs",
  "27.0:RequestTable",
  "27.0:SessionTable",
  "27.0:SwiftTaskLifetime",
  "27.0:SwiftTasksInfoTable",
  "27.0:SwiftTaskStateTable",
  "27.0:time-sample",
  "27.0:ToolTable",
  // ── xcode-27.0 track-detail ──────────────────────────────────────────────
  "27.0:Allocations/Allocations-List",
  "27.0:Leaks/Leaks",
]);

// ─── Types ────────────────────────────────────────────────────────────────────

export type RulesConfidence = "verified" | "nearest";

export interface ResolvedRules {
  /** The rules-version that governs parsing for this (xcodeVersion, schema). */
  rulesVersion: string;
  /**
   * "verified" — this exact (rulesVersion, schema) has a fixture and is known good.
   * "nearest"  — we fell back to an adjacent version; behaviour may differ.
   */
  confidence: RulesConfidence;
}

// ─── Resolution ───────────────────────────────────────────────────────────────

/**
 * Resolve the rules-version and confidence for a (xcodeVersion, schema) pair.
 *
 * Resolution order:
 *   1. VERSION_SCHEMA_OVERRIDES[xcodeVersion][schema]
 *   2. VERSION_BASE[xcodeVersion]
 *   3. Nearest known version (numeric distance), confidence → "nearest"
 *
 * Passing an empty/null xcodeVersion triggers the nearest-version fallback,
 * which returns "nearest" confidence for every schema.
 */
export function resolveRules(xcodeVersion: string, schema: string): ResolvedRules {
  // 1. Per-schema override for this exact version
  const schemaOverride = VERSION_SCHEMA_OVERRIDES[xcodeVersion]?.[schema];
  if (schemaOverride !== undefined) {
    return {
      rulesVersion: schemaOverride,
      confidence: VERIFIED_PAIRS.has(`${schemaOverride}:${schema}`)
        ? "verified"
        : "nearest",
    };
  }

  // 2. Exact base version match
  const base = VERSION_BASE[xcodeVersion];
  if (base !== undefined) {
    return {
      rulesVersion: base,
      confidence: VERIFIED_PAIRS.has(`${base}:${schema}`) ? "verified" : "nearest",
    };
  }

  // 3. Nearest known version fallback
  const nearest = findNearestVersion(xcodeVersion);
  return { rulesVersion: nearest, confidence: "nearest" };
}

/**
 * Find the nearest known version to xcodeVersion by numeric proximity.
 * Prefers the highest version that is ≤ xcodeVersion (slightly old is safer
 * than slightly new). If all known versions are newer, picks the lowest.
 */
function findNearestVersion(xcodeVersion: string): string {
  const known = Object.keys(VERSION_BASE);
  if (known.length === 0) return xcodeVersion;

  const target = toVersionNumber(xcodeVersion);

  const older = known
    .filter((v) => toVersionNumber(v) <= target)
    .sort((a, b) => toVersionNumber(b) - toVersionNumber(a));
  if (older.length > 0) return VERSION_BASE[older[0]];

  const newer = known.sort((a, b) => toVersionNumber(a) - toVersionNumber(b));
  return VERSION_BASE[newer[0]];
}

function toVersionNumber(v: string): number {
  const [major = 0, minor = 0] = v.split(".").map(Number);
  return major * 1000 + minor;
}
