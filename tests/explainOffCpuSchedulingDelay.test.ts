/**
 * PMT:slow-cobble — explainOffCpuInterval's `rows.length === 0` branch (no
 * blocking syscall overlaps the window) must promote a thread-state
 * scheduling-delay to a real classification instead of hardcoding null, per
 * the retrospective's Session 3 finding (CPU-spin warmup scenario: a real
 * thread-state Runnable gap with zero blocking syscalls in the window).
 */
import { describe, it, expect, vi } from "vitest";

const RUN = 1;
const SESSION_ID = "session";
const SYSCALL_SCHEMA = "syscall";
const THREAD_STATE_SCHEMA = "thread-state";

vi.mock("../src/engine/session.js", async () => {
  const { openSessionDb, SqliteTableWriter } = await import("../src/engine/sqliteStore.js");
  const { registerRegexpUdf, registerPercentileUdfs, registerInternDecodeUdf } = await import("../src/engine/sqlHydrate.js");

  const db = openSessionDb(":memory:", { journalMode: "default" });
  registerRegexpUdf(db);
  registerPercentileUdfs(db);
  registerInternDecodeUdf(db);

  const syscallCols = [
    { mnemonic: "start", name: "Start", engineeringType: "start-time" },
    { mnemonic: "duration", name: "Duration", engineeringType: "duration" },
    { mnemonic: "waittime", name: "Wait Time", engineeringType: "duration-waiting" },
    { mnemonic: "cputime", name: "CPU Time", engineeringType: "duration-on-core" },
    { mnemonic: "thread", name: "Thread", engineeringType: "thread" },
    { mnemonic: "call", name: "Call", engineeringType: "syscall" },
    { mnemonic: "backtrace", name: "Backtrace", engineeringType: "backtrace" },
  ];
  // Empty syscall table (schema present, cols known — but 0 rows) for BOTH
  // scenarios below: with a CPU-spin warmup, there is no blocking syscall in
  // the window at all, so the dominant-wait query always comes back empty.
  const syscallTableName = `${RUN}:${SYSCALL_SCHEMA}`;
  const syscallWriter = new SqliteTableWriter(db, syscallTableName, syscallCols);
  const syscallRowCount = syscallWriter.finish();

  const threadStateCols = [
    { mnemonic: "start", name: "Start", engineeringType: "start-time" },
    { mnemonic: "duration", name: "Duration", engineeringType: "duration" },
    { mnemonic: "state", name: "State", engineeringType: "thread-state" },
    { mnemonic: "thread", name: "Thread", engineeringType: "thread" },
  ];
  const threadStateTableName = `${RUN}:${THREAD_STATE_SCHEMA}`;
  const threadStateWriter = new SqliteTableWriter(db, threadStateTableName, threadStateCols);
  // A real Runnable gap overlapping [10_000_000, 30_000_000]: 16.3ms runnable,
  // starting just before the window and extending through it.
  threadStateWriter.writeRow({
    start: { type: "start-time", fmt: "5000000", raw: 5_000_000 },
    duration: { type: "duration", fmt: "16300000", raw: 16_300_000 },
    state: { type: "thread-state", fmt: "Runnable", raw: "Runnable" },
    thread: { type: "thread", fmt: "Main Thread", raw: "Main Thread" },
  });
  const threadStateRowCount = threadStateWriter.finish();

  const handles: Record<string, { schema: string; cols: unknown[]; dbPath: string; tableName: string; rowCount: number }> = {
    [SYSCALL_SCHEMA]: { schema: SYSCALL_SCHEMA, cols: syscallCols, dbPath: ":memory:", tableName: syscallTableName, rowCount: syscallRowCount },
    [THREAD_STATE_SCHEMA]: { schema: THREAD_STATE_SCHEMA, cols: threadStateCols, dbPath: ":memory:", tableName: threadStateTableName, rowCount: threadStateRowCount },
  };

  const schemaModel = [
    { run: RUN, toc: { schema: SYSCALL_SCHEMA } },
    { run: RUN, toc: { schema: THREAD_STATE_SCHEMA } },
  ];

  return {
    getTable: async (_sessionId: string, _run: number, schema: string) => handles[schema],
    getDb: async (_sessionId: string) => db,
    getSchemaModel: (_sessionId: string) => schemaModel,
    lastRun: (_sessionId: string) => RUN,
  };
});

const { explainOffCpuInterval } = await import("../src/core/explainOffCpu.js");

describe("explainOffCpuInterval — scheduling-delay promotion (PMT:slow-cobble)", () => {
  it("classifies as scheduling-delay when 0 syscall waits overlap but thread-state shows a real Runnable gap", async () => {
    const result = await explainOffCpuInterval(SESSION_ID, { startNs: 10_000_000, endNs: 30_000_000 });

    expect(result.waitsInWindow).toBe(0);
    expect(result.evidence).toBeNull();
    expect(result.classification).not.toBeNull();
    expect(result.classification?.class).toBe("scheduling-delay");
    expect(result.classification?.headline).toMatch(/runnable/i);
    expect(result.classification?.headline).toMatch(/16\.3/);
    expect(result.classification?.deepestWaitFrame).toBeNull();
    expect(result.schedulingDelay).toBeDefined();
    expect(result.schedulingDelay?.runnableMs).toBeCloseTo(16.3, 1);
    expect(result.summary).toMatch(/scheduling-delay/);
    // With a real classification, the "not proof of blocked" caveat note
    // (meant for the genuinely-nothing-found case) should NOT be attached.
    expect(result.note).toBeUndefined();
  });

  it("stays classification: null when there is neither a syscall wait nor a scheduling delay", async () => {
    // A window with no overlap at all with the thread-state Runnable row
    // (which spans [5_000_000, 21_300_000]) and no syscall rows either.
    const result = await explainOffCpuInterval(SESSION_ID, { startNs: 1_000_000_000, endNs: 1_000_100_000 });

    expect(result.waitsInWindow).toBe(0);
    expect(result.classification).toBeNull();
    expect(result.schedulingDelay).toBeUndefined();
    expect(result.note).toMatch(/NOT proof of "blocked"/);
  });
});
