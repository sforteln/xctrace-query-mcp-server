/**
 * xctrace record wrapper.
 *
 * Shells out to `xcrun xctrace record` and maps every failure mode to a
 * structured XctraceError rather than leaking raw stderr — mirroring the
 * export wrapper in xctrace.ts.
 *
 * This function is for time-limited recordings (--time-limit). Interactive
 * start/stop recordings that need SIGINT finalization are handled separately
 * (see the interactive lifecycle layer).
 *
 * --attach and --launch are mutually exclusive; passing both or neither is a
 * validation error. All other options are forwarded verbatim to xctrace.
 */
import { execFile, spawn, ChildProcess } from "node:child_process";
import { XctraceError, XctraceErrorDetails } from "./xctrace.js";
import { existsSync } from "node:fs";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Handle returned by {@link spawnRecord} for the interactive lifecycle. */
export interface SpawnRecordHandle {
  /** The spawned ChildProcess — send SIGINT to finalize gracefully. */
  process: ChildProcess;
  /** argv passed to xcrun (for diagnostics). */
  args: string[];
}

export interface RecordOptions {
  /** Instruments template name, e.g. "Time Profiler", "Allocations". */
  template: string;
  /**
   * Extra instruments to add on top of the template via repeated
   * `--instrument <name>` flags. Built-in xctrace templates are single-
   * instrument (e.g. "Allocations" and "Leaks" are separate templates with
   * no combined built-in) — this is how a recording captures both.
   */
  extraInstruments?: string[];
  /**
   * Attach to a running process by PID (numeric string) or process name.
   * Mutually exclusive with `launch`.
   */
  attach?: string;
  /**
   * Launch an app by path and record from startup.
   * Mutually exclusive with `attach`. Required for App Launch template.
   */
  launch?: string;
  /**
   * Extra arguments passed to the launched process (xctrace's
   * `--launch -- command [arguments]` form). Only meaningful with `launch`.
   */
  launchArgs?: string[];
  /** Target device name or UDID. Omit to record on the host Mac. */
  device?: string;
  /** Recording duration, e.g. "15s", "1m", "1m30s". Omit for no time limit. */
  timeLimit?: string;
  /** Absolute path where the resulting .trace bundle will be written. */
  output: string;
  /**
   * Absolute path to a JSON file of per-instrument recording options, passed
   * as `--recording-options <file>`. Format: `{"<Instrument>": {"<key>": <value>}}`,
   * matching the keys `xcrun xctrace record --show-recording-options` reports
   * for the chosen template. Callers write this file (see writeRecordingOptionsFile
   * in core/recording.ts) — this module only forwards the path to xctrace.
   */
  recordingOptionsFile?: string;
}

export interface RecordResult {
  /** Absolute path of the produced .trace bundle (same as opts.output). */
  tracePath: string;
  /**
   * Non-fatal run issues xctrace reported while STILL saving a viewable trace —
   * e.g. a bundled instrument that's unsupported on the target ("Hitches is not
   * supported on this platform" on a Simulator, where Hitches needs real
   * display/GPU present-timing hardware). The trace is valid and the other
   * instruments recorded; the flagged ones just have no data. Present only when
   * the recording finished "with errors" but the bundle was saved anyway.
   */
  runIssues?: string[];
}

const XCRUN = "xcrun";
const DEFAULT_MAX_BUFFER = 32 * 1024 * 1024; // 32 MB (record stdout is minimal)

// ─── Time-limit parser ────────────────────────────────────────────────────────

/** Parse xctrace time-limit strings like "15s", "1m", "1m30s" into milliseconds. */
function parseTimeLimitMs(s: string): number | null {
  const m = /^(?:(\d+)m)?(?:(\d+)s)?$/.exec(s.trim());
  if (!m || (!m[1] && !m[2])) return null;
  const minutes = m[1] ? parseInt(m[1], 10) : 0;
  const seconds = m[2] ? parseInt(m[2], 10) : 0;
  return (minutes * 60 + seconds) * 1000;
}

