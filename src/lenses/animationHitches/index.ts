// Tool description format: see the comment above createServer() in src/index.ts.
// Enforced by tests/driftGuard.test.ts — verb-led openers, ⚠️ Not for blocks, no stale identifiers.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Lens, QuickStart } from "../types.js";
import type { NextAction } from "../../core/response.js";
import type { CellDetail } from "../../core/getRow.js";

const HITCHES_SCHEMA = "hitches";
const HITCHES_RENDERS_SCHEMA = "hitches-renders";
const DISPLAYED_SURFACES_SCHEMA = "displayed-surfaces-interval";
const DISPLAY_SURFACE_SWAP_SCHEMA = "display-surface-swap";
const DEVICE_DISPLAY_INFO_SCHEMA = "device-display-info";
const TIME_PROFILE_SCHEMAS = ["time-sample", "time-profile"];
const OFF_CPU_SCHEMAS = ["syscall", "thread-state"];

const HITCHES_DISPLAY_SCHEMAS = [
  HITCHES_SCHEMA,
  HITCHES_RENDERS_SCHEMA,
  "hitches-gpu",
  "hitches-framewait",
  "hitches-updates",
  "hitches-frame-lifetimes",
  "display-vsyncs-interval",
  DISPLAYED_SURFACES_SCHEMA,
  DISPLAY_SURFACE_SWAP_SCHEMA,
  "display-compositor-interval",
  DEVICE_DISPLAY_INFO_SCHEMA,
];

/**
 * THE GOTCHA (scratchpad 054 #2, verified live, Instruments 16.0): hitches.
 * swap-id (uint32) and display-surface-swap.swap-id (engineeringType
 * displayed-surface-swap) are DIFFERENT ID SPACES — an agent that tries
 * query(display-surface-swap, {swap-id: <a hitch's swap-id>}) gets 0 rows and
 * can wrongly read that as "no matching presentation" (the recurring
 * "negative result read as a positive conclusion" failure, scratchpad 062).
 * The correct join is a TIME-WINDOW correlate, not swap-id equality.
 */
function swapIdGotchaAction(sessionId: string, run: number): NextAction {
  return {
    tool: "correlate",
    args: { sessionId, intervalsSchema: HITCHES_SCHEMA, eventsSchema: DISPLAYED_SURFACES_SCHEMA, groupBy: "display", matchThread: false, run },
    description:
      "⚠️ hitches.swap-id and display-surface-swap.swap-id are DIFFERENT ID SPACES — querying " +
      "display-surface-swap filtered to a hitch's swap-id returns 0 rows, which is NOT evidence of " +
      "\"no matching presentation\" (a real gotcha, verified live). To join a hitch to its on-screen " +
      "presentation, use this TIME-WINDOW correlate instead (or join hitches-renders to " +
      "displayed-surfaces-interval via their shared surface-id, a real equality key).",
  };
}

/**
 * The off-CPU caveat (scratchpad 055/056/062): a hitch with no on-CPU
 * main-thread samples in its window is likely an IDLE held-frame, not a
 * compute problem — classify (on-CPU real / off-CPU idle / off-CPU blocked)
 * before concluding. Duration alone is an entry point, not a verdict
 * (scratchpad 059).
 *
 * Three tiers by what the trace carries: (1) if it has the off-CPU-side
 * schemas (syscall/thread-state), point straight at the DIG —
 * explain_off_cpu_interval NAMES the class by backtrace (PMT:lean-pass), the
 * strongest answer; (2) else if it has Time Profiler, correlate to at least
 * split on-CPU vs off-CPU (but that can't say idle-vs-blocked); (3) else
 * re-record. Mirrors hangsLens's timeProfileCorrelationHint's escalation.
 */
function offCpuClassificationAction(sessionId: string, run: number, allSchemas: string[]): NextAction {
  const hasOffCpu = OFF_CPU_SCHEMAS.some((s) => allSchemas.includes(s));
  if (hasOffCpu) {
    return {
      tool: "explain_off_cpu_interval",
      args: { sessionId, run, startNs: 0, endNs: 0, thread: "Main Thread" },
      description:
        "Before treating a hitch's duration as a compute problem, classify the stall: pass the hitch's " +
        "[start, start+duration] window here to explain_off_cpu_interval — it reads the syscall backtrace " +
        "and names whether the main thread was idle (a benign held-frame, e.g. parked at _DPSNextEvent), " +
        "genuinely BLOCKED (e.g. a synchronous dispatch wait on the render server), or scheduling-delayed. " +
        "Duration alone is an entry point, not a verdict; the class is in the stack, not the syscall name.",
    };
  }
  const hasTimeProfile = TIME_PROFILE_SCHEMAS.some((s) => allSchemas.includes(s));
  if (hasTimeProfile) {
    return {
      tool: "correlate",
      args: { sessionId, intervalsSchema: HITCHES_SCHEMA, eventsSchema: "time-sample", groupBy: "is-system", run },
      description:
        "Before treating a hitch's duration as a compute problem, classify it: correlate against Time " +
        "Profiler samples to see whether the main thread was actually ON-CPU during the hitch window " +
        "(a real compute cost) or had NO samples there (an off-CPU idle held-frame or a blocked wait) — " +
        "duration alone is an entry point, not a verdict. For the deeper idle-vs-blocked split, compose a " +
        "System Trace recording so syscall/thread-state are present and explain_off_cpu_interval can dig.",
    };
  }
  return {
    tool: "start_recording",
    args: { template: "Animation Hitches" },
    description:
      "hitches has no backtrace of its own, and this trace has no Time Profiler samples to correlate " +
      "against — re-record with template: \"Animation Hitches\" (already bundles Time Profiler) " +
      "before concluding a hitch's duration reflects real compute cost rather than an off-CPU idle hold.",
  };
}

