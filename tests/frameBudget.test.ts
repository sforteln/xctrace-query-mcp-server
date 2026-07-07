/**
 * PMT:still-hail — unit tests for the real per-display frame-budget resolver
 * (src/detectors/frameBudget.ts) and its wiring into the hitch detectors.
 *
 * Follows tests/detectorsCorpus.test.ts's pattern: synthetic tables via
 * SqliteTableWriter over an in-memory db, ctx.tableName is the identity
 * function (schema name IS the physical table name) so a schema that was
 * never ingested naturally 404s (caught by frameBudget's safeTable probe)
 * instead of needing a separate "not present" fixture.
 */
import { describe, it, expect } from "vitest";
import { openSessionDb, SqliteTableWriter } from "../src/engine/sqliteStore.js";
import type { SchemaCol, NormalizedRow } from "../src/engine/parseTable.js";
import type { DetectorContext } from "../src/detectors/index.js";
import { DEFAULT_REFRESH_INTERVAL_MS, HITCH_MODERATE_MULTIPLE } from "../src/detectors/bands.js";
import { resolveFrameBudgetMs, DEVICE_DISPLAY_INFO_SCHEMA, DISPLAY_VSYNCS_SCHEMA } from "../src/detectors/frameBudget.js";
import { outlierSweep } from "../src/detectors/outlierSweep.js";

type Row = Record<string, { type: string; fmt: string | number; raw: string | number }>;

function colsOf(shape: Record<string, string>): SchemaCol[] {
  return Object.entries(shape).map(([mnemonic, engineeringType]) => ({ mnemonic, name: mnemonic, engineeringType }));
}

function ingest(db: ReturnType<typeof openSessionDb>, schema: string, cols: SchemaCol[], rows: Row[]): void {
  const w = new SqliteTableWriter(db, schema, cols);
  for (const r of rows) w.writeRow(r as NormalizedRow);
  w.finish();
}

function newDb(): ReturnType<typeof openSessionDb> {
  return openSessionDb(":memory:", { journalMode: "default" });
}

const ctxFor = (db: ReturnType<typeof openSessionDb>): DetectorContext => ({
  db,
  sessionId: "",
  run: 1,
  tableName: (schema: string) => schema,
});

const cell = (type: string, v: string | number) => ({ type, fmt: String(v), raw: v });

const DISPLAY_INFO_COLS = colsOf({
  timestamp: "event-time",
  "display-id": "uint64",
  "device-name": "metal-object-label",
  "max-refresh-rate": "uint32",
  "is-main-display": "boolean",
});

function ingestDisplayInfo(
  db: ReturnType<typeof openSessionDb>,
  displays: Array<{ displayId: number; rate: number; isMain: boolean; deviceName?: string }>
): void {
  ingest(
    db,
    DEVICE_DISPLAY_INFO_SCHEMA,
    DISPLAY_INFO_COLS,
    displays.map((d) => ({
      timestamp: cell("event-time", 0),
      "display-id": cell("uint64", d.displayId),
      "device-name": cell("metal-object-label", d.deviceName ?? "Built-in Display"),
      "max-refresh-rate": cell("uint32", d.rate),
      "is-main-display": cell("boolean", d.isMain ? "Yes" : "No"),
    }))
  );
}

const VSYNC_COLS = colsOf({ timestamp: "start-time", "display-name": "display-name" });

function ingestVsyncTicks(db: ReturnType<typeof openSessionDb>, display: string, tickTimesNs: number[]): void {
  ingest(
    db,
    DISPLAY_VSYNCS_SCHEMA,
    VSYNC_COLS,
    tickTimesNs.map((ts) => ({
      timestamp: cell("start-time", ts),
      "display-name": cell("display-name", display),
    }))
  );
}

