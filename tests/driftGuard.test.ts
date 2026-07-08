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
import { createServer } from "../src/index.js";
import { VERIFIED_PAIRS } from "../src/engine/versionRules.js";
import { RECORDING_INTENTS } from "../src/core/recording.js";

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