/** hitches-renders' own surface-id is a real, working equality join key against displayed-surfaces-interval — the alternative the swap-id gotcha steers toward. */
function surfaceIdJoinAction(sessionId: string, run: number): NextAction {
  return {
    tool: "relate",
    args: {
      sessionId,
      schemaA: HITCHES_RENDERS_SCHEMA,
      schemaB: DISPLAYED_SURFACES_SCHEMA,
      joinCondition: "equality",
      polarity: "exists",
      on: [{ a: "surface-id", b: "surface-id" }],
      groupBy: "display",
      run,
    },
    description:
      "hitches-renders and displayed-surfaces-interval share a real surface-id equality key (unlike " +
      "swap-id, which does NOT join across hitches/display-surface-swap) — use this to see which " +
      "render passes correspond to which on-screen surface presentations.",
  };
}

/** device-display-info's display-id is numeric — hitches.display / the other Display schemas' display-name are the SAME "Display N" string form, a direct join key device-display-info does NOT share. */
function displayJoinKeyAction(sessionId: string, run: number): NextAction {
  return {
    tool: "find",
    args: { sessionId, schema: DEVICE_DISPLAY_INFO_SCHEMA, run, where: [{ col: "display-id", op: "not-null" }] },
    description:
      "hitches.display, display-vsyncs-interval.display-name, and displayed-surfaces-interval.display-name " +
      "all carry the SAME \"Display N\" string — a direct join key across those three. device-display-info's " +
      "own display-id is a DIFFERENT, numeric identifier — don't assume it matches hitches.display; join " +
      "on the shared \"Display N\" string form instead when correlating hitch/surface data against these.",
  };
}

const animationHitchesLens: Lens = {
  instruments: HITCHES_DISPLAY_SCHEMAS,

  registerTools(_server: McpServer): void {
    // No lens-specific tools — core verbs (find, aggregate, correlate, relate) work directly on these schemas.
  },

  nextActions(
    sessionId: string,
    schema: string,
    run: number,
    allSchemas: string[],
    row?: Record<string, CellDetail | null>
  ): NextAction[] {
    if (!HITCHES_DISPLAY_SCHEMAS.includes(schema) || row) return [];
    const actions: NextAction[] = [];

    if (schema === HITCHES_SCHEMA) {
      actions.push(swapIdGotchaAction(sessionId, run));
      actions.push(offCpuClassificationAction(sessionId, run, allSchemas));
    } else if (schema === DISPLAY_SURFACE_SWAP_SCHEMA) {
      actions.push(swapIdGotchaAction(sessionId, run));
    } else if (schema === HITCHES_RENDERS_SCHEMA) {
      actions.push(surfaceIdJoinAction(sessionId, run));
    } else if (schema === DEVICE_DISPLAY_INFO_SCHEMA) {
      actions.push(displayJoinKeyAction(sessionId, run));
    }

    return actions;
  },

  quickStart(schemas: string[], sessionId: string, run: number): QuickStart | null {
    if (!schemas.includes(HITCHES_SCHEMA)) return null;
    // Bounded-by-construction (PMT:spare-goat) — aggregate by display, not a
    // raw duration-sort. The richer "vsync-cadence frames held" table
    // (still-hail's vsyncCadenceTable.ts) is already computed automatically
    // around the worst hitch by the eager sweep (PMT:ruddy-elk) whenever one
    // fires — this quickStart is the fallback entry point for when nothing
    // fired yet (or this schema is being explored outside that sweep).
    return {
      schema: HITCHES_SCHEMA,
      tool: "aggregate",
      args: { sessionId, schema: HITCHES_SCHEMA, run, groupBy: "display", measure: "duration", op: "sum", topN: 10 },
      hint:
        "Animation Hitches trace — total hitch duration per display shows where drops concentrate. " +
        "The richer \"frames held\" vsync-cadence table (which turns a hitch's raw duration into the " +
        "concrete sequence of vsync ticks a surface sat on-screen through) is already computed " +
        "automatically around the worst hitch if one fires during the eager sweep — check the " +
        "recommended finding first before building this by hand.",
    };
  },
};

export default animationHitchesLens;
