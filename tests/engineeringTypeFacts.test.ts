/**
 * Drift guard: src/engine/engineeringTypeFacts.ts is GENERATED from
 * aidocs/engineeringTypeReference.json (scripts/generate-type-facts.py).
 * If the reference is re-scraped (Apple updated their docs) without
 * regenerating the module, the two encodings silently diverge — exactly the
 * cross-reference-drift class this project's driftGuard tests exist to catch.
 * This recomputes the expected facts from the JSON and asserts the module
 * matches, entry for entry.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ENGINEERING_TYPE_FACTS } from "../src/engine/engineeringTypeFacts.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

interface RefEntry {
  usage?: Record<string, string>;
}

function expectedFromJson(): Record<string, { family: string; categorical: boolean; sentinel: string | null; bitWidth: number | null; sentinelMax: number | null }> {
  const ref = JSON.parse(readFileSync(join(ROOT, "aidocs", "engineeringTypeReference.json"), "utf8")) as Record<string, RefEntry[]>;
  const out: ReturnType<typeof expectedFromJson> = {};
  for (const [family, types] of Object.entries(ref)) {
    for (const t of types) {
      const usage = t.usage ?? {};
      const mnemonic = usage["Mnemonic"];
      expect(mnemonic, `entry without Mnemonic in family ${family}`).toBeTruthy();
      const sentinel = usage["Sentinel"] ?? null;
      const widthMatch = usage["Bit Width"]?.match(/(\d+) bits?/);
      const bitWidth = widthMatch ? Number(widthMatch[1]) : null;
      const sentinelMax = sentinel === "max" && bitWidth !== null && bitWidth <= 53 ? 2 ** bitWidth - 1 : null;
      out[mnemonic!] = {
        family,
        categorical: "categorical" in usage,
        sentinel,
        bitWidth,
        sentinelMax,
      };
    }
  }
  return out;
}

describe("engineeringTypeFacts drift guard", () => {
  const expected = expectedFromJson();

  it("module covers exactly the reference's mnemonics", () => {
    expect(Object.keys(ENGINEERING_TYPE_FACTS).sort()).toEqual(Object.keys(expected).sort());
  });

  it("every entry matches the reference JSON", () => {
    for (const [mnemonic, want] of Object.entries(expected)) {
      expect(ENGINEERING_TYPE_FACTS[mnemonic], mnemonic).toEqual(want);
    }
  });

  it("audit-cited anchor facts hold (regeneration sanity)", () => {
    // Anchors cited throughout aidocs/engineeringTypeReferenceAudit.md — if
    // one of these changes, the audit's conclusions need re-checking, not
    // just a regeneration.
    expect(ENGINEERING_TYPE_FACTS["duration"].sentinel).toBe("zero");
    expect(ENGINEERING_TYPE_FACTS["boolean"].sentinelMax).toBe(3);
    expect(ENGINEERING_TYPE_FACTS["kperf-bt"].categorical).toBe(true);
    expect(ENGINEERING_TYPE_FACTS["syscall-return"].sentinel).toBe("max");
    expect(ENGINEERING_TYPE_FACTS["weight"].categorical).toBe(false);
    expect(ENGINEERING_TYPE_FACTS["core"].sentinelMax).toBe(65535);
  });
});
