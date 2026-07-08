/**
 * PMT:thorny-verge — call_tree's self-describing empty result: the deferred
 * f3203f0 bonus. Distinguishes a thread filter that matched nothing (the
 * schema has samples, wrong substring — the exact class of bug f3203f0
 * itself fixed) from a genuinely off-CPU/idle time window (no samples
 * anywhere in that window, not just for one thread).
 *
 * Same synthetic-table + stubbed session.js pattern as
 * callTreeThreadFilter.test.ts.
 */
import { describe, it, expect, vi } from "vitest";

const SCHEMA = "time-profile";
const RUN = 1;
const SESSION_ID = "session";

const MAIN_THREAD_FMT = "0x350e17  Main Thread";

vi.mock("../src/engine/session.js", async () => {
  const { openSessionDb, SqliteTableWriter } = await import("../src/engine/sqliteStore.js");
  const { registerRegexpUdf, registerPercentileUdfs, registerInternDecodeUdf } = await import("../src/engine/sqlHydrate.js");

  const db = openSessionDb(":memory:", { journalMode: "default" });
  registerRegexpUdf(db);
  registerPercentileUdfs(db);
  registerInternDecodeUdf(db);

  const cols = [
    { mnemonic: "time", name: "Timestamp", engineeringType: "sample-time" },
    { mnemonic: "thread", name: "Thread", engineeringType: "thread" },
    { mnemonic: "weight", name: "Weight", engineeringType: "weight" },
    { mnemonic: "stack", name: "Stack", engineeringType: "tagged-backtrace" },
  ];

  const tableName = `${RUN}:${SCHEMA}`;
  const writer = new SqliteTableWriter(db, tableName, cols);

  function frame(name: string) {
    return { name, addr: "0x1", binaryName: "App", binaryPath: "/App" };
  }
  const stack = [frame("leaf"), frame("root")];

  // 5 samples clustered early in the trace (t = 0..4000) — a later window
  // (e.g. 100000+) has genuinely no samples at all, on ANY thread.
  for (let i = 0; i < 5; i++) {
    writer.writeRow({
      time: { type: "sample-time", fmt: String(i * 1000), raw: i * 1000 },
      thread: { type: "thread", fmt: MAIN_THREAD_FMT, raw: MAIN_THREAD_FMT },
      weight: { type: "weight", fmt: "100", raw: 100 },
      stack: {
        type: "tagged-backtrace",
        fmt: stack.map((f) => f.name).join(" -> "),
        raw: stack.length,
        resolvedFrames: stack,
      },
    });
  }
  const rowCount = writer.finish();

  const handle = { schema: SCHEMA, cols, dbPath: ":memory:", tableName, rowCount };
  const session = { schemaModel: [] as unknown[], callCache: new Map<string, unknown>() };

  return {
    getSession: (_sessionId: string) => session,
    getTable: async (_sessionId: string, _run: number, _schema: string, _position?: number) => handle,
    getDb: async (_sessionId: string) => db,
    getSchemaMeta: async (_sessionId: string, _run: number, _schema: string, _position?: number) => ({ cols, rowCount }),
    lastRun: (_sessionId: string) => RUN,
  };
});

const { callTree } = await import("../src/core/callTree.js");

describe("call_tree zero-samples note", () => {
  it("distinguishes a thread filter matching nothing from a genuinely empty schema", async () => {
    const result = await callTree(SESSION_ID, SCHEMA, { thread: "NoSuchThreadSubstring" });
    expect(result.totalSamples).toBe(0);
    expect(result.note).toMatch(/0 samples matched thread filter "NoSuchThreadSubstring"/);
    expect(result.note).toMatch(/5 sample/);
  });

  it("reports a genuinely off-CPU/idle window when the timeRange has no samples anywhere", async () => {
    const result = await callTree(SESSION_ID, SCHEMA, { timeRange: { startNs: 1_000_000, endNs: 2_000_000 } });
    expect(result.totalSamples).toBe(0);
    expect(result.note).toMatch(/off-CPU\/idle/);
    expect(result.note).toMatch(/5 sample/);
  });

  it("carries no zero-samples note when samples actually match", async () => {
    const result = await callTree(SESSION_ID, SCHEMA, {});
    expect(result.totalSamples).toBe(5);
    expect(result.note).toBeUndefined();
  });
});
