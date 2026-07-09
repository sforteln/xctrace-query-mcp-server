/**
 * query()/find() cap + redact large cell values the same way get_row does.
 *
 * Verified live (a Foundation Models + SwiftUI retrospective session,
 * 2026-07-09): a 12-row ModelInferenceTable query() returned 163,000
 * characters — query()'s own contract is "summary rows, full detail via
 * get_row" (src/core/query.ts's own file header), but nothing was actually
 * enforcing that for large per-cell values (a full prompt/response text
 * field, same failure shape get_row's own fix (PMT:loam-merlin) already
 * covered). The caller had to work around it by saving the response to a
 * file and reading it back in chunks — real wasted tokens/turns.
 *
 * Same synthetic-table + stubbed session.js pattern as
 * queryFindAggregateEmptyResults.test.ts.
 */
import { describe, it, expect, vi } from "vitest";

const SCHEMA = "big-cell-table";
const RUN = 1;
const SESSION_ID = "session";
const MAX_CELL_CHARS = 2000;
const HUGE_PROMPT = "The quick brown fox. ".repeat(500); // ~11,000 chars — well past the cap
const HEADER_BLOCK = "(Accept : */*), (Authorization : Bearer super-secret-token-xyz)";

vi.mock("../src/engine/session.js", async () => {
  const { openSessionDb, SqliteTableWriter } = await import("../src/engine/sqliteStore.js");
  const { registerRegexpUdf, registerPercentileUdfs, registerInternDecodeUdf } = await import("../src/engine/sqlHydrate.js");

  const db = openSessionDb(":memory:", { journalMode: "default" });
  registerRegexpUdf(db);
  registerPercentileUdfs(db);
  registerInternDecodeUdf(db);

  const cols = [
    { mnemonic: "prompt", name: "Prompt", engineeringType: "string" },
    { mnemonic: "request-headers", name: "Request Headers", engineeringType: "string" },
  ];

  const tableName = `${RUN}:${SCHEMA}`;
  const writer = new SqliteTableWriter(db, tableName, cols);
  writer.writeRow({
    prompt: { type: "string", fmt: HUGE_PROMPT, raw: HUGE_PROMPT },
    "request-headers": { type: "string", fmt: HEADER_BLOCK, raw: HEADER_BLOCK },
  });
  const rowCount = writer.finish();

  const handle = { schema: SCHEMA, cols, dbPath: ":memory:", tableName, rowCount };
  const session = { schemaModel: [] as unknown[], callCache: new Map<string, unknown>() };

  return {
    getSession: (_sessionId: string) => session,
    getTable: async () => handle,
    getDb: async () => db,
    getSchemaMeta: async () => ({ cols, rowCount: handle.rowCount }),
    lastRun: (_sessionId: string) => RUN,
  };
});

const { queryTable } = await import("../src/core/query.js");
const { findRows } = await import("../src/core/find.js");

describe("query() caps + redacts large cells", () => {
  it("truncates a huge prompt field to MAX_CELL_CHARS", async () => {
    const result = await queryTable(SESSION_ID, SCHEMA, {});
    const cell = result.rows[0].cells.prompt!;
    expect(cell.length).toBeLessThan(HUGE_PROMPT.length);
    expect(cell.length).toBeLessThanOrEqual(MAX_CELL_CHARS + 60); // cap + truncation-note overhead
    expect(cell).toMatch(/truncated/);
  });

  it("redacts a sensitive header value in a header-shaped column", async () => {
    const result = await queryTable(SESSION_ID, SCHEMA, {});
    const cell = result.rows[0].cells["request-headers"]!;
    expect(cell).not.toContain("super-secret-token-xyz");
    expect(cell).toContain("[REDACTED]");
    expect(cell).toContain("Accept : */*"); // benign headers untouched
  });
});

describe("find() caps + redacts large cells", () => {
  it("truncates a huge prompt field to MAX_CELL_CHARS", async () => {
    const result = await findRows(SESSION_ID, SCHEMA, { where: [] });
    const cell = result.rows[0].cells.prompt!;
    expect(cell.length).toBeLessThanOrEqual(MAX_CELL_CHARS + 60);
    expect(cell).toMatch(/truncated/);
  });

  it("redacts a sensitive header value in a header-shaped column", async () => {
    const result = await findRows(SESSION_ID, SCHEMA, { where: [] });
    const cell = result.rows[0].cells["request-headers"]!;
    expect(cell).not.toContain("super-secret-token-xyz");
    expect(cell).toContain("[REDACTED]");
  });
});
