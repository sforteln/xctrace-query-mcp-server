/**
 * Interactive recording lifecycle — start/stop keyed by recordingId.
 *
 * Unlike the blocking startRecording() in recording.ts (which uses execFile and
 * returns only after xctrace exits), this module spawns xctrace as a background
 * process and lets the caller control when to finalize:
 *
 *   startSession() → spawn xctrace, return recordingId immediately
 *   stopSession(id) → send SIGINT, wait for graceful exit, return .trace path
 *
 * SIGINT (not SIGKILL) triggers xctrace's graceful finalization: it flushes
 * buffered data and writes a valid .trace bundle before exiting. SIGKILL would
 * leave the bundle incomplete.
 *
 * Active recordings are stored in an in-memory map for the process lifetime.
 * The map is intentionally not persisted — a server restart loses in-progress
 * recordings (xctrace would keep running, but we'd lose the recordingId).
 */
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { spawnRecord } from "../engine/record.js";
import { detectXcodeVersion } from "../engine/xcodeVersion.js";
import { resolveAttachTarget } from "./resolveAttachTarget.js";
import { isSimulatorTarget, assertUnambiguousDevice } from "./listDevices.js";
import {
  defaultOutputPath,
  writeRecordingOptionsFile,
  collectPrivacyNotices,
  expandTemplates,
  bareInstrumentTemplateNotes,
  mitigateHangsOsLogFidelity,
  defaultPointsOfInterest,
  deviceOnlyInstrumentWarning,
  hostArchInstrumentWarning,
  knownBrokenInstrumentWarning,
  resolveCustomTemplateName,
  CUSTOM_TEMPLATE_NOTES,
  TEMPLATE_NOTES,
  TEMPLATE_RECORDING_OPTIONS,
  LAUNCH_REQUIRED_TEMPLATES,
  allocationsLeaksNote,
} from "./recording.js";
import { XctraceError } from "../engine/xctrace.js";
import type { ChildProcess } from "node:child_process";

// ─── Status model ─────────────────────────────────────────────────────────────

export type RecordingStatus = "recording" | "finalizing" | "done" | "failed";

interface ActiveRecording {
  recordingId: string;
  tracePath: string;
  template: string;
  instrumentsUsed: string;
  status: RecordingStatus;
  startedAt: number;
  process: ChildProcess | null;
  /** Resolves once the process exits (normally, via SIGINT, or on error). */
  done: Promise<void>;
  exitCode: number | null;
  /** Accumulated stderr (trimmed, last 2 KB kept). */
  stderr: string;
  /**
   * Accumulated stdout (trimmed, last 2 KB kept). xctrace normally prints
   * diagnostics to stderr, but a launch-mode failure has been observed with
   * a non-zero exit code and completely empty stderr — capture stdout too
   * so a failure like that isn't a dead end with nothing to go on.
   */
  stdout: string;
  /**
   * Set when xctrace exited non-zero at finalize but the trace bundle still
   * exists — verified live: a launch-mode recording exited 54 during
   * teardown twice, and the resulting trace was still valid and openable
   * (765 MB, full structure) both times. A non-zero finalize exit does NOT
   * mean the recording is unusable, so this is surfaced as a warning rather
   * than discarding real data by throwing "failed". But it can also mean a
   * schema's write was interrupted mid-flight while others (already fully
   * written) survive intact — also verified live: Allocations came through
   * complete (765 MB) while Leaks/Leaks came back with 0 rows and NO
   * COLUMNS AT ALL in the same trace, meaning that schema's write likely
   * never completed — a schema in this state must not be read as "ran and
   * found nothing," only as "may not have finished."
   */
  finalizeWarning?: string;
}

const activeRecordings = new Map<string, ActiveRecording>();

// ─── Start ────────────────────────────────────────────────────────────────────

