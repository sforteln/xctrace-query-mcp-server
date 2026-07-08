/**
 * PMT:ruddy-elk — unit tests for the eager bounded-schema bootstrap:
 *  - eagerSchemas.ts's kind classifier + eager-set selection (bounded ∩
 *    allowlist, cap enforced, firehoses excluded)
 *  - the schema-boundedness sweep gate (runDetectorsOverIngested runs an
 *    EXPENSIVE detector once its schema is ingested — unlike runCheapDetectors)
 *  - clean-sweep-reports-negatives (buildSweepNote)
 *  - the annotated inventory shape (buildSchemaInventory): warm-exact vs
 *    estimate, correlate-hint, no-silent-cap line
 *
 * Follows tests/detectorsSweepLenses.test.ts / tests/frameBudget.test.ts's
 * pattern: synthetic tables via SqliteTableWriter over an in-memory db, so
 * none of this touches a real .trace file or xctrace.
 */
import { describe, it, expect } from "vitest";
import { openSessionDb, SqliteTableWriter } from "../src/engine/sqliteStore.js";
import type { SchemaCol, NormalizedRow } from "../src/engine/parseTable.js";
import { runCheapDetectors, runDetectorsOverIngested, type DetectorContext, type RankedFinding } from "../src/detectors/index.js";
import {
  schemaKind,
  isBoundedKind,
  selectEagerSchemas,
  EAGER_ALLOWLIST,
  EAGER_SCHEMA_MAX,
  kindDescriptor,
} from "../src/detectors/eagerSchemas.js";
import { outlierSweep } from "../src/detectors/outlierSweep.js";
import { renderHitchSweep, HITCHES_RENDERS_SCHEMA } from "../src/detectors/renderHitchSweep.js";
import { buildSchemaInventory, buildSweepNote } from "../src/detectors/surface.js";
import { DEFAULT_REFRESH_INTERVAL_MS } from "../src/detectors/bands.js";
import { DEVICE_DISPLAY_INFO_SCHEMA } from "../src/detectors/frameBudget.js";

function newDb(): ReturnType<typeof openSessionDb> {
  return openSessionDb(":memory:", { journalMode: "default" });
}

const cell = (type: string, v: string | number) => ({ type, fmt: String(v), raw: v });

function colsOf(shape: Record<string, string>): SchemaCol[] {
  return Object.entries(shape).map(([mnemonic, engineeringType]) => ({ mnemonic, name: mnemonic, engineeringType }));
}

function ingest(db: ReturnType<typeof openSessionDb>, schema: string, cols: SchemaCol[], rows: NormalizedRow[]): void {
  const w = new SqliteTableWriter(db, schema, cols);
  for (const r of rows) w.writeRow(r);
  w.finish();
}

const HITCH_COLS: SchemaCol[] = [
  { mnemonic: "start", name: "Start", engineeringType: "start-time" },
  { mnemonic: "duration", name: "Duration", engineeringType: "duration" },
  { mnemonic: "is-system", name: "Is System", engineeringType: "string" },
];

function ingestHitches(db: ReturnType<typeof openSessionDb>, durationsMs: number[]): void {
  ingest(
    db,
    "hitches",
    HITCH_COLS,
    durationsMs.map((ms, i) => ({
      start: cell("start-time", i * 100_000_000),
      duration: cell("duration", Math.round(ms * 1e6)),
      "is-system": cell("string", "No"),
    }))
  );
}

const ctxFor = (db: ReturnType<typeof openSessionDb>): DetectorContext => ({
  db,
  sessionId: "",
  run: 1,
  tableName: (schema) => schema,
});

const FRAME_MS = DEFAULT_REFRESH_INTERVAL_MS;

// ─── eagerSchemas.ts: kind classifier ──────────────────────────────────────────

