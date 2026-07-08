/**
 * PMT:narrow-ochre: find()'s two new condition-model gaps closed post
 * wise-sierra's SQL cutover — cross-column comparison (compareCol) and
 * AND/OR nesting (allOf/anyOf) — asserted against an ingested SQLite table
 * (SqliteTableWriter + a stubbed session.js), same pattern as
 * callTreeThreadFilter.test.ts, not a JS row-array scan.
 */
import { describe, it, expect, vi } from "vitest";

const SCHEMA = "cost-table";
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
    { mnemonic: "direct-cost", name: "Direct Cost", engineeringType: "weight" },
    { mnemonic: "downstream-cost", name: "Downstream Cost", engineeringType: "weight" },
    { mnemonic: "name", name: "Name", engineeringType: "label" },
  ];

  const tableName = `${RUN}:${SCHEMA}`;
  const writer = new SqliteTableWriter(db, tableName, cols);

  function writeRow(directCost: number, downstreamCost: number, name: string) {
    writer.writeRow({
      "direct-cost": { type: "weight", fmt: String(directCost), raw: directCost },
      "downstream-cost": { type: "weight", fmt: String(downstreamCost), raw: downstreamCost },
      name: { type: "label", fmt: name, raw: name },
    });
  }

  // downstream > direct
  writeRow(10, 15, "foo-thing");
  // downstream < direct
  writeRow(20, 5, "bar-thing");
  // downstream == direct
  writeRow(30, 30, "baz-thing");
  // downstream < direct, name matches neither foo nor bar
  writeRow(5, 2, "other");
  const rowCount = writer.finish();

  const handle = { schema: SCHEMA, cols, dbPath: ":memory:", tableName, rowCount };
  const session = { schemaModel: [] as unknown[], callCache: new Map<string, unknown>() };

  return {
    getSession: (_sessionId: string) => session,
    getTable: async (_sessionId: string, _run: number, _schema: string, _position?: number) => handle,
    getDb: async (_sessionId: string) => db,
    getSchemaMeta: async (_sessionId: string, _run: number, _schema: string, _position?: number) => ({
      cols,
      rowCount,
    }),
    lastRun: (_sessionId: string) => RUN,
  };
});

const { findRows } = await import("../src/core/find.js");

describe("find() cross-column comparison (compareCol)", () => {
  it("gt: matches only rows where downstream-cost exceeds direct-cost", async () => {
    const found = await findRows(SESSION_ID, SCHEMA, {
      where: [{ col: "downstream-cost", op: "gt", compareCol: "direct-cost" }],
    });
    expect(found.matchCount).toBe(1);
    expect(found.rows[0].cells.name).toBe("foo-thing");
  });

  it("gte: includes the equal row too", async () => {
    const found = await findRows(SESSION_ID, SCHEMA, {
      where: [{ col: "downstream-cost", op: "gte", compareCol: "direct-cost" }],
    });
    expect(found.matchCount).toBe(2);
    const names = found.rows.map((r) => r.cells.name).sort();
    expect(names).toEqual(["baz-thing", "foo-thing"]);
  });

  it("eq: matches only the row where the two columns are equal", async () => {
    const found = await findRows(SESSION_ID, SCHEMA, {
      where: [{ col: "downstream-cost", op: "eq", compareCol: "direct-cost" }],
    });
    expect(found.matchCount).toBe(1);
    expect(found.rows[0].cells.name).toBe("baz-thing");
  });

  it("ne: matches every row where the two columns differ", async () => {
    const found = await findRows(SESSION_ID, SCHEMA, {
      where: [{ col: "downstream-cost", op: "ne", compareCol: "direct-cost" }],
    });
    expect(found.matchCount).toBe(3);
  });

  it("rejects compareCol combined with val", async () => {
    await expect(
      findRows(SESSION_ID, SCHEMA, {
        where: [{ col: "downstream-cost", op: "gt", val: 1, compareCol: "direct-cost" }],
      })
    ).rejects.toThrow(/val.*compareCol|compareCol.*val/i);
  });

  it("rejects compareCol on an op that doesn't support it", async () => {
    await expect(
      findRows(SESSION_ID, SCHEMA, {
        where: [{ col: "name", op: "contains", compareCol: "direct-cost" }],
      })
    ).rejects.toThrow(/compareCol/);
  });
});

describe("find() AND/OR condition tree", () => {
  it("anyOf: matches rows satisfying either branch", async () => {
    const found = await findRows(SESSION_ID, SCHEMA, {
      where: [
        {
          anyOf: [
            { col: "name", op: "contains", val: "foo" },
            { col: "name", op: "contains", val: "bar" },
          ],
        },
      ],
    });
    expect(found.matchCount).toBe(2);
    const names = found.rows.map((r) => r.cells.name).sort();
    expect(names).toEqual(["bar-thing", "foo-thing"]);
  });

  it("top-level array still ANDs (unchanged default)", async () => {
    const found = await findRows(SESSION_ID, SCHEMA, {
      where: [
        { col: "name", op: "contains", val: "thing" },
        { col: "direct-cost", op: "gt", val: 15 },
      ],
    });
    // "thing" excludes "other"; direct-cost > 15 excludes foo-thing(10) — leaves bar-thing(20), baz-thing(30)
    expect(found.matchCount).toBe(2);
    const names = found.rows.map((r) => r.cells.name).sort();
    expect(names).toEqual(["bar-thing", "baz-thing"]);
  });

  it("mixed AND-OR: allOf wrapping an anyOf group", async () => {
    const found = await findRows(SESSION_ID, SCHEMA, {
      where: [
        {
          allOf: [
            { col: "direct-cost", op: "gt", val: 0 },
            {
              anyOf: [
                { col: "name", op: "contains", val: "foo" },
                { col: "name", op: "contains", val: "baz" },
              ],
            },
          ],
        },
      ],
    });
    expect(found.matchCount).toBe(2);
    const names = found.rows.map((r) => r.cells.name).sort();
    expect(names).toEqual(["baz-thing", "foo-thing"]);
  });

  it("anyOf combined with a cross-column condition", async () => {
    const found = await findRows(SESSION_ID, SCHEMA, {
      where: [
        {
          anyOf: [
            { col: "downstream-cost", op: "gt", compareCol: "direct-cost" },
            { col: "name", op: "eq", val: "other" },
          ],
        },
      ],
    });
    expect(found.matchCount).toBe(2);
    const names = found.rows.map((r) => r.cells.name).sort();
    expect(names).toEqual(["foo-thing", "other"]);
  });
});