export interface StartSessionOptions {
  attach?: string;
  launch?: string;
  device?: string;
  timeLimit?: string;
  /**
   * BARE extra instruments to compose on top of the base template, via
   * repeated `--instrument <name>` — recorded exactly as named, never
   * expanded even when the name is ALSO a richer template (see
   * bareInstrumentTemplateNotes in recording.ts). Use this for a genuinely
   * standalone instrument, or when you deliberately want only that
   * instrument's raw signal without its template's extras. Use `template`'s
   * array form instead when you want a whole second template's full bundle.
   */
  instruments?: string[];
  /**
   * Which template(s) to record with (PMT:stubborn-beck — collapsed from the
   * old separate `template`/`templates` params, one polymorphic param
   * instead of two spellings of the same "what's my base" decision). A
   * single string is a straightforward base template (real xctrace name, or
   * a recognized custom-template shortcut like "memory-vm" — see
   * CUSTOM_TEMPLATE_PATHS in recording.ts). An array's FIRST entry becomes
   * the base (passed via --template); every entry after it is an ADDITIONAL
   * whole template composed on top, each expanded to its full bundled
   * instrument set (per TEMPLATE_BUNDLES) plus any recordingOptions it bakes
   * in — so template: ["Data Persistence", "SwiftUI"] records the complete
   * union of both templates, not Data Persistence's template plus a bare,
   * bundle-less SwiftUI instrument. Omit entirely (with `instruments`
   * non-empty) for a template-less recording — xctrace's own implicit
   * "Blank template".
   */
  template?: string | string[];
  /**
   * Subsystem name(s) to enable for CUSTOM app-defined os_signpost interval
   * capture (`OSSignposter.beginInterval`/`endInterval` calls, landing in
   * the `OSSignpostIntervals` schema) — e.g. ["com.example.myapp"]. This is
   * the ONLY way to capture those: verified live (test-os-signpost-
   * subsystem-capture.md, PMT:vivid-rill) that `os_signpost` is a real,
   * separate xctrace instrument (distinct from "Points of Interest") whose
   * `dynamicTracingEnabledSubsystems` recording-option defaults to an EMPTY
   * array — with no subsystem listed, the OS never enables tracing for a
   * custom app subsystem, no matter which template or which other
   * instruments are composed. When given, composes the bare `os_signpost`
   * instrument and sets this option. Not needed for `emitEvent`-style
   * instant signposts on a `category: .pointsOfInterest` log handle — those
   * land in `PointsOfInterestEvents` via the `Points of Interest` instrument
   * alone (already auto-composed by defaultPointsOfInterest), no subsystem
   * gate at all.
   */
  signpostSubsystems?: string[];
}

export interface StartSessionResult {
  recordingId: string;
  status: "recording";
  tracePath: string;
  template: string;
  instrumentsUsed: string;
  privacyNotice?: string;
  /**
   * Every piece of curated guidance about this recording, joined together:
   * the resolved base template's own note (TEMPLATE_NOTES), the Allocations/
   * Leaks recipe note when relevant, what any additional composed templates
   * expanded to, bare-instrument steering, and the Hangs os-log / Points of
   * Interest auto-add notes. Previously split across a separate `note`
   * (intent-level) and `compositionNote` (composition-level) field — merged
   * since there's no more "intent" object to justify keeping that distinction.
   */
  compositionNote?: string;
  /**
   * Instruments added bare via `templates` composition that are NOT part of
   * the base template's own bundle — their tuned configuration and any
   * template-only auxiliary behavior (e.g. Hangs' threshold, os-log's scope)
   * is not guaranteed to match a real template recording. Empty/absent when
   * every composed instrument happens to already be covered by the base
   * template's own bundle. See PMT:gravel-falcon.
   */
  fidelityAtRisk?: string[];
  /**
   * Present when the target is a Simulator AND the resolved template/
   * instruments include one or more device-only instruments (needs the GPU,
   * real display, energy/thermal sensors, or CPU performance counters/ANE —
   * see DEVICE_ONLY_INSTRUMENTS in recording.ts). A WARNING, not a block —
   * the curated map may drift; the rest of the recording still proceeds, and
   * record()'s partial-success runIssues handling is the backstop for the
   * actual outcome. See PMT:stormy-coast.
   */
  deviceOnlyWarning?: string;
  /**
   * Present when the resolved template/instruments include one or more
   * instruments the CURRENT HOST Mac's CPU architecture can't support (see
   * HOST_ARCH_ONLY_INSTRUMENTS in recording.ts) — e.g. "Processor Trace" on
   * any Apple Silicon Mac (needs Intel PT hardware). Unlike deviceOnlyWarning
   * this is NOT about the target (device/Simulator) — it fails the same way
   * regardless of what's being profiled, because the limit is the machine
   * running Instruments itself. A WARNING, not a block — record()'s
   * partial-success runIssues handling remains the backstop.
   */
  hostArchWarning?: string;
  /**
   * Present when the resolved template/instruments match a curated known-
   * broken combination on the CURRENT Xcode version (see
   * KNOWN_BROKEN_INSTRUMENTS in recording.ts) — e.g. Network Connections
   * crashing on write on this Xcode 27 beta. A WARNING, not a block — this
   * evidence is genuinely live-repro-only (not sourced from any Apple
   * compatibility list the way DEVICE_ONLY_INSTRUMENTS is), and a beta bug
   * can be fixed in the very next Xcode release, so treat this as a strong
   * hint to retry differently, not a permanent fact. See PMT:ash-stone.
   */
  knownBrokenWarning?: string;
}

