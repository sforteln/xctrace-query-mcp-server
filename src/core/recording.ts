/**
 * Recording intent map — translates friendly verb intents into xctrace templates.
 *
 * Agents and users think in intents ("profile CPU", "find leaks") not xctrace
 * template strings. This layer encodes the non-obvious rules — most importantly
 * the two-Leaks behavior: Leaks alone yields no backtraces; Allocations+Leaks
 * together gives leaked objects their responsible frames.
 *
 * The interactive start_recording/stop_recording MCP tools (recordingSession.ts)
 * call startSession() with the resolved intent. The output path is
 * auto-generated in the server-owned recordings directory.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { XctraceError } from "../engine/xctrace.js";
import { openTrace } from "../engine/session.js";
import type { RunSummary, InstrumentSummary, TimeRange } from "../engine/session.js";

// ─── Intent model ─────────────────────────────────────────────────────────────

export interface RecordingIntent {
  /** Friendly name shown in the response so the agent knows what was recorded. */
  label: string;
  /** xctrace --template value. */
  template: string;
  /**
   * Extra instruments to add on top of the template via repeated
   * `--instrument <name>`. Built-in templates are single-instrument — e.g.
   * "Allocations" and "Leaks" are separate templates with no built-in
   * combination — so this is the only way to record both in one pass.
   */
  extraInstruments?: string[];
  /**
   * When true, --launch is required and --attach is not accepted.
   * App Launch is the only built-in intent with this constraint — its sole
   * purpose is capturing the startup sequence from process creation.
   */
  launchRequired: boolean;
  /** Extra explanation surfaced in the recording result. */
  note?: string;
  /**
   * Privacy warning surfaced to the agent and user before recording starts.
   * Set this for any template that captures user-generated content (prompts,
   * network payloads, database records, etc.) that could contain PII or secrets.
   */
  privacyNotice?: string;
  /**
   * Per-instrument recording options applied via `xctrace record --recording-options`.
   * Keys/values must match what `xcrun xctrace record --template <template>
   * --show-recording-options` reports for that template — xctrace silently
   * ignores unrecognised keys, so verify against that output before adding any.
   * These are baked-in defaults, not agent-tunable: the intent layer's whole
   * point is to keep raw xctrace knobs out of the tool surface, so only set
   * this when there's no real tradeoff (e.g. layout tracing is strictly more
   * data for free) — a genuine cost/benefit knob should stay at Apple's
   * per-template default rather than becoming a one-off param.
   */
  recordingOptions?: Record<string, Record<string, unknown>>;
}

/**
 * Which extra instruments a built-in xctrace TEMPLATE bundles for free, beyond
 * its own headline instrument — verified via `xcrun xctrace record --template
 * <name> --show-recording-options` for every template referenced below (that
 * command prints one entry per bundled instrument that HAS a configurable
 * recording option; an instrument with no configurable options, e.g. Thermal
 * State, is invisible to it, so this is a confirmed lower bound, not
 * necessarily the complete instrument list a template records).
 *
 * Why this matters: most of these template names are ALSO valid standalone
 * `--instrument` names (e.g. "Time Profiler" is both a template and an
 * instrument). Composing one of these names via `instruments: [...]` on top
 * of an unrelated base template gives you ONLY that bare instrument — none of
 * the bundle below — with no signal that anything is missing. An agent that
 * reaches for `instruments: ["Time Profiler"]` instead of `type: "cpu"` (or
 * `template: "Time Profiler"`) silently loses Hangs + Points of Interest and
 * would have no way to know Hangs data was never being recorded at all.
 * bundleWarningsFor() below uses this table to catch that case in-band.
 */
export const TEMPLATE_BUNDLES: Record<string, string[]> = {
  "Time Profiler": ["Hangs", "Points of Interest", "Thermal State"],
  "SwiftUI": ["Hangs", "Time Profiler"],
  "CPU Profiler": ["Hangs", "Points of Interest"],
  "CPU Counters": ["Time Profiler", "Points of Interest"],
  "Power Profiler": ["Metal Performance Overview", "Time Profiler"],
  "Allocations": ["Points of Interest"],
  "Leaks": ["Points of Interest"],
  "Core AI": ["Time Profiler"],
  "Core ML": ["Time Profiler"],
  "Processor Trace": ["Points of Interest"],
  "Network": ["Points of Interest"],
  "App Launch": ["Time Profiler"],
  "Animation Hitches": ["Hangs", "Time Profiler"],
  "Swift Concurrency": ["Hangs", "Points of Interest", "Time Profiler"],
};

