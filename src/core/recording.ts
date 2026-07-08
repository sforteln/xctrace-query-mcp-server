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
 * instrument). The two composition params below (see StartSessionOptions in
 * recordingSession.ts) exist BECAUSE of this overlap: `templates` explicitly
 * asks for a name's full bundle (expandTemplates() below uses this table);
 * `instruments` explicitly asks for the bare instrument only, and is never
 * auto-promoted — an `instruments` entry that happens to match a key here
 * only gets a steer-to-`templates` note, never silent expansion. Naming was
 * deliberately picked to make the two knobs impossible to confuse: you say
 * which one you meant instead of the server guessing from an overloaded name.
 */
export const TEMPLATE_BUNDLES: Record<string, string[]> = {
  "Time Profiler": ["Hangs", "Points of Interest", "Thermal State"],
  "SwiftUI": ["Hangs", "Time Profiler"],
  "CPU Profiler": ["Hangs", "Points of Interest", "Thermal State"],
  "CPU Counters": ["Time Profiler", "Points of Interest"],
  "Power Profiler": ["Metal Performance Overview", "Time Profiler"],
  "Allocations": ["Points of Interest"],
  "Leaks": ["Points of Interest"],
  "Core AI": ["Time Profiler"],
  "Core ML": ["Time Profiler"],
  "Processor Trace": ["Points of Interest"],
  "Network": ["Points of Interest"],
  "App Launch": ["Time Profiler"],
  "Animation Hitches": ["Hangs", "Points of Interest", "Time Profiler"],
  "Swift Concurrency": ["Hangs", "Points of Interest", "Time Profiler"],
};

/**
 * Look up the curated `recordingOptions` a RECORDING_INTENTS entry bakes in
 * for its own template (e.g. swiftui's `enableLayoutTracing`), keyed by
 * template name instead of intent name. Composing that template's name via
 * `templates` should carry these along too — otherwise expandTemplates would
 * correctly add the SwiftUI instrument + its Hangs + Time Profiler bundle,
 * but silently drop layout tracing, which is exactly the same
 * "looks complete, isn't" trap one level down.
 */
function templateRecordingOptions(
  templateName: string
): Record<string, Record<string, unknown>> | undefined {
  for (const intent of Object.values(RECORDING_INTENTS) as RecordingIntent[]) {
    if (intent.template === templateName && intent.recordingOptions) {
      return intent.recordingOptions;
    }
  }
  return undefined;
}

export interface ExpandedTemplates {
  /** Union of every bundled instrument, excluding the base template itself. */
  instruments: string[];
  /** Merged recordingOptions contributed by any composed template. */
  recordingOptions: Record<string, Record<string, unknown>>;
  /** One entry per composed name, describing what it expanded to. */
  notes: string[];
  /**
   * Instruments that ended up in `instruments` WITHOUT being part of the base
   * template's own bundle (TEMPLATE_BUNDLES[resolvedTemplate]) — meaning they
   * were only ever addable as a bare `--instrument` flag, which does not carry
   * a template's tuned configuration or template-only auxiliary behavior
   * (e.g. Hangs' hangsThreshold defaults to 100 bare vs 250 via a real
   * template; os-log's subsystem/category scope never survives a bare
   * addition at all — see PMT:gravel-falcon). Empty when every composed
   * instrument happens to already be covered by the base template's own
   * bundle (e.g. composing SwiftUI onto a Swift-Concurrency base costs
   * nothing extra here, since Swift Concurrency's own bundle already
   * includes Hangs/Time Profiler with full fidelity) — verified live that
   * xctrace's template-sourced config wins even if a redundant bare
   * `--instrument` of the same name is also present, so this is purely a
   * reporting concern, not something that needs de-duplication logic.
   */
  fidelityAtRisk: string[];
}

/**
 * A caller reaching for `templates` sometimes writes a `type` enum key
 * (e.g. "swift-concurrency") instead of the real xctrace template name
 * ("Swift Concurrency") the two are easy to confuse — verified live, this
 * exact mistake happened in a real cross-AI conversation. Every `type` key
 * already knows its own real template name, so there's no reason to make
 * the caller get the casing/spelling exactly right for anything already
 * curated — resolve a recognized `type` key transparently. Anything else
 * passes through unchanged, assumed to already be a real template name
 * (e.g. an uncurated one no `type` covers) — if it's wrong, that's now a
 * genuine "check `xcrun xctrace list templates`" case, not a trap we set.
 */
export function resolveTemplateName(name: string): string {
  const intent = (RECORDING_INTENTS as Record<string, RecordingIntent>)[name];
  return intent ? intent.template : name;
}

