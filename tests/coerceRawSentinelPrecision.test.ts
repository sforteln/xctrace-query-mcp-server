/**
 * PMT:loam-merlin (HTTPTracing findings, xcodeAI 2026-07-08) — a uint64
 * sentinel (CFNetwork's error-code "no error" = 2^64-1 =
 * 18446744073709551615) silently rounded to 18446744073709552000 (off by
 * 385) when coerced through Number(). Verified live against a real
 * HTTPTraffic trace. coerceRaw now keeps any all-digit value past
 * Number.MAX_SAFE_INTEGER as the exact string instead.
 */
import { describe, it, expect } from "vitest";
import { coerceRaw as coerceRawSchemaTable } from "../src/engine/parseTable.js";
import { coerceRaw as coerceRawTrackDetail } from "../src/engine/parseTrackDetail.js";

const UINT64_MAX = "18446744073709551615";

describe.each([
  ["parseTable.ts (schema-table)", coerceRawSchemaTable],
  ["parseTrackDetail.ts (track-detail)", coerceRawTrackDetail],
])("%s coerceRaw", (_label, coerceRaw) => {
  it("coerces an ordinary small all-digit string to a number, unchanged from before", () => {
    expect(coerceRaw("42")).toBe(42);
    expect(coerceRaw("0")).toBe(0);
  });

  it("keeps a non-digit string as-is", () => {
    expect(coerceRaw("hello")).toBe("hello");
    expect(coerceRaw("-999")).toBe("-999"); // leading '-' isn't all-digit
  });

  it("keeps Number.MAX_SAFE_INTEGER as a number (boundary, still exact)", () => {
    const s = String(Number.MAX_SAFE_INTEGER);
    expect(coerceRaw(s)).toBe(Number.MAX_SAFE_INTEGER);
    expect(typeof coerceRaw(s)).toBe("number");
  });

  it("keeps a uint64 sentinel (2^64-1) as the EXACT string, not a rounded double", () => {
    const result = coerceRaw(UINT64_MAX);
    expect(typeof result).toBe("string");
    expect(BigInt(result as string)).toBe(BigInt(UINT64_MAX));
    // The bug this guards against: naive Number(text) coercion rounds this
    // value to a DIFFERENT number (18446744073709552000) — confirm that
    // lossy path really would have produced a wrong value, so this test
    // would actually fail if coerceRaw regressed to plain Number() coercion.
    expect(String(Number(UINT64_MAX))).not.toBe(UINT64_MAX);
  });

  it("keeps any value one past MAX_SAFE_INTEGER as a string too", () => {
    const justOver = String(Number.MAX_SAFE_INTEGER + 2); // +1 isn't representable distinctly
    const result = coerceRaw(justOver);
    expect(typeof result).toBe("string");
  });
});
