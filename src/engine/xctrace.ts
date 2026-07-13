/**
 * xctrace export wrapper.
 *
 * The only programmatic read path into an Instruments `.trace` is
 * `xcrun xctrace export`, which has two modes:
 *   --toc            enumerate the schemas/tables in the trace (table of contents)
 *   --xpath <expr>   pull one table's rows as XML
 *
 * This module shells out to both, captures stdout, and turns every failure mode
 * (missing binary, bad path, non-zero exit, empty result, unparseable output)
 * into a structured {@link XctraceError} instead of leaking raw stderr. It does
 * NOT model rows yet — `exportXPath` returns the raw table XML; row parsing,
 * de-duplication, and caching are layered on top in later work.
 */
import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { XMLParser } from "fast-xml-parser";
import type { Readable } from "node:stream";

/** Discriminates the ways an xctrace export or record can fail. */
export type XctraceErrorKind =
  | "xctrace-not-found"  // xcrun/xctrace binary unavailable (Xcode not installed)
  | "trace-not-found"    // the .trace path does not exist
  | "export-failed"      // xctrace export exited non-zero
  | "empty-result"       // the command succeeded but produced no output
  | "parse-error"        // output could not be parsed as expected
  | "record-failed"      // xctrace record exited non-zero (general failure)
  | "target-not-found"   // --attach target process/app not found
  | "injection-attach-failed" // target was found/launched but the injecting instrument's attach step itself failed (commonly a hardened/code-signed target rejecting liboainject)
  | "bad-template"       // --template name does not exist
  | "template-only-name" // a `templates` composition entry names a template that xctrace does NOT also expose as a bare --instrument (composing it this way fails outright — see recording.ts's TEMPLATE_ONLY_NAMES)
  | "permission-denied"  // Instruments/DTServiceHub authorization not granted
  | "ambiguous-schema"   // schema appears multiple times in this run — needs a position
  | "ambiguous-device"   // `device` name-substring matched more than one target — needs the UDID
  | "table-too-large";   // aborted mid-parse — approaching the process's heap limit

export interface XctraceErrorDetails {
  /** The argv passed to xcrun, for diagnostics (no secrets — just paths/flags). */
  command?: string[];
  /** Process exit code, when the failure was a non-zero exit. */
  exitCode?: number | null;
  /**
   * Present when the process was terminated by a signal instead of exiting
   * normally (exitCode is null in that case) — e.g. "SIGTRAP" for a crash.
   * Verified live: xctrace can crash silently (no stderr) exporting a
   * specific table; this is the only signal that it crashed rather than
   * just failing cleanly.
   */
  signal?: string;
  /** Captured stderr, trimmed — surfaced as a field, never dumped raw to the agent. */
  stderr?: string;
  /**
   * Captured stdout, trimmed. xctrace normally explains failures on stderr,
   * but a launch-mode failure has been observed with a non-zero exit and
   * completely empty stderr — surfacing stdout too means that case isn't a
   * dead end with nothing to diagnose it from.
   */
  stdout?: string;
  /** The trace path involved, when relevant. */
  tracePath?: string;
  /**
   * Present for "ambiguous-schema" errors — the available instances (1-based
   * position) and whatever TOC attributes distinguish them, so the caller can
   * pick the right one and retry with `position` set.
   */
  instances?: Array<{
    position: number;
    documentation: string | null;
    swiftTable: string | null;
    subsystem: string | null;
    category: string | null;
    codes: string | null;
  }>;
  /**
   * Present for "ambiguous-device" errors — every device the substring
   * matched, so the caller can pick one and retry with its UDID.
   */
  deviceMatches?: Array<{ name: string; udid: string; kind: string }>;
  /** Present for "table-too-large" — how far the parse got before aborting. */
  rowsParsedBeforeAbort?: number;
  /** Present for "table-too-large" — heap usage at abort time, for diagnosis. */
  heapUsedMb?: number;
  /** Present for "table-too-large" — the process's actual configured heap ceiling. */
  heapLimitMb?: number;
}

