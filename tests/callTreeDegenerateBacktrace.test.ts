/**
 * PMT:clear-crow — triaging the "attach-mode-degenerate-backtraces" candidate
 * in aidocs/adviceCaptureLog.md: recording Allocations via --attach against an
 * already-running process produced 275,314 rows where EVERY backtrace resolved
 * to the SAME single degenerate frame ("<Call stack limit reached>") — nothing
 * errors or warns, the recording looks completely normal, only the backtrace
 * CONTENT is silently useless. This promotes it from a pure documentation
 * candidate to an in-band call_tree note (destination 3): auto-derived from the
 * already-computed hot-function population, no separate scan needed.
 */
import { describe, it, expect, vi } from "vitest";

const SCHEMA = "allocations-backtraces";
const DIVERSE_SCHEMA = "allocations-backtraces-diverse";
const RUN = 1;
const SESSION_ID = "session";
const DEGENERATE_FRAME = "<Call stack limit reached>";

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
  const degenerateStack = [frame(DEGENERATE_FRAME)]; // the real attach-mode failure shape: exactly 1 frame
  const realStack = [frame("leafA"), frame("midA"), frame("rootA")];

  let t = 0;
  function writeRow(weight: number, frames: ReturnType<typeof frame>[]) {
    writer.writeRow({
      time: { type: "sample-time", fmt: String(t), raw: t },
      thread: { type: "thread", fmt: "0x1 Main Thread", raw: "0x1 Main Thread" },
      weight: { type: "weight", fmt: String(weight), raw: weight },
      stack: {
        type: "tagged-backtrace",
        fmt: frames.map((f) => f.name).join(" -> "),
        raw: frames.length,
        resolvedFrames: frames,
      },
    });
    t += 1000;
  }

  // Real captured shape: 275,314 rows all degenerate — pare down to a fast,
  // representative fixture (still well over the min-samples floor).
  const DEGENERATE_COUNT = 50;
  for (let i = 0; i < DEGENERATE_COUNT; i++) writeRow(64, degenerateStack);
  const rowCount = writer.finish();
  const handle = { schema: SCHEMA, cols, dbPath: ":memory:", tableName, rowCount };

  // Negative control (a different schema in the SAME db): normal, diverse
  // multi-frame backtraces — the note must NOT fire here, guarding against a
  // false positive on a legitimately-simple-but-real trace.
  const diverseTableName = `${RUN}:${DIVERSE_SCHEMA}`;
  const diverseWriter = new SqliteTableWriter(db, diverseTableName, cols);
  let dt = 0;
  const diverseStacks = [
    [frame("leafA"), frame("midA"), frame("rootA")],
    [frame("leafB"), frame("midB"), frame("rootB")],
    [frame("leafC"), frame("rootC")],
  ];
  for (let i = 0; i < 30; i++) {
    diverseWriter.writeRow({
      time: { type: "sample-time", fmt: String(dt), raw: dt },
      thread: { type: "thread", fmt: "0x1 Main Thread", raw: "0x1 Main Thread" },
      weight: { type: "weight", fmt: "64", raw: 64 },
      stack: {
        type: "tagged-backtrace",
        fmt: diverseStacks[i % 3].map((f) => f.name).join(" -> "),
        raw: diverseStacks[i % 3].length,
        resolvedFrames: diverseStacks[i % 3],
      },
    });
    dt += 1000;
  }
  const diverseRowCount = diverseWriter.finish();
  const diverseHandle = { schema: DIVERSE_SCHEMA, cols, dbPath: ":memory:", tableName: diverseTableName, rowCount: diverseRowCount };

  const handles: Record<string, typeof handle> = { [SCHEMA]: handle, [DIVERSE_SCHEMA]: diverseHandle };
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

const { callTree } = await import("../src/core/callTree.js");

describe("call_tree degenerate-backtrace note (attach-mode fidelity issue)", () => {
  it("flags a population where EVERY backtrace resolves to the same degenerate frame", async () => {
    const tree = await callTree(SESSION_ID, SCHEMA, { view: "hot" });
    expect(tree.totalSamples).toBe(50);
    expect(tree.note).toBeDefined();
    expect(tree.note).toMatch(/same single degenerate frame/i);
    expect(tree.note).toMatch(/attach/i);
    expect(tree.note).toMatch(/launch/i);
  });

  it("fires for the tree and spine views too, not just hot", async () => {
    const tree = await callTree(SESSION_ID, SCHEMA, { view: "tree" });
    expect(tree.note).toMatch(/degenerate frame/i);

    const spine = await callTree(SESSION_ID, SCHEMA, { view: "spine" });
    expect(spine.note).toMatch(/degenerate frame/i);
  });

  it("does NOT fire on a normal, diverse backtrace population (no false positive)", async () => {
    const tree = await callTree(SESSION_ID, DIVERSE_SCHEMA, { view: "hot" });
    expect(tree.totalSamples).toBe(30);
    expect(tree.note ?? "").not.toMatch(/degenerate frame/i);
  });
});
