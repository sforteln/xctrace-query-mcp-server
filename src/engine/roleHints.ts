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
