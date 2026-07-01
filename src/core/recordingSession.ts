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
import { spawnRecord } from "../engine/record.js";
import {
  defaultOutputPath,
  writeRecordingOptionsFile,
  collectPrivacyNotices,
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
   * Extra instruments to compose on top of intent.template, via repeated
   * `--instrument <name>` — merged with any extraInstruments the intent
   * itself already declares (e.g. leaks-backtraces' built-in "Leaks").
   */
  instruments?: string[];
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
  const { intent, attach, launch, device, timeLimit, instruments, template } = opts;

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

  // `template` overrides intent.template (a raw passthrough for custom/
  // uncurated templates); `instruments` is purely additive on top of
  // whichever template is used, merged with any the intent already declares.
  const resolvedTemplate = template ?? intent.template;
  const resolvedExtraInstruments = [...(intent.extraInstruments ?? []), ...(instruments ?? [])];
  const resolvedLabel =
    instruments && instruments.length > 0 ? `${intent.label} + ${instruments.join(" + ")}` : intent.label;
  // intent.privacyNotice already covers intent.template (curated, detailed
  // text) — only scan ad-hoc additions here. Still de-duped below since a
  // caller-supplied `template` that happens to match the intent's own can
  // otherwise show the identical notice twice.
  const adHocNotices = collectPrivacyNotices([...(instruments ?? []), ...(template ? [template] : [])]);
  const resolvedPrivacyNotice =
    [...new Set([intent.privacyNotice, ...adHocNotices].filter((n): n is string => Boolean(n)))].join("\n\n") ||
    undefined;

  const tracePath = await defaultOutputPath(resolvedTemplate);
  const recordingOptionsFile = await writeRecordingOptionsFile(tracePath, intent.recordingOptions);
  const recordingId = randomUUID();

  const handle = spawnRecord({
    template: resolvedTemplate,
    extraInstruments: resolvedExtraInstruments,
    attach,
    launch,
    device,
    timeLimit,
    output: tracePath,
    recordingOptionsFile,
  });

  const stderrChunks: string[] = [];
  handle.process.stderr?.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk.toString());
    // Keep a rolling 2 KB window — enough for error diagnosis.
    const total = stderrChunks.reduce((n, s) => n + s.length, 0);
    while (stderrChunks.length > 1 && total - stderrChunks[0].length > 2048) {
      stderrChunks.shift();
    }
  });

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

  handle.process.on("close", (code: number | null) => {
    rec.stderr = stderrChunks.join("").trim();
    rec.exitCode = code;
    // xctrace exits 0 on a clean stop (SIGINT-finalized or time-limit reached).
    // It can also exit null when killed by a signal — treat null as done since
    // SIGINT-triggered exits sometimes report null on macOS.
    if (rec.status !== "failed") {
      rec.status = code === null || code === 0 ? "done" : "failed";
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
  };
}

// ─── Stop ─────────────────────────────────────────────────────────────────────

export interface StopSessionResult {
  recordingId: string;
  status: RecordingStatus;
  tracePath: string;
  template: string;
  instrumentsUsed: string;
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
    const excerpt = rec.stderr ? ` ${rec.stderr.slice(-500)}` : "";
    throw new XctraceError(
      "record-failed",
      `Recording failed (exit code ${rec.exitCode}).${excerpt}`,
      { exitCode: rec.exitCode ?? null, stderr: rec.stderr }
    );
  }

  return {
    recordingId,
    status: rec.status,
    tracePath: rec.tracePath,
    template: rec.template,
    instrumentsUsed: rec.instrumentsUsed,
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
