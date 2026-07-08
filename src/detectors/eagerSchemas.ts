/**
 * PMT:ruddy-elk — schema-kind classifier + the curated eager-ingest allowlist.
 *
 * There is NO cheap schema-size probe (verified empirically): no xctrace
 * count flag; `--toc` carries zero row counts (`<table schema="hitches"/>`);
 * XPath `count()` silently fails (xctrace's XPath is a restricted
 * element-selection subset, no functions); on-disk bundle stores are opaque
 * `indexed-store-N` IDs, not schema-keyed; and a full export of a 4-row
 * schema still costs ~5.5s fixed overhead (vs ~34s for 495k rows) — probing
 * costs the SAME as ingesting. So the eager set can't be derived from a live
 * size check; it has to be a curated, VERIFIED allowlist keyed on schema
 * NAME, and a not-yet-ingested schema's inventory size is a categorical KIND
 * tier — the PRIMARY mechanism, not a fallback.
 */

/** A schema's kind — bounded-by-nature (diagnosed/metadata) is eager-safe;
 *  everything else (interval/sample/firehose) is never eager, regardless of
 *  how small it happens to look in one particular trace. "unknown" is the
 *  conservative default for anything not curated below. */
export type SchemaKind = "diagnosed" | "metadata" | "interval" | "sample" | "firehose" | "unknown";

interface SchemaKindEntry {
  kind: SchemaKind;
  /** How this kind was established — a live row count, or the general shape
   *  ("per-sample firehose"). Not surfaced to the AI; documents provenance. */
  note?: string;
}

/**
 * Curated map: schema name -> kind. Only schemas with a VERIFIED shape (a
 * real row count from a real trace, or an unambiguous "per-X firehose"
 * category) are listed — an unlisted schema falls back to "unknown" rather
 * than a guess (see schemaKind()).
 */
const SCHEMA_KINDS: Record<string, SchemaKindEntry> = {
  // ── Bounded-by-nature (diagnosed/metadata) — eager-safe ──────────────────────
  hitches: { kind: "diagnosed", note: "29-801 rows verified live across multiple traces" },
  "hitches-renders": { kind: "interval", note: "1,560 rows verified live" },
  "device-display-info": { kind: "metadata", note: "1 row verified live — per-connected-display metadata" },
  "displayed-surfaces-interval": { kind: "interval", note: "1,629 rows verified live" },
  "hang-risks": { kind: "diagnosed" },
  "potential-hangs": { kind: "diagnosed" },

  // ── Firehoses — NEVER eager, regardless of what any single trace looks like ──
  "time-sample": { kind: "firehose" },
  "time-profile": { kind: "firehose" },
  "runloop-events": { kind: "firehose" },
  "runloop-intervals": { kind: "firehose" },
  "swiftui-updates": { kind: "firehose", note: "~893k rows observed" },
  ThreadActivity: { kind: "firehose" },
  Allocations: { kind: "firehose" },
  "Allocations List": { kind: "firehose" },
  "display-vsyncs-interval": { kind: "firehose", note: "per-vsync-tick log — thousands+ rows" },
  "cpu-profile": { kind: "firehose" },
  syscall: { kind: "firehose" },
  kdebug: { kind: "firehose" },
  "context-switch": { kind: "firehose" },
  "thread-state": { kind: "firehose" },
};

/** Classify a schema's kind. Unlisted -> "unknown" (conservative — never
 *  assumed bounded just because it's absent from the curated map). */
export function schemaKind(schema: string): SchemaKind {
  return SCHEMA_KINDS[schema]?.kind ?? "unknown";
}

const BOUNDED_KINDS: ReadonlySet<SchemaKind> = new Set(["diagnosed", "metadata"]);

/** True only for a schema whose KIND is bounded-by-nature (diagnosed/
 *  metadata) — never for interval/sample/firehose/unknown, which may be
 *  arbitrarily large even when a single trace happens to show a small count. */
export function isBoundedKind(schema: string): boolean {
  return BOUNDED_KINDS.has(schemaKind(schema));
}

/**
 * The schemas actually eager-ingested at open_trace / stop_recording.
 *
 * hitches / hitches-renders: required by the hitch detectors (animation-
 * hitches-distribution, outlier-sweep, near-miss-sweep all need hitches;
 * render-hitch-sweep needs hitches-renders).
 *
 * device-display-info: not a detector requirement but a CONTEXT dependency —
 * frameBudget.ts's resolveFrameBudgetMs() reads it (PMT:still-hail) so the
 * hitch detectors threshold against the REAL per-display refresh rate
 * instead of assuming 60Hz. Eager-ingesting it makes the hitch detectors
 * device-accurate on the very first sweep (validated live against a 120Hz
 * iPhone trace).
 *
 * Deliberately NOT included — CANDIDATES pending row-shape verification:
 * ModelInferenceTable and SwiftActorQueueSize (the FM/concurrency cheap
 * detectors' own schemas). Adding an unverified schema here would repeat the
 * GCD-Performance mistake in the other direction (assumed signal-less,
 * wasn't — here: assumed bounded, might not be). Verify their real row
 * counts on a live trace before promoting them into this list.
 */
export const EAGER_ALLOWLIST: readonly string[] = ["hitches", "hitches-renders", "device-display-info"];

/**
 * Worst-case latency cap. Each eager ingest costs ~5.5s fixed overhead
 * (verified — even a 4-row export pays this), so a cap of 4 bounds
 * stop_recording's added latency to ~22s. Simon explicitly OK'd ~25s: "25s
 * to get some initial context that can help give the AI direction, even if
 * that direction is 'no big hangs' — I'm for it."
 */
export const EAGER_SCHEMA_MAX = 4;

/**
 * Priority order when more allowlisted schemas are present than the cap
 * allows — hitches and device-display-info first (the pair that makes the
 * hitch detectors both FIRE and be device-accurate); anything bumped past
 * the cap is reported "present, not auto-scanned" in the inventory, never
 * silently dropped.
 */
const EAGER_PRIORITY: readonly string[] = ["hitches", "device-display-info", "hitches-renders"];

function priorityIndex(schema: string): number {
  const i = EAGER_PRIORITY.indexOf(schema);
  return i === -1 ? EAGER_PRIORITY.length : i;
}

/**
 * eager set = present ∩ allowlist, ordered by priority, capped. `allowlist`
 * and `cap` default to the real constants above — parameterized only so
 * tests can exercise the capping/ordering logic in isolation without
 * depending on EAGER_ALLOWLIST happening to be longer than EAGER_SCHEMA_MAX.
 */
export function selectEagerSchemas(
  presentSchemas: readonly string[],
  allowlist: readonly string[] = EAGER_ALLOWLIST,
  cap: number = EAGER_SCHEMA_MAX
): string[] {
  const present = new Set(presentSchemas);
  const allowed = allowlist.filter((s) => present.has(s));
  const ordered = [...allowed].sort((a, b) => priorityIndex(a) - priorityIndex(b));
  return ordered.slice(0, cap);
}

/** Human-readable descriptor for a kind — used both for the inventory's
 *  "~estimate (…)" label and its "present, not auto-scanned (…)" note. */
export function kindDescriptor(kind: SchemaKind): string {
  switch (kind) {
    case "diagnosed":
      return "diagnosed events — bounded";
    case "metadata":
      return "metadata — bounded";
    case "interval":
      return "interval series — size varies";
    case "sample":
      return "large — per-sample firehose";
    case "firehose":
      return "large — firehose";
    case "unknown":
      return "unknown kind";
  }
}