/**
 * Warn when a caller-supplied `instruments` entry names a bare instrument
 * that is ALSO a richer built-in template (per TEMPLATE_BUNDLES) — the
 * concrete trap this table exists to catch. Only checks caller-supplied
 * names, not an intent's own curated `extraInstruments` (those are trusted,
 * already accounted for by whoever wrote the intent).
 */
export function bundleWarningsFor(
  resolvedTemplate: string,
  callerInstruments: string[] | undefined
): string[] {
  const warnings: string[] = [];
  for (const name of callerInstruments ?? []) {
    if (name === resolvedTemplate) continue;
    const bundle = TEMPLATE_BUNDLES[name];
    if (bundle && bundle.length > 0) {
      warnings.push(
        `"${name}" was added here as a single instrument — it does NOT include what the ` +
        `"${name}" TEMPLATE bundles for free (${bundle.join(" + ")}). If you wanted those too, ` +
        `use template: "${name}" (or the matching \`type\`, if one exists) instead of composing ` +
        `it via instruments.`
      );
    }
  }
  return warnings;
}

export const RECORDING_INTENTS = {
  cpu: {
    label: "Time Profiler",
    template: "Time Profiler",
    launchRequired: false,
    note:
      "The Time Profiler template already bundles Hangs + Points of Interest + Thermal State " +
      "for free — after opening, query 'potential-hangs'/'hitches' and points-of-interest " +
      "schemas alongside the CPU samples, no extra instruments needed.",
  },
  memory: {
    label: "Allocations",
    template: "Allocations",
    launchRequired: false,
    note: "The Allocations template already bundles Points of Interest for free.",
  },
  network: {
    label: "Network",
    template: "Network",
    launchRequired: false,
    note: "The Network template already bundles Points of Interest for free.",
    privacyNotice:
      "Network recordings capture all HTTP/HTTPS traffic including request bodies, " +
      "response payloads, cookies, and authorization headers. " +
      "API keys, session tokens, and user data may be stored in the trace.",
  },
  launch: {
    label: "App Launch",
    template: "App Launch",
    launchRequired: true,
    note:
      "App Launch requires --launch: its purpose is capturing the startup sequence from " +
      "process creation. Use record_cpu with attach for CPU profiling of a running app. " +
      "The App Launch template already bundles Time Profiler for free.",
  },
  leaks: {
    label: "Leaks",
    template: "Leaks",
    launchRequired: false,
    note:
      "Records Leaks only — fast, gives the leak list without responsible call frames. " +
      'Use "leaks-backtraces" to also capture stack frames (records Allocations + Leaks). ' +
      "The Leaks template already bundles Points of Interest for free.",
  },
  "leaks-backtraces": {
    label: "Allocations + Leaks (with backtraces)",
    template: "Allocations",
    extraInstruments: ["Leaks"],
    launchRequired: false,
    note:
      "Records Allocations + Leaks together so leaked objects carry responsible frames. " +
      'Use "leaks" for a faster Leaks-only recording (leak list, no stacks). ' +
      "Prefer launch over attach when you actually need to see WHERE a leaked object " +
      "came from: malloc stack logging only captures allocations made DURING the " +
      "recording, so with attach, anything already live when Instruments attaches has " +
      "no stack in principle, not from a symbolication failure — confirmed both by " +
      "get_row's PRE-ATTACHMENT label on Leaks/Leaks (join to Allocations/Allocations " +
      'List shows timestamp 0) and by Instruments.app\'s own UI ("No stack trace is ' +
      'available for this leak. It may have been allocated before the recording ' +
      'started."). Attach is fine when you only need the leak list/counts, not the callsite. ' +
      "The Allocations base template already bundles Points of Interest for free.",
  },
  hangs: {
    label: "Activity Monitor (Hangs & Hitches)",
    template: "Activity Monitor",
    launchRequired: false,
    note:
      "Records hangs, potential hangs, and hang risk events. " +
      "After opening, query the 'potential-hangs', 'hitches', and 'hang-risks' schemas. " +
      "This template does NOT bundle Points of Interest — if the app calls os_signpost around " +
      "its own operations, pass instruments: [\"Points of Interest\"] and correlate() a hang " +
      "interval against the signpost schemas (os-signpost/OSSignpostIntervals) to see which " +
      "named app operation was running when the hang occurred.",
  },
  hitches: {
    label: "Animation Hitches",
    template: "Animation Hitches",
    launchRequired: false,
    note:
      "Records animation hitches (frame drops during scrolling, animations, and transitions). " +
      "After opening, query the 'hitches' schema. The Animation Hitches template already " +
      "bundles Hangs + Time Profiler for free (with a tighter 33ms hang threshold tuned for " +
      "hitch detection, vs. the default 250ms), but NOT Points of Interest — if the app calls " +
      "os_signpost around its own operations, pass instruments: [\"Points of Interest\"] and " +
      "correlate() a hitch interval against the signpost schemas to see which named app " +
      "operation was running when the frame dropped.",
  },
  "swift-concurrency": {
    label: "Swift Concurrency",
    template: "Swift Concurrency",
    launchRequired: false,
    note:
      "Records Swift Task and Actor lifetimes, executor queue depth, and task state transitions. " +
      "After opening, query SwiftTaskLifetime, SwiftActorLifetime, SwiftActorQueueSize, " +
      "SwiftTaskCreationEvent, and SwiftTaskStateTable schemas. The Swift Concurrency template " +
      "already bundles Hangs + Points of Interest + Time Profiler for free.",
  },
  swiftui: {
    label: "SwiftUI",
    template: "SwiftUI",
    launchRequired: false,
    note:
      "Records SwiftUI view body re-evaluations, state changes, and layout passes " +
      "(layout tracing is enabled by default). After opening, query 'swiftui-updates' " +
      "and 'swiftui-changes' for update/cause events, or 'swiftui-layout-updates' / " +
      "'SwiftUILayoutUpdates2' for per-view layout pass timing. The SwiftUI template already " +
      "bundles Hangs + Time Profiler for free (with highFrequencySampling enabled) — query " +
      "Time Profiler's schemas directly for CPU cost alongside the view-update data, no " +
      "extra instruments or a separate recording needed.",
    recordingOptions: {
      SwiftUI: { enableLayoutTracing: true },
    },
  },
  "core-data": {
    label: "Data Persistence (Core Data / SwiftData)",
    template: "Data Persistence",
    launchRequired: false,
    note:
      "Records Core Data and SwiftData object faults, relationship faults, fetches, and saves. " +
      "After opening, query 'core-data-fault', 'core-data-relationship-fault', " +
      "'core-data-fetch', and 'core-data-save' schemas. " +
      "To attribute this activity to the UI event that triggered it, pass " +
      "instruments: [\"SwiftUI\"] to start_recording — each row's Caller backtrace already " +
      "resolves the full call chain (e.g. a SwiftUI view body update through AttributeGraph " +
      "into the fetch), readable directly via get_row, no extra correlation step needed.",
    privacyNotice:
      "Data Persistence recordings capture entity names, fetch predicates, and object contents. " +
      "Database records including user-generated content may be stored in the trace.",
  },
  "foundation-models": {
    label: "Foundation Models",
    template: "Foundation Models",
    launchRequired: false,
    note:
      "Records all on-device Foundation Models inference calls: prompts, responses, " +
      "token counts, and latency. After opening, query ModelInferenceTable and ModelLoadingTable.",
    privacyNotice:
      "This recording captures ALL Foundation Models prompts and responses in unencrypted form, " +
      "including any sensitive or personally identifying information such as emails, messages, " +
      "phone numbers, usernames, access tokens, and passwords. " +
      "Inform the user before starting — xctrace will also log this data to system logs.",
  },
} satisfies Record<string, RecordingIntent>;

