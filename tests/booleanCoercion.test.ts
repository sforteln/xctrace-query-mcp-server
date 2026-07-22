/**
 * PMT:haze-eagle Tier 2 item 5 (+ PMT:navy-glen item 1) — JSON boolean
 * coercion in find/filters, format-aware across the two export vocabularies:
 * schema-table booleans store raw 0/1 and display "Yes"/"No"; track-detail
 * booleans (Allocations' `live`) store the literal strings "true"/"false".
 * Before this, zod rejected `val: false` outright, and the string "false"
 * silently matched 0 rows against a schema-table boolean (live field report).
 *
 * Same synthetic-table + stubbed session.js pattern as
 * aggregateSummabilitySentinels.test.ts.
 */
import { describe, it, expect, vi } from "vitest";

const SCHEMA = "bool-table";
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
    { mnemonic: "stime", name: "Start", engineeringType: "start-time" },
    { mnemonic: "dur", name: "Duration", engineeringType: "duration" },
    // schema-table vocabulary: raw 0/1, fmt Yes/No
    { mnemonic: "is-system", name: "Is System", engineeringType: "boolean" },
    // track-detail vocabulary: literal "true"/"false" strings (inferred string type)
    { mnemonic: "live", name: "Live", engineeringType: "string" },
  ];

  const tableName = `${RUN}:bool-table`;
  const writer = new SqliteTableWriter(db, tableName, cols);
  const rows: Array<[number, number, { raw: number; fmt: string }, string]> = [
    [1000, 10, { raw: 0, fmt: "No" }, "true"],
    [2000, 10, { raw: 0, fmt: "No" }, "false"],
    [3000, 10, { raw: 1, fmt: "Yes" }, "true"],
    // xctrace's own sentinel mis-format, fixture-proven: raw 3 displayed "Yes"
    [4000, 10, { raw: 3, fmt: "Yes" }, "false"],
  ];
  for (const [stime, dur, sys, live] of rows) {
    writer.writeRow({
      stime: { type: "start-time", fmt: String(stime), raw: stime },
      dur: { type: "duration", fmt: String(dur), raw: dur },
      "is-system": { type: "boolean", fmt: sys.fmt, raw: sys.raw },
      live: { type: "string", fmt: live, raw: live },
    });
  }
  const rowCount = writer.finish();

  const session = { schemaModel: [] as unknown[], callCache: new Map<string, unknown>() };
  return {
    getSession: (_s: string) => session,
    getTable: async () => ({ schema: SCHEMA, cols, dbPath: ":memory:", tableName, rowCount }),
    getDb: async () => db,
    getSchemaMeta: async () => ({ cols, rowCount }),
    lastRun: () => RUN,
  };
});

const { findRows } = await import("../src/core/find.js");
const { aggregateTable } = await import("../src/core/aggregate.js");

describe("JSON boolean coercion — schema-table vocabulary (raw 0/1, fmt Yes/No)", () => {
  it("val:false matches the fmt=No rows (previously 0 rows via the string 'false')", async () => {
    const r = await findRows(SESSION_ID, SCHEMA, { where: [{ col: "is-system", op: "eq", val: false }] });
    expect(r.matchCount).toBe(2);
  });

  it("val:true matches Yes rows — including the sentinel-3 row xctrace itself formats as Yes", async () => {
    const r = await findRows(SESSION_ID, SCHEMA, { where: [{ col: "is-system", op: "eq", val: true }] });
    // Matching what the user SEES (fmt "Yes") — the raw-3 sentinel row displays
    // "Yes", so it matches; the describe_schema sentinel gotcha carries the
    // caveat rather than this predicate silently disagreeing with the display.
    expect(r.matchCount).toBe(2);
  });

  it("the string vocabulary still works unchanged", async () => {
    const r = await findRows(SESSION_ID, SCHEMA, { where: [{ col: "is-system", op: "eq", val: "No" }] });
    expect(r.matchCount).toBe(2);
  });

  it("boolean with a non-eq/ne op is a clear error, not silent garbage", async () => {
    await expect(
      findRows(SESSION_ID, SCHEMA, { where: [{ col: "is-system", op: "gt", val: true }] })
    ).rejects.toThrow(/boolean value only works with op "eq" or "ne"/);
  });
});

describe("JSON boolean coercion — track-detail vocabulary (literal 'true'/'false' strings)", () => {
  it("val:true matches the string-'true' rows", async () => {
    const r = await findRows(SESSION_ID, SCHEMA, { where: [{ col: "live", op: "eq", val: true }] });
    expect(r.matchCount).toBe(2);
  });

  it("val:false matches the string-'false' rows", async () => {
    const r = await findRows(SESSION_ID, SCHEMA, { where: [{ col: "live", op: "ne", val: true }] });
    expect(r.matchCount).toBe(2);
  });

  it("the literal string form keeps working untouched", async () => {
    const r = await findRows(SESSION_ID, SCHEMA, { where: [{ col: "live", op: "eq", val: "true" }] });
    expect(r.matchCount).toBe(2);
  });
});

describe("boolean coercion through equality filters (query/aggregate path)", () => {
  it("aggregate's filter accepts a JSON boolean", async () => {
    const r = await aggregateTable(SESSION_ID, SCHEMA, {
      groupBy: "is-system",
      op: "count",
      filter: { live: true },
    });
    const total = r.groups.reduce((a, g) => a + g.value, 0);
    expect(total).toBe(2);
  });
});
