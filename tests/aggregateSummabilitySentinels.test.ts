/**
 * PMT:haze-eagle Tier 1 — summability enforcement + max-sentinel exclusion
 * in aggregate(), driven by the generated engineeringTypeFacts module.
 *
 * Evidence base (aidocs/engineeringTypeReferenceAudit.md): before this,
 * SUM(pid)/AVG(core) returned plausible-looking void numbers, and real-db
 * AVG(errno) returned 1.675e18 instead of the honest 0.065 because 4-9% of
 * rows hold the type's max-sentinel ("missing/NA").
 *
 * Same synthetic-table + stubbed session.js pattern as
 * queryFindAggregateEmptyResults.test.ts.
 */
import { describe, it, expect, vi } from "vitest";

const SCHEMA = "syscall-like";
const RUN = 1;
const SESSION_ID = "session";

// Real-shape values, mirroring the verification pass's findings:
// - errno: mostly 0, a few real small errnos, sentinel rows at BOTH observed
//   producer magnitudes (2^64-class stored as digit-string TEXT, and 2^32−2).
// - pid: documented-categorical (17-bit, sentinel 131071).
// - stime: sample-time (50-bit, exact sentinel 2^50−1).
const UINT64_SENTINEL = "18446744073709551614";
const UINT32_SENTINEL = 4294967294;
const TIME_SENTINEL = 2 ** 50 - 1;

vi.mock("../src/engine/session.js", async () => {
  const { openSessionDb, SqliteTableWriter } = await import("../src/engine/sqliteStore.js");
  const { registerRegexpUdf, registerPercentileUdfs, registerInternDecodeUdf } = await import("../src/engine/sqlHydrate.js");

  const db = openSessionDb(":memory:", { journalMode: "default" });
  registerRegexpUdf(db);
  registerPercentileUdfs(db);
  registerInternDecodeUdf(db);

  const cols = [
    { mnemonic: "stime", name: "Start", engineeringType: "sample-time" },
    { mnemonic: "errno", name: "Errno", engineeringType: "syscall-return" },
    { mnemonic: "pid", name: "Pid", engineeringType: "pid" },
    { mnemonic: "name", name: "Name", engineeringType: "string" },
  ];

  const tableName = `${RUN}:syscall-like`;
  const writer = new SqliteTableWriter(db, tableName, cols);
  const rows: Array<[number | string, number | string, number, string]> = [
    [1000, 0, 100, "read"],
    [2000, 0, 100, "read"],
    [3000, 2, 100, "read"], // real errno 2
    [4000, UINT64_SENTINEL, 100, "read"], // 64-bit-class sentinel (TEXT digit string)
    [5000, UINT32_SENTINEL, 100, "read"], // 32-bit-class sentinel, same schema
    [TIME_SENTINEL, 0, 100, "read"], // time sentinel row (exact 50-bit max)
  ];
  for (const [stime, errno, pid, name] of rows) {
    writer.writeRow({
      stime: { type: "sample-time", fmt: String(stime), raw: stime },
      errno: { type: "syscall-return", fmt: String(errno), raw: errno },
      pid: { type: "pid", fmt: String(pid), raw: pid },
      name: { type: "string", fmt: name, raw: name },
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

const { aggregateTable } = await import("../src/core/aggregate.js");

describe("summability enforcement (categorical measures)", () => {
  it("rejects sum over a documented-categorical measure, naming the valid ones", async () => {
    await expect(
      aggregateTable(SESSION_ID, SCHEMA, { groupBy: "name", measure: "pid", op: "sum" })
    ).rejects.toThrow(/categorical.*cannot be summed or averaged.*Measure columns in this schema: stime, errno/s);
  });

  it("rejects avg the same way", async () => {
    await expect(
      aggregateTable(SESSION_ID, SCHEMA, { groupBy: "name", measure: "pid", op: "avg" })
    ).rejects.toThrow(/categorical/);
  });

  it("count needs no measure and stays allowed regardless", async () => {
    const r = await aggregateTable(SESSION_ID, SCHEMA, { groupBy: "pid", op: "count" });
    expect(r.groups[0].value).toBe(6);
  });
});

describe("max-sentinel exclusion for measures", () => {
  it("excludes both observed sentinel magnitudes from avg and says so in the note", async () => {
    const r = await aggregateTable(SESSION_ID, SCHEMA, { groupBy: "name", measure: "errno", op: "avg" });
    // Honest average over the 4 non-sentinel rows: (0+0+2+0)/4 = 0.5 —
    // including the sentinels would have produced ~3e18.
    expect(r.groups[0].value).toBeCloseTo(0.5);
    expect(r.note).toMatch(/2 rows.*sentinel/s);
  });

  it("excludes an exact-width sentinel (50-bit sample-time) via equality", async () => {
    const r = await aggregateTable(SESSION_ID, SCHEMA, { groupBy: "name", measure: "stime", op: "max" });
    // Max over non-sentinel rows is 5000 — the 2^50−1 sentinel row is excluded.
    expect(r.groups[0].value).toBe(5000);
    expect(r.note).toMatch(/1 row.*sentinel/s);
  });

  it("adds no note when no sentinel rows exist in the measure", async () => {
    const r = await aggregateTable(SESSION_ID, SCHEMA, { groupBy: "name", measure: "errno", op: "sum", filter: { pid: 100 }, timeRange: { startNs: 0, endNs: 3500 } });
    expect(r.note ?? "").not.toMatch(/sentinel/);
  });
});

const { findRows } = await import("../src/core/find.js");

describe("find's is-sentinel / not-sentinel ops (sentinel as a filterable-FOR subset)", () => {
  it("is-sentinel matches both observed producer magnitudes on a max-sentinel type", async () => {
    const r = await findRows(SESSION_ID, SCHEMA, { where: [{ col: "errno", op: "is-sentinel" }] });
    expect(r.matchCount).toBe(2); // the 2^64-class TEXT row AND the 2^32−2 row
  });

  it("not-sentinel is the complement over non-null rows", async () => {
    const r = await findRows(SESSION_ID, SCHEMA, { where: [{ col: "errno", op: "not-sentinel" }] });
    expect(r.matchCount).toBe(4);
  });

  it("is-sentinel on a time column matches the documented 2^50−1 max (missingness semantics)", async () => {
    const r = await findRows(SESSION_ID, SCHEMA, { where: [{ col: "stime", op: "is-sentinel" }] });
    expect(r.matchCount).toBe(1); // the TIME_SENTINEL row; no t=0 rows in this table
  });

  it("rejects is-sentinel on a type with no documented sentinel, with a clear error", async () => {
    await expect(
      findRows(SESSION_ID, SCHEMA, { where: [{ col: "name", op: "is-sentinel" }] })
    ).rejects.toThrow(/has no documented sentinel/);
  });
});