/**
 * A structured error from the xctrace engine. Callers (and the MCP tool layer)
 * branch on `kind` and present `message` + `details` rather than a stderr dump.
 */
export class XctraceError extends Error {
  constructor(
    readonly kind: XctraceErrorKind,
    message: string,
    readonly details: XctraceErrorDetails = {}
  ) {
    super(message);
    this.name = "XctraceError";
  }

  /** Plain-object form suitable for returning in an MCP tool response. */
  toStructured(): {
    error: XctraceErrorKind;
    message: string;
    details: XctraceErrorDetails;
  } {
    return { error: this.kind, message: this.message, details: this.details };
  }
}

/** One table entry from the trace's table of contents. */
export interface TocTable {
  /** The schema name — used to address the table via XPath. */
  schema: string;
  /**
   * All attributes on the <table> element verbatim (schema plus any
   * disambiguators like instrument codes). Preserved so callers can build a
   * precise XPath when a schema appears more than once in a run.
   */
  attributes: Record<string, string>;
}

/** One <detail> inside a track — carries name and kind (always "table" so far). */
export interface TocTrackDetail {
  name: string;
  kind: string;
}

/** One <track> inside /trace-toc/run/tracks. */
export interface TocTrack {
  name: string;
  details: TocTrackDetail[];
}

/** One key/value option xctrace applied to an instrument for this run, already human-readable (e.g. "Include Brief Unresponsiveness (>100ms)", not a raw enum). */
export interface TocRecordingSetting {
  key: string;
  value: string;
}

/** One instrument's recording settings, as xctrace actually configured it. */
export interface TocInstrumentSettings {
  name: string;
  options: TocRecordingSetting[];
}

/**
 * The `<summary>` block from `--toc`'s `<run><info>` — what this run was
 * ACTUALLY recorded with, straight from xctrace itself (not far-swan's
 * memory of what it asked for). Genuinely useful for two things: (1) a
 * reminder when reopening a trace later ("what was this?"), and (2) a
 * self-check — comparing this against what start_recording was actually
 * asked to compose catches the exact class of silent fidelity loss this
 * project has repeatedly found (a bare-composed instrument losing its
 * template-tuned settings, e.g. Hangs' threshold defaulting to 100ms instead
 * of a template's 250ms) without needing to already know that quirk exists.
 */
export interface TocRecordingSummary {
  /** The template used as the recording's base, or "Blank" for instruments-only/no template. Null if absent (older trace formats). */
  templateName: string | null;
  recordingMode: string | null;
  /** The configured time limit, as xctrace formatted it (e.g. "5 seconds"). Null when no limit was set. */
  timeLimit: string | null;
  /** Actual elapsed recording duration in seconds. */
  duration: number | null;
  /** Why the recording ended, e.g. "Time limit reached" vs a manual stop. */
  endReason: string | null;
  /** Per-instrument settings as xctrace actually applied them — the ground truth for "what config did this trace end up with." */
  instrumentSettings: TocInstrumentSettings[];
}

/** One run from the trace's table of contents. */
export interface TocRun {
  /** The run number, used in XPath addressing (`run[@number="N"]`). */
  number: number;
  /** Tables exported by this run (the /data/table schema-table format). */
  tables: TocTable[];
  /** Tracks exported by this run (the /tracks/track/details/detail format). */
  tracks: TocTrack[];
  /** What this run was actually recorded with, from <info><summary> — undefined if the TOC carries no summary block (older trace formats). */
  summary?: TocRecordingSummary;
}

/** Parsed table of contents for a `.trace`. */
export interface Toc {
  runs: TocRun[];
}

/** Generous cap for captured stdout (table XML can be large). */
const DEFAULT_MAX_BUFFER = 512 * 1024 * 1024; // 512 MB

const XCRUN = "xcrun";

/**
 * Run `xcrun xctrace export` with the given trailing args and return stdout.
 * Validates the trace path up front and normalizes spawn/exit failures into
 * {@link XctraceError}.
 */