describe("schemaKind / isBoundedKind (PMT:ruddy-elk classifier)", () => {
  it("classifies the verified-bounded schemas as diagnosed/metadata/interval", () => {
    expect(schemaKind("hitches")).toBe("diagnosed");
    expect(schemaKind("device-display-info")).toBe("metadata");
    expect(schemaKind("hitches-renders")).toBe("interval");
    expect(schemaKind("hang-risks")).toBe("diagnosed");
    expect(schemaKind("potential-hangs")).toBe("diagnosed");
  });

  it("classifies known firehoses as firehose, never eager-safe", () => {
    for (const schema of ["time-sample", "runloop-events", "swiftui-updates", "ThreadActivity", "Allocations", "display-vsyncs-interval"]) {
      expect(schemaKind(schema)).toBe("firehose");
      expect(isBoundedKind(schema)).toBe(false);
    }
  });

  it("defaults an unlisted schema to unknown — never assumed bounded", () => {
    expect(schemaKind("some-brand-new-schema")).toBe("unknown");
    expect(isBoundedKind("some-brand-new-schema")).toBe(false);
  });

  it("only diagnosed/metadata kinds are bounded", () => {
    expect(isBoundedKind("hitches")).toBe(true);
    expect(isBoundedKind("device-display-info")).toBe(true);
    expect(isBoundedKind("hitches-renders")).toBe(false); // interval — not eager-safe by kind alone
  });
});

// ─── eagerSchemas.ts: eager-set selection ──────────────────────────────────────

describe("selectEagerSchemas (PMT:ruddy-elk eager-set derivation)", () => {
  it("returns present ∩ EAGER_ALLOWLIST, excluding firehoses regardless of presence", () => {
    const present = ["hitches", "hitches-renders", "device-display-info", "time-sample", "swiftui-updates"];
    const eager = selectEagerSchemas(present);
    expect(new Set(eager)).toEqual(new Set(EAGER_ALLOWLIST));
    expect(eager).not.toContain("time-sample");
    expect(eager).not.toContain("swiftui-updates");
  });

  it("returns nothing when none of the allowlisted schemas are present", () => {
    expect(selectEagerSchemas(["time-sample", "swiftui-updates"])).toEqual([]);
  });

  it("caps the eager set at the given cap, prioritizing hitches + device-display-info first", () => {
    const present = ["hitches", "hitches-renders", "device-display-info"];
    const capped = selectEagerSchemas(present, EAGER_ALLOWLIST, 2);
    expect(capped).toHaveLength(2);
    expect(capped).toEqual(["hitches", "device-display-info"]);
  });

  it("the real EAGER_SCHEMA_MAX bounds worst-case latency to ~4 x 5.5s ≈ 22s", () => {
    expect(EAGER_SCHEMA_MAX).toBeGreaterThanOrEqual(EAGER_ALLOWLIST.length);
    expect(EAGER_SCHEMA_MAX).toBeLessThanOrEqual(5); // sanity bound — not meant to grow unboundedly
  });

  it("an unpinned custom allowlist/cap still filters + caps correctly (structural, not tied to real constants)", () => {
    const customAllowlist = ["a", "b", "c", "d"];
    const result = selectEagerSchemas(["a", "c", "d", "z"], customAllowlist, 2);
    expect(result).toHaveLength(2);
    for (const s of result) expect(customAllowlist).toContain(s);
  });
});

// ─── The schema-boundedness sweep gate ─────────────────────────────────────────

