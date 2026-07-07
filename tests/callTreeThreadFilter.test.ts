/**
 * Regression test for a live bug: call_tree's `thread` filter matched ZERO
 * samples on a real time-profile trace for every value tried (a tid
 * substring, "0x350e17"/"350e17", a thread name "Main Thread", even a
 * process name), while find()/query() matched thousands of rows for the
 * SAME substrings on the SAME schema. Root-caused to two independent breaks
 * introduced by the SQLite size-reduction work (PMT:ruddy-owl interning +
 * the general dusk-floe SQL cutover), both fixed in src/core/callTree.ts:
 *
 *  1. threadCol resolution used a naive `cols.find(c => c.engineeringType
 *     === "thread")` — the FIRST column with that exact declared type wins,
 *     which silently picks the wrong column when a schema carries more than
 *     one thread-role column (e.g. both "process" and "thread" are
 *     engineering-type "thread"). find/query don't have this problem because
 *     the AI names the column directly; call_tree has to infer it, and must
 *     do so the same principled way (classifyWithHints + preferredThreadColumn)
 *     instead of a first-match scan.
 *
 *  2. Even once the right column is picked, its __fmt cell can be a
 *     flavor-2-interned SENTINEL token rather than the literal display text
 *     (any thread column is exactly the low-cardinality/high-repeat shape
 *     PMT:ruddy-owl targets — a handful of distinct threads repeated across
 *     every sample). find/query already decode through sqlHydrate's
 *     internResolved() before matching; call_tree's LIKE clause did not, so
 *     it was comparing a substring against an opaque token and could never
 *     match ANY value once interning kicked in.
 *
 * This test builds a synthetic time-profile-shaped table (SqliteTableWriter,
 * bypassing the live xctrace/.trace pipeline entirely — session.ts's module
 * is stubbed) that reproduces BOTH conditions at once: a distractor
 * "process" column ordered before "thread" (both engineering-type "thread"),
 * with the thread column's values forced into flavor-2 interning. It fails
 * if EITHER fix is reverted, and passes only with both in place.
 */
import { describe, it, expect, vi } from "vitest";

const SCHEMA = "time-profile";
const RUN = 1;
const SESSION_ID = "session";

const MAIN_THREAD_FMT = "0x350e17  Main Thread";
const WORKER_THREAD_FMT = "0x220011  Worker Thread";
const PROCESS_FMT = "com.example.App (1234)"; // distractor column's value — never contains a thread substring