async function runExport(
  tracePath: string,
  modeArgs: string[]
): Promise<string> {
  // Validate the path before spawning so a bad path is a clean structured error
  // rather than an opaque xctrace exit. A .trace is a bundle (directory).
  try {
    await fs.access(tracePath);
  } catch {
    throw new XctraceError(
      "trace-not-found",
      `No .trace found at path: ${tracePath}`,
      { tracePath }
    );
  }

  const args = ["xctrace", "export", "--input", tracePath, ...modeArgs];

  return await new Promise<string>((resolve, reject) => {
    execFile(
      XCRUN,
      args,
      { maxBuffer: DEFAULT_MAX_BUFFER, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (err) {
          // ENOENT on xcrun itself => Xcode/command line tools missing.
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
              ? ((err as { code: number }).code)
              : null;
          reject(
            new XctraceError(
              "export-failed",
              `xctrace export exited with an error${
                exitCode !== null ? ` (code ${exitCode})` : ""
              }.`,
              {
                command: [XCRUN, ...args],
                exitCode,
                stderr: stderr?.trim(),
                tracePath,
              }
            )
          );
          return;
        }
        resolve(stdout);
      }
    );
  });
}

/**
 * Export the table of contents and parse it into a list of runs/tables.
 * @throws {XctraceError} on any failure (kind tells you which).
 */
export async function exportToc(tracePath: string): Promise<Toc> {
  const xml = await runExport(tracePath, ["--toc"]);
  if (!xml.trim()) {
    throw new XctraceError(
      "empty-result",
      "xctrace --toc produced no output.",
      { tracePath }
    );
  }
  return parseToc(xml, tracePath);
}

/**
 * Export one table by raw XPath expression and return the table XML verbatim.
 * Row parsing happens in a later layer; this is the raw fetch primitive.
 * @throws {XctraceError} on any failure (kind tells you which).
 */
export async function exportXPath(
  tracePath: string,
  xpath: string
): Promise<string> {
  const xml = await runExport(tracePath, ["--xpath", xpath]);
  // A matching xpath returns a <node> (even for a real table with zero rows); a
  // non-matching xpath returns an otherwise-empty <trace-query-result>. Treat
  // the latter as an empty result so "no such table" is a structured error
  // rather than a silently-empty success.
  if (!xml.trim() || !/<node[\s>]/.test(xml)) {
    throw new XctraceError(
      "empty-result",
      `xctrace --xpath matched no nodes for expression: ${xpath}`,
      { tracePath }
    );
  }
  return xml;
}

/** Handle returned by {@link exportXPathStream}. */
export interface XPathStreamHandle {
  /** xctrace's stdout — pipe this into a SAX parser (or any stream consumer). */
  stdout: Readable;
  /**
   * Resolves when xctrace exits cleanly (code 0); rejects with a structured
   * XctraceError otherwise. Await this alongside consuming `stdout` (e.g.
   * `Promise.all([parseTableStream(stdout), done])`) — a non-zero exit after
   * stdout has already produced data means whatever was parsed may be
   * truncated, so the process-exit error should win over a parse that
   * "succeeded" on partial data.
   */
  done: Promise<void>;
}

/**
 * Like {@link exportXPath} but streams xctrace's stdout directly instead of
 * buffering the whole export into one string. Exists for tables that can be
 * gigabytes — large enough to blow execFile's maxBuffer cap, and large enough
 * that materializing the whole thing as a JS string plus a parsed DOM tree
 * simultaneously is wasteful even when it fits. Row parsing happens in the
 * streaming parsers (parseTableStream / parseTrackDetailStream); this is the
 * raw fetch primitive for that path, mirroring exportXPath's role for the
 * buffered path.
 *
 * @throws {XctraceError} "trace-not-found" synchronously if the path is bad;
 *         all other failures surface via the returned `done` promise.
 */