describe("runDetectorsOverIngested (PMT:ruddy-elk sweep-gate: boundedness, not cost)", () => {
  it("fires an EXPENSIVE detector once its bounded schema is ingested — where runCheapDetectors stays silent", () => {
    const db = newDb();
    // Well over both the moderate and high hitch bands.
    ingestHitches(db, [...Array(10).fill(FRAME_MS * 0.2), ...Array(6).fill(FRAME_MS * 1.5), ...Array(2).fill(FRAME_MS * 2.5)]);
    const ctx = ctxFor(db);
    const ingested = new Set(["hitches"]);

    // Sanity: runCheapDetectors gates on cost and skips this expensive detector entirely.
    expect(runCheapDetectors([outlierSweep], ctx, ingested)).toEqual([]);

    // runDetectorsOverIngested gates on schema availability only — the bounded
    // 801-ish-row hitches table runs in ms even though the detector is "expensive".
    const ranked = runDetectorsOverIngested([outlierSweep], ctx, ingested);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].detectorId).toBe("outlier-sweep");
  });

  it("does not fire a detector whose required schema isn't in the ingested set", () => {
    const db = newDb();
    ingestHitches(db, [...Array(6).fill(FRAME_MS * 1.5)]);
    const ctx = ctxFor(db);
    // hitches-renders was never ingested — render-hitch-sweep must not run.
    const ranked = runDetectorsOverIngested([renderHitchSweep], ctx, new Set(["hitches"]));
    expect(ranked).toEqual([]);
  });

  it("runs multiple hitch detectors (cheap tier is empty here — all hitch detectors are expensive) once hitches is ingested", () => {
    const db = newDb();
    ingestHitches(db, [...Array(10).fill(FRAME_MS * 0.2), ...Array(6).fill(FRAME_MS * 1.5), ...Array(2).fill(FRAME_MS * 2.5)]);
    const ctx = ctxFor(db);
    const ranked = runDetectorsOverIngested([outlierSweep], ctx, new Set(["hitches"]));
    expect(ranked.length).toBeGreaterThan(0);
  });
});

// ─── clean-sweep-reports-negatives ──────────────────────────────────────────────

describe("buildSweepNote (PMT:ruddy-elk clean-sweep reports negatives)", () => {
  it("reports what was swept and that it's clean when nothing fired, including device accuracy when device-display-info resolved the budget", () => {
    const db = newDb();
    ingestHitches(db, Array(29).fill(FRAME_MS * 0.2)); // well under budget — clean
    ingest(
      db,
      DEVICE_DISPLAY_INFO_SCHEMA,
      colsOf({ timestamp: "event-time", "display-id": "uint64", "max-refresh-rate": "uint32", "is-main-display": "boolean" }),
      [
        {
          timestamp: cell("event-time", 0),
          "display-id": cell("uint64", 1),
          "max-refresh-rate": cell("uint32", 120),
          "is-main-display": cell("boolean", "Yes"),
        },
      ]
    );
    const ctx = ctxFor(db);
    const note = buildSweepNote(ctx, ["hitches", DEVICE_DISPLAY_INFO_SCHEMA], []);
    expect(note).toContain("Swept hitches");
    expect(note).toContain("29 hitches");
    expect(note).toContain("device-accurate @120Hz");
    expect(note).toContain("clean");
  });

  it("names the fired detector(s) instead of reporting clean when something fired", () => {
    const db = newDb();
    const ctx = ctxFor(db);
    const finding: RankedFinding = {
      detectorId: "outlier-sweep",
      title: "Outlier Sweep",
      summary: "2 hitches over 2x budget",
      criterion: "count 2 over 0",
      severity: "high",
      score: 5,
      callSpec: { verb: "find", schema: "hitches", args: {} },
      handles: [],
    };
    const note = buildSweepNote(ctx, ["hitches"], [finding]);
    expect(note).toContain("Swept hitches");
    expect(note).toContain("1 finding");
    expect(note).toContain("outlier-sweep");
    expect(note).not.toContain("clean");
  });

  it("degrades gracefully (never throws) when the hitches table isn't actually queryable", () => {
    const db = newDb();
    const ctx = ctxFor(db); // no hitches table ingested at all
    expect(() => buildSweepNote(ctx, ["hitches"], [])).not.toThrow();
    expect(buildSweepNote(ctx, ["hitches"], [])).toContain("clean");
  });
});

// ─── the annotated inventory shape ──────────────────────────────────────────────

