/**
 * PMT:dusty-loam — call_tree(view: "spine") used to always return the
 * complete, untrimmed root-to-leaf chain. Live xcodeAI feedback: a real
 * 209-frame-deep main-thread spine exceeded the calling harness's own
 * oversized-tool-result threshold and got redirected to a file, with only a
 * head-truncated preview (showing nothing but run-loop boilerplate) returned
 * inline. The signal on a spine is always leaf-ward, never root-ward — the
 * root-ward prefix above appCodeStartsAtDepth is mandatory scaffolding
 * present in every sample on that thread, idle or busy.
 *
 * This covers the new default behavior: spine now returns only frames from
 * appCodeStartsAtDepth onward by default (a real size reduction, not just a
 * reordering — array order stays root-to-leaf, per the explicit design
 * decision to NOT reverse it), with `leaf: N` and `full: true` as explicit
 * overrides, and a fixed tail-window fallback when appCodeStartsAtDepth is
 * null (no wait frame anywhere on the path — no natural cut point to use).
 *
 * Three independent synthetic backtraces, distinguished by thread substring,
 * share one fixture table (mirrors callTreeThreadFilter.test.ts's pattern):
 *  - "ThreadA": a realistic 5-frame chain with a WAIT_FRAME_NAMES frame
 *    (CFRunLoopRun) at depth 1 — exercises the default trim + leaf/full.
 *  - "ThreadB": a 40-frame chain with NO wait frame at all — exercises the
 *    fixed-tail fallback (appCodeStartsAtDepth null, chain longer than the cap).
 *  - "ThreadC": a 5-frame chain with NO wait frame — confirms the fallback
 *    does NOT trim when the chain is already shorter than the cap.
 */
import { describe, it, expect, vi } from "vitest";

const SCHEMA = "time-profile";
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
    { mnemonic: "thread", name: "Thread", engineeringType: "thread" },
    { mnemonic: "weight", name: "Weight", engineeringType: "weight" },
    { mnemonic: "stack", name: "Stack", engineeringType: "tagged-backtrace" },
  ];

  const tableName = `${RUN}:${SCHEMA}`;
  const writer = new SqliteTableWriter(db, tableName, cols);

  function frame(name: string) {
    return { name, addr: "0x1", binaryName: "App", binaryPath: "/App" };
  }

  // Leaf-first (frame_index 0 = deepest), matching the real ingested shape —
  // callTree.ts reverses this to root-first before folding.
  const withWaitStack = [
    frame("MyView.layoutSubviews"),
    frame("MyView.render"),
    frame("AppDelegate.handleEvent"),
    frame("CFRunLoopRun"), // WAIT_FRAME_NAMES member
    frame("NSApplicationMain"),
  ]; // root-first: NSApplicationMain(0) CFRunLoopRun(1) AppDelegate.handleEvent(2) MyView.render(3) MyView.layoutSubviews(4)

  const deepNoWaitStack = Array.from({ length: 40 }, (_, i) => frame(`deepFrame${39 - i}`));
  // root-first: deepFrame0(0) ... deepFrame39(39, leaf) — none match WAIT_FRAME_NAMES.

  const shortNoWaitStack = Array.from({ length: 5 }, (_, i) => frame(`shallowFrame${4 - i}`));
  // root-first: shallowFrame0(0) ... shallowFrame4(4, leaf) — none match WAIT_FRAME_NAMES.

  let t = 0;
  function writeRow(threadFmt: string, frames: ReturnType<typeof frame>[]) {
    writer.writeRow({
      time: { type: "sample-time", fmt: String(t), raw: t },
      thread: { type: "thread", fmt: threadFmt, raw: threadFmt },
      weight: { type: "weight", fmt: "100", raw: 100 },
      stack: {
        type: "tagged-backtrace",
        fmt: frames.map((f) => f.name).join(" -> "),
        raw: frames.length,
        resolvedFrames: frames,
      },
    });
    t += 1000;
  }

  writeRow("0xAAAA  ThreadA", withWaitStack);
  writeRow("0xBBBB  ThreadB", deepNoWaitStack);
  writeRow("0xCCCC  ThreadC", shortNoWaitStack);
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

describe("call_tree(view: spine) — default trim, leaf, full (PMT:dusty-loam)", () => {
  it("default: trims to appCodeStartsAtDepth onward, root-to-leaf order preserved", async () => {
    const result = await callTree(SESSION_ID, SCHEMA, { thread: "ThreadA", view: "spine" });
    expect(result.appCodeStartsAtDepth).toBe(2);
    expect(result.spineFramesOmitted).toBe(2);
    expect(result.spine?.map((f) => f.name)).toEqual([
      "AppDelegate.handleEvent",
      "MyView.render",
      "MyView.layoutSubviews",
    ]);
    // depth stays ABSOLUTE (into the full chain), not renumbered from 0.
    expect(result.spine?.[0].depth).toBe(2);
    expect(result.spine?.[result.spine.length - 1].depth).toBe(4);
  });

  it("leaf: N overrides the default trim with a fixed-size window", async () => {
    const result = await callTree(SESSION_ID, SCHEMA, { thread: "ThreadA", view: "spine", leaf: 2 });
    expect(result.spine?.map((f) => f.name)).toEqual(["MyView.render", "MyView.layoutSubviews"]);
    expect(result.spineFramesOmitted).toBe(3);
  });

  it("full: true returns the complete untrimmed root-to-leaf chain", async () => {
    const result = await callTree(SESSION_ID, SCHEMA, { thread: "ThreadA", view: "spine", full: true });
    expect(result.spine?.map((f) => f.name)).toEqual([
      "NSApplicationMain",
      "CFRunLoopRun",
      "AppDelegate.handleEvent",
      "MyView.render",
      "MyView.layoutSubviews",
    ]);
    expect(result.spineFramesOmitted).toBeUndefined();
    // appCodeStartsAtDepth is still surfaced as an informational pointer even
    // though nothing was trimmed this time.
    expect(result.appCodeStartsAtDepth).toBe(2);
  });

  it("fallback: no wait frame anywhere and chain longer than the cap trims to a fixed tail window", async () => {
    const result = await callTree(SESSION_ID, SCHEMA, { thread: "ThreadB", view: "spine" });
    expect(result.appCodeStartsAtDepth).toBeNull();
    expect(result.spineFramesOmitted).toBe(10);
    expect(result.spine?.length).toBe(30);
    expect(result.spine?.[0].name).toBe("deepFrame10");
    expect(result.spine?.[result.spine.length - 1].name).toBe("deepFrame39");
  });

  it("fallback: no wait frame but chain already shorter than the cap is left untrimmed", async () => {
    const result = await callTree(SESSION_ID, SCHEMA, { thread: "ThreadC", view: "spine" });
    expect(result.appCodeStartsAtDepth).toBeNull();
    expect(result.spineFramesOmitted).toBeUndefined();
    expect(result.spine?.map((f) => f.name)).toEqual([
      "shallowFrame0", "shallowFrame1", "shallowFrame2", "shallowFrame3", "shallowFrame4",
    ]);
  });
});
