/**
 * Xcode version tracking (PMT:hollow-crystal).
 *
 * This project has only ever been verified against ONE Xcode build.
 * detectXcodeVersion() (xcodeVersion.ts) still runs so we know what the
 * client actually has — this file's only job is a flat "is that a version
 * we've confirmed works" check. It used to be a full adaptive multi-version
 * rules-resolution system (per-schema rules-version lookup + nearest-version
 * fallback + a "verified"/"nearest" confidence signal on every list_instruments
 * schema entry) — that was removed after it turned out to be built for a
 * future with many tracked versions but only ever had one real entry
 * (VERSION_BASE = {"27.0": "27.0"}, VERSION_SCHEMA_OVERRIDES always empty).
 *
 * Granularity is the SHORT version string (e.g. "27.0", what
 * detectXcodeVersion() actually returns) — not build/beta-level (e.g. not the
 * finer "25183.45.9" build number). Deliberate: trace schema formats aren't
 * expected to change often within one short version, and re-verifying against
 * every beta/point release isn't worth the ongoing maintenance cost.
 *
 * Adding a newly-confirmed Xcode version: append it to
 * CONFIRMED_WORKING_VERSIONS below once you've actually run the test suite
 * against it — this is a manual, deliberate confirmation, not automatic.
 */

/** Xcode short versions (CFBundleShortVersionString) confirmed to work end-to-end. */
export const CONFIRMED_WORKING_VERSIONS: string[] = ["27.0"];

export interface VersionWarning {
  detectedVersion: string;
  confirmedVersions: string[];
  message: string;
}

/**
 * Build a VersionWarning for open_trace when the detected Xcode version isn't
 * in CONFIRMED_WORKING_VERSIONS. Returns null for a confirmed version — no
 * warning needed. A null xcodeVersion (detection failed) also produces one.
 */
export function buildVersionWarning(xcodeVersion: string | null): VersionWarning | null {
  if (xcodeVersion !== null && CONFIRMED_WORKING_VERSIONS.includes(xcodeVersion)) {
    return null;
  }
  const detected = xcodeVersion ?? "unknown";
  const message = xcodeVersion
    ? `Xcode ${xcodeVersion} has not been confirmed working — this has only been tested against: ${CONFIRMED_WORKING_VERSIONS.join(", ")}. Results may differ.`
    : `Xcode version could not be detected — this has only been tested against: ${CONFIRMED_WORKING_VERSIONS.join(", ")}. Results may differ.`;
  return { detectedVersion: detected, confirmedVersions: CONFIRMED_WORKING_VERSIONS, message };
}

/**
 * Schema names with a committed regression fixture under tests/fixtures/xcode-27.0/.
 * Used only as a reference set for driftGuard's "is this a real, known schema
 * name" check — NOT part of any runtime version-resolution behavior (that
 * system is gone; this is just the plain list of names, decoupled from any
 * version key it used to be paired with).
 */
export const FIXTURED_SCHEMAS = new Set<string>([
  // ── schema-table ──────────────────────────────────────────────
  "core-data-fault",
  "core-data-fetch",
  "core-data-relationship-fault",
  "core-data-save",
  "detected-fs-antipattern",
  "display-surface-swap",
  "displayed-surfaces-interval",
  "FMEventTable",
  "fs-syscall",
  "hang-risks",
  "hitches",
  "hitches-renders",
  "InstructionsTable",
  "ModelInferenceTable",
  "ModelLoadingTable",
  "network-connection-detected",
  "network-connection-update",
  "NetworkConnectionStats",
  "potential-hangs",
  "RequestTable",
  "runloop-events",
  "runloop-intervals",
  "SessionTable",
  "SwiftTaskLifetime",
  "SwiftTasksInfoTable",
  "SwiftTaskStateTable",
  "swiftui-causes",
  "swiftui-changes",
  "swiftui-full-causes",
  "swiftui-layout-updates",
  "swiftui-update-groups",
  "swiftui-updates",
  "SwiftUIFilteredUpdates",
  "SwiftUILayoutUpdates2",
  "time-sample",
  "ToolTable",
  // ── track-detail ──────────────────────────────────────────────
  "Allocations/Allocations List",
  "Leaks/Leaks",
  "VM Tracker/Regions Map",
]);