export async function exportXPathStream(
  tracePath: string,
  xpath: string
): Promise<XPathStreamHandle> {
  try {
    await fs.access(tracePath);
  } catch {
    throw new XctraceError(
      "trace-not-found",
      `No .trace found at path: ${tracePath}`,
      { tracePath }
    );
  }

  const args = ["xctrace", "export", "--input", tracePath, "--xpath", xpath];
  const child = spawn(XCRUN, args, { stdio: ["ignore", "pipe", "pipe"] });

  const stderrChunks: string[] = [];
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk.toString());
    const total = stderrChunks.reduce((n, s) => n + s.length, 0);
    while (stderrChunks.length > 1 && total - stderrChunks[0].length > 2048) {
      stderrChunks.shift();
    }
  });

  const done = new Promise<void>((resolve, reject) => {
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        reject(
          new XctraceError(
            "xctrace-not-found",
            "`xcrun xctrace` not found. Xcode (with command line tools) must be installed.",
            { command: [XCRUN, ...args] }
          )
        );
        return;
      }
      reject(
        new XctraceError("export-failed", `xctrace export failed to start: ${err.message}`, {
          command: [XCRUN, ...args],
        })
      );
    });

    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (code === 0) {
        resolve();
        return;
      }
      // A crash (as opposed to a normal non-zero exit) reports code:null and
      // the terminating signal instead — verified live: xctrace crashed
      // silently exporting core-data-fetch (SIGTRAP, no stderr at all),
      // which a code-only message would render as just "exited with an
      // error" with no hint that it actually crashed.
      reject(
        new XctraceError(
          "export-failed",
          `xctrace export exited with an error${code !== null ? ` (code ${code})` : signal ? ` (crashed: ${signal})` : ""}.`,
          {
            command: [XCRUN, ...args],
            exitCode: code,
            ...(signal ? { signal } : {}),
            stderr: stderrChunks.join("").trim(),
            tracePath,
          }
        )
      );
    });
  });

  // Prevent an unhandled-rejection warning if the caller doesn't await `done`
  // until after consuming stdout — this attaches a handler without consuming
  // the original promise the caller still holds and will itself await.
  done.catch(() => {});

  return { stdout: child.stdout!, done };
}

/**
 * Await a streaming parse against exportXPathStream's `done` signal, giving
 * PRIORITY to a non-zero xctrace exit over a parse failure — verified live:
 * xctrace crashed (silently, exit 133, no stderr) partway through exporting
 * core-data-fetch, truncating its stdout mid-stream; the streaming XML
 * parser correctly noticed the
 * truncation and threw "Unclosed root tag", and a naive `Promise.all([parse,
 * done])` surfaced THAT generic parse error to the caller instead of the far
 * more diagnostic exit-code one — Promise.all rejects with whichever promise
 * settles first, and the parser reliably notices EOF-mid-document before the
 * separate process "close" event fires. `done`'s own doc comment already
 * says the exit error "should win" for exactly this reason; this function is
 * what actually makes that true, since plain Promise.all does not.
 *
 * A caller that gets THIS error instead of a parse error learns immediately
 * "xctrace itself failed to export this table" (with exitCode/stderr, if
 * any) rather than being misled into thinking the trace or the parser is at
 * fault — the parse failure is a downstream SYMPTOM of the crash, not an
 * independent bug.
 */
export async function raceParseAgainstExport<T>(parse: Promise<T>, done: Promise<void>): Promise<T> {
  const [parseResult, doneResult] = await Promise.allSettled([parse, done]);
  if (doneResult.status === "rejected") throw doneResult.reason;
  if (parseResult.status === "rejected") throw parseResult.reason;
  return parseResult.value;
}

/**
 * Build the canonical XPath that addresses a single table within a run, e.g.
 * `/trace-toc/run[@number="1"]/data/table[@schema="time-profile"]`.
 */
export function buildTableXPath(run: number, schema: string): string {
  return `/trace-toc/run[@number="${run}"]/data/table[@schema="${schema}"]`;
}

/**
 * Like buildTableXPath but selects the Nth occurrence (1-based) — used when
 * multiple tables share the same schema name (e.g. SwiftUIFilteredUpdates).
 */
