/**
 * Hard-coded role hints for the top instruments.
 *
 * The heuristic classifier (roleInference.ts) covers any schema, but for the
 * instruments people use most we pin roles deterministically so they never
 * depend on heuristic drift — and so we can:
 *   - give each schema a friendly instrument name (heuristics can't infer this),
 *   - correct the handful of columns heuristics get wrong (e.g. asset-id is a
 *     groupable model name → label, not an id → detail; scope is a begin/end
 *     category → label, not opaque → detail),
 *   - mark the canonical primaryTime / primaryWeight columns that the universal
 *     verbs (query timeRange, aggregate measure) default to.
 *
 * classifyWithHints(schema, cols) is the entry point the schema model and
 * describeSchema use: it applies a pinned schema's full column map when present,
 * and falls back to classifyColumn() for every other schema and any column a
 * pinned schema doesn't list.
 *
 * Column maps below were built from real exported schemas in the trace fixtures
 * (~/Documents/traces). Allocations/Leaks use the track-detail format
 * (src/engine/parseTrackDetail.ts) and are pinned under their synthesized schema
 * names ("Allocations/Statistics", "Allocations/Allocations List", "Leaks/Leaks").
 */
import type { SchemaCol } from "./parseTable.js";
import {
  classifyColumn,
  ClassifiedColumn,
  ColumnRole,
  RoleInfo,
  WeightUnit,
} from "./roleInference.js";

/** A single pinned column role (role + optional weight unit). */
interface ColHint {
  role: ColumnRole;
  unit?: WeightUnit;
}

export interface SchemaHint {
  /** Friendly instrument / family name shown to the agent. */
  instrument: string;
  /** The canonical time column mnemonic (query timeRange default). */
  primaryTime?: string;
  /** The canonical measure column mnemonic (aggregate measure default). */
  primaryWeight?: string;
  /** Full per-column role map. Columns not listed fall back to heuristics. */
  columns: Record<string, ColHint>;
}

// Shorthands for terse, readable column maps.
const t: ColHint = { role: "time" };
const thread: ColHint = { role: "thread" };
const label: ColHint = { role: "label" };
const detail: ColHint = { role: "detail" };
const bt: ColHint = { role: "backtrace" };
const ns: ColHint = { role: "weight", unit: "nanoseconds" };
const count: ColHint = { role: "weight", unit: "count" };
const bytes: ColHint = { role: "weight", unit: "bytes" };

// ─── Pinned schemas ───────────────────────────────────────────────────────────