vi.mock("../src/engine/session.js", async () => {
  const { openSessionDb, SqliteTableWriter } = await import("../src/engine/sqliteStore.js");
  const { registerRegexpUdf, registerPercentileUdfs, registerInternDecodeUdf } = await import("../src/engine/sqlHydrate.js");

  const db = openSessionDb(":memory:", { journalMode: "default" });
  registerRegexpUdf(db);
  registerPercentileUdfs(db);
  registerInternDecodeUdf(db);

  const cols = [
    { mnemonic: "time", name: "Timestamp", engineeringType: "sample-time" },
    // Distractor: declared engineering-type "thread" too, and ordered BEFORE
    // the real "thread" column — a naive first-match scan picks this one.
    { mnemonic: "process", name: "Process", engineeringType: "thread" },
    { mnemonic: "thread", name: "Thread", engineeringType: "thread" },
    { mnemonic: "weight", name: "Weight", engineeringType: "weight" },
    { mnemonic: "stack", name: "Stack", engineeringType: "tagged-backtrace" },
  ];

  const tableName = `${RUN}:${SCHEMA}`;
  // Force "thread"/"process" into flavor-2 interning regardless of natural
  // row-count statistics (the constructor's own injection point for exactly
  // this — "tests / a caller that already knows the flavor-2 columns") so a
  // small, fast fixture still exercises the real sentinel-token storage
  // format a large low-cardinality thread column gets in production.
  const writer = new SqliteTableWriter(db, tableName, cols, {
    internColumns: new Set(["thread", "process"]),
  });

  function frame(name: string) {
    return { name, addr: "0x1", binaryName: "App", binaryPath: "/App" };
  }
  const mainStack = [frame("leafA"), frame("midA"), frame("rootA")]; // leaf-first
  const workerStack = [frame("leafB"), frame("rootB")];

  let t = 0;
  function writeRow(threadFmt: string, weight: number, frames: ReturnType<typeof frame>[]) {
    writer.writeRow({
      time: { type: "sample-time", fmt: String(t), raw: t },
      process: { type: "thread", fmt: PROCESS_FMT, raw: PROCESS_FMT },
      thread: { type: "thread", fmt: threadFmt, raw: threadFmt },
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

  const MAIN_COUNT = 4;
  const WORKER_COUNT = 3;
  for (let i = 0; i < MAIN_COUNT; i++) writeRow(MAIN_THREAD_FMT, 100, mainStack);
  for (let i = 0; i < WORKER_COUNT; i++) writeRow(WORKER_THREAD_FMT, 50, workerStack);
  const rowCount = writer.finish();

  // Sanity guard against the test silently becoming vacuous: confirm the
  // forced interning actually produced sentinel rows in interned_values —
  // if a future refactor changes the injection API and this stops doing
  // anything, this assertion (not the real test bodies) is what should fail.
  const internedCount = (db.prepare("SELECT COUNT(*) AS n FROM interned_values").get() as { n: number }).n;
  if (internedCount === 0) {
    throw new Error("test fixture setup failed to intern any values — internColumns injection broke");
  }

  const handle = {
    schema: SCHEMA,
    cols,
    dbPath: ":memory:",
    tableName,
    rowCount,
  };

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

const { callTree } = await import("../src/core/callTree.js");
const { findRows } = await import("../src/core/find.js");

describe("call_tree thread filter (regression: wrong-column-pick + un-decoded intern sentinel)", () => {
  it("matches the SAME population find() matches for a tid substring", async () => {
    const found = await findRows(SESSION_ID, SCHEMA, {
      where: [{ col: "thread", op: "contains", val: "350e17" }],
    });
    expect(found.matchCount).toBe(4);

    const tree = await callTree(SESSION_ID, SCHEMA, { thread: "350e17" });
    expect(tree.totalSamples).toBe(4);
  });

  it("matches on a thread NAME substring, not just the tid", async () => {
    const tree = await callTree(SESSION_ID, SCHEMA, { thread: "Main Thread" });
    expect(tree.totalSamples).toBe(4);
  });

  it("matches the worker thread's samples distinctly from the main thread's", async () => {
    const tree = await callTree(SESSION_ID, SCHEMA, { thread: "220011" });
    expect(tree.totalSamples).toBe(3);
  });

  it("is not fooled by the distractor process column's own value", async () => {
    // PROCESS_FMT never contains a thread substring — if threadCol had
    // resolved to "process" (the old naive first-match bug), every one of
    // the above assertions would already have failed with 0. This just
    // pins the negative-control shape explicitly.
    const tree = await callTree(SESSION_ID, SCHEMA, { thread: PROCESS_FMT });
    expect(tree.totalSamples).toBe(0);
  });

  it("returns a genuine 0 for a value nothing matches (not a false empty)", async () => {
    const tree = await callTree(SESSION_ID, SCHEMA, { thread: "NoSuchThreadXYZ" });
    expect(tree.totalSamples).toBe(0);
    expect(tree.roots).toEqual([]);
  });

  it("unfiltered call_tree still returns every sample", async () => {
    const tree = await callTree(SESSION_ID, SCHEMA, {});
    expect(tree.totalSamples).toBe(7);
  });

  it("holds for the hot and spine views too, not just the default tree view", async () => {
    const hot = await callTree(SESSION_ID, SCHEMA, { thread: "350e17", view: "hot" });
    expect(hot.totalSamples).toBe(4);
    expect(hot.hotFunctions && hot.hotFunctions.length > 0).toBe(true);

    const spine = await callTree(SESSION_ID, SCHEMA, { thread: "350e17", view: "spine" });
    expect(spine.totalSamples).toBe(4);
    expect(spine.spine && spine.spine.length > 0).toBe(true);
  });
});