describe("resolveFrameBudgetMs (PMT:still-hail)", () => {
  it("resolves 8.33ms for a 120Hz main display (device-display-info primary path)", () => {
    const db = newDb();
    ingestDisplayInfo(db, [{ displayId: 1, rate: 120, isMain: true }]);
    const result = resolveFrameBudgetMs(ctxFor(db), "Display 1");
    expect(result.source).toBe("device-display-info");
    expect(result.assumed).toBe(false);
    expect(result.budgetMs).toBeCloseTo(1000 / 120, 2); // 8.33ms
  });

  it("resolves 16.67ms for a 60Hz display", () => {
    const db = newDb();
    ingestDisplayInfo(db, [{ displayId: 1, rate: 60, isMain: true }]);
    const result = resolveFrameBudgetMs(ctxFor(db));
    expect(result.source).toBe("device-display-info");
    expect(result.budgetMs).toBeCloseTo(1000 / 60, 2); // 16.67ms
  });

  it("prefers the main display, and matches by trailing display-id digits, when multiple displays are ingested", () => {
    const db = newDb();
    ingestDisplayInfo(db, [
      { displayId: 2, rate: 60, isMain: false },
      { displayId: 1, rate: 120, isMain: true },
    ]);
    // No display hint -> falls back to is-main-display.
    expect(resolveFrameBudgetMs(ctxFor(db)).budgetMs).toBeCloseTo(1000 / 120, 2);
    // Explicit join by trailing digits in "Display N" -> the 60Hz secondary.
    expect(resolveFrameBudgetMs(ctxFor(db), "Display 2").budgetMs).toBeCloseTo(1000 / 60, 2);
  });

  it("falls back to the DEFAULT constant with assumed:true when neither Display schema is ingested", () => {
    const db = newDb();
    const result = resolveFrameBudgetMs(ctxFor(db));
    expect(result.source).toBe("fallback");
    expect(result.assumed).toBe(true);
    expect(result.budgetMs).toBe(DEFAULT_REFRESH_INTERVAL_MS);
    expect(result.note).toMatch(/device-display-info not ingested/);
  });

  it("derives cadence from display-vsyncs-interval tick GAPS when device-display-info is absent", () => {
    // Verified live against the real animation-hitches trace: display-vsyncs-interval's own
    // `duration` column is a constant 1ns sentinel, not the real inter-vsync interval — the
    // resolver (correctly) uses the gap between consecutive tick timestamps instead. Simulate
    // a 120Hz cadence (~8.33ms between ticks) here.
    const db = newDb();
    const cadenceNs = (1000 / 120) * 1e6;
    const ticks = Array.from({ length: 12 }, (_, i) => Math.round(i * cadenceNs));
    ingestVsyncTicks(db, "Display 1", ticks);
    const result = resolveFrameBudgetMs(ctxFor(db), "Display 1");
    expect(result.source).toBe("vsync-cadence");
    expect(result.assumed).toBe(false);
    expect(result.budgetMs).toBeCloseTo(1000 / 120, 1);
  });
});

describe("hitch detectors wired to the real budget (PMT:still-hail integration)", () => {
  const HITCH_COLS = colsOf({ start: "start-time", duration: "duration", "is-system": "string", display: "display-name" });

  function ingestHitches(db: ReturnType<typeof openSessionDb>, durationsMs: number[]): void {
    ingest(
      db,
      "hitches",
      HITCH_COLS,
      durationsMs.map((ms, i) => ({
        start: cell("start-time", i * 100_000_000),
        duration: cell("duration", Math.round(ms * 1e6)),
        "is-system": cell("string", "No"),
        display: cell("display-name", "Display 1"),
      }))
    );
  }

  it("a 10ms hitch fires the outlier sweep's Moderate band on a 120Hz display (real budget 8.33ms)", () => {
    const db = newDb();
    ingestDisplayInfo(db, [{ displayId: 1, rate: 120, isMain: true }]);
    // 6 identical 10ms app-caused hitches: > MIN_HITCH_SAMPLES and > OUTLIER_MODERATE_COUNT_THRESHOLD.
    ingestHitches(db, Array(6).fill(10));
    const finding = outlierSweep.run(ctxFor(db));
    expect(finding).not.toBeNull();
    expect(finding!.firing.some((f) => f.metric.includes("Moderate"))).toBe(true);
  });

  it("the SAME 10ms hitch stays clean under a 60Hz budget (real budget 16.67ms — this is exactly the under-reporting bug still-hail fixes in reverse: no longer OVER-firing at 60Hz on a device that's actually 120Hz)", () => {
    const db = newDb();
    ingestDisplayInfo(db, [{ displayId: 1, rate: 60, isMain: true }]);
    ingestHitches(db, Array(6).fill(10));
    expect(outlierSweep.run(ctxFor(db))).toBeNull();
  });

  it("with no Display schema ingested at all, falls back to the 60Hz constant (same clean result, but flagged as assumed)", () => {
    const db = newDb();
    ingestHitches(db, Array(6).fill(10));
    expect(outlierSweep.run(ctxFor(db))).toBeNull();
    expect(resolveFrameBudgetMs(ctxFor(db)).assumed).toBe(true);
  });

  it("sanity: HITCH_MODERATE_MULTIPLE x 120Hz budget is under 10ms (the crossing this whole scenario depends on)", () => {
    expect(HITCH_MODERATE_MULTIPLE * (1000 / 120)).toBeLessThan(10);
    expect(HITCH_MODERATE_MULTIPLE * (1000 / 60)).toBeGreaterThan(10);
  });
});