/**
 * Expand a caller's explicit `templates` list — additional WHOLE templates to
 * layer onto the base one — into the real union of instruments xctrace needs,
 * plus any recordingOptions those templates bake in. Each name is expanded to
 * `[name, ...TEMPLATE_BUNDLES[name]]`; a name with no known bundle still
 * passes through as itself (e.g. a template with only a headline instrument
 * and no configurable-options bundle to discover). This is the ONLY place
 * TEMPLATE_BUNDLES expansion happens — `instruments` (bare) is never silently
 * promoted through this path, see bareInstrumentTemplateNotes() below.
 */
export function expandTemplates(
  names: string[],
  resolvedTemplate: string
): ExpandedTemplates {
  const seen = new Set<string>([resolvedTemplate]);
  // Instruments the base template's OWN bundle already covers with full
  // fidelity — a real `--template <resolvedTemplate>` invocation, not a bare
  // `--instrument` addition. Anything in here (or the base name itself)
  // keeps its tuned config/auxiliary behavior even if a composed extra also
  // "wants" it; anything NOT in here that ends up in `instruments` only got
  // there via a bare addition — see PMT:gravel-falcon.
  const baseCovered = new Set<string>([resolvedTemplate, ...(TEMPLATE_BUNDLES[resolvedTemplate] ?? [])]);
  const instruments: string[] = [];
  const recordingOptions: Record<string, Record<string, unknown>> = {};
  const notes: string[] = [];
  const fidelityAtRisk = new Set<string>();

  for (const rawName of names) {
    const name = resolveTemplateName(rawName);
    const bundle = TEMPLATE_BUNDLES[name] ?? [];
    const expansion = [name, ...bundle];
    const added: string[] = [];
    const addedAtRisk: string[] = [];
    for (const inst of expansion) {
      if (!seen.has(inst)) {
        seen.add(inst);
        instruments.push(inst);
        added.push(inst);
        // Only the AUXILIARY bundle instruments are a fidelity concern — the
        // composed template's own headline instrument (`name`) is what the
        // caller explicitly asked for, and its own tuned recordingOptions (if
        // any) are already separately preserved via templateRecordingOptions()
        // regardless of bare-vs-template addition (e.g. SwiftUI's
        // enableLayoutTracing). It's the bundle items riding along implicitly
        // (e.g. Hangs, Time Profiler) whose tuned config/auxiliary behavior
        // the caller isn't necessarily thinking about that can silently
        // degrade — see PMT:gravel-falcon.
        if (inst !== name && !baseCovered.has(inst)) {
          fidelityAtRisk.add(inst);
          addedAtRisk.push(inst);
        }
      }
    }
    const opts = templateRecordingOptions(name);
    if (opts) Object.assign(recordingOptions, opts);

    const resolvedNote = name !== rawName ? ` ("${rawName}" is a \`type\` key — resolved to its real template)` : "";
    const fidelityNote =
      addedAtRisk.length > 0
        ? ` ${addedAtRisk.join(", ")} ${addedAtRisk.length === 1 ? "was" : "were"} added bare (not part of ` +
          `"${resolvedTemplate}"'s own bundle) — tuned configuration and any template-only auxiliary behavior ` +
          `(e.g. Hangs' threshold, os-log's subsystem/category scope) is NOT guaranteed to match a real ` +
          `template recording of "${name}".`
        : bundle.length > 0
          ? ` Full fidelity — every instrument here is already covered by "${resolvedTemplate}"'s own bundle.`
          : "";
    notes.push(
      bundle.length > 0
        ? `template: "${name}" expanded to ${[name, ...bundle].join(" + ")}` +
          `${opts ? " plus its own recording options" : ""}${resolvedNote}.${fidelityNote}`
        : `template: "${name}" has no known extra bundle — recorded as its headline instrument only${resolvedNote}.`
    );
  }

  return { instruments, recordingOptions, notes, fidelityAtRisk: [...fidelityAtRisk] };
}

/**
 * Steer, never silently fix: when a caller-supplied BARE `instruments` entry
 * names something that is ALSO a richer template (per TEMPLATE_BUNDLES), it
 * is recorded exactly as named — no expansion — since a caller reaching for
 * `instruments` may deliberately want just that one bare signal (e.g. to
 * avoid a second CPU-sampling instrument already covered elsewhere). This
 * only adds a note pointing at `templates` in case the caller actually meant
 * "the whole template" and picked the wrong param.
 */
