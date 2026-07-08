/**
 * PMT:loam-merlin (HTTPTracing findings, xcodeAI 2026-07-08) — get_row's
 * size cap + header redaction. Verified live against a real on-device
 * HTTPTraffic.trace: interned_values held a base64 image response body
 * resolved to 342 KB for ONE cell, with no size relationship to the rest of
 * the row — get_row had no backstop at all before this fix.
 */
import { describe, it, expect } from "vitest";
import { truncateText, redactSensitiveHeaders, sanitizeCellText, MAX_CELL_CHARS } from "../src/core/getRow.js";

describe("truncateText", () => {
  it("passes short text through unchanged", () => {
    const r = truncateText("hello");
    expect(r).toEqual({ text: "hello", truncated: false });
  });

  it("passes text exactly at the cap through unchanged", () => {
    const s = "a".repeat(MAX_CELL_CHARS);
    const r = truncateText(s);
    expect(r.truncated).toBe(false);
    expect(r.text).toBe(s);
  });

  it("truncates text over the cap and reports the original length", () => {
    const s = "a".repeat(MAX_CELL_CHARS + 500);
    const r = truncateText(s);
    expect(r.truncated).toBe(true);
    expect(r.originalLength).toBe(MAX_CELL_CHARS + 500);
    expect(r.text.length).toBeLessThan(s.length);
    expect(r.text).toMatch(/truncated/);
  });
});

describe("redactSensitiveHeaders", () => {
  const headerBlock =
    "(Accept : */*), (Authorization : Bearer sk-abc123.secret), (Host : api.example.com), " +
    "(Cookie : session=deadbeef; other=1), (Content-Type : application/json)";

  it("redacts Authorization and Cookie values but leaves benign headers intact", () => {
    const out = redactSensitiveHeaders("request-headers", headerBlock);
    expect(out).toContain("(Authorization : [REDACTED])");
    expect(out).toContain("(Cookie : [REDACTED])");
    expect(out).toContain("(Accept : */*)");
    expect(out).toContain("(Host : api.example.com)");
    expect(out).not.toContain("sk-abc123.secret");
    expect(out).not.toContain("deadbeef");
  });

  it("is case-insensitive on the header name", () => {
    const out = redactSensitiveHeaders("response-headers", "(authorization : Bearer xyz), (SET-COOKIE : a=1)");
    expect(out).not.toContain("Bearer xyz");
    expect(out).not.toContain("a=1");
  });

  it("only applies to mnemonics that look like header columns", () => {
    // A non-header column that happens to contain "(Authorization : ...)"-shaped
    // text (e.g. a free-text log line) must NOT be touched — redaction is scoped
    // to avoid mangling unrelated compound-cell content.
    const out = redactSensitiveHeaders("error-message", "(Authorization : Bearer xyz)");
    expect(out).toContain("Bearer xyz");
  });

  it("leaves non-header mnemonics with no header-shaped content untouched", () => {
    expect(redactSensitiveHeaders("http-status-text", "OK")).toBe("OK");
  });
});

describe("sanitizeCellText", () => {
  it("redacts before truncating, so a redacted header block can shrink below the cap", () => {
    const longSecret = "x".repeat(MAX_CELL_CHARS);
    const block = `(Accept : */*), (Authorization : Bearer ${longSecret})`;
    const r = sanitizeCellText("request-headers", block);
    expect(r.text).not.toContain(longSecret);
    expect(r.text).toContain("[REDACTED]");
  });

  it("still truncates a huge non-header blob (e.g. an interned image body)", () => {
    const blob = "UklGR".repeat(100_000); // simulates a large base64 body, ~500KB
    const r = sanitizeCellText("response-body", blob);
    expect(r.truncated).toBe(true);
    expect(r.originalLength).toBe(blob.length);
  });
});