// ─── stderr → structured error ────────────────────────────────────────────────

/**
 * Pull xctrace's "* [Error] …" / "[Warning] …" run-issue lines out of its
 * combined output (e.g. "Hitches is not supported on this platform"). Used to
 * surface WHICH bundled instruments errored on a partial-success recording.
 */
export function extractRunIssues(output: string): string[] {
  const issues: string[] = [];
  for (const line of output.split("\n")) {
    const m = line.match(/\[(?:Error|Warning)\]\s*(.+?)\s*$/);
    if (m) issues.push(m[1].trim());
  }
  return issues;
}

function classifyRecordFailure(
  stderr: string,
  exitCode: number | null,
  command: string[]
): XctraceError {
  const s = stderr.toLowerCase();

  if (
    s.includes("no process found") ||
    s.includes("unable to find") ||
    s.includes("could not find") ||
    s.includes("cannot find process") ||
    s.includes("no running instance")
  ) {
    return new XctraceError(
      "target-not-found",
      `xctrace could not find the attach target: ${stderr.trim()}. On a device or Simulator, ` +
        `attach-by-NAME frequently fails even when the process IS running — attach by PID instead ` +
        `(get it from \`xcrun devicectl device info processes --device <udid>\` for a device, or the ` +
        `PID printed by \`xcrun simctl launch <udid> <bundle-id>\` for a Simulator).`,
      { command, stderr: stderr.trim() }
    );
  }

  if (
    (s.includes("template") && (s.includes("not found") || s.includes("no such"))) ||
    s.includes("invalid template")
  ) {
    return new XctraceError(
      "bad-template",
      `Template not found. Check the name with \`xcrun xctrace list templates\`: ${stderr.trim()}`,
      { command, stderr: stderr.trim() }
    );
  }

  if (
    s.includes("dtservicehub") ||
    s.includes("authorization") ||
    s.includes("permission denied") ||
    s.includes("instruments is not allowed")
  ) {
    return new XctraceError(
      "permission-denied",
      "Instruments authorization required. Open Instruments.app once to grant permission, or run: sudo DevToolsSecurity -enable",
      { command, stderr: stderr.trim() }
    );
  }

  const details: XctraceErrorDetails = {
    command,
    exitCode: exitCode ?? null,
    stderr: stderr.trim(),
  };
  return new XctraceError(
    "record-failed",
    `xctrace record exited with an error${exitCode !== null ? ` (code ${exitCode})` : ""}.`,
    details
  );
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Spawn `xcrun xctrace record` as a long-running background process and return
 * a handle for the interactive lifecycle (start → user interacts → SIGINT stop).
 *
 * The caller is responsible for:
 *   - Listening on `handle.process.stderr` to buffer error output.
 *   - Sending `handle.process.kill("SIGINT")` to finalize gracefully.
 *   - Waiting for the `"close"` event before reading the .trace.
 *
 * Does NOT validate attach/launch exclusivity — the caller must do that before
 * spawning.
 */
export function spawnRecord(opts: RecordOptions): SpawnRecordHandle {
  const { template, extraInstruments, attach, launch, launchArgs, device, timeLimit, output, recordingOptionsFile } = opts;

  // `--launch -- command [arguments]` consumes everything after `--` as the
  // launch target and its args, so it must be the LAST thing in argv — every
  // other option (including --output) has to come before it.
  const args: string[] = [
    "xctrace", "record",
    "--template", template,
    ...(extraInstruments ?? []).flatMap((name) => ["--instrument", name]),
    ...(device ? ["--device", device] : []),
    ...(timeLimit ? ["--time-limit", timeLimit] : []),
    ...(recordingOptionsFile ? ["--recording-options", recordingOptionsFile] : []),
    "--output", output,
    ...(attach !== undefined ? ["--attach", attach] : []),
    ...(launch !== undefined ? ["--launch", "--", launch, ...(launchArgs ?? [])] : []),
  ];

  const proc = spawn(XCRUN, args, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Some templates (e.g. Foundation Models) print a privacy notice and block on
  // stdin waiting for Enter before starting. Write a newline immediately so
  // xctrace proceeds without hanging.
  proc.stdin?.write("\n");
  proc.stdin?.end();

  return { process: proc, args: [XCRUN, ...args] };
}

/**
 * Run `xcrun xctrace record` and return the path of the resulting .trace.
 *
 * @throws {XctraceError} with kind:
 *   - "record-failed"    non-zero exit, unrecognised cause
 *   - "target-not-found" --attach target process not running / --launch path missing
 *   - "bad-template"     --template name not recognised
 *   - "permission-denied" Instruments/DTServiceHub auth not granted
 *   - "xctrace-not-found" xcrun binary missing (Xcode not installed)
 */
export async function record(opts: RecordOptions): Promise<RecordResult> {
  const { template, extraInstruments, attach, launch, launchArgs, device, timeLimit, output, recordingOptionsFile } = opts;

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

  // `--launch -- command [arguments]` consumes everything after `--` as the
  // launch target and its args, so it must be the LAST thing in argv — every
  // other option (including --output) has to come before it.
  const args: string[] = [
    "xctrace", "record",
    "--template", template,
    ...(extraInstruments ?? []).flatMap((name) => ["--instrument", name]),
    ...(device ? ["--device", device] : []),
    ...(timeLimit ? ["--time-limit", timeLimit] : []),
    ...(recordingOptionsFile ? ["--recording-options", recordingOptionsFile] : []),
    "--output", output,
    ...(attach !== undefined ? ["--attach", attach] : []),
    ...(launch !== undefined ? ["--launch", "--", launch, ...(launchArgs ?? [])] : []),
  ];

  const limitMs = timeLimit ? parseTimeLimitMs(timeLimit) : null;
  // Add a 30-second grace period beyond the declared time limit; if no limit
  // is given, cap at 5 minutes (callers wanting longer recordings should use
  // the interactive-lifecycle layer with SIGINT finalization).
  const timeoutMs = limitMs !== null ? limitMs + 30_000 : 5 * 60 * 1000;

  return new Promise<RecordResult>((resolve, reject) => {
    const child = execFile(
      XCRUN,
      args,
      { maxBuffer: DEFAULT_MAX_BUFFER, encoding: "utf8", timeout: timeoutMs },
      (err, stdout, stderr) => {
        if (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            reject(
              new XctraceError(
                "xctrace-not-found",
                "`xcrun xctrace` not found. Xcode (with command line tools) must be installed.",
                { command: [XCRUN, ...args] }
              )
            );
            return;
          }
          const exitCode =
            typeof (err as { code?: unknown }).code === "number"
              ? (err as { code: number }).code
              : null;
          // Non-zero exit but the .trace was STILL SAVED (xctrace prints "trace is
          // still ready to be viewed") = PARTIAL SUCCESS: a bundled instrument is
          // unsupported on the target (e.g. Animation Hitches on a Simulator — no
          // real display) so it errors, but the rest of the template recorded
          // fine. Keep the valid trace + surface the run-issues rather than
          // discarding a good capture on a benign sub-instrument error.
          const out = `${stdout ?? ""}\n${stderr ?? ""}`;
          if (/still ready to be viewed|output file saved/i.test(out) && existsSync(output)) {
            resolve({ tracePath: output, runIssues: extractRunIssues(out) });
            return;
          }
          reject(classifyRecordFailure(stderr ?? "", exitCode, [XCRUN, ...args]));
          return;
        }
        resolve({ tracePath: output });
      }
    );
    // ACK xctrace's interactive privacy prompt so it doesn't hang waiting for Enter.
    child.stdin?.write("\n");
    child.stdin?.end();
  });
}
