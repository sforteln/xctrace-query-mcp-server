/**
 * PMT:thorny-verge — query/find/aggregate's self-describing empty results.
 * Distinguishes "your filter/timeRange excluded everything" (the schema has
 * data) from "this schema genuinely has 0 rows" — the scratchpad 062
 * throughline: a bare [] gets read as a positive conclusion.
 *
 * Same synthetic-table + stubbed session.js pattern as
 * callTreeThreadFilter.test.ts.
 */
import { describe, it, expect, vi } from "vitest";

const SCHEMA = "cost-table";
const EMPTY_SCHEMA = "empty-table";
const RUN = 1;
const SESSION_ID = "session";

vi.mock("../src/engine/session.js", async () => {
  const { openSessionDb, SqliteTableWriter } = await import("../src/engine/sqliteStore.js");
  const { registerRegexpUdf, registerPercentileUdfs, registerInternDecodeUdf } = await import("../src/engine/sqlHydrate.js");

  const db = openSessionDb(":memory:", { journalMode: "default" });
  registerRegexpUdf(db);
  registerPercentileUdfs(db);
  registerInternDecodeUdf(db);

  const cols = [
    { mnemonic: "time", name: "Timestamp", engineeringType: "sample-time" },
    { mnemonic: "cost", name: "Cost", engineeringType: "weight" },
    { mnemonic: "name", name: "Name", engineeringType: "label" },
  ];

  const tableName = `${RUN}:${SCHEMA}`;
  const writer = new SqliteTableWriter(db, tableName, cols);
  for (let i = 0; i < 10; i++) {
    writer.writeRow({
      time: { type: "sample-time", fmt: String(i * 1000), raw: i * 1000 },
      cost: { type: "weight", fmt: String(10), raw: 10 },
      name: { type: "label", fmt: "foo", raw: "foo" },
    });
  }
  const rowCount = writer.finish();

  const emptyTableName = `${RUN}:${EMPTY_SCHEMA}`;
  const emptyWriter = new SqliteTableWriter(db, emptyTableName, cols);
  const emptyRowCount = emptyWriter.finish();

  const handles: Record<string, { schema: string; cols: typeof cols; dbPath: string; tableName: string; rowCount: number }> = {
    [SCHEMA]: { schema: SCHEMA, cols, dbPath: ":memory:", tableName, rowCount },
    [EMPTY_SCHEMA]: { schema: EMPTY_SCHEMA, cols, dbPath: ":memory:", tableName: emptyTableName, rowCount: emptyRowCount },
  };

  const session = { schemaModel: [] as unknown[], callCache: new Map<string, unknown>() };

  return {
    getSession: (_sessionId: string) => session,
    getTable: async (_sessionId: string, _run: number, schema: string, _position?: number) => handles[schema],
    getDb: async (_sessionId: string) => db,
    getSchemaMeta: async (_sessionId: string, _run: number, schema: string, _position?: number) => ({
      cols,
      rowCount: handles[schema].rowCount,
    }),
    lastRun: (_sessionId: string) => RUN,
  };
});

const { queryTable } = await import("../src/core/query.js");
const { findRows } = await import("../src/core/find.js");
const { aggregateTable } = await import("../src/core/aggregate.js");

describe("query() self-describing empty results", () => {
  it("says the filter excluded everything when the schema has data", async () => {
    const result = await queryTable(SESSION_ID, SCHEMA, { filter: { name: "nonexistent" } });
    expect(result.totalRows).toBe(0);
    expect(result.note).toMatch(/0 of 10/);
    expect(result.note).toMatch(/has data/);
  });

  it("says the schema is genuinely empty when it has 0 rows and no filter", async () => {
    const result = await queryTable(SESSION_ID, EMPTY_SCHEMA, {});
    expect(result.totalRows).toBe(0);
    expect(result.note).toMatch(/genuinely has 0/);
  });

  it("carries no note when rows actually match", async () => {
    const result = await queryTable(SESSION_ID, SCHEMA, {});
    expect(result.totalRows).toBe(10);
    expect(result.note).toBeUndefined();
  });
});

describe("find() self-describing empty results", () => {
  it("says the where clause excluded everything when the schema has data", async () => {
    const result = await findRows(SESSION_ID, SCHEMA, {
      where: [{ col: "name", op: "eq", val: "nonexistent" }],
    });
    expect(result.matchCount).toBe(0);
    expect(result.note).toMatch(/0 of 10/);
  });

  it("says the schema is genuinely empty when it has 0 rows and no where clause", async () => {
    const result = await findRows(SESSION_ID, EMPTY_SCHEMA, { where: [] });
    expect(result.matchCount).toBe(0);
    expect(result.note).toMatch(/genuinely has 0/);
  });
});

describe("aggregate() self-describing empty results", () => {
  it("says the filter excluded everything when the schema has data", async () => {
    const result = await aggregateTable(SESSION_ID, SCHEMA, {
      groupBy: "name",
      measure: "cost",
      op: "sum",
      filter: { name: "nonexistent" },
    });
    expect(result.totalGroups).toBe(0);
    expect(result.note).toMatch(/0 of 10/);
  });

  it("says the schema is genuinely empty when it has 0 rows", async () => {
    const result = await aggregateTable(SESSION_ID, EMPTY_SCHEMA, { groupBy: "name", measure: "cost", op: "sum" });
    expect(result.totalGroups).toBe(0);
    expect(result.note).toMatch(/genuinely has 0/);
  });

  it("carries no note when groups actually form", async () => {
    const result = await aggregateTable(SESSION_ID, SCHEMA, { groupBy: "name", measure: "cost", op: "sum" });
    expect(result.totalGroups).toBe(1);
    expect(result.note).toBeUndefined();
  });
});