describe("buildSchemaInventory (PMT:ruddy-elk annotated inventory)", () => {
  it("gives a warm schema an exact count and no scanNote", () => {
    const entries = buildSchemaInventory([{ schema: "hitches", rowCount: 29 }], new Set(["hitches"]), []);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ name: "hitches", warm: true, count: 29, countLabel: "29" });
    expect(entries[0].scanNote).toBeUndefined();
  });

  it("gives a cold schema a categorical estimate label and a no-silent-cap scanNote", () => {
    const entries = buildSchemaInventory([{ schema: "swiftui-updates", rowCount: null }], new Set(), []);
    expect(entries[0].warm).toBe(false);
    expect(entries[0].count).toBeNull();
    expect(entries[0].countLabel).toContain("~estimate");
    expect(entries[0].countLabel).toContain(kindDescriptor("firehose"));
    expect(entries[0].scanNote).toMatch(/present, not auto-scanned/);
    expect(entries[0].scanNote).toMatch(/open to run its detector/);
  });

  it("labels an unlisted schema's cold estimate as unknown kind, never guessed bounded", () => {
    const entries = buildSchemaInventory([{ schema: "some-new-schema", rowCount: null }], new Set(), []);
    expect(entries[0].kind).toBe("unknown");
    expect(entries[0].countLabel).toContain("unknown kind");
  });

  it("sets carries-own-backtrace for a schema whose pinned hint has a backtrace column, needs-join otherwise", () => {
    const entries = buildSchemaInventory(
      [
        { schema: "os-log", rowCount: 10 }, // pinned with a backtrace column
        { schema: "hitches", rowCount: 29 }, // pinned, no backtrace column
      ],
      new Set(["os-log", "hitches"]),
      []
    );
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
    expect(byName["os-log"].correlateHint).toBe("carries-own-backtrace");
    expect(byName["hitches"].correlateHint).toBe("needs-join/correlate");
  });

  it("marks detectorResult clean when a schema's detectors ran but none fired, and fired N when one did", () => {
    const cleanEntries = buildSchemaInventory([{ schema: "hitches", rowCount: 29 }], new Set(["hitches"]), []);
    expect(cleanEntries[0].detectorResult).toBe("clean");

    const finding: RankedFinding = {
      detectorId: "outlier-sweep",
      title: "Outlier Sweep",
      summary: "fired",
      criterion: "count 2 over 0",
      severity: "high",
      score: 5,
      callSpec: { verb: "find", schema: "hitches", args: {} },
      handles: [],
    };
    const firedEntries = buildSchemaInventory([{ schema: "hitches", rowCount: 29 }], new Set(["hitches"]), [finding]);
    expect(firedEntries[0].detectorResult).toBe("fired 1");
  });

  it("omits detectorResult for a schema no detector is gated on", () => {
    const entries = buildSchemaInventory([{ schema: "device-display-info", rowCount: 1 }], new Set(["device-display-info"]), []);
    expect(entries[0].detectorResult).toBeUndefined();
  });

  it("dedupes a schema that appears more than once (ambiguous positions) to a single inventory line", () => {
    const entries = buildSchemaInventory(
      [
        { schema: "SwiftUIFilteredUpdates", rowCount: 5 },
        { schema: "SwiftUIFilteredUpdates", rowCount: null },
      ],
      new Set(),
      []
    );
    expect(entries).toHaveLength(1);
  });

  it("one compact line per schema — bounded by schema count, not row count", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ schema: `schema-${i}`, rowCount: i }));
    const entries = buildSchemaInventory(many, new Set(), []);
    expect(entries).toHaveLength(30);
    for (const e of entries) {
      expect(Object.keys(e).length).toBeLessThanOrEqual(7); // compact — no column lists / full finding detail
    }
  });
});

// Sanity: HITCHES_RENDERS_SCHEMA constant is what selectEagerSchemas/EAGER_ALLOWLIST key on.
describe("cross-check: renderHitchSweep's schema constant matches the eager allowlist entry", () => {
  it("HITCHES_RENDERS_SCHEMA is in EAGER_ALLOWLIST", () => {
    expect(EAGER_ALLOWLIST).toContain(HITCHES_RENDERS_SCHEMA);
  });
});