export function bareInstrumentTemplateNotes(
  resolvedTemplate: string,
  callerInstruments: string[] | undefined
): string[] {
  const notes: string[] = [];
  for (const name of callerInstruments ?? []) {
    if (name === resolvedTemplate) continue;
    const bundle = TEMPLATE_BUNDLES[name];
    if (bundle && bundle.length > 0) {
      notes.push(
        `instruments: ["${name}"] was recorded as that BARE instrument only — it does NOT include ` +
        `what the "${name}" TEMPLATE bundles for free (${bundle.join(" + ")}). If you wanted the ` +
        `whole template, pass templates: ["${name}"] instead (or the matching \`type\`, if one exists).`
      );
    }
  }
  return notes;
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
    note:
      "The Network template already bundles Points of Interest for free. It fuses TWO independent " +
      "sources with DIFFERENT scoping: (1) per-process CFNetwork/URLSession client tables — respect " +
      "attach/launch, but only capture OUTBOUND URLSession/CFNetwork client activity, so they're empty " +
      "for a socket server or any non-URLSession networking (verified live: empty for an MCP server " +
      "that only accepts inbound connections). (2) NetworkConnectionStats/network-connection-update/" +
      "network-connection-detected — a system-wide interface tap that IGNORES attach/launch entirely " +
      "and records every process on the interface; scope these with a pid/process filter via " +
      "find/aggregate instead. Also: loopback traffic (localhost/127.0.0.1/::1) is NEVER captured — " +
      "the tap is bound to physical interfaces (e.g. en0/Wi-Fi), not loopback. To profile a localhost-" +
      "only client+server pair, drive the traffic from ANOTHER host on the same network so it crosses " +
      "a physical interface instead.",
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
    label: "CPU Profiler (Hangs, low overhead)",
    template: "CPU Profiler",
    launchRequired: false,
    note:
      "Records hangs and hang-risk events at low overhead — verified live: this template's real " +
      "schemas are 'potential-hangs' and 'hang-risks' (NOT 'hitches' — that schema only comes from " +
      "type: \"hitches\"/Animation Hitches; if you're chasing frame drops during scrolling/animation " +
      "specifically, use that instead). Points of Interest is already bundled for free. " +
      "IMPORTANT — decide this NOW, not after recording: 'potential-hangs' carries start/duration/" +
      "thread/process but NO backtrace column — it tells you WHEN a hang happened, never WHAT was " +
      "running, and this template has no CPU-sampling instrument to correlate against (its own " +
      "'cpu-profile' schema is a lightweight counter-based profile, not the tagged-backtrace " +
      "'time-profile' schema call_tree/correlate need). If you already know you'll want to see what " +
      "the app was doing during a hang, don't compose templates: [\"Time Profiler\"] onto this — " +
      "use type: \"cpu\" instead: Time Profiler's own template already bundles Hangs + Points of " +
      "Interest + Thermal State for free, so it's a strict superset of this recording plus full CPU " +
      "attribution, in one pass, without running two separate CPU-sampling instruments side by side. " +
      "Reach for type: \"hangs\" specifically when you want lower-overhead hang-watching over a long " +
      "session and don't need CPU attribution.",
  },
  hitches: {
    label: "Animation Hitches",
    template: "Animation Hitches",
    launchRequired: false,
    note:
      "Records animation hitches (frame drops during scrolling, animations, and transitions). " +
      "After opening, query the 'hitches' schema — like 'potential-hangs', it carries no " +
      "backtrace of its own, but UNLIKE 'hangs' (type: \"hangs\"), you don't need to compose " +
      "anything extra to find out what was running: the Animation Hitches template already " +
      "bundles Hangs + Points of Interest + Time Profiler for free (with a tighter 33ms hang " +
      "threshold tuned for hitch detection, vs. the default 250ms) — correlate a hitch's " +
      "[start, start+duration] against Time Profiler's samples directly, or call_tree(view: " +
      "\"hot\" or \"spine\", timeRange: <the hitch's window>), no re-recording needed. If the " +
      "app calls os_signpost, its events are already captured — no extra instrument needed.",
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
      "templates: [\"SwiftUI\"] to start_recording — each row's Caller backtrace already " +
      "resolves the full call chain (e.g. a SwiftUI view body update through AttributeGraph " +
      "into the fetch), readable directly via get_row, no extra correlation step needed. " +
      "templates (not instruments) is what you want here: it records the COMPLETE SwiftUI " +
      "template — its own Hangs + Time Profiler bundle, layout tracing enabled — alongside " +
      "Data Persistence, in one recording. instruments: [\"SwiftUI\"] would give you only " +
      "the bare SwiftUI instrument, missing that bundle.",
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
      "token counts, and latency. After opening, query ModelInferenceTable and ModelLoadingTable. " +
      "To confirm inference actually ran on the Neural Engine (rather than falling back to CPU/GPU) " +
      "and measure real hardware utilization, compose instruments: [\"Neural Engine\"] into this " +
      "recording — verified live: it adds the 'ane-hw-intervals' schema (start/duration per ANE-busy " +
      "interval, no thread/backtrace column), which correlate can pair against ModelInferenceTable's " +
      "own request timestamps on the shared clock to answer 'was the ANE busy for the full span of " +
      "this inference' — a provable hardware fact, not an assumption.",
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
 * extraInstruments, a caller-supplied `instruments` or `templates` list, or a
 * raw `template` override — so e.g. composing `templates: ["Foundation
 * Models"]` on top of an unrelated intent still surfaces a warning, not just
 * the built-in foundation-models intent itself.
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
