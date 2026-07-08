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
  type RecordingIntent,
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
  note?: string;
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
  intent: RecordingIntent;
  attach?: string;
  launch?: string;
  device?: string;
  timeLimit?: string;
  /**
   * BARE extra instruments to compose on top of intent.template, via repeated
   * `--instrument <name>` — recorded exactly as named, never expanded even
   * when the name is ALSO a richer template (see bareInstrumentTemplateNotes
   * in recording.ts) — merged with any extraInstruments the intent itself
   * already declares (e.g. leaks-backtraces' built-in "Leaks"). Use this for
   * a genuinely standalone instrument, or when you deliberately want only
   * that instrument's raw signal without its template's extras. Use
   * `templates` instead when you want a whole second template's full bundle.
   */
  instruments?: string[];
  /**
   * Additional WHOLE templates to compose on top of intent.template — each
   * name is expanded to its full bundled instrument set (per TEMPLATE_BUNDLES)
   * plus any recordingOptions it bakes in, so e.g. templates: ["SwiftUI"] on
   * type: "core-data" records the complete SwiftUI template (+ its Hangs +
   * Time Profiler bundle + layout tracing), not just the bare instrument.
   * This is the explicit way to start a session with two templates at once —
   * deliberately a separate param from `instruments` so the caller states
   * which one they meant instead of the server guessing from an overloaded
   * name that is both a template and a standalone instrument.
   */
  templates?: string[];
  /**
   * Raw `--template <name|path>` override, for a custom or uncurated
   * template the `type` enum doesn't cover. Overrides intent.template but
   * keeps the intent's other metadata (label, note, launchRequired,
   * recordingOptions) — pass a minimal ad-hoc intent if you don't want that.
   */
  template?: string;
}

export interface StartSessionResult {
  recordingId: string;
  status: "recording";
  tracePath: string;
  template: string;
  instrumentsUsed: string;
  note?: string;
  privacyNotice?: string;
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
  const { intent, attach, launch, device, timeLimit, instruments, templates, template } = opts;

  if (intent.launchRequired && launch === undefined) {
    throw new XctraceError(
      "record-failed",
      `${intent.label} requires a launch path (--launch). ${intent.note ?? ""}`,
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

  // `template` overrides intent.template (a raw passthrough for custom/
  // uncurated templates). Two DISTINCT composition params, deliberately not
  // merged into one: `instruments` are bare additions (recorded exactly as
  // named, merged with the intent's own curated extraInstruments, e.g.
  // leaks-backtraces' built-in "Leaks"); `templates` names WHOLE additional
  // templates and is expanded via expandTemplates() into each one's full
  // bundle + recordingOptions, so type: "core-data" + templates: ["SwiftUI"]
  // records the complete union of both templates, not core-data's template
  // plus a bare, bundle-less SwiftUI instrument.
  const resolvedTemplate = template ?? intent.template;
  const expanded = expandTemplates(templates ?? [], resolvedTemplate);
  const literalInstruments = [...(intent.extraInstruments ?? []), ...(instruments ?? [])];
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
  const resolvedExtraInstruments = poiDefault.instrument
    ? [...withHangsMitigation, poiDefault.instrument]
    : withHangsMitigation;
  const resolvedLabel = [
    intent.label,
    ...(templates ?? []).map((t) => `template:${t}`),
    ...(instruments ?? []),
  ].join(" + ");
  // intent.privacyNotice already covers intent.template (curated, detailed
  // text) — only scan ad-hoc additions here. Still de-duped below since a
  // caller-supplied `template` that happens to match the intent's own can
  // otherwise show the identical notice twice.
  const adHocNotices = collectPrivacyNotices([
    ...(instruments ?? []),
    ...(templates ?? []),
    ...(template ? [template] : []),
  ]);
  const resolvedPrivacyNotice =
    [...new Set([intent.privacyNotice, ...adHocNotices].filter((n): n is string => Boolean(n)))].join("\n\n") ||
    undefined;
  const resolvedCompositionNote =
    [
      ...expanded.notes,
      ...bareInstrumentTemplateNotes(resolvedTemplate, instruments),
      ...(hangsMitigation.note ? [hangsMitigation.note] : []),
      ...(poiDefault.note ? [poiDefault.note] : []),
    ].join("\n\n") || undefined;
  // intent.recordingOptions (the base template's own curated options) wins on
  // key collision — expanded options come from ADDITIONAL composed
  // templates, so the base template's explicit choice takes precedence.
  const resolvedRecordingOptions =
    Object.keys(expanded.recordingOptions).length > 0 || intent.recordingOptions
      ? { ...expanded.recordingOptions, ...intent.recordingOptions }
      : undefined;

  const tracePath = await defaultOutputPath(resolvedTemplate);
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
    template: resolvedTemplate,
    instrumentsUsed: resolvedLabel,
    note: intent.note,
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
    template: resolvedTemplate,
    instrumentsUsed: resolvedLabel,
    ...(intent.note ? { note: intent.note } : {}),
    ...(resolvedPrivacyNotice ? { privacyNotice: resolvedPrivacyNotice } : {}),
    ...(resolvedCompositionNote ? { compositionNote: resolvedCompositionNote } : {}),
    ...(expanded.fidelityAtRisk.length > 0 ? { fidelityAtRisk: expanded.fidelityAtRisk } : {}),
    ...(deviceOnlyWarning ? { deviceOnlyWarning } : {}),
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