export const SCHEMA_HINTS: Record<string, SchemaHint> = {
  // ── Time Profiler ──────────────────────────────────────────────────────────
  "time-sample": {
    instrument: "Time Profiler",
    primaryTime: "time",
    // No measure column — weight is the sample COUNT per group (aggregate counts rows).
    columns: {
      time: t,
      thread: thread,
      "core-index": thread,
      "thread-state": label,
      "cp-kernel-callstack": bt,
      "cp-user-callstack": bt,
      "sample-type": label,
    },
  },
  "context-switch-sample": {
    instrument: "Time Profiler (context switches)",
    primaryTime: "time",
    columns: {
      time: t,
      thread: thread,
      "core-index": thread,
      "thread-state": label,
    },
  },

  // ── Foundation Models (flagship) ─────────────────────────────────────────────
  ModelInferenceTable: {
    instrument: "Foundation Models (inference)",
    primaryTime: "start",
    primaryWeight: "duration",
    columns: {
      start: t,
      duration: ns,
      "model-request-id": detail,
      "turn-index": detail,
      "session-index": detail,
      "plot-label": label,
      "agent-name": label,
      prompt: detail,
      response: detail,
      instruction: detail,
      instructions: detail,
      tokens: count,
      "model-information": detail,
      content: detail,
      "total-tokens": count,
      "prompt-tokens": count,
      "response-tokens": count,
      "cached-tokens": count,
      resolve: detail,
      "error-count": count,
      "error-message": detail,
      color: label,
    },
  },
  ModelLoadingTable: {
    instrument: "Foundation Models (model loading)",
    primaryTime: "start",
    primaryWeight: "duration",
    columns: {
      start: t,
      duration: ns,
      "request-id": detail,
      // asset-id is a groupable model asset name (com.apple.fm.language.*), not
      // an opaque id — heuristics would mark it detail via the id-rule.
      "asset-id": label,
      "from-state": label,
      "to-state": label,
      transition: label,
      "transition-color": label,
    },
  },
  InstructionsTable: {
    instrument: "Foundation Models (instructions)",
    // start is this row's own event time; session-start is a session-wide
    // constant repeated across every row in that session — start is the one
    // that actually varies per instruction and belongs in timeRange filtering.
    primaryTime: "start",
    primaryWeight: "duration",
    columns: {
      start: t,
      duration: ns,
      instruction: detail,
      "session-start": t,
      "session-index": detail,
      "plot-label": label,
      "synthesized-id": detail,
      "sub-synthesized-ids": detail,
    },
  },

  // ── Points of Interest / Signposts ───────────────────────────────────────────
  "os-signpost": {
    instrument: "Points of Interest (signposts)",
    primaryTime: "time",
    columns: {
      time: t,
      thread: thread,
      process: thread,
      "event-type": label,
      // scope is the begin/end/event category — heuristics default it to detail.
      scope: label,
      identifier: detail,
      name: label,
      "format-string": detail,
      backtrace: bt,
      subsystem: label,
      category: label,
      message: detail,
      "emit-location": detail,
    },
  },
  OSSignpostIntervals: {
    instrument: "Points of Interest (intervals)",
    primaryTime: "start",
    primaryWeight: "duration",
    columns: {
      start: t,
      duration: ns,
      "layout-qualifier": detail,
      name: label,
      category: label,
      subsystem: label,
      identifier: detail,
      process: thread,
      "end-process": thread,
      "start-thread": thread,
      "end-thread": thread,
      "start-message": detail,
      "end-message": detail,
      "start-backtrace": bt,
      "end-backtrace": bt,
      "start-emit-location": detail,
      "end-emit-location": detail,
      signature: detail,
    },
  },
  PointsOfInterestEvents: {
    instrument: "Points of Interest (events)",
    primaryTime: "time",
    columns: {
      time: t,
      process: thread,
      thread: thread,
      subsystem: label,
      name: label,
      message: detail,
      "emit-location": detail,
      backtrace: bt,
    },
  },

  // ── System Trace ──────────────────────────────────────────────────────────────
  "thread-info": {
    instrument: "System Trace (thread info)",
    primaryTime: "time",
    columns: {
      time: t,
      pid: thread,
      tid: thread,
      process: thread,
      thread: thread,
      name: label,
      "main-thread": detail,
    },
  },
  "process-info": {
    instrument: "System Trace (process info)",
    primaryTime: "time",
    columns: {
      time: t,
      pid: thread,
      "unique-id": detail,
      process: thread,
      "process-name": label,
    },
  },

  // ── Allocations (track-detail format) ────────────────────────────────────────
  // Synthesized schema names: "Allocations/Statistics" and "Allocations/Allocations List".
  // These live under /tracks/track/details/detail (not /data/table), parsed by
  // parseTrackDetail. Pinned here so roles are deterministic regardless of heuristics.
  "Allocations/Statistics": {
    instrument: "Allocations (statistics)",
    primaryWeight: "persistent-bytes",
    columns: {
      category: label,
      "persistent-bytes": bytes,
      "count-persistent": count,
      "total-bytes": bytes,
      "transient-bytes": bytes,
      "count-events": count,
      "count-transient": count,
      "count-total": count,
    },
  },
  "Allocations/Allocations List": {
    instrument: "Allocations (list)",
    primaryTime: "timestamp",
    primaryWeight: "size",
    columns: {
      address: detail,
      category: label,
      live: detail,
      "responsible-caller": detail,
      size: bytes,
      identifier: detail,
      "responsible-library": label,
      timestamp: t,
      "thread-id": thread,
      index: detail,
      backtrace: bt,
    },
  },

  // ── Leaks (track-detail format) ───────────────────────────────────────────────
  // Schema name: "Leaks/Leaks".
  // Leaks alone has no backtraces; use AllocAndLeaksWithBacktraces for stacks.
  "Leaks/Leaks": {
    instrument: "Leaks",
    primaryWeight: "size",
    columns: {
      "leaked-object": label,
      size: bytes,
      "responsible-frame": detail,
      count: count,
      "responsible-library": label,
      address: detail,
    },
  },

  // ── Hangs & Hitches ───────────────────────────────────────────────────────────
  // From HangsAndHitches.trace (Activity Monitor template).
  // Hitches = frame rendering delays; potential-hangs = main-thread unresponsiveness.
  "potential-hangs": {
    instrument: "Hangs",
    primaryTime: "start",
    primaryWeight: "duration",
    columns: {
      start: t,
      duration: ns,
      // hang-type classifies the unresponsiveness: "Brief Unresponsiveness" vs
      // "Potential Interaction Delay" — heuristics would mark it detail.
      "hang-type": label,
      thread: thread,
      process: thread,
    },
  },
  hitches: {
    instrument: "Hitches",
    primaryTime: "start",
    primaryWeight: "duration",
    columns: {
      start: t,
      duration: ns,
      process: thread,
      // is-system flags system-caused hitches vs. app-caused ones.
      "is-system": detail,
      // swap-id is an internal frame-swap identifier.
      "swap-id": detail,
      // label holds an address — heuristics would call it label due to the name.
      label: detail,
      // display is the display/screen identifier ("Display 1") — the SAME
      // string form display-vsyncs-interval/displayed-surfaces-interval's own
      // display-name columns carry (a direct join key across those three;
      // device-display-info's display-id is numeric and needs frameBudget.ts's
      // heuristic join instead — see PMT:still-hail).
      display: label,
      // narrative-description explains the hitch cause.
      "narrative-description": detail,
    },
  },
  // hitches-renders: per-render-pass detail behind a hitch (containment-level
  // lets a render nest inside another — offscreen passes, etc). Verified live
  // (2026-07-07T20-27-57-animation-hitches.trace, 1,560 rows): frame-color is
  // an event-concept VISUALIZATION tag ("Brown"/"Purple"/"Green" — Instruments'
  // own timeline color-coding), NOT a diagnostic signal — don't mistake it for
  // one. containment-level/offscreen-passes were both 0 for every top-level
  // (non-nested) render sampled; no buffer/pipeline-depth signal was found on
  // this schema (see frameBudget.ts's header + PMT:still-hail's completion
  // report for why the render baseline stayed a documented follow-up).
  "hitches-renders": {
    instrument: "Hitches (render detail)",
    primaryTime: "start",
    primaryWeight: "duration",
    columns: {
      start: t,
      duration: ns,
      display: label,
      "offscreen-passes": detail,
      "swap-id": detail,
      "surface-id": detail,
      // frame-color: a UI color tag (event-concept), not a severity/category signal.
      "frame-color": detail,
      "containment-level": detail,
      label: detail,
    },
  },
  // device-display-info (PMT:still-hail): per-connected-display metadata, one
  // row per display (tiny). max-refresh-rate is THE frame-budget source
  // frameBudget.ts reads (budget = 1000/rate ms) — verified live: 0 rows in
  // the still-hail authoring trace (a real, not hypothetical, "not ingested /
  // empty" case the resolver must degrade through to display-vsyncs-interval
  // or the fallback constant).
  "device-display-info": {
    instrument: "Displays",
    primaryTime: "timestamp",
    columns: {
      timestamp: t,
      "accelerator-id": detail,
      // display-id is a groupable join key (numeric), like hitches' own "display" — label, not detail.
      "display-id": label,
      // device-name is a metal-object-label (GPU/display product name), not a "Display N" string —
      // don't assume it matches hitches.display; frameBudget.ts's heuristic join uses display-id instead.
      "device-name": label,
      "framebuffer-index": detail,
      resolution: detail,
      "built-in": detail,
      // max-refresh-rate: THE frame-budget source (Hz) — see frameBudget.ts.
      "max-refresh-rate": detail,
      "is-main-display": detail,
    },
  },
  // display-vsyncs-interval (PMT:still-hail, corrected by the render-baseline
  // follow-up): per-vsync tick log (2,364 rows in the authoring trace — NOT
  // tiny; a real recording can carry many more).
  // VERIFIED LIVE, surprising: `duration` is NOT the inter-vsync interval in
  // practice — every single row carried the identical value (a 1ns sentinel
  // for the "VSync Request" marker), despite the column's declared
  // engineering-type ("duration") implying otherwise. frameBudget.ts's
  // vsync-cadence fallback therefore derives cadence from the GAP between
  // consecutive `timestamp` values, not from this column — pinned here as
  // `ns` anyway (matches the declared type/what a future trace might carry),
  // but don't rely on it for cadence without checking for variance first.
  // CORRECTION (render-baseline follow-up): still-hail's column probe missed
  // that `color` (a confusing mnemonic reused as a plain UI tag on OTHER
  // Display schemas — hitches-renders' frame-color, displayed-surfaces-
  // interval's own color) carries engineering-type "render-buffer-depth"
  // HERE, on THIS schema specifically — verified live, fmt="2" (constant)
  // across every one of the 2,364 rows in the authoring trace. This IS the
  // buffer-count signal still-hail believed didn't exist; frameBudget.ts's
  // resolveRenderBaselineMs() reads it. Similarly `event` carries engineering-
  // type "vsync-event" (constant "VSYNC" in this trace) — a plain label.
  "display-vsyncs-interval": {
    instrument: "Displays (vsync ticks)",
    primaryTime: "timestamp",
    primaryWeight: "duration",
    columns: {
      timestamp: t,
      duration: ns,
      // display-name is a "Display N" string — the SAME form hitches.display carries (direct join key).
      "display-name": label,
      // color: despite the name, engineering-type is render-buffer-depth on THIS
      // schema (verified live, fmt="2") — the swap-chain/back-buffer count
      // frameBudget.ts's resolveRenderBaselineMs() reads. A small count, not a
      // UI tag, unlike the same-named `color` column elsewhere.
      color: count,
      "event-label": detail,
      // event: engineering-type vsync-event (e.g. "VSYNC") — a plain label.
      event: label,
    },
  },
  // displayed-surfaces-interval (PMT:still-hail): one row per surface
  // presentation (1,629 rows in the authoring trace). This is the "on-screen
  // duration" side of the vsync-cadence table (vsyncCadenceTable.ts) — a
  // surface's `duration` spanning multiple vsync cadences IS the dropped-frame
  // hold the hitch made visible.
  "displayed-surfaces-interval": {
    instrument: "Displays (surface presentation)",
    primaryTime: "start",
    primaryWeight: "duration",
    columns: {
      start: t,
      duration: ns,
      "cpu-to-display-latency": ns,
      "display-name": label,
      "connection-UUID": detail,
      "surface-id": detail,
      "pixel-format": detail,
      // color: same UI visualization tag as display-vsyncs-interval.color — not a buffer-depth signal.
      color: detail,
      "event-priority": detail,
      "event-label": detail,
      category: label,
      // event-depth: Metal render-pass NESTING level (onscreen vs. offscreen
      // passes) — verified live, constant 0 for every top-level surface
      // sampled. NOT the swap-chain/back-buffer count; don't use this for the
      // render baseline's buffer-count term (see hitches-renders' note above).
      "event-depth": detail,
      "direct-to-display": detail,
      "detachment-reason": detail,
      "detachment-suggestion": detail,
    },
  },
  "hang-risks": {
    instrument: "Hang Risks",
    primaryTime: "time",
    columns: {
      time: t,
      process: thread,
      thread: thread,
      message: detail,
      severity: label,
      "event-type": label,
      backtrace: bt,
    },
  },

  // ── Thermal State ──────────────────────────────────────────────────────────────
  // Verified live (2026-07-02, Time Profiler recording — Thermal State is bundled
  // in, not a standalone template): no thread/process/backtrace column at all —
  // literally just a state level over an interval. Zero causal signal on its own;
  // see the "thermal" lens's nextActions for the Time Profiler correlation nudge.
  "device-thermal-state-intervals": {
    instrument: "Thermal State",
    primaryTime: "start",
    primaryWeight: "duration",
    columns: {
      start: t,
      duration: ns,
      end: t,
      "thermal-state": label,
      "track-label": detail,
      "is-induced": detail,
      narrative: detail,
    },
  },

  // ── GCD Performance ────────────────────────────────────────────────────────────
  // Verified live (2026-07-02, composed onto Time Profiler against Finder) while
  // checking whether this belonged in the "low-signal-alone" list (PMT:sage-weasel)
  // — it does NOT: this schema has its OWN resolved backtrace per flagged event
  // (same engineering-type as Leaks/Allocations/core-data-fetch's Caller), so it's
  // independently useful without correlating against anything else.
  "gcd-perf-event": {
    instrument: "GCD Performance",
    primaryTime: "timestamp",
    columns: {
      timestamp: t,
      thread: thread,
      code: detail,
      severity: label,
      "dispatch-perf-event": label,
      "dispatch-queue": detail,
      "dispatch-source": detail,
      "old-target-queue": detail,
      "new-target-queue": detail,
      label: label,
      backtrace: bt,
      // "core" mnemonic is heuristically role "thread" globally (roleInference.ts)
      // but excluded from preferredThreadColumn's candidate pool there — a CPU
      // core index isn't a thread identity for correlation purposes.
      "running-cpu": detail,
    },
  },

  // ── SwiftData / Core Data ─────────────────────────────────────────────────────
  // fault, relationship-fault, fetch, save — all from the SwiftData template.
  "core-data-fault": {
    instrument: "Data Faults (object)",
    primaryTime: "start",
    primaryWeight: "fault-duration",
    columns: {
      start: t,
      "fault-duration": ns,
      // fault-object is a CoreData/SwiftData object URI — groupable by entity.
      "fault-object": detail,
      backtrace: bt,
      thread: thread,
      narrative: detail,
    },
  },
  "core-data-relationship-fault": {
    instrument: "Data Faults (relationship)",
    primaryTime: "start",
    primaryWeight: "fault-duration",
    columns: {
      start: t,
      "fault-duration": ns,
      "relationship-fault-source": detail,
      // relationship is the property name — groupable to find hot relationships.
      relationship: label,
      backtrace: bt,
      thread: thread,
      narrative: detail,
    },
  },
  "core-data-fetch": {
    instrument: "Data Fetches",
    primaryTime: "start",
    primaryWeight: "duration",
    columns: {
      start: t,
      duration: ns,
      // fetch-entity is the entity class name — groupable to find slow entity fetches.
      "fetch-entity": label,
      "fetch-count": count,
      backtrace: bt,
      // spid is the signpost identifier — opaque.
      spid: detail,
      thread: thread,
    },
  },
  "core-data-save": {
    instrument: "Data Saves",
    primaryTime: "start",
    primaryWeight: "duration",
    columns: {
      start: t,
      duration: ns,
      thread: thread,
      backtrace: bt,
    },
  },

  // ── Swift Concurrency ──────────────────────────────────────────────────────────
  // From the Swift Concurrency template (swift.trace).
  // SwiftTaskLifetime: one row per async task, spanning its full lifetime.
  SwiftTaskLifetime: {
    instrument: "Swift Tasks (lifetime)",
    primaryTime: "start",
    primaryWeight: "duration",
    columns: {
      start: t,
      duration: ns,
      // task is an opaque analysis-core-swift-task reference.
      task: detail,
      process: thread,
    },
  },
  // SwiftActorLifetime: one row per actor instance.
  SwiftActorLifetime: {
    instrument: "Swift Actors (lifetime)",
    primaryTime: "start",
    primaryWeight: "duration",
    columns: {
      start: t,
      duration: ns,
      // actor-class is the Swift actor class name — groupable to find hot actor types.
      "actor-class": label,
      actor: detail,
      "enqueued-actor": detail,
    },
  },
  // SwiftActorQueueSize: time-series of tasks waiting on each actor (Swift Executors).
  SwiftActorQueueSize: {
    instrument: "Swift Executors (queue depth)",
    primaryTime: "start",
    primaryWeight: "count",
    columns: {
      start: t,
      duration: ns,
      actor: detail,
      count: count,
      tasks: detail,
      process: thread,
    },
  },
  // SwiftTaskCreationEvent: one row per task creation.
  SwiftTaskCreationEvent: {
    instrument: "Swift Tasks (creation events)",
    primaryTime: "timestamp",
    columns: {
      timestamp: t,
      task: detail,
      thread: thread,
      backtrace: bt,
      process: thread,
    },
  },
  // SwiftTaskStateTable: one row per task state interval (running/suspended/waiting).
  SwiftTaskStateTable: {
    instrument: "Swift Tasks (state)",
    primaryTime: "start",
    primaryWeight: "duration",
    columns: {
      start: t,
      duration: ns,
      task: detail,
      "enqueued-actor": detail,
      actor: detail,
      // state is "Running", "Suspended", "Waiting" etc.
      state: label,
      priority: label,
      "resume-function": detail,
      "waiting-for": detail,
      backtrace: bt,
      "suspend-backtrace": bt,
      process: thread,
      thread: thread,
      narrative: detail,
    },
  },

  // ── SwiftUI ────────────────────────────────────────────────────────────────────
  // swiftui-updates: one row per view body re-evaluation or representable update.
  "swiftui-updates": {
    instrument: "SwiftUI (view updates)",
    primaryTime: "start",
    primaryWeight: "duration",
    columns: {
      start: t,
      duration: ns,
      id: detail,
      // update-type is "View Body Update", "Representable Update", etc.
      "update-type": label,
      allocations: count,
      description: detail,
      // category is the SwiftUI update category (body, layout, draw…).
      category: label,
      "view-hierarchy": detail,
      module: label,
      // view-name is the Swift type name of the view — key for grouping.
      "view-name": label,
      process: thread,
      thread: thread,
      "root-causes": detail,
      // severity is "Warning", "Critical" — heuristics would call it detail.
      severity: label,
      // downstream-cost: total time spent in views triggered by this update.
      "downstream-cost": ns,
      "downstream-events": detail,
      "cause-graph-node": detail,
      "full-cause-graph-node": detail,
    },
  },
  // swiftui-layout-updates / SwiftUILayoutUpdates2: per-view layout pass
  // timing. duration is the pass's total cost including children; self-
  // duration is this view alone — duration is the canonical "how expensive
  // was this" measure (matches the existing SwiftUI lens's own quickStart,
  // which already sorts these schemas by duration, not self-duration).
  "swiftui-layout-updates": {
    instrument: "SwiftUI (layout updates)",
    primaryTime: "start",
    primaryWeight: "duration",
    columns: {
      start: t,
      duration: ns,
      id: detail,
      "self-duration": ns,
      cached: detail,
      description: detail,
      "view-hierarchy": detail,
      module: label,
      "view-name": label,
      process: thread,
      thread: thread,
      severity: label,
      "full-cause-graph-node": detail,
    },
  },
  SwiftUILayoutUpdates2: {
    instrument: "SwiftUI (layout updates, v2)",
    primaryTime: "start",
    primaryWeight: "duration",
    columns: {
      start: t,
      duration: ns,
      id: detail,
      "self-duration": ns,
      depth: detail,
      cached: detail,
      description: detail,
      "view-hierarchy": detail,
      module: label,
      "view-name": label,
      process: thread,
      thread: thread,
      severity: label,
      "full-cause-graph-node": detail,
    },
  },
  // swiftui-changes: state mutations that triggered view updates.
  "swiftui-changes": {
    instrument: "SwiftUI (state changes)",
    primaryTime: "timestamp",
    columns: {
      timestamp: t,
      id: detail,
      description: detail,
      backtrace: bt,
      process: thread,
      thread: thread,
    },
  },

  // ── Network ───────────────────────────────────────────────────────────────────
  NetworkConnectionStats: {
    instrument: "Network (connection stats)",
    primaryTime: "sample-time",
    primaryWeight: "bytes-in",
    columns: {
      "sample-time": t,
      "connection-serial": detail,
      process: thread,
      interface: label,
      "network-protocol": label,
      "local-address": label,
      "remote-address": label,
      description: label,
      "packets-in": count,
      "bytes-in": bytes,
      "packets-out": count,
      "bytes-out": bytes,
      "dups-received": bytes,
      "out-of-order": bytes,
      retransmitted: bytes,
      "min-round-trip": ns,
      "avg-round-trip": ns,
    },
  },
  "network-connection-update": {
    instrument: "Network (connection updates)",
    primaryTime: "time",
    primaryWeight: "rx-bytes",
    columns: {
      time: t,
      "connection-serial": detail,
      "rx-packets": count,
      "rx-bytes": bytes,
      "tx-packets": count,
      "tx-bytes": bytes,
      "rx-dups": bytes,
      "rx-ooo": bytes,
      "tx-retx": bytes,
      "min-rtt": ns,
      "average-rtt": ns,
    },
  },
};

// ─── Public API ───────────────────────────────────────────────────────────────

/** Return the pinned hint for a schema, if any. */
export function hintFor(schema: string): SchemaHint | undefined {
  return SCHEMA_HINTS[schema];
}

/** Is this schema pinned in the override table? */
export function isPinned(schema: string): boolean {
  return schema in SCHEMA_HINTS;
}

/**
 * Classify a schema's columns, applying pinned overrides first and falling back
 * to the heuristic classifier for any unpinned schema or unlisted column.
 */
export function classifyWithHints(
  schema: string,
  cols: SchemaCol[]
): ClassifiedColumn[] {
  const hint = SCHEMA_HINTS[schema];
  return cols.map((col) => {
    const override = hint?.columns[col.mnemonic];
    if (override) {
      const roleInfo: RoleInfo = {
        role: override.role,
        ...(override.unit ? { unit: override.unit } : {}),
        confidence: "high",
        source: "override",
      };
      return { ...col, roleInfo };
    }
    return { ...col, roleInfo: classifyColumn(col) };
  });
}
