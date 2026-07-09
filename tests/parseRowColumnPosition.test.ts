/**
 * Regression test for PMT:black-jay: parseRow must resolve each column from
 * its true document position, not from a shared per-engineering-type FIFO
 * queue.
 *
 * com-apple-cfnetwork-task-intervals is a real schema with three columns
 * that all share the "medium-length-string" engineering-type: server-ip,
 * task-description, http-path. Verified live against a real HTTPTraffic.trace
 * export: with the old type-bucket algorithm, an earlier null column (a
 * `<sentinel/>`, invisible to the type bucket) caused a later column sharing
 * that type to silently consume a value that belonged to a different column
 * further down the row — http-path came back holding a boolean stolen from
 * an unrelated `successful` column once its own queue ran dry.
 *
 * This fixture (tests/fixtures/xcode-27.0/schema-table/
 * com-apple-cfnetwork-task-intervals.xml) reproduces the same shape with
 * synthetic values: row 1 has task-description null (server-ip and http-path
 * present); row 2 has server-ip null (task-description and http-path
 * present) — both orderings of "which same-typed column is the null one".
 */
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { describe, it, expect } from "vitest";
import { parseTableStream } from "../src/engine/parseTable.js";

const FIXTURE = new URL(
  "./fixtures/xcode-27.0/schema-table/com-apple-cfnetwork-task-intervals.xml",
  import.meta.url
).pathname;

describe("parseRow resolves same-engineering-type columns by true document position", () => {
  it("row 1: task-description null does not steal server-ip's or http-path's value", async () => {
    const xml = readFileSync(FIXTURE, "utf8");
    const { rows } = await parseTableStream(Readable.from([xml]));

    const row1 = rows[0];
    expect(row1["task-description"]).toBeNull();
    expect(row1["server-ip"]?.fmt).toBe("Unknown IP");
    expect(row1["http-path"]?.fmt).toBe("/xrpc/app.example.feed.getPostThread");
    expect(row1["successful"]?.fmt).toBe("Yes");
  });

  it("row 2: server-ip null does not steal task-description's or http-path's value", async () => {
    const xml = readFileSync(FIXTURE, "utf8");
    const { rows } = await parseTableStream(Readable.from([xml]));

    const row2 = rows[1];
    expect(row2["server-ip"]).toBeNull();
    expect(row2["task-description"]?.fmt).toBe("Background Refresh");
    expect(row2["http-path"]?.fmt).toBe("/api/v2/notifications");
    expect(row2["successful"]?.fmt).toBe("No");
    expect(row2["error-domain"]?.fmt).toBe("NSURLErrorDomain");
  });
});
