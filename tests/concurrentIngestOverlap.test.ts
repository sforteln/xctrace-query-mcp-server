/**
 * PMT:harsh-brook — two DIFFERENT fresh schemas' `xctrace export` subprocess
 * spawns must overlap (Promise.all's expressed intent in relate.ts/
 * correlate.ts), while the actual db-writing consume+parse+insert step must
 * still serialize one-at-a-time on the session's single connection (the
 * invariant sessionIngestChain exists to protect).
 *
 * Deliberately uses injected/mocked timing, not real xctrace/wall-clock
 * races (see the prompt's own item 4) — the ordering assertions below are
 * gated by polling for specific callLog entries to appear (real fs I/O
 * happens before the mocked export spawn — getSessionDb opens a real
 * sqlite cache file — so a bounded poll is used instead of a fixed
 * microtask-flush count) plus one manually-released gate. No wall-clock
 * duration is ever asserted on, only relative ORDER of log entries, so
 * this can't flake on a slow CI box.
 */
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

const SCHEMA_A = "concurrent-schema-a";
const SCHEMA_B = "concurrent-schema-b";

const callLog: string[] = [];
let releaseAParse: () => void;
const aParseGate = new Promise<void>((resolve) => {
  releaseAParse = resolve;
});

function labelFor(needle: string): string {
  return needle.includes(SCHEMA_A) ? "A" : "B";
}

vi.mock("../src/engine/xctrace.js", async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    exportToc: async () => ({
      runs: [
        {
          number: 1,
          tables: [
            { schema: SCHEMA_A, attributes: {} },
            { schema: SCHEMA_B, attributes: {} },
          ],
          tracks: [],
        },
      ],
    }),
    exportXPathStream: vi.fn(async (_tracePath: string, xpath: string) => {
      callLog.push(`spawn:${labelFor(xpath)}`);
      return { stdout: new Readable({ read() {} }), done: Promise.resolve() };
    }),
  };
});

vi.mock("../src/engine/parseTable.js", async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    parseTableStreamToSqlite: vi.fn(async (_stdout: unknown, _db: unknown, tableName: string) => {
      const label = labelFor(tableName);
      callLog.push(`consume-start:${label}`);
      if (label === "A") await aParseGate;
      callLog.push(`consume-end:${label}`);
      return { cols: [], rowCount: 0 };
    }),
  };
});

vi.mock("../src/engine/xcodeVersion.js", () => ({
  detectXcodeVersion: async () => null,
}));

const { openTrace, getTable } = await import("../src/engine/session.js");

/** Poll until `predicate()` is true, yielding to the event loop's I/O phase
 *  between checks (real fs work happens before the mocked spawn is reached,
 *  so pure microtask flushes never give it a chance to run). Bounded so a
 *  genuine regression fails fast instead of hanging. */
async function waitUntil(predicate: () => boolean, maxIterations = 500): Promise<void> {
  for (let i = 0; i < maxIterations; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`waitUntil: condition not met after ${maxIterations} iterations. callLog=${JSON.stringify(callLog)}`);
}

describe("PMT:harsh-brook — concurrent first-touch ingestion", () => {
  it("overlaps two schemas' export spawns but still serializes their consume+insert phase", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "harsh-brook-"));
    const tracePath = join(tmpDir, "fixture.trace");
    mkdirSync(tracePath); // a real, empty directory — enough for fs.stat/fs.access to succeed

    try {
      const { sessionId } = await openTrace(tracePath);

      const pairPromise = Promise.all([
        getTable(sessionId, 1, SCHEMA_A),
        getTable(sessionId, 1, SCHEMA_B),
      ]);

      // Wait until both spawns AND A's consume have started (A's consume is
      // parked behind aParseGate, so this is a stable state to poll for).
      await waitUntil(() => callLog.includes("spawn:A") && callLog.includes("spawn:B") && callLog.includes("consume-start:A"));

      // B's spawn already happened even though A's consume is still parked
      // (not yet finished) — proving the subprocess spawn is no longer gated
      // behind A's whole pipeline the way it was before this fix.
      expect(callLog).toContain("spawn:A");
      expect(callLog).toContain("spawn:B");
      expect(callLog).toContain("consume-start:A");
      expect(callLog).not.toContain("consume-end:A");
      // B's consume must NOT have started yet — the insert-phase serialization
      // (sessionIngestChain) still holds.
      expect(callLog).not.toContain("consume-start:B");

      releaseAParse();
      await pairPromise;

      expect(callLog.indexOf("consume-end:A")).toBeLessThan(callLog.indexOf("consume-start:B"));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("still dedupes two concurrent calls for the SAME schema to one ingestion (the self-join case sessionIngestChain/pendingIngest were originally added to fix)", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "harsh-brook-selfjoin-"));
    const tracePath = join(tmpDir, "fixture.trace");
    mkdirSync(tracePath);

    try {
      const { sessionId } = await openTrace(tracePath);
      const spawnCountBefore = callLog.filter((e) => e === "spawn:A").length;

      // Two concurrent requests for the SAME (run, schema) on a session
      // where it's not yet cached — mirrors relate() self-joining a schema
      // (e.g. a thread-info-with-itself join) — must still share ONE
      // ingestion (pendingIngest's per-(run,schema) dedupe), unaffected by
      // this change (which only touches the DIFFERENT-schema case).
      const [handleA, handleB] = await Promise.all([
        getTable(sessionId, 1, SCHEMA_A),
        getTable(sessionId, 1, SCHEMA_A),
      ]);

      const spawnCountAfter = callLog.filter((e) => e === "spawn:A").length;
      expect(spawnCountAfter - spawnCountBefore).toBe(1);
      expect(handleA).toBe(handleB);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
