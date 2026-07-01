/**
 * Recording intent map — translates friendly verb intents into xctrace templates.
 *
 * Agents and users think in intents ("profile CPU", "find leaks") not xctrace
 * template strings. This layer encodes the non-obvious rules — most importantly
 * the two-Leaks behavior: Leaks alone yields no backtraces; Allocations+Leaks
 * together gives leaked objects their responsible frames.
 *
 * Each MCP recording tool calls startRecording() with the resolved intent.
 * The output path is auto-generated in the server-owned recordings directory.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { record } from "../engine/record.js";
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

export const RECORDING_INTENTS = {
  cpu: {
    label: "Time Profiler",
    template: "Time Profiler",
    launchRequired: false,
  },
  memory: {
    label: "Allocations",
    template: "Allocations",
    launchRequired: false,
  },
  network: {
    label: "Network",
    template: "Network",
    launchRequired: false,
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
      "process creation. Use record_cpu with attach for CPU profiling of a running app.",
  },
  leaks: {
    label: "Leaks",
    template: "Leaks",
    launchRequired: false,
    note:
      "Records Leaks only — fast, gives the leak list without responsible call frames. " +
      'Use "leaks-backtraces" to also capture stack frames (records Allocations + Leaks).',
  },
  "leaks-backtraces": {
    label: "Allocations + Leaks (with backtraces)",
    template: "Allocations",
    extraInstruments: ["Leaks"],
    launchRequired: false,
    note:
      "Records Allocations + Leaks together so leaked objects carry responsible frames. " +
      'Use "leaks" for a faster Leaks-only recording (leak list, no stacks).',
  },
  hangs: {
    label: "Activity Monitor (Hangs & Hitches)",
    template: "Activity Monitor",
    launchRequired: false,
    note:
      "Records hangs, potential hangs, and hang risk events. " +
      "After opening, query the 'potential-hangs', 'hitches', and 'hang-risks' schemas.",
  },
  hitches: {
    label: "Animation Hitches",
    template: "Animation Hitches",
    launchRequired: false,
    note:
      "Records animation hitches (frame drops during scrolling, animations, and transitions). " +
      "After opening, query the 'hitches' schema.",
  },
  "swift-concurrency": {
    label: "Swift Concurrency",
    template: "Swift Concurrency",
    launchRequired: false,
    note:
      "Records Swift Task and Actor lifetimes, executor queue depth, and task state transitions. " +
      "After opening, query SwiftTaskLifetime, SwiftActorLifetime, SwiftActorQueueSize, " +
      "SwiftTaskCreationEvent, and SwiftTaskStateTable schemas.",
  },
  swiftui: {
    label: "SwiftUI",
    template: "SwiftUI",
    launchRequired: false,
    note:
      "Records SwiftUI view body re-evaluations, state changes, and layout passes " +
      "(layout tracing is enabled by default). After opening, query 'swiftui-updates' " +
      "and 'swiftui-changes' for update/cause events, or 'swiftui-layout-updates' / " +
      "'SwiftUILayoutUpdates2' for per-view layout pass timing.",
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
      "'core-data-fetch', and 'core-data-save' schemas.",
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

export interface StartRecordingOptions {
  intent: RecordingIntent;
  attach?: string;
  launch?: string;
  device?: string;
  timeLimit?: string;
}

export interface OpenedSession {
  sessionId: string;
  runs: RunSummary[];
  instruments: InstrumentSummary[];
  timeRange: TimeRange | null;
}

export interface StartRecordingResult {
  /** Path of the produced .trace bundle. */
  tracePath: string;
  /** xctrace template used. */
  template: string;
  /** Friendly description of the instruments that were active. */
  instrumentsUsed: string;
  /** Extra context about what was recorded and why. */
  note?: string;
  /** Data-sensitivity warning for templates that capture PII or secrets. */
  privacyNotice?: string;
  /**
   * Automatically-opened session — present when openTrace succeeded.
   * Pass sessionId to list_instruments / describe_schema.
   */
  session?: OpenedSession;
  /** Structured error from openTrace, present when auto-open failed. */
  openError?: object;
}

/**
 * Resolve an intent, generate an output path, and run xctrace record.
 * Auto-opens the resulting trace and returns a ready-to-use sessionId.
 *
 * @throws {XctraceError} — structured error for any xctrace or validation failure.
 */
export async function startRecording(
  opts: StartRecordingOptions
): Promise<StartRecordingResult> {
  const { intent, attach, launch, device, timeLimit } = opts;

  // Enforce launch-required for App Launch (and any future launch-only intent).
  if (intent.launchRequired && launch === undefined) {
    throw new XctraceError(
      "record-failed",
      `${intent.label} requires a launch path (the --launch flag). ` +
        (intent.note ?? ""),
      {}
    );
  }

  const outputPath = await defaultOutputPath(intent.template);
  const recordingOptionsFile = await writeRecordingOptionsFile(outputPath, intent.recordingOptions);

  // Delegate to the engine wrapper — it validates attach/launch exclusivity
  // and maps every xctrace failure to a structured XctraceError.
  await record({
    template: intent.template,
    extraInstruments: intent.extraInstruments,
    attach,
    launch,
    device,
    timeLimit,
    output: outputPath,
    recordingOptionsFile,
  });

  const base: StartRecordingResult = {
    tracePath: outputPath,
    template: intent.template,
    instrumentsUsed: intent.label,
    ...(intent.note ? { note: intent.note } : {}),
    ...(intent.privacyNotice ? { privacyNotice: intent.privacyNotice } : {}),
  };

  return { ...base, ...(await tryOpenTrace(outputPath)) };
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
