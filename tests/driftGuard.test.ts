/**
 * Tool description drift guards.
 *
 * Two categories of checks:
 *
 * Structural — enforces the behavioral-spec shape of every tool description:
 *   • Opens with a verb or "Use X when…" (never a vacuous determiner/pronoun)
 *   • Contains a "⚠️ Not for" block (list_ tools with no obvious misuse are exempt)
 *   • No param description ≥20 chars is a substring of its own tool description
 *
 * Identifier integrity — catches stale references ("silent lie" class):
 *   • Backtick-quoted snake_case tokens in descriptions must be registered tool names
 *   • Single-quoted schema names in descriptions must be in VERIFIED_PAIRS or exempted
 *
 * All checks derive their reference data from live source imports — no hardcoded lists.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { createServer } from "../src/index.js";
import { VERIFIED_PAIRS } from "../src/engine/versionRules.js";
import { RECORDING_INTENTS } from "../src/core/recording.js";
import type { SchemaCol } from "../src/engine/parseTable.js";
import { parseTableXml } from "../src/engine/parseTable.js";
import { parseTrackDetailXml } from "../src/engine/parseTrackDetail.js";
import { classifyWithHints } from "../src/engine/roleHints.js";
import { primaryTime as relatePrimaryTime } from "../src/core/relate.js";
import {
  CURATED_EDGES,
  deriveEdges,
  connectionsFor,
  invert,
  edgeTimeColumn,
  type SchemaEdge,
} from "../src/engine/schemaEdges.js";
import { CURATED_GOTCHAS } from "../src/core/queryHints.js";

// ── Extract tool metadata from the live server ────────────────────────────────

const server = createServer();

type InputSchema = {
  shape?: Record<string, { description?: string; [k: string]: unknown }>;
};
type RegisteredTool = { description: string; inputSchema: InputSchema };
type ToolRegistry = Record<string, RegisteredTool>;

const tools = (server as unknown as { _registeredTools: ToolRegistry })
  ._registeredTools;

const TOOL_NAMES = new Set(Object.keys(tools));

// ── Reference sets ────────────────────────────────────────────────────────────

// Schema names with verified fixtures — everything after ":" in VERIFIED_PAIRS keys.
const KNOWN_SCHEMAS = new Set([...VERIFIED_PAIRS].map((p) => p.split(":")[1]));

// Schema-like tokens referenced in tool descriptions that are NOT in VERIFIED_PAIRS
// but are legitimate. Add here when a check produces a false positive, with justification.
const SCHEMA_REF_EXEMPTIONS = new Set([
  "time-profile", // used by call_tree; real schema name but no fixture yet (backtrace track-detail)
  "cpu-profile",  // CPU Profiler's tagged-backtrace schema; verified live this session, no fixture yet
  "ane-hw-intervals", // Neural Engine instrument's interval schema; verified live (PMT:amber-ibis), no fixture yet
  // (runloop-intervals graduated to a committed fixture in PMT:rust-gravel — now in VERIFIED_PAIRS, exemption removed.)
  "os-signpost", // bare-instrument Points of Interest schema; verified live repeatedly (PMT:calm-starling), no fixture yet
  "Prompt",       // Instruments UI phase-label in list_fm_requests description — not a schema name
  "Resolve",      // Instruments UI phase-label in list_fm_requests description — not a schema name
]);

// ── Rules ─────────────────────────────────────────────────────────────────────

const VACUOUS_OPENERS = /^(the|this|a|an|here|there|it)\b/i;

// list_ tools with no obvious misuse class are exempt from the ⚠️ Not for requirement.
// A misuse class exists when an agent might plausibly call the tool for the wrong job.
// Add to this set only when the tool's purpose is unambiguous from its name alone.
const NOT_FOR_EXEMPT = new Set([
  "list_instruments",    // self-evident: lists what's in the trace
  "list_traces",         // self-evident: lists available .trace files
  "list_search_roots",   // self-evident: lists configured search directories
  "list_processes",      // self-evident: lists running processes
  "list_fm_requests",    // self-evident: lists Foundation Models requests
]);

// Shared by both "single-quoted schema names" checks below (tool descriptions
// and RECORDING_INTENTS notes) — same convention, same reference data, just a
// different source string each time.
function staleSchemaRefs(text: string): string[] {
  const quoted = [...text.matchAll(/'([A-Za-z][A-Za-z0-9-]+)'/g)].map((m) => m[1]);
  const schemaLike = quoted.filter((t) => t.includes("-") || /^[A-Z]/.test(t));
  return schemaLike.filter((t) => !KNOWN_SCHEMAS.has(t) && !SCHEMA_REF_EXEMPTIONS.has(t));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Structural: tool description shape", () => {
  for (const [name, tool] of Object.entries(tools)) {
    const desc = tool.description ?? "";

    it(`${name}: opens with a verb or "Use X when…" — not a vacuous determiner`, () => {
      expect(
        VACUOUS_OPENERS.test(desc),
        `"${name}" description opens with a vacuous word.\n` +
        `  First words: "${desc.split(" ").slice(0, 4).join(" ")}"\n` +
        `  Fix: start with a verb ("Load", "Return", "Filter") or "Use X when…"`
      ).toBe(false);
    });

    if (!NOT_FOR_EXEMPT.has(name)) {
      it(`${name}: contains a "⚠️ Not for" block`, () => {
        expect(
          desc.includes("⚠️ Not for"),
          `"${name}" is missing a ⚠️ Not for block.\n` +
          `  Add one to steer the agent away from misuse, e.g.:\n` +
          `  "⚠️ Not for <wrong use case> — use <correct tool> instead."`
        ).toBe(true);
      });
    }

    it(`${name}: no param description ≥20 chars is a substring of the tool description`, () => {
      const props = tool.inputSchema?.shape ?? {};
      const violations: string[] = [];
      for (const [param, schema] of Object.entries(props)) {
        const paramDesc = (schema as { description?: string }).description ?? "";
        if (paramDesc.length >= 20 && desc.includes(paramDesc)) {
          violations.push(
            `  .${param}: "${paramDesc.slice(0, 60)}${paramDesc.length > 60 ? "…" : ""}"`
          );
        }
      }
      expect(
        violations,
        `"${name}" has param description(s) that are substrings of the tool description.\n` +
        `  (Keeps intent vocabulary separate from call-decision vocabulary.)\n` +
        violations.join("\n")
      ).toEqual([]);
    });
  }
});

describe("Identifier integrity: no stale references", () => {
  for (const [name, tool] of Object.entries(tools)) {
    const desc = tool.description ?? "";

    it(`${name}: backtick-quoted snake_case tokens are registered tool names`, () => {
      // Match `token_name` patterns; filter to tokens that contain underscores (tool-name shaped).
      const toolLike = [...desc.matchAll(/`([a-z][a-z0-9_]+)`/g)]
        .map((m) => m[1])
        .filter((t) => t.includes("_"));

      const stale = toolLike.filter((t) => !TOOL_NAMES.has(t));
      expect(
        stale,
        `"${name}" references unknown tool(s) in backticks: ${stale.join(", ")}\n` +
        `  Either rename the backtick reference to match the registered tool name, ` +
        `or remove it from the description.`
      ).toEqual([]);
    });

    it(`${name}: single-quoted schema names are in VERIFIED_PAIRS or SCHEMA_REF_EXEMPTIONS`, () => {
      // Match 'schema-name' or 'SchemaCamelCase' — tokens with hyphens or leading uppercase.
      const stale = staleSchemaRefs(desc);
      expect(
        stale,
        `"${name}" references schema(s) not in VERIFIED_PAIRS: ${stale.join(", ")}\n` +
        `  If the schema was renamed, update the description to match.\n` +
        `  If this is an intentional reference to an unfixtureed schema, add it to SCHEMA_REF_EXEMPTIONS with a comment.`
      ).toEqual([]);
    });
  }
});

// RECORDING_INTENTS[type].note fields name specific schemas in prose just as
// confidently as tool descriptions do (e.g. hangs' note: "this template's
// real schemas are 'potential-hangs' and 'hang-risks'") but were never
// covered by the scan above, which only reads registered tool.description
// strings — a real, previously-flagged gap (see PMT:clear-crow). Same
// reference data (VERIFIED_PAIRS + exemptions), no new machinery.
describe("Identifier integrity: RECORDING_INTENTS notes don't reference stale schemas", () => {
  for (const [type, intent] of Object.entries(RECORDING_INTENTS)) {
    if (!intent.note) continue;
    it(`${type}: single-quoted schema names in its note are in VERIFIED_PAIRS or SCHEMA_REF_EXEMPTIONS`, () => {
      const stale = staleSchemaRefs(intent.note!);
      expect(
        stale,
        `RECORDING_INTENTS["${type}"].note references schema(s) not in VERIFIED_PAIRS: ${stale.join(", ")}\n` +
        `  If the schema was renamed, update the note to match.\n` +
        `  If this is an intentional reference to an unfixtureed schema, add it to SCHEMA_REF_EXEMPTIONS with a comment.`
      ).toEqual([]);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Cross-schema connection registry drift guards (PMT:rust-gravel)
//
// Extends this file's existing "reference data from the committed fixtures +
// VERIFIED_PAIRS, no parallel harness" discipline to the SchemaEdge registry:
//   (a) referential + coverage gate — every schema/col a CURATED edge names
//       exists in a committed fixture
//   (b) order-invariant derivation — permuting fixture schema/column order
//       reproduces the identical derived edge set (the f3203f0 position-
//       dependence class)
//   (c) negative-edge — the swap-id non-join stays a genuine different-id-space
//       (flips if Apple ever unifies them)
//   (d) kind-consistency — a time-window edge's endpoints carry primaryTime; a
//       tuple edge carries a thread pair + a time pair
//   (e) inverted-equality — the connection graph is bidirectionally consistent
//       (every A→B edge has its structural inverse surfaced from B)
// plus a guard that edgeTimeColumn never drifts from relate.primaryTime.
// ═══════════════════════════════════════════════════════════════════════════════

// Load every committed fixture's real columns, keyed by the ACTUAL schema name.
// schema-table: "foo__bar.xml" → "foo/bar". track-detail names carry spaces, so
// its filenames also encode "-" for a space: "Allocations__Allocations-List" →
// "Allocations/Allocations List".
function loadFixtureCols(): Map<string, SchemaCol[]> {
  const root = new URL("./fixtures/xcode-27.0", import.meta.url).pathname;
  const map = new Map<string, SchemaCol[]>();
  for (const kind of ["schema-table", "track-detail"] as const) {
    const dir = join(root, kind);
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".xml")) continue;
      let schema = basename(f, ".xml").replace(/__/g, "/");
      if (kind === "track-detail") schema = schema.replace(/-/g, " ");
      const xml = readFileSync(join(dir, f), "utf8");
      const parsed = kind === "schema-table" ? parseTableXml(xml) : parseTrackDetailXml(xml, schema);
      map.set(schema, parsed.cols);
    }
  }
  return map;
}

const FIXTURE_COLS = loadFixtureCols();
const FIXTURE_SCHEMAS = [...FIXTURE_COLS.entries()].map(([schema, cols]) => ({ schema, cols }));

const roleOf = (schema: string, col: string): string | undefined =>
  classifyWithHints(schema, FIXTURE_COLS.get(schema)!).find((c) => c.mnemonic === col)?.roleInfo.role;

const edgeKey = (e: SchemaEdge): string =>
  `${e.from}|${e.to}|${e.kind}|${e.on.map((p) => `${p.fromCol}=${p.toCol}`).join(",")}`;

// (a) REFERENTIAL + COVERAGE GATE ────────────────────────────────────────────────
describe("schemaEdges (a): every curated edge is referentially valid against a committed fixture", () => {
  CURATED_EDGES.forEach((edge, i) => {
    it(`#${i} ${edge.from} →${edge.kind}→ ${edge.to}: both endpoints fixtured, keyed columns exist`, () => {
      const fromCols = FIXTURE_COLS.get(edge.from);
      const toCols = FIXTURE_COLS.get(edge.to);
      expect(fromCols, `no committed fixture for "${edge.from}" — coverage gate: a curated edge may only name a fixtured schema`).toBeDefined();
      expect(toCols, `no committed fixture for "${edge.to}" — coverage gate: a curated edge may only name a fixtured schema`).toBeDefined();
      const onKeys = (edge as { onKeys?: Array<{ fromCol: string; toCol: string }> }).onKeys;
      if (onKeys) {
        for (const pair of onKeys) {
          expect(fromCols!.some((c) => c.mnemonic === pair.fromCol), `${edge.from}.${pair.fromCol} not in the committed fixture`).toBe(true);
          expect(toCols!.some((c) => c.mnemonic === pair.toCol), `${edge.to}.${pair.toCol} not in the committed fixture`).toBe(true);
        }
      }
    });
  });
});

// (b) ORDER-INVARIANT DERIVATION ─────────────────────────────────────────────────
describe("schemaEdges (b): derived-layer derivation is order-invariant over the fixtures", () => {
  const baseline = new Set(deriveEdges(FIXTURE_SCHEMAS).map(edgeKey));

  it("emits a non-trivial number of derived edges (guards against a silently-empty derivation)", () => {
    expect(baseline.size).toBeGreaterThan(10);
  });

  it("reversed schema order + reversed columns within each schema reproduces the identical edge set", () => {
    const permuted = [...FIXTURE_SCHEMAS].reverse().map((s) => ({ schema: s.schema, cols: [...s.cols].reverse() }));
    expect(new Set(deriveEdges(permuted).map(edgeKey))).toEqual(baseline);
  });

  it("a rotation + a per-schema column rotation reproduces the identical edge set", () => {
    const half = Math.floor(FIXTURE_SCHEMAS.length / 2);
    const rotated = [...FIXTURE_SCHEMAS.slice(half), ...FIXTURE_SCHEMAS.slice(0, half)].map((s) => ({
      schema: s.schema,
      cols: s.cols.length > 1 ? [s.cols[s.cols.length - 1], ...s.cols.slice(0, -1)] : s.cols,
    }));
    expect(new Set(deriveEdges(rotated).map(edgeKey))).toEqual(baseline);
  });
});

// (c) NEGATIVE-EDGE ──────────────────────────────────────────────────────────────
describe("schemaEdges (c): the swap-id negative edge stays a genuine non-join", () => {
  it("hitches.swap-id and display-surface-swap.swap-id are different engineering-types (different id-spaces)", () => {
    const a = FIXTURE_COLS.get("hitches")!.find((c) => c.mnemonic === "swap-id")!;
    const b = FIXTURE_COLS.get("display-surface-swap")!.find((c) => c.mnemonic === "swap-id")!;
    expect(a.engineeringType).not.toBe(b.engineeringType);
  });

  it("the registry records exactly this pair as a curated NEGATIVE edge", () => {
    const neg = CURATED_EDGES.find(
      (e) => e.kind === "negative" && e.from === "hitches" && e.to === "display-surface-swap"
    );
    expect(neg).toBeDefined();
  });
});

// (d) KIND-CONSISTENCY ───────────────────────────────────────────────────────────
describe("schemaEdges (d): edge kinds are structurally consistent over the fixtures", () => {
  const derived = deriveEdges(FIXTURE_SCHEMAS);

  it("every derived time-window edge's endpoints classify as a time role", () => {
    for (const e of derived.filter((e) => e.kind === "time-window")) {
      expect(roleOf(e.from, e.on[0].fromCol), `${e.from}.${e.on[0].fromCol}`).toBe("time");
      expect(roleOf(e.to, e.on[0].toCol), `${e.to}.${e.on[0].toCol}`).toBe("time");
    }
  });

  it("every derived tuple edge carries a thread pair (pair 0) and a time pair (pair 1)", () => {
    const tuples = derived.filter((e) => e.kind === "tuple");
    expect(tuples.length).toBeGreaterThan(0);
    for (const e of tuples) {
      expect(e.on).toHaveLength(2);
      expect(roleOf(e.from, e.on[0].fromCol)).toBe("thread");
      expect(roleOf(e.to, e.on[0].toCol)).toBe("thread");
      expect(roleOf(e.from, e.on[1].fromCol)).toBe("time");
      expect(roleOf(e.to, e.on[1].toCol)).toBe("time");
    }
  });

  it("every curated directional/window edge resolves a primaryTime on BOTH endpoints", () => {
    for (const def of CURATED_EDGES.filter((d) => !(d as { onKeys?: unknown }).onKeys)) {
      expect(edgeTimeColumn(def.from, FIXTURE_COLS.get(def.from)!), `${def.from} primaryTime`).not.toBeNull();
      expect(edgeTimeColumn(def.to, FIXTURE_COLS.get(def.to)!), `${def.to} primaryTime`).not.toBeNull();
    }
  });
});

// (e) INVERTED-EQUALITY (bidirectional consistency) ───────────────────────────────
describe("schemaEdges (e): the connection graph is bidirectionally consistent", () => {
  it("every edge A→B in connectionsFor(A) has its structural inverse in connectionsFor(B)", () => {
    const missing: string[] = [];
    for (const { schema } of FIXTURE_SCHEMAS) {
      for (const e of connectionsFor(schema, FIXTURE_SCHEMAS).edges) {
        const wantKey = edgeKey(invert(e));
        const back = connectionsFor(e.to, FIXTURE_SCHEMAS).edges;
        if (!back.some((b) => edgeKey(b) === wantKey)) {
          missing.push(`${edgeKey(e)} — no inverse in connectionsFor("${e.to}")`);
        }
      }
    }
    expect(missing, missing.slice(0, 5).join("\n")).toEqual([]);
  });
});

// edgeTimeColumn must never drift from relate.primaryTime (they share the same rule). ──
describe("schemaEdges: edgeTimeColumn agrees with relate.primaryTime for every fixture", () => {
  it("resolves the identical primary time column across all fixtured schemas", () => {
    const disagreements: string[] = [];
    for (const { schema, cols } of FIXTURE_SCHEMAS) {
      const mine = edgeTimeColumn(schema, cols);
      const theirs = relatePrimaryTime(schema, classifyWithHints(schema, cols));
      if (mine !== theirs) disagreements.push(`${schema}: edges=${mine} relate=${theirs}`);
    }
    expect(disagreements).toEqual([]);
  });
});

// CURATED queryHints gotchas (PMT:faint-trout) — referentially guarded, same
// discipline as the schemaEdges curated layer: every schema key must be
// fixtured, every named column must exist in that fixture (a rename goes red).
describe("queryHints: curated gotchas are referentially valid against committed fixtures", () => {
  for (const [schema, gotchas] of Object.entries(CURATED_GOTCHAS)) {
    it(`${schema}: fixtured, and every named column exists`, () => {
      const cols = FIXTURE_COLS.get(schema);
      expect(cols, `no committed fixture for "${schema}" — a curated gotcha may only name a fixtured schema`).toBeDefined();
      for (const g of gotchas) {
        if (g.column) {
          expect(cols!.some((c) => c.mnemonic === g.column), `${schema}.${g.column} not in the committed fixture`).toBe(true);
        }
      }
    });
  }
});
