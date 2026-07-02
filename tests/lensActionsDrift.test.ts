/**
 * Validates every lens's nextActions()/quickStart() output against the LIVE
 * tool registry: the `tool` field names an actually-registered MCP tool, and
 * `args` parses against that tool's own zod inputSchema.
 *
 * Exists because a lens's suggested tool/args payload is written once and
 * never re-validated when the target tool's requirements later change — a
 * real example: several SwiftUI lens actions once suggested generic
 * `aggregate` against SwiftUIFilteredUpdates with no `position`, built before
 * the ambiguous-schema check existed on that tool. driftGuard.test.ts only
 * checks tool description STRINGS; it never validates the runtime
 * `{tool, args}` objects a lens's nextActions()/quickStart() actually return.
 * See PMT:gravel-trace.
 *
 * KNOWN GAP (documented, not silently skipped): the Leaks and Network lenses'
 * unattributableFractionHint/buildAllocationJoinAction/preExistingSnapshotHint
 * call `peekTable()`, which requires a real, already-open session — these
 * specific branches can't be exercised here without a live/fixture-backed
 * session (the heavier "actually invoke against a fixture session" stretch
 * goal the prompt explicitly deprioritized). They were checked by manual
 * code review instead (see PMT:gravel-trace's completion report) and found
 * consistent with their target tools' current schemas at the time of writing.
 */
import { describe, it, expect } from "vitest";
import { createServer } from "../src/index.js";
import type { Lens } from "../src/lenses/types.js";
import type { CellDetail } from "../src/core/getRow.js";
import fmLens from "../src/lenses/foundationModels/index.js";
import leaksLens from "../src/lenses/leaks/index.js";
import timeProfilerLens from "../src/lenses/timeProfiler/index.js";
import networkLens from "../src/lenses/network/index.js";
import hangsLens from "../src/lenses/hangs/index.js";
import swiftConcurrencyLens from "../src/lenses/swiftConcurrency/index.js";
import swiftUILens from "../src/lenses/swiftUI/index.js";
import coreDataLens from "../src/lenses/coreData/index.js";
import allocationsLens from "../src/lenses/allocations/index.js";
import thermalLens from "../src/lenses/thermal/index.js";

// Mirrors src/index.ts's LENSES array — kept independent of it (imported
// directly from each lens module) so this test doesn't need index.ts to
// export its internal registry just to be tested.
const LENSES: Array<{ label: string; lens: Lens }> = [
  { label: "foundationModels", lens: fmLens },
  { label: "leaks", lens: leaksLens },
  { label: "network", lens: networkLens },
  { label: "swiftConcurrency", lens: swiftConcurrencyLens },
  { label: "swiftUI", lens: swiftUILens },
  { label: "coreData", lens: coreDataLens },
  { label: "allocations", lens: allocationsLens },
  { label: "hangs", lens: hangsLens },
  { label: "timeProfiler", lens: timeProfilerLens },
  { label: "thermal", lens: thermalLens },
];

// Schemas whose lens calls peekTable() internally and therefore need a real,
// already-open session — see the KNOWN GAP note above.
const NEEDS_LIVE_SESSION = new Set(["Leaks/Leaks", "network-connection-detected"]);

const ALL_SCHEMAS = [...new Set(LENSES.flatMap(({ lens }) => lens.instruments))];

const server = createServer();
type ZodLike = { safeParse: (v: unknown) => { success: boolean; error?: { issues?: unknown } } };
type RegisteredTool = { inputSchema?: ZodLike };
const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
  ._registeredTools;
const TOOL_NAMES = new Set(Object.keys(tools));

function cell(raw: string | number, type = "uint-64"): CellDetail {
  return { type, fmt: String(raw), raw, role: "detail" };
}

// Covers every column name any lens's per-row nextActions reads (see hangs,
// thermal — leaks' row-dependent branch is in NEEDS_LIVE_SESSION and skipped).
const SYNTHETIC_ROW: Record<string, CellDetail | null> = {
  start: cell(1_000_000),
  duration: cell(50_000),
  address: cell("0x1000", "string"),
};

interface ActionLike {
  tool: string;
  args: Record<string, unknown>;
}

function validate(label: string, source: string, action: ActionLike): void {
  it(`${label} / ${source}: "${action.tool}" is registered with valid args`, () => {
    expect(TOOL_NAMES.has(action.tool), `"${action.tool}" is not a registered tool name`).toBe(true);
    const tool = tools[action.tool];
    if (!tool?.inputSchema) return; // a no-arg tool — nothing to validate
    const result = tool.inputSchema.safeParse(action.args);
    expect(
      result.success,
      `${source} suggested ${action.tool}(${JSON.stringify(action.args)}) which fails that tool's ` +
      `own inputSchema: ${JSON.stringify(result.error?.issues ?? result)}`
    ).toBe(true);
  });
}

describe("lens nextActions/quickStart stay valid against the live tool registry", () => {
  for (const { label, lens } of LENSES) {
    for (const schema of lens.instruments) {
      if (NEEDS_LIVE_SESSION.has(schema)) continue;

      // Table-wide (no row), against the lens's own schemas only.
      for (const action of lens.nextActions("test-session", schema, 1, [...lens.instruments])) {
        validate(label, `${schema} nextActions (own schemas, no row)`, action);
      }
      // Table-wide, against the full cross-lens schema superset — exercises
      // "companion schema present" branches (e.g. hangs' Time Profiler check).
      for (const action of lens.nextActions("test-session", schema, 1, ALL_SCHEMAS)) {
        validate(label, `${schema} nextActions (all schemas, no row)`, action);
      }
      // Per-row, with a synthetic row covering every column a lens reads.
      for (const action of lens.nextActions("test-session", schema, 1, ALL_SCHEMAS, SYNTHETIC_ROW)) {
        validate(label, `${schema} nextActions (all schemas, with row)`, action);
      }
    }

    // quickStart: once per schema in isolation, and once against the full superset.
    for (const schema of lens.instruments) {
      const isolated = lens.quickStart?.([schema], "test-session", 1);
      if (isolated) validate(label, `${schema} quickStart (isolated)`, isolated);
    }
    const superset = lens.quickStart?.(ALL_SCHEMAS, "test-session", 1);
    if (superset) validate(label, `quickStart (all schemas)`, superset);
  }
});