/**
 * True when a `--launch` target is an AppKit application, for which a profiling
 * launch should pass `-ApplePersistenceIgnoreState YES` (see startSession) to
 * dodge the liboainject × window-state-restoration crash under Allocations/
 * Leaks. Matches BOTH forms of an app path:
 *   - the bundle directory              `…/Foo.app`
 *   - the executable inside the bundle  `…/Foo.app/Contents/MacOS/Foo`
 * The second is what profiling a DEBUG BUILD hands you (Xcode build products /
 * a direct `xctrace --launch <executable>`) and is the common developer case a
 * bare `.endsWith(".app")` check silently missed. A genuine non-app CLI target
 * (a tool that parses its own argv) matches neither and correctly gets no flag.
 */
export function isAppLaunchPath(launch: string | undefined): boolean {
  return launch !== undefined && (launch.endsWith(".app") || launch.includes(".app/Contents/MacOS/"));
}

/**
 * Spawn xctrace in the background and return a recordingId.
 * Call stopSession(recordingId) to finalize.
 *
 * @throws {XctraceError} for validation failures (launch-required, both/neither attach+launch).
 */
export async function startSession(
  opts: StartSessionOptions
): Promise<StartSessionResult> {
  const { attach, launch, device, timeLimit, instruments, template, signpostSubsystems } = opts;

  // `template` is a single string (one base) or an array (first entry is the
  // base, passed via --template; the rest are additional whole templates
  // composed on top, same as the old templates-alone shape). Each entry
  // tolerates a recognized custom-template shortcut (e.g. "memory-vm").
  const templateList = (template === undefined ? [] : Array.isArray(template) ? template : [template]).map(
    resolveCustomTemplateName
  );
  const resolvedTemplate = templateList[0];
  const additionalTemplates = templateList.slice(1);

  const expanded = expandTemplates(additionalTemplates, resolvedTemplate);
  const literalInstruments = instruments ?? [];
  const baseExtraInstruments = [
    ...new Set([...literalInstruments, ...expanded.instruments].filter((i) => i !== resolvedTemplate)),
  ];
  // PMT:birch-river: compensate for Hangs' os-log coverage not surviving a
  // bare composition — see mitigateHangsOsLogFidelity's own doc for the
  // verified cost/scope tradeoffs behind making this automatic.
  const hangsMitigation = mitigateHangsOsLogFidelity(expanded.fidelityAtRisk, baseExtraInstruments);
  const withHangsMitigation = hangsMitigation.instrument
    ? [...baseExtraInstruments, hangsMitigation.instrument]
    : baseExtraInstruments;
  // PMT:plain-creek: default bare "Points of Interest" onto every recording
  // whose resolved template doesn't already bundle it — see the function's
  // own doc for the cost/fidelity evidence behind making this unconditional.
  const poiDefault = defaultPointsOfInterest(resolvedTemplate, withHangsMitigation);
  const withPoiDefault = poiDefault.instrument
    ? [...withHangsMitigation, poiDefault.instrument]
    : withHangsMitigation;
  // PMT:vivid-rill: custom app-defined os_signpost INTERVAL capture
  // (beginInterval/endInterval → OSSignpostIntervals) needs the separate
  // `os_signpost` instrument + dynamicTracingEnabledSubsystems — verified
  // live (test-os-signpost-subsystem-capture.md) that neither is ever
  // composed/set by anything else in this codebase, so without this,
  // OSSignpostIntervals never carries a custom subsystem's rows no matter
  // which template is chosen.
  const wantsSignpostSubsystems = signpostSubsystems !== undefined && signpostSubsystems.length > 0;
  const resolvedExtraInstruments =
    wantsSignpostSubsystems && !withPoiDefault.includes("os_signpost")
      ? [...withPoiDefault, "os_signpost"]
      : withPoiDefault;

  // Every resolved name (base + composed extras) — what launchRequired,
  // curated notes, and the Allocations/Leaks recipe all key off, regardless
  // of which "role" (base vs. extra) a given name played to get there.
  const resolvedNames = new Set<string>([
    ...(resolvedTemplate !== undefined ? [resolvedTemplate] : []),
    ...resolvedExtraInstruments,
  ]);

  if ([...resolvedNames].some((n) => LAUNCH_REQUIRED_TEMPLATES.has(n)) && launch === undefined) {
    throw new XctraceError(
      "record-failed",
      `"App Launch" requires a launch path (--launch). ${TEMPLATE_NOTES["App Launch"] ?? ""}`,
      {}
    );
  }
  if (attach !== undefined && launch !== undefined) {
    throw new XctraceError(
      "record-failed",
      "Specify either attach (--attach) or launch (--launch), not both.",
      {}
    );
  }
  if (attach === undefined && launch === undefined) {
    throw new XctraceError(
      "record-failed",
      "One of attach (--attach <pid|name>) or launch (--launch <app-path>) is required.",
      {}
    );
  }

  // PMT:loam-merlin: fail BEFORE spawning xctrace when `device` name-
  // substring-matches more than one target — verified live, xctrace itself
  // only reports this at finalize (stop_recording), after a 30s drive was
  // already wasted on a session that was dead from the start.
  await assertUnambiguousDevice(device);

  const resolvedLabel = [
    resolvedTemplate ?? "Blank template (instruments-only)",
    ...additionalTemplates.map((t) => `template:${t}`),
    ...literalInstruments,
  ].join(" + ");
  const adHocNotices = collectPrivacyNotices([
    ...literalInstruments,
    ...additionalTemplates,
    ...(resolvedTemplate !== undefined ? [resolvedTemplate] : []),
  ]);
  const resolvedPrivacyNotice = adHocNotices.length > 0 ? [...new Set(adHocNotices)].join("\n\n") : undefined;
  // CUSTOM_TEMPLATE_NOTES is checked against the RAW (pre-resolution) name —
  // a custom template's short name ("memory-vm") is what's discoverable, not
  // its resolved absolute path.
  const rawBaseName = template === undefined ? undefined : Array.isArray(template) ? template[0] : template;
  const customNote = rawBaseName !== undefined ? CUSTOM_TEMPLATE_NOTES[rawBaseName] : undefined;
  const templateNote = customNote ?? (resolvedTemplate !== undefined ? TEMPLATE_NOTES[resolvedTemplate] : undefined);
  const leaksNote = allocationsLeaksNote(resolvedNames);
  const signpostSubsystemsNote = wantsSignpostSubsystems
    ? `os_signpost composed with dynamicTracingEnabledSubsystems: [${signpostSubsystems!.map((s) => `"${s}"`).join(", ")}] — ` +
      "custom beginInterval/endInterval calls from those subsystems will land in OSSignpostIntervals. This does NOT " +
      "affect emitEvent-style instant signposts (category: .pointsOfInterest) — those already land in " +
      "PointsOfInterestEvents via the Points of Interest instrument alone, no subsystem gate needed."
    : undefined;
  const resolvedCompositionNote =
    [
      ...(templateNote ? [templateNote] : []),
      ...(leaksNote ? [leaksNote] : []),
      ...expanded.notes,
      ...bareInstrumentTemplateNotes(resolvedTemplate, instruments),
      ...(hangsMitigation.note ? [hangsMitigation.note] : []),
      ...(poiDefault.note ? [poiDefault.note] : []),
      ...(signpostSubsystemsNote ? [signpostSubsystemsNote] : []),
    ].join("\n\n") || undefined;
  // The base template's own curated options win on key collision over
  // composed-extra options — but the caller's own explicit signpostSubsystems
  // ask is the most specific of all and wins over everything (nothing in
  // TEMPLATE_BUNDLES/TEMPLATE_RECORDING_OPTIONS sets os_signpost options
  // today anyway, so this collision is theoretical, not yet observed).
  const baseRecordingOptions = resolvedTemplate !== undefined ? TEMPLATE_RECORDING_OPTIONS[resolvedTemplate] : undefined;
  const signpostRecordingOptions = wantsSignpostSubsystems
    ? { os_signpost: { dynamicTracingEnabledSubsystems: signpostSubsystems! } }
    : undefined;
  const resolvedRecordingOptions =
    Object.keys(expanded.recordingOptions).length > 0 || baseRecordingOptions || signpostRecordingOptions
      ? { ...expanded.recordingOptions, ...baseRecordingOptions, ...signpostRecordingOptions }
      : undefined;

  // No base template at all (instruments-only recording) — derive the output
  // filename slug from the first extra instrument instead, so the file isn't
  // named after a literal "undefined".
  const tracePath = await defaultOutputPath(resolvedTemplate ?? resolvedExtraInstruments[0] ?? "recording");
  // Human-readable stand-in for the `template` field on every response/status
  // type below (all typed as plain `string` — display metadata, never fed
  // back into an xctrace call) so an instruments-only recording doesn't
  // report an empty/undefined template.
  const templateLabel = resolvedTemplate ?? "(none — instruments-only, xctrace's implicit Blank template)";
  const recordingOptionsFile = await writeRecordingOptionsFile(tracePath, resolvedRecordingOptions);
  const recordingId = randomUUID();

  // Verified live: launching an AppKit app under an injecting instrument (e.g.
  // Allocations/Leaks) can crash during AppKit's window-state restoration —
  // liboainject's autorelease-pool interposition trips
  // -[NSView _clearRememberedEditingFirstResponder] mid-teardown, well before
  // any app code runs (so it leaves no app-attributable crash report). This is
  // NOT app-specific — it hits ANY app profiled with Allocations/Leaks in
  // launch mode. -ApplePersistenceIgnoreState YES skips that restoration path
  // entirely, and there's no reason a profiling launch would want stale window
  // state restored, so it's unconditional for app launches.
  // See isAppLaunchPath for why BOTH the bundle dir and the executable-inside-
  // the-bundle forms count as an app launch (the debug-build case).
  const resolvedLaunchArgs = isAppLaunchPath(launch) ? ["-ApplePersistenceIgnoreState", "YES"] : undefined;

  // PMT:sleek-vault: attach-by-NAME doesn't resolve on a device/Simulator, so when
  // targeting one, resolve the CFBundleIdentifier/name to a live PID and attach by
  // PID (the app must already be running — far-swan attaches, never launches). On
  // the host Mac (no device) attach-by-name works, so pass it through unchanged.
  const resolvedAttach =
    attach !== undefined && device !== undefined
      ? await resolveAttachTarget(attach, device)
      : attach;

  // PMT:stormy-coast: xctrace doesn't expose Simulator instrument compatibility
  // itself — only the Instruments GUI does (greys out unsupported instruments) —
  // so warn upfront from the curated DEVICE_ONLY_INSTRUMENTS map rather than
  // finding out from a failed/un-exportable sub-instrument after the fact.
  const deviceOnlyWarning =
    device !== undefined && (await isSimulatorTarget(device))
      ? deviceOnlyInstrumentWarning(resolvedTemplate, resolvedExtraInstruments, true)
      : undefined;

  // PMT:flint-crystal follow-up: warn (never block) when the resolved
  // template/instruments need a CPU architecture this HOST Mac doesn't have
  // (e.g. Processor Trace needs Intel PT — permanently absent on Apple
  // Silicon) — unlike deviceOnlyWarning this is unconditional on the target,
  // since the limit is the machine running Instruments, not what's profiled.
  const hostArchWarning = hostArchInstrumentWarning(resolvedTemplate, resolvedExtraInstruments, process.arch);

  // PMT:ash-stone gap #2: warn (never block) when the CURRENT Xcode matches a
  // curated known-broken instrument/combination — unlike deviceOnlyWarning
  // this isn't sim-specific, since the confirmed repro was a device recording.
  const knownBrokenWarning = knownBrokenInstrumentWarning(
    resolvedTemplate,
    resolvedExtraInstruments,
    await detectXcodeVersion()
  );

  const handle = spawnRecord({
    template: resolvedTemplate,
    extraInstruments: resolvedExtraInstruments,
    attach: resolvedAttach,
    launch,
    launchArgs: resolvedLaunchArgs,
    device,
    timeLimit,
    output: tracePath,
    recordingOptionsFile,
  });

  // Rolling 2 KB window on each stream — enough for error diagnosis without
  // holding a whole long recording's output in memory.
  function rollingCollector(chunks: string[]) {
    return (chunk: Buffer) => {
      chunks.push(chunk.toString());
      const total = chunks.reduce((n, s) => n + s.length, 0);
      while (chunks.length > 1 && total - chunks[0].length > 2048) {
        chunks.shift();
      }
    };
  }
  const stderrChunks: string[] = [];
  const stdoutChunks: string[] = [];
  handle.process.stderr?.on("data", rollingCollector(stderrChunks));
  handle.process.stdout?.on("data", rollingCollector(stdoutChunks));

  const rec: ActiveRecording = {
    recordingId,
    tracePath,
    template: templateLabel,
    instrumentsUsed: resolvedLabel,
    status: "recording",
    startedAt: Date.now(),
    process: handle.process,
    done: null!,
    exitCode: null,
    stderr: "",
    stdout: "",
  };

  let resolveExit!: () => void;
  rec.done = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });

  handle.process.on("error", (err: NodeJS.ErrnoException) => {
    rec.stderr = err.message;
    rec.status = "failed";
    rec.process = null;
    resolveExit();
  });

  handle.process.on("close", async (code: number | null) => {
    rec.stderr = stderrChunks.join("").trim();
    rec.stdout = stdoutChunks.join("").trim();
    rec.exitCode = code;
    // xctrace exits 0 on a clean stop (SIGINT-finalized or time-limit reached).
    // It can also exit null when killed by a signal — treat null as done since
    // SIGINT-triggered exits sometimes report null on macOS.
    if (rec.status !== "failed") {
      if (code === null || code === 0) {
        rec.status = "done";
      } else {
        // A non-zero exit here does NOT necessarily mean the recording is
        // unusable — verified live: a launch-mode recording exited non-zero
        // (54) during finalize teardown twice, and both times the trace
        // bundle was still complete, valid, and openable (765 MB). Check
        // whether the bundle actually exists before discarding real data.
        const traceExists = await stat(rec.tracePath).then(
          () => true,
          () => false
        );
        if (traceExists) {
          rec.status = "done";
          rec.finalizeWarning =
            `xctrace exited with code ${code} during finalize — the trace bundle exists and may still ` +
            "be usable, but finalize may have been interrupted before every schema finished writing " +
            "(one confirmed cause, for launch-mode recordings under an injecting instrument like " +
            "Allocations/Leaks: the launched app itself crashing during AppKit window-state restoration, " +
            "which kills xctrace's target and cuts the recording short — see -ApplePersistenceIgnoreState " +
            "default in startSession). A schema returning zero rows with NO COLUMNS AT ALL is a sign its " +
            "write may never have completed — that is different from \"the instrument ran and found " +
            "nothing,\" so don't treat an empty result as ground truth without checking describe_schema/" +
            "list_instruments first.";
        } else {
          rec.status = "failed";
        }
      }
    }
    rec.process = null;
    resolveExit();
  });

  activeRecordings.set(recordingId, rec);

  return {
    recordingId,
    status: "recording",
    tracePath,
    template: templateLabel,
    instrumentsUsed: resolvedLabel,
    ...(resolvedPrivacyNotice ? { privacyNotice: resolvedPrivacyNotice } : {}),
    ...(resolvedCompositionNote ? { compositionNote: resolvedCompositionNote } : {}),
    ...(expanded.fidelityAtRisk.length > 0 ? { fidelityAtRisk: expanded.fidelityAtRisk } : {}),
    ...(deviceOnlyWarning ? { deviceOnlyWarning } : {}),
    ...(hostArchWarning ? { hostArchWarning } : {}),
    ...(knownBrokenWarning ? { knownBrokenWarning } : {}),
  };
}