/**
 * Privacy notices keyed by template OR instrument name. Distinct from
 * RecordingIntent.privacyNotice above (which is the curated, more detailed
 * text for a whole intent's base template): this covers ad-hoc composition —
 * extraInstruments, a caller-supplied `instruments` list, or a raw `template`
 * override — so e.g. composing `instruments: ["Foundation Models"]` on top of
 * an unrelated intent still surfaces a warning, not just the built-in
 * foundation-models intent itself.
 */
const SENSITIVE_NAME_NOTICES: Record<string, string> = {
  Network:
    "Network recordings capture all HTTP/HTTPS traffic including request bodies, " +
    "response payloads, cookies, and authorization headers. API keys, session tokens, " +
    "and user data may be stored in the trace.",
  "Foundation Models":
    "This recording captures ALL Foundation Models prompts and responses in unencrypted form, " +
    "including any sensitive or personally identifying information such as emails, messages, " +
    "phone numbers, usernames, access tokens, and passwords. " +
    "Inform the user before starting — xctrace will also log this data to system logs.",
  "Data Persistence":
    "Data Persistence recordings capture entity names, fetch predicates, and object contents. " +
    "Database records including user-generated content may be stored in the trace.",
  "Data Fetches":
    "Core Data/SwiftData fetch recordings capture entity names and fetch predicates, " +
    "which may include user-generated content.",
  "Data Faults":
    "Core Data/SwiftData fault recordings capture entity and relationship names tied to " +
    "specific managed objects, which may include user-generated content.",
  "Data Saves":
    "Core Data/SwiftData save recordings capture entity names tied to specific managed " +
    "objects, which may include user-generated content.",
};