export function buildTableXPathAtPosition(run: number, schema: string, position: number): string {
  return `/trace-toc/run[@number="${run}"]/data/table[@schema="${schema}"][${position}]`;
}

/**
 * Build the XPath that addresses a track-detail, e.g.
 * `/trace-toc/run[@number="1"]/tracks/track[@name="Allocations"]/details/detail[@name="Allocations List"]`.
 */
export function buildTrackDetailXPath(
  run: number,
  trackName: string,
  detailName: string
): string {
  return (
    `/trace-toc/run[@number="${run}"]/tracks/` +
    `track[@name="${trackName}"]/details/detail[@name="${detailName}"]`
  );
}

const tocParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
});

/** Coerce fast-xml-parser's "one-or-many" shape into an array. */
function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** Parse `--toc` XML into the {@link Toc} structure. Exported for direct unit-testing with canned XML — the real caller is exportToc. */
export function parseToc(xml: string, tracePath: string): Toc {
  let doc: unknown;
  try {
    doc = tocParser.parse(xml);
  } catch (cause) {
    throw new XctraceError("parse-error", "Failed to parse --toc XML.", {
      tracePath,
    });
  }

  const toc = (doc as Record<string, any>)?.["trace-toc"];
  if (!toc) {
    throw new XctraceError(
      "parse-error",
      "--toc XML missing <trace-toc> root.",
      { tracePath }
    );
  }

  const runs: TocRun[] = asArray<Record<string, any>>(toc.run).map((run) => {
    const number = Number(run["@_number"] ?? 0);

    // /data/table — the schema-table format.
    const tables: TocTable[] = asArray<Record<string, any>>(
      run?.data?.table
    ).map((table) => {
      const attributes: Record<string, string> = {};
      for (const [key, val] of Object.entries(table)) {
        if (key.startsWith("@_")) attributes[key.slice(2)] = String(val);
      }
      return { schema: attributes.schema ?? "", attributes };
    });

    // /tracks/track/details/detail — the track-detail format.
    // <detail> attributes can appear in any order (kind-before-name OR
    // name-before-kind) — fast-xml-parser normalises them into the same object,
    // so we always access by key, never by position.
    const tracks: TocTrack[] = asArray<Record<string, any>>(
      run?.tracks?.track
    ).map((track) => {
      const trackName = String(track["@_name"] ?? "");
      const details: TocTrackDetail[] = asArray<Record<string, any>>(
        track?.details?.detail
      ).map((detail) => ({
        name: String(detail["@_name"] ?? ""),
        kind: String(detail["@_kind"] ?? "table"),
      }));
      return { name: trackName, details };
    });

    // /info/summary — what this run was ACTUALLY recorded with (see
    // TocRecordingSummary's doc comment). Absent on older trace formats.
    const summaryNode = run?.info?.summary;
    const summary: TocRecordingSummary | undefined = summaryNode
      ? {
          templateName: summaryNode["template-name"] != null ? String(summaryNode["template-name"]) : null,
          recordingMode: summaryNode["recording-mode"] != null ? String(summaryNode["recording-mode"]) : null,
          timeLimit: summaryNode["time-limit"] != null ? String(summaryNode["time-limit"]) : null,
          duration: summaryNode["duration"] != null ? Number(summaryNode["duration"]) : null,
          endReason: summaryNode["end-reason"] != null ? String(summaryNode["end-reason"]) : null,
          instrumentSettings: asArray<Record<string, any>>(
            // xctrace's own element name — "intruments" is xctrace's typo, not ours.
            summaryNode["intruments-recording-settings"]?.instrument
          ).map((inst) => ({
            name: String(inst["@_name"] ?? ""),
            options: asArray<Record<string, any>>(inst?.options?.option).map((opt) => ({
              key: String(opt["@_key"] ?? ""),
              value: String(opt["@_value"] ?? ""),
            })),
          })),
        }
      : undefined;

    return { number, tables, tracks, ...(summary ? { summary } : {}) };
  });

  return { runs };
}