// ─── Stop ─────────────────────────────────────────────────────────────────────

export interface StopSessionResult {
  recordingId: string;
  status: RecordingStatus;
  tracePath: string;
  template: string;
  instrumentsUsed: string;
  finalizeWarning?: string;
  /**
   * Present only when finalize exited non-zero (the finalizeWarning case) —
   * xctrace's actual exit code (e.g. 54) so the caller isn't reasoning from the
   * canned warning string alone. The failure PATH already surfaces this in its
   * error; the finalize-but-usable path used to drop it, leaving a code-54
   * truncation opaque.
   */
  exitCode?: number | null;
  /**
   * Present only when finalize exited non-zero AND xctrace actually printed
   * something — the tail of its console output (stderr preferred, stdout
   * fallback; both already capped at ~2 KB). The ground-truth diagnostic for a
   * finalize failure; omitted when xctrace exited non-zero with no output
   * (a real, observed launch-mode case — its absence is itself informative).
   */
  finalizeOutput?: string;
}

/**
 * Finalize a recording by sending SIGINT, then wait for xctrace to exit.
 * If the recording already finished (time-limit expired), returns immediately.
 *
 * @throws {XctraceError} if the recordingId is unknown or the recording failed.
 */
export async function stopSession(
  recordingId: string
): Promise<StopSessionResult> {
  const rec = activeRecordings.get(recordingId);
  if (!rec) {
    throw new XctraceError(
      "record-failed",
      `No active recording found with id "${recordingId}". ` +
        "It may have already been stopped or the server was restarted.",
      {}
    );
  }

  if (rec.status === "recording") {
    rec.status = "finalizing";
    // SIGINT triggers xctrace's graceful shutdown path — it flushes data and
    // writes a valid .trace. SIGKILL would leave an incomplete bundle.
    rec.process?.kill("SIGINT");
  }

  // Wait for process exit — covers the case where it was already finalizing,
  // already done (time-limited auto-stop), or we just sent SIGINT.
  await rec.done;

  if (rec.status === "failed") {
    // stderr is usually where xctrace explains itself, but a launch-mode
    // failure has been observed with a non-zero exit and completely empty
    // stderr — fall back to stdout rather than leaving a bare exit code
    // with nothing to diagnose it from.
    const excerptSource = rec.stderr || rec.stdout;
    const excerpt = excerptSource ? ` ${excerptSource.slice(-500)}` : " (no output on stdout or stderr)";
    throw new XctraceError(
      "record-failed",
      `Recording failed (exit code ${rec.exitCode}).${excerpt}`,
      { exitCode: rec.exitCode ?? null, stderr: rec.stderr, stdout: rec.stdout }
    );
  }

  // On a finalize warning (xctrace exited non-zero but the trace is usable),
  // surface the actual exit code + any console output so the caller can
  // diagnose it — not just the canned warning string. (See StopSessionResult.)
  const finalizeOutput = rec.finalizeWarning ? (rec.stderr || rec.stdout).slice(-500) : "";
  return {
    recordingId,
    status: rec.status,
    tracePath: rec.tracePath,
    template: rec.template,
    instrumentsUsed: rec.instrumentsUsed,
    ...(rec.finalizeWarning
      ? {
          finalizeWarning: rec.finalizeWarning,
          exitCode: rec.exitCode,
          ...(finalizeOutput ? { finalizeOutput } : {}),
        }
      : {}),
  };
}

// ─── Status query ─────────────────────────────────────────────────────────────

export interface RecordingStatusResult {
  recordingId: string;
  status: RecordingStatus;
  tracePath: string;
  template: string;
  instrumentsUsed: string;
  elapsedMs: number;
}

/**
 * Return the current status of a recording without stopping it.
 * Useful for polling time-limited recordings that may have already finished.
 *
 * @throws {XctraceError} if the recordingId is unknown.
 */
export function getRecordingStatus(recordingId: string): RecordingStatusResult {
  const rec = activeRecordings.get(recordingId);
  if (!rec) {
    throw new XctraceError(
      "record-failed",
      `No recording found with id "${recordingId}".`,
      {}
    );
  }
  return {
    recordingId,
    status: rec.status,
    tracePath: rec.tracePath,
    template: rec.template,
    instrumentsUsed: rec.instrumentsUsed,
    elapsedMs: Date.now() - rec.startedAt,
  };
}
