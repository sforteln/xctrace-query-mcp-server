/**
 * PMT:thorny-verge — relate()'s self-describing empty result. Deliberately
 * narrow: only fires when totalA is 0 (schemaA has no rows to relate at all),
 * NOT when totalMatches/totalGroups is 0 with totalA > 0 — that's often the
 * legitimate finding itself (e.g. "0 unmatched" is good news for a leak
 * check), so a generic "this looks empty" note there would be actively
 * misleading.
 */
import { describe, it, expect, vi } from "vitest";

const SCHEMA_A = "interval-schema";
const SCHEMA_B = "event-schema";
const EMPTY_SCHEMA_A = "empty-interval-schema";
const RUN = 1;
const SESSION_ID = "session";

vi.mock("../src/engine/session.js", async () => {
  const { openSessionDb, SqliteTableWriter } = await import("../src/engine/sqliteStore.js");
  const { registerRegexpUdf, registerPercentileUdfs, registerInternDecodeUdf } = await import("../src/engine/sqlHydrate.js");

  const db = openSessionDb(":memory:", { journalMode: "default" });
  registerRegexpUdf(db);
  registerPercentileUdfs(db);
  registerInternDecodeUdf(db);

  const aCols = [
    { mnemonic: "start", name: "Start", engineeringType: "start-time" },
    { mnemonic: "duration", name: "Duration", engineeringType: "duration" },
    { mnemonic: "label", name: "Label", engineeringType: "label" },
  ];
  const bCols = [{ mnemonic: "time", name: "Time", engineeringType: "sample-time" }];

  const aTableName = `${RUN}:${SCHEMA_A}`;
  const aWriter = new SqliteTableWriter(db, aTableName, aCols);
  // 5 intervals, none of which contain any B event (all B events land far outside).
  for (let i = 0; i < 5; i++) {
    aWriter.writeRow({
      start: { type: "start-time", fmt: String(i * 10_000), raw: i * 10_000 },
      duration: { type: "duration", fmt: "1000", raw: 1000 },
      label: { type: "label", fmt: "grp", raw: "grp" },
    });
  }
  const aRowCount = aWriter.finish();

  const bTableName = `${RUN}:${SCHEMA_B}`;
  const bWriter = new SqliteTableWriter(db, bTableName, bCols);
  for (let i = 0; i < 3; i++) {
    bWriter.writeRow({ time: { type: "sample-time", fmt: String(1_000_000 + i), raw: 1_000_000 + i } });
  }
  const bRowCount = bWriter.finish();

  const emptyATableName = `${RUN}:${EMPTY_SCHEMA_A}`;
  const emptyAWriter = new SqliteTableWriter(db, emptyATableName, aCols);
  const emptyARowCount = emptyAWriter.finish();

  const handles: Record<string, { schema: string; cols: unknown[]; dbPath: string; tableName: string; rowCount: number }> = {
    [SCHEMA_A]: { schema: SCHEMA_A, cols: aCols, dbPath: ":memory:", tableName: aTableName, rowCount: aRowCount },
    [SCHEMA_B]: { schema: SCHEMA_B, cols: bCols, dbPath: ":memory:", tableName: bTableName, rowCount: bRowCount },
    [EMPTY_SCHEMA_A]: { schema: EMPTY_SCHEMA_A, cols: aCols, dbPath: ":memory:", tableName: emptyATableName, rowCount: emptyARowCount },
  };

  const session = { schemaModel: [] as unknown[], callCache: new Map<string, unknown>() };

  return {
    getSession: (_sessionId: string) => session,
    getTable: async (_sessionId: string, _run: number, schema: string, _position?: number) => handles[schema],
    getDb: async (_sessionId: string) => db,
    getSchemaMeta: async (_sessionId: string, _run: number, schema: string, _position?: number) => ({
      cols: handles[schema].cols,
      rowCount: handles[schema].rowCount,
    }),
    lastRun: (_sessionId: string) => RUN,
  };
});

const { relate } = await import("../src/core/relate.js");

describe("relate() self-describing empty results", () => {
  it("notes that aFilter excluded everything when schemaA has real data", async () => {
    const result = await relate(SESSION_ID, SCHEMA_A, SCHEMA_B, {
      joinCondition: "time-range",
      polarity: "exists",
      groupBy: "label",
      matchThread: false,
      aFilter: { label: "nonexistent" },
    });
    expect(result.totalA).toBe(0);
    expect(result.note).toMatch(/0 of 5/);
    expect(result.note).toMatch(/has data/);
  });

  it("notes that schemaA is genuinely empty when it has 0 rows", async () => {
    const result = await relate(SESSION_ID, EMPTY_SCHEMA_A, SCHEMA_B, {
      joinCondition: "time-range",
      polarity: "exists",
      groupBy: "label",
      matchThread: false,
    });
    expect(result.totalA).toBe(0);
    expect(result.note).toMatch(/genuinely has 0/);
  });

  it("does NOT attach a note when totalA > 0 but nothing matched — that's a legitimate finding, not an error", async () => {
    const result = await relate(SESSION_ID, SCHEMA_A, SCHEMA_B, {
      joinCondition: "time-range",
      polarity: "exists",
      groupBy: "label",
      matchThread: false,
    });
    expect(result.totalA).toBe(5);
    expect(result.totalMatches).toBe(0);
    expect(result.note).toBeUndefined();
  });
});
