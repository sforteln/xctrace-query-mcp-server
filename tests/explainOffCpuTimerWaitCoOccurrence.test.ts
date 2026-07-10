/**
 * PMT:serene-elk — a dominant Thread.sleep syscall wait must classify as
 * timer-wait (not unclassified), AND a co-occurring real scheduling-delay
 * signal in the same window must not go unmentioned in the one-line summary.
 *
 * Verified live against the real off-CPU retrospective's Session 2 trace
 * (2026-07-09T03-31-24-system-trace.trace, row 7950): the dominant wait in
 * that window IS a 104.8ms +[NSThread sleepForTimeInterval:] call, and
 * thread-state ALSO shows a real 11.8ms Runnable gap overlapping the same
 * window — schedulingDelay was already correctly attached before this fix,
 * but the summary line never mentioned it, so an agent skimming just that
 * line had no cue to look for it. This synthetic fixture reproduces the
 * same shape (dominant timer-wait + co-occurring scheduling delay) to
 * regression-test both fixes together.
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
  const syscallTableName = `${RUN}:${SYSCALL_SCHEMA}`;
  const syscallWriter = new SqliteTableWriter(db, syscallTableName, syscallCols);

  // Real resolved frame sequence from Session 2's trace, row 7950 (leaf-first).
  const sleepFrames = [
    { name: "__semwait_signal", addr: "0x1", binaryName: "libsystem_kernel.dylib", binaryPath: null },
    { name: "nanosleep", addr: "0x2", binaryName: "libsystem_c.dylib", binaryPath: null },
    { name: "+[NSThread sleepForTimeInterval:]", addr: "0x3", binaryName: "Foundation", binaryPath: null },
    { name: "static OffCPUTestHarness.scenario4_schedulingDelay()", addr: "0x4", binaryName: "App", binaryPath: null },
  ];
  syscallWriter.writeRow({
    start: { type: "start-time", fmt: "9998353625", raw: 9_998_353_625 },
    duration: { type: "duration", fmt: "104766000", raw: 104_766_000 },
    waittime: { type: "duration-waiting", fmt: "104758750", raw: 104_758_750 },
    cputime: { type: "duration-on-core", fmt: "3821376", raw: 3_821_376 },
    thread: { type: "thread", fmt: "Main Thread", raw: "Main Thread" },
    call: { type: "syscall", fmt: "semwait_signal", raw: "semwait_signal" },
    backtrace: {
      type: "backtrace",
      fmt: sleepFrames.map((f) => f.name).join(" -> "),
      raw: sleepFrames.length,
      resolvedFrames: sleepFrames,
    },
  });
  const syscallRowCount = syscallWriter.finish();

  const threadStateCols = [
    { mnemonic: "start", name: "Start", engineeringType: "start-time" },
    { mnemonic: "duration", name: "Duration", engineeringType: "duration" },
    { mnemonic: "state", name: "State", engineeringType: "thread-state" },
    { mnemonic: "thread", name: "Thread", engineeringType: "thread" },
  ];
  const threadStateTableName = `${RUN}:${THREAD_STATE_SCHEMA}`;
  const threadStateWriter = new SqliteTableWriter(db, threadStateTableName, threadStateCols);
  // A real Runnable gap overlapping the syscall window above.
  threadStateWriter.writeRow({
    start: { type: "start-time", fmt: "9998000000", raw: 9_998_000_000 },
    duration: { type: "duration", fmt: "11765500", raw: 11_765_500 },
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

describe("explainOffCpuInterval — timer-wait dominant, with a co-occurring scheduling delay (PMT:serene-elk)", () => {
  it("classifies the dominant wait as timer-wait AND surfaces the co-occurring scheduling delay in both the field and the summary line", async () => {
    const result = await explainOffCpuInterval(SESSION_ID, {
      startNs: 9_998_353_625,
      endNs: 9_998_353_625 + 104_766_000,
      thread: "Main Thread",
    });

    expect(result.waitsInWindow).toBe(1);
    expect(result.classification?.class).toBe("timer-wait");
    expect(result.classification?.timerMarker).toBe("+[NSThread sleepForTimeInterval:]");

    // The co-occurring scheduling delay must NOT be silently dropped just
    // because the dominant wait got a confident, benign-sounding label.
    expect(result.schedulingDelay).toBeDefined();
    expect(result.schedulingDelay?.runnableMs).toBeCloseTo(11.77, 1);
    expect(result.summary).toMatch(/timer-wait/);
    expect(result.summary).toMatch(/ALSO shows a .* scheduling delay/);
  });
});