/**
 * Collect distinct privacy notices for a set of template/instrument names,
 * in first-seen order. Callers typically pass extraInstruments/instruments/
 * a raw template override — NOT the base intent's own template, since that's
 * already covered by RecordingIntent.privacyNotice (more detailed, curated
 * text) and would otherwise show a redundant second notice.
 */
export function collectPrivacyNotices(names: (string | undefined)[]): string[] {
  const notices: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (!name) continue;
    const notice = SENSITIVE_NAME_NOTICES[name];
    if (notice && !seen.has(notice)) {
      seen.add(notice);
      notices.push(notice);
    }
  }
  return notices;
}

// ─── Output path ──────────────────────────────────────────────────────────────

/**
 * Generate a timestamped output path in the server-owned recordings directory
 * (~Library/Application Support/far-swan/recordings/<ts>-<slug>.trace).
 * Creates the directory if it doesn't exist.
 */
export async function defaultOutputPath(template: string): Promise<string> {
  const dir = join(
    homedir(),
    "Library",
    "Application Support",
    "far-swan",
    "recordings"
  );
  await mkdir(dir, { recursive: true });

  const ts = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .slice(0, 19);
  const slug = template.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return join(dir, `${ts}-${slug}.trace`);
}

/**
 * Write an intent's recordingOptions to a JSON file alongside the trace output
 * (same directory, same base name) so xctrace's --recording-options can find it.
 * Returns undefined when the intent has no recordingOptions — callers skip the flag.
 */
export async function writeRecordingOptionsFile(
  outputPath: string,
  recordingOptions: Record<string, Record<string, unknown>> | undefined
): Promise<string | undefined> {
  if (!recordingOptions) return undefined;
  const optionsPath = outputPath.replace(/\.trace$/, ".recording-options.json");
  await writeFile(optionsPath, JSON.stringify(recordingOptions, null, 2), "utf8");
  return optionsPath;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface OpenedSession {
  sessionId: string;
  runs: RunSummary[];
  instruments: InstrumentSummary[];
  timeRange: TimeRange | null;
}

// ─── Auto-open helper ─────────────────────────────────────────────────────────

/**
 * Best-effort openTrace after a recording completes. Returns { session } on
 * success or { openError } on failure — never throws. Callers include both the
 * blocking record_* verbs and the interactive stop_recording tool.
 */
export async function tryOpenTrace(
  tracePath: string
): Promise<{ session: OpenedSession } | { openError: object }> {
  try {
    const { sessionId, runs, instruments, timeRange } = await openTrace(tracePath);
    return { session: { sessionId, runs, instruments, timeRange } };
  } catch (err) {
    if (err instanceof XctraceError) {
      return { openError: err.toStructured() };
    }
    return { openError: { error: "open-failed", message: String(err) } };
  }
}
