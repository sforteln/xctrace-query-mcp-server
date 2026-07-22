#!/usr/bin/env python3
"""Generate src/engine/engineeringTypeFacts.ts from aidocs/engineeringTypeReference.json.

The reference JSON is Apple's own Engineering Type Reference (scraped by
scripts/scrape-engineering-types.py). This turns the audit-relevant facts —
family, categorical flag, sentinel spec — into a small runtime module so
summability enforcement and sentinel handling consume ONE encoding of the
reference (see PMT:haze-eagle's decision item). All 238 types are included:
the size cost is negligible and it eliminates the "type not in module" gap
class entirely; types absent from Apple's reference (e.g. kperf-bt's cousins
analysis-core-swift-task, mach-port, swiftui-update...) simply have no entry,
and every consumer must treat an absent lookup as "no claim" — never as
"safe" or "unsafe".

Run from the repo root:  python3 scripts/generate-type-facts.py
A drift test (tests/engineeringTypeFacts.test.ts) asserts the module matches
the JSON, so a re-scrape that changes the reference fails CI until this is
re-run.
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REF = ROOT / "aidocs" / "engineeringTypeReference.json"
OUT = ROOT / "src" / "engine" / "engineeringTypeFacts.ts"

ref = json.loads(REF.read_text())

entries = []
for family, types in ref.items():
    for t in types:
        usage = t.get("usage", {})
        mnemonic = usage.get("Mnemonic")
        if not mnemonic:
            raise SystemExit(f"entry without Mnemonic in family {family}: {t.get('name')}")
        sentinel = usage.get("Sentinel")
        if sentinel not in (None, "zero", "max"):
            raise SystemExit(f"unexpected Sentinel value {sentinel!r} on {mnemonic}")
        bit_width = None
        if "Bit Width" in usage:
            m = re.match(r"(\d+) bits?", usage["Bit Width"])
            if m:
                bit_width = int(m.group(1))
        # sentinelMax: the numeric "max" sentinel when the width makes it
        # representable exactly in a JS number (<= 53 bits). Wider sentinels
        # (64-bit) can't be an exact JS number — consumers use the near-max
        # window approach instead (see aggregate.ts's sentinel exclusion).
        sentinel_max = None
        if sentinel == "max" and bit_width is not None and bit_width <= 53:
            sentinel_max = 2**bit_width - 1
        entries.append(
            {
                "mnemonic": mnemonic,
                "family": family,
                "categorical": "categorical" in usage,
                "sentinel": sentinel,
                "bitWidth": bit_width,
                "sentinelMax": sentinel_max,
            }
        )

entries.sort(key=lambda e: e["mnemonic"])

lines = []
lines.append("// GENERATED FILE — do not edit by hand.")
lines.append("// Source: aidocs/engineeringTypeReference.json (Apple's Engineering Type Reference).")
lines.append("// Regenerate with: python3 scripts/generate-type-facts.py")
lines.append("// Drift-guarded by tests/engineeringTypeFacts.test.ts.")
lines.append("")
lines.append("export interface EngineeringTypeFacts {")
lines.append("  /** Apple's family grouping: CPU | Energy | General | Graphics | I/O | Internal | Memory. */")
lines.append("  family: string;")
lines.append('  /** True when Apple marks the type "Value cannot be summed or averaged." */')
lines.append("  categorical: boolean;")
lines.append('  /** Sentinel spec: "zero" (0 = missing/NA), "max" (top of the value range = missing/NA), or null. */')
lines.append('  sentinel: "zero" | "max" | null;')
lines.append("  /** Documented bit width, when Apple states one. */")
lines.append("  bitWidth: number | null;")
lines.append("  /** Exact numeric max-sentinel when representable in a JS number (bitWidth <= 53); null otherwise. */")
lines.append("  sentinelMax: number | null;")
lines.append("}")
lines.append("")
lines.append("export const ENGINEERING_TYPE_FACTS: Record<string, EngineeringTypeFacts> = {")
for e in entries:
    sent = f'"{e["sentinel"]}"' if e["sentinel"] else "null"
    bw = e["bitWidth"] if e["bitWidth"] is not None else "null"
    sm = e["sentinelMax"] if e["sentinelMax"] is not None else "null"
    cat = "true" if e["categorical"] else "false"
    lines.append(
        f'  "{e["mnemonic"]}": {{ family: "{e["family"]}", categorical: {cat}, sentinel: {sent}, bitWidth: {bw}, sentinelMax: {sm} }},'
    )
lines.append("};")
lines.append("")
lines.append("/** Facts for one engineering-type mnemonic, or undefined when Apple's reference has no entry (an absent lookup is \"no claim\", never \"safe\"/\"unsafe\"). */")
lines.append("export function typeFacts(engineeringType: string): EngineeringTypeFacts | undefined {")
lines.append("  return ENGINEERING_TYPE_FACTS[engineeringType];")
lines.append("}")
lines.append("")

OUT.write_text("\n".join(lines))
cats = sum(1 for e in entries if e["categorical"])
sents = sum(1 for e in entries if e["sentinel"])
print(f"wrote {OUT.relative_to(ROOT)}: {len(entries)} types, {cats} categorical, {sents} sentinel-bearing")
