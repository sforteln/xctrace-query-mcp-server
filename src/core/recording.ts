/**
 * Recording composition helpers — curated knowledge about xctrace templates
 * and instruments, keyed by their REAL names (PMT:stubborn-beck).
 *
 * Earlier versions of this file routed all of this through a `type` enum of
 * friendly intent keys ("cpu", "leaks-backtraces", ...) that resolved to a
 * real template internally. That layer was removed: its curated knowledge
 * (which templates need launch not attach, which combinations need a
 * specific note, which template bakes in which recordingOptions) is real and
 * stays — but it now fires off the ACTUAL resolved template/instrument names
 * a caller ends up with, regardless of how they got there, rather than
 * requiring a specific enum key to unlock it. Two things justified the
 * change: (1) hiding this behind a friendly-label translation layer stopped
 * an agent from using its own genuine Instruments/xctrace domain knowledge to
 * reason about what to do; (2) most of the curated behavior (privacy
 * notices, recordingOptions) was ALREADY keyed off real names independent of
 * the enum, so the enum's only genuinely unique value was a handful of
 * multi-template recipes (most importantly: Leaks alone yields no
 * backtraces; Allocations+Leaks together gives leaked objects their
 * responsible frames) — which fire just as well keyed off the resolved set.
 *
 * The interactive start_recording/stop_recording MCP tools (recordingSession.ts)
 * call startSession() with the caller's `template`/`instruments`. The output
 * path is auto-generated in the server-owned recordings directory.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { XctraceError } from "../engine/xctrace.js";
import { getConfig, defaultRecordingsDir } from "../config.js";
import { openTrace } from "../engine/session.js";
import type { RunSummary, InstrumentSummary, TimeRange } from "../engine/session.js";
import { resolveAssetPath } from "./assetPaths.js";

// ─── Template bundles ─────────────────────────────────────────────────────────

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
 * recordingSession.ts) exist BECAUSE of this overlap: an ARRAY entry in
 * `template` (beyond the first/base one) explicitly asks for a name's full
 * bundle (expandTemplates() below uses this table); `instruments` explicitly
 * asks for the bare instrument only, and is never auto-promoted — an
 * `instruments` entry that happens to match a key here only gets a
 * steer-to-`template` note, never silent expansion. Naming was deliberately
 * picked to make the two knobs impossible to confuse: you say which one you
 * meant instead of the server guessing from an overloaded name.
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
  // PMT:calm-starling: does NOT bundle the full "Points of Interest" instrument —
  // could not re-verify live (this Mac's Apple Silicon CPU doesn't support
  // Processor Trace at all), but trusting the prior session's confirmed "no
  // signpost-related schema at all" finding over the unverified prior claim here.
  "Processor Trace": [],
  "Network": ["Points of Interest"],
  "App Launch": ["Time Profiler"],
  // PMT:calm-starling: does NOT bundle the full "Points of Interest" instrument —
  // re-verified live against a fresh target (Xcode, not previously used) and via
  // the Instruments.app GUI's own "Add Instrument" list for this template (shows
  // Hitches/Display/Time Profiler/Thread Activity/Thermal State/Hangs — no
  // signpost instrument at all): Animation Hitches' own os-signpost coverage is
  // a BARE 'os-signpost' schema only (no OSSignpostIntervals/os-signpost-arg/
  // PointsOfInterestEvents) — see TEMPLATE_NOTES["Animation Hitches"] for the
  // caller-facing guidance this correction feeds into.
  "Animation Hitches": ["Hangs", "Time Profiler"],
  "Swift Concurrency": ["Hangs", "Points of Interest", "Time Profiler"],
};

/**
 * Curated `recordingOptions` a template needs baked in, keyed by its real
 * name (e.g. SwiftUI's `enableLayoutTracing`). Composing that template's
 * name via `template`'s array form should carry these along too — otherwise
 * expandTemplates would correctly add the SwiftUI instrument + its Hangs +
 * Time Profiler bundle, but silently drop layout tracing, which is exactly
 * the same "looks complete, isn't" trap one level down. Keys/values must
 * match what `xcrun xctrace record --template <template> --show-recording-
 * options` reports for that template — xctrace silently ignores unrecognised
 * keys, so verify against that output before adding any. These are baked-in
 * defaults, not agent-tunable — only set one when there's no real tradeoff
 * (e.g. layout tracing is strictly more data for free); a genuine cost/
 * benefit knob should stay at Apple's per-template default rather than
 * becoming a one-off param.
 */
export const TEMPLATE_RECORDING_OPTIONS: Record<string, Record<string, Record<string, unknown>>> = {
  SwiftUI: { SwiftUI: { enableLayoutTracing: true } },
};

/**
 * Custom, non-guessable shipped .tracetemplate assets — the ONE category of
 * "friendly name" that survives the removal of the old `type` enum, because
 * unlike every former `type` key (which was purely an ALIAS for a real,
 * independently-discoverable xctrace template name — the caller could always
 * have just used the real name directly), this has no real name at all: it's
 * an absolute file path resolved at runtime relative to this package's
 * install location, which a caller has no way to guess or discover via
 * `xcrun xctrace list templates`. Resolved transparently wherever a
 * `template` entry is given, same tolerant-alias spirit as before, just
 * scoped down to genuinely unguessable resources instead of every recipe.
 */
export const CUSTOM_TEMPLATE_PATHS: Record<string, string> = {
  // PMT:gold-haven: offline-validated custom template — VM Tracker's
  // "Automatic Snapshotting" (3s interval) is baked in because it's
  // template-only configuration xctrace's own --recording-options can't
  // reach (verified live: --show-recording-options returns {} for VM
  // Tracker — it has no exposed configurable options at all, not "nothing
  // to configure"). Without this, VM Tracker's 'Regions Map' schema comes
  // back EMPTY under both attach and launch.
  "memory-vm": resolveAssetPath("AllocVMTrackerAuto3s.tracetemplate"),
};

/** Rich guidance for a custom template, keyed by its SHORT name (checked before path resolution). */
export const CUSTOM_TEMPLATE_NOTES: Record<string, string> = {
  "memory-vm":
    "Custom template built via Instruments.app's GUI, not a stock xctrace template — VM Tracker's " +
    "\"Automatic Snapshotting\" (3s interval) is baked in (see CUSTOM_TEMPLATE_PATHS' doc comment for why " +
    "xctrace's own --recording-options can't reach this). Bundles VM Tracker's Regions Map for free " +
    "alongside standard Allocations tracking — Points of Interest is NOT bundled (this template only " +
    "composes Allocations + VM Tracker), so it's added automatically like any other POI-less template. " +
    "Use template: \"Allocations\" instead for plain Allocations without the VM Tracker regions breakdown.",
};

export function resolveCustomTemplateName(name: string): string {
  return CUSTOM_TEMPLATE_PATHS[name] ?? name;
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
 * PMT:calm-starling: template names that do NOT also exist as a bare
 * `--instrument` name — confirmed live against every key in TEMPLATE_BUNDLES
 * via `xcrun xctrace list instruments` (2026-07-08). This matters because
 * expandTemplates() below composes an EXTRA `template` array entry by pushing
 * its own headline name into the bare-instrument list (`[name, ...bundle]`) —
 * the BASE template is always safe (passed via `--template`, never
 * `--instrument`), but composing one of THESE names as an extra tries
 * `--instrument "<name>"`, which xctrace rejects outright. Reproduced live:
 * `xctrace record --template "Time Profiler" --instrument "Data Persistence"
 * ...` fails with "Instrument with name 'Data Persistence' cannot be found"
 * (exit 56) — previously an opaque generic `record-failed`, not caught
 * before ever shelling out.
 *
 * Every other TEMPLATE_BUNDLES key (Time Profiler, SwiftUI, Foundation Models,
 * CPU Profiler, Leaks, Allocations, Power Profiler, Core AI, Core ML,
 * Processor Trace, CPU Counters) is ALSO a valid bare instrument name —
 * verified the same way — so composing any of those as an extra template is
 * fine and unaffected by this guard.
 */
export const TEMPLATE_ONLY_NAMES = new Set<string>([
  "Data Persistence",
  "Network",
  "App Launch",
  "Swift Concurrency",
  "Animation Hitches",
]);

/**
 * Expand a caller's explicit additional-template names — WHOLE templates to
 * layer onto the base one — into the real union of instruments xctrace needs,
 * plus any recordingOptions those templates bake in. Each name is expanded to
 * `[name, ...TEMPLATE_BUNDLES[name]]`; a name with no known bundle still
 * passes through as itself (e.g. a template with only a headline instrument
 * and no configurable-options bundle to discover). This is the ONLY place
 * TEMPLATE_BUNDLES expansion happens — `instruments` (bare) is never silently
 * promoted through this path, see bareInstrumentTemplateNotes() below.
 *
 * @throws {XctraceError} kind "template-only-name" when a composed name is in
 * TEMPLATE_ONLY_NAMES — fails fast, before ever shelling out to xctrace,
 * rather than surfacing xctrace's own opaque "Instrument ... cannot be found".
 */
export function expandTemplates(
  names: string[],
  resolvedTemplate: string | undefined
): ExpandedTemplates {
  // `resolvedTemplate` is undefined only for an instruments-only recording
  // (no template/instruments at all, xctrace's implicit "Blank template")
  // — there's no base to seed `seen`/`baseCovered` with in that case.
  const baseLabel = resolvedTemplate ?? "(no base template — instruments-only)";
  const seen = new Set<string>(resolvedTemplate !== undefined ? [resolvedTemplate] : []);
  // Instruments the base template's OWN bundle already covers with full
  // fidelity — a real `--template <resolvedTemplate>` invocation, not a bare
  // `--instrument` addition. Anything in here (or the base name itself)
  // keeps its tuned config/auxiliary behavior even if a composed extra also
  // "wants" it; anything NOT in here that ends up in `instruments` only got
  // there via a bare addition — see PMT:gravel-falcon.
  const baseBundle = resolvedTemplate !== undefined ? TEMPLATE_BUNDLES[resolvedTemplate] ?? [] : [];
  const baseCovered = new Set<string>(resolvedTemplate !== undefined ? [resolvedTemplate, ...baseBundle] : []);
  const instruments: string[] = [];
  const recordingOptions: Record<string, Record<string, unknown>> = {};
  const notes: string[] = [];
  const fidelityAtRisk = new Set<string>();

  for (const rawName of names) {
    const name = resolveCustomTemplateName(rawName);
    if (name !== resolvedTemplate && TEMPLATE_ONLY_NAMES.has(name)) {
      throw new XctraceError(
        "template-only-name",
        `"${name}" is a TEMPLATE name with no matching bare \`--instrument\` — composing it as an extra ` +
          `(on top of "${resolvedTemplate}") is not supported by xctrace: confirmed live that this fails ` +
          `outright ("Instrument with name '${name}' cannot be found"). Use it as your BASE template ` +
          `instead (the first entry when \`template\` is an array, or a bare \`template\` string), or check ` +
          `\`xcrun xctrace list instruments\` for a real bare-instrument alternative.`
      );
    }
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
        // any) are already separately preserved via TEMPLATE_RECORDING_OPTIONS
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
    const opts = TEMPLATE_RECORDING_OPTIONS[name];
    if (opts) Object.assign(recordingOptions, opts);

    const resolvedNote = name !== rawName ? ` ("${rawName}" is a custom template shortcut — resolved to its real path)` : "";
    const fidelityNote =
      addedAtRisk.length > 0
        ? ` ${addedAtRisk.join(", ")} ${addedAtRisk.length === 1 ? "was" : "were"} added bare (not part of ` +
          `"${baseLabel}"'s own bundle) — tuned configuration and any template-only auxiliary behavior ` +
          `(e.g. Hangs' threshold, os-log's subsystem/category scope) is NOT guaranteed to match a real ` +
          `template recording of "${name}".`
        : bundle.length > 0
          ? ` Full fidelity — every instrument here is already covered by "${baseLabel}"'s own bundle.`
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
 * only adds a note pointing at `template` in case the caller actually meant
 * "the whole template" and picked the wrong param.
 */
export function bareInstrumentTemplateNotes(
  resolvedTemplate: string | undefined,
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
        `whole template, pass template: ["${name}"] instead.`
      );
    }
  }
  return notes;
}

/**
 * PMT:birch-river: Hangs' com.apple.runtime-issues os-log coverage never
 * survives a bare `--instrument` addition (see expandTemplates' fidelityAtRisk
 * doc) — a real xctrace behavior, not a far-swan bug, confirmed via
 * PMT:full-trace's template audit. When Hangs specifically lands in
 * fidelityAtRisk, auto-add the bare "os_log" instrument to at least partially
 * compensate.
 *
 * Verified live (A/B test against a real attached process, 5s and 30s, PMT:
 * birch-river) before making this automatic: bare os_log's own bundle-size
 * cost is small (+0.3% at 5s, +0.6% at 30s over a ~22MB baseline) and it stays
 * scoped to the attached/launched process by default
 * (recordAllProcessesInSingleProcessMode defaults false, so it is NOT a
 * system-wide firehose) — light enough to add automatically for this
 * specific, confirmed trigger. But it comes back COMPLETELY UNSCOPED on
 * subsystem/category (confirmed live: com.apple.network/com.apple.iCloudQuota/
 * com.apple.DesktopServices alongside anything runtime-issues-relevant),
 * unlike a real template's own curated capture — the os-log lens's
 * quickStart/nextActions default to a filter approximating the known
 * runtime-issues watchlist, not an exact match (xctrace itself provides no way
 * to apply that scope to a bare os_log instrument).
 *
 * Deliberately NOT generalized to every fidelityAtRisk instrument — only
 * Hangs is confirmed to correlate with os-log coverage today. Points of
 * Interest, Foundation Models, and Network each have their own DIFFERENT
 * os-log scope (per PMT:full-trace's per-template mapping), so auto-adding
 * os_log for those triggers would apply the wrong watchlist.
 */
export function mitigateHangsOsLogFidelity(
  fidelityAtRisk: string[],
  resolvedExtraInstruments: string[]
): { instrument?: string; note?: string } {
  if (!fidelityAtRisk.includes("Hangs")) return {};
  if (resolvedExtraInstruments.includes("os_log")) return {};
  return {
    instrument: "os_log",
    note:
      "Hangs was added bare (see fidelityAtRisk) — its com.apple.runtime-issues os-log coverage does not " +
      "come along for free the way it would via a real Hangs-bundling template, so bare \"os_log\" was " +
      "auto-added to compensate. It comes back completely UNSCOPED (no subsystem/category filter applied " +
      "by xctrace) — query/find the 'os-log' schema (its lens default already approximates the curated " +
      "runtime-issues scope) rather than treating every row as hang-relevant.",
  };
}

/**
 * PMT:stormy-coast: curated device-only instrument map, keyed by hardware
 * dependency. xctrace does NOT expose Simulator compatibility — only the
 * Instruments GUI does (greys out unsupported instruments for a sim target)
 * — so this is sourced from xcodeAI's GUI-derived list (2026-07-08), same
 * curation discipline as TEMPLATE_BUNDLES (curated because xctrace won't
 * confirm it). A Simulator handed one of these produces a failed or
 * un-exportable (sub-)trace instead of a clear upfront error — exactly the
 * "Hitches is not supported on this platform" failure class that cost a
 * prior session real time. Reconciled: Allocations is SIM-SAFE — earlier
 * Allocations-on-sim failures traced to a stale PID + an --all-processes
 * target-type mistake, not a real incompatibility, so it is deliberately
 * NOT in this set.
 *
 * RULE OF THUMB for anything not listed here (new/unknown instruments): if
 * the metric needs the GPU, the real display/present pipeline, energy/
 * thermal sensors, or CPU performance counters/ANE, it's device-only;
 * CPU/memory/allocation/concurrency/signpost/persistence work is sim-safe.
 */
export const DEVICE_ONLY_INSTRUMENTS: Record<string, string> = {
  // display/present timing — needs the real display + present pipeline
  "Animation Hitches": "a real display/present pipeline",
  Hitches: "a real display/present pipeline",
  "Core Animation FPS": "a real display/present pipeline",
  "Frame Lifetimes": "a real display/present pipeline",
  Display: "a real display/present pipeline",
  // GPU — needs real GPU hardware
  GPU: "real GPU hardware",
  "Metal Application": "real GPU hardware",
  "Metal GPU Counters": "real GPU hardware",
  "Metal Performance Overview": "real GPU hardware",
  "Advanced Graphics Statistics": "real GPU hardware",
  "Foveated Streaming": "real GPU hardware",
  // energy/thermal — needs real power/thermal sensors
  "Power Profiler": "real power/thermal sensors",
  "Location Energy Model": "real power/thermal sensors",
  "Thermal State": "real thermal sensors",
  // hardware PMU / ANE — needs real performance-monitoring hardware
  "CPU Counters": "real CPU performance-counter hardware",
  "Processor Trace": "real CPU performance-counter hardware",
  "Neural Engine": "real ANE hardware",
  "Core AI": "real ANE hardware",
};

/**
 * PMT:stormy-coast: WARN (never block — the map is curated, may drift as
 * Xcode changes; the record() partial-success runIssues handling remains
 * the backstop for the actual outcome) when a Simulator target is asked for
 * a device-only instrument, whether requested directly (`resolvedExtra
 * Instruments`) or pulled in as part of the base template's own bundle
 * (`resolvedTemplate`'s TEMPLATE_BUNDLES entry) — e.g. the SwiftUI/Animation
 * Hitches templates both bundle Hitches, so a SwiftUI recording on a sim
 * should pre-warn that Hitches won't capture even though the caller never
 * named it directly.
 */
export function deviceOnlyInstrumentWarning(
  resolvedTemplate: string | undefined,
  resolvedExtraInstruments: string[],
  isSimulator: boolean
): string | undefined {
  if (!isSimulator) return undefined;
  const candidates = new Set([
    ...(resolvedTemplate !== undefined ? [resolvedTemplate] : []),
    ...(resolvedTemplate !== undefined ? TEMPLATE_BUNDLES[resolvedTemplate] ?? [] : []),
    ...resolvedExtraInstruments,
  ]);
  const flagged = [...candidates].filter((name) => name in DEVICE_ONLY_INSTRUMENTS);
  if (flagged.length === 0) return undefined;
  return flagged
    .map(
      (name) =>
        `"${name}" is device-only (needs ${DEVICE_ONLY_INSTRUMENTS[name]}) — it won't capture on a ` +
        `Simulator; the rest of the recording will still work. Use a physical device for "${name}".`
    )
    .join("\n\n");
}

/**
 * PMT:ash-stone gap #2: known-broken instrument/template combinations on a
 * SPECIFIC Xcode version — a fundamentally different curation problem from
 * DEVICE_ONLY_INSTRUMENTS above. That map is a stable hardware fact (true
 * forever, sourced from the Instruments GUI's own compatibility list — an
 * Apple-provided signal). THIS map is genuinely live-repro-only: one
 * session's crash reproduction, not corroborated by any Apple compatibility
 * surface, and — unlike a hardware fact — can be silently fixed in the very
 * next Xcode release, making a stale entry actively misleading rather than
 * just unhelpful. There is no reliable signal for "has Apple fixed this
 * yet" short of re-testing, so entries are NOT auto-expired — each carries
 * its own verifiedAt/xcodeVersion so a future reader (human or agent) can
 * judge staleness themselves, and the warning text repeats that caveat
 * every time it fires rather than relying on the code being pruned promptly.
 *
 * `xcodeVersion` is a PREFIX match against detectXcodeVersion()'s output
 * (e.g. "27." matches "27.0", "27.1", any 27.x beta or GA) — deliberately
 * coarse, since a beta bug reproduced on one point release is not proven
 * fixed on a sibling point release without re-testing either.
 */
export interface KnownBrokenInstrumentEntry {
  /** Xcode version prefix this was confirmed against, e.g. "27." for any 27.x. */
  xcodeVersion: string;
  /** What breaks and how — the actionable symptom, not just "avoid this". */
  symptom: string;
  /** Suggested retry/mitigation — steer toward, never a hard block. */
  mitigation: string;
  /** Session/date + evidence this was verified live, for future staleness judgment. */
  verifiedAt: string;
}

export const KNOWN_BROKEN_INSTRUMENTS: Record<string, KnownBrokenInstrumentEntry[]> = {
  "Network Connections": [
    {
      xcodeVersion: "27.",
      symptom:
        "Crashes on write, corrupting the whole trace bundle: raw .atrc data present but no template " +
        "document and no per-instrument stores — \"Document Missing Template Error\" on open/export. " +
        "Every OTHER instrument in the Network template records fine; only Network Connections crashes.",
      mitigation:
        "Retry with instruments: [\"HTTP Traffic\"] (or other Network-template members) individually " +
        "instead of template: \"Network\", which pulls in Network Connections as part of its bundle. The " +
        "SAME \"Document Missing Template Error\" symptom was also reproduced with a completely different " +
        "pairing (template: [\"File Activity\"] + Time Profiler/Hangs on this same beta) — evidence this " +
        "is a broader unstable-COMBINATION pattern on this Xcode version, not specific to Network " +
        "Connections alone, so retrying with FEWER composed instruments generally is the safer move, not " +
        "just swapping out this one name.",
      verifiedAt:
        "2026-07-08, PMT:ash-stone (HTTPTraffic.trace device recording + manual Instruments.app GUI " +
        "repro that isolated Network Connections as the crashing instrument).",
    },
  ],
};

/**
 * WARN (never block — see the map's own doc comment on why this evidence is
 * weaker than DEVICE_ONLY_INSTRUMENTS') when the current Xcode version
 * matches a curated known-broken entry for the resolved template/instruments.
 * `xcodeVersion` is whatever detectXcodeVersion() returns for THIS machine —
 * null (undetectable) means no warning, never a false positive from missing data.
 */
export function knownBrokenInstrumentWarning(
  resolvedTemplate: string | undefined,
  resolvedExtraInstruments: string[],
  xcodeVersion: string | null
): string | undefined {
  if (!xcodeVersion) return undefined;
  const candidates = new Set([
    ...(resolvedTemplate !== undefined ? [resolvedTemplate] : []),
    ...(resolvedTemplate !== undefined ? TEMPLATE_BUNDLES[resolvedTemplate] ?? [] : []),
    ...resolvedExtraInstruments,
  ]);
  const warnings: string[] = [];
  for (const name of candidates) {
    for (const entry of KNOWN_BROKEN_INSTRUMENTS[name] ?? []) {
      if (xcodeVersion.startsWith(entry.xcodeVersion)) {
        warnings.push(
          `"${name}" is known broken on Xcode ${xcodeVersion} (matches curated range "${entry.xcodeVersion}"): ` +
            `${entry.symptom} Mitigation: ${entry.mitigation} (verified ${entry.verifiedAt} — a beta-specific, ` +
            `live-repro-only finding, not sourced from an Apple compatibility list; may already be fixed in a ` +
            `newer Xcode — re-verify before trusting this indefinitely.)`
        );
      }
    }
  }
  return warnings.length > 0 ? warnings.join("\n\n") : undefined;
}

export function defaultPointsOfInterest(
  resolvedTemplate: string | undefined,
  resolvedExtraInstruments: string[]
): { instrument?: string; note?: string } {
  if (resolvedTemplate === "Points of Interest") return {};
  if (resolvedTemplate !== undefined && (TEMPLATE_BUNDLES[resolvedTemplate] ?? []).includes("Points of Interest")) return {};
  if (resolvedExtraInstruments.includes("Points of Interest")) return {};
  return {
    instrument: "Points of Interest",
    note:
      "\"Points of Interest\" was auto-added bare — the resolved template doesn't bundle it, and " +
      "composing it costs ~0 when the app never calls os_signpost (confirmed live at 5s/30s/60s " +
      "against both quiet and busy targets). PMT:vivid-rill: this instrument alone is enough for " +
      "emitEvent-style instant signposts on a category: .pointsOfInterest log handle (they land in " +
      "'PointsOfInterestEvents', no further config needed) and for the raw 'os-signpost' schema's " +
      "event rows — but it does NOT capture beginInterval/endInterval calls into 'OSSignpostIntervals' " +
      "for a CUSTOM app subsystem; that needs the separate os_signpost instrument + " +
      "dynamicTracingEnabledSubsystems (pass signpostSubsystems: [\"your.subsystem\"] to start_recording) " +
      "regardless of which template or instruments are composed.",
  };
}

/**
 * Whether a resolved base template requires --launch (App Launch's sole
 * purpose is capturing the startup sequence from process creation, which
 * only a genuine process-creation event — not an --attach to an already-
 * running process — can produce). Checked against the ACTUAL resolved
 * template/instrument set rather than a `type` key, so it applies whether
 * "App Launch" was reached as the base template or (structurally possible,
 * though unusual) as a composed extra.
 */
export const LAUNCH_REQUIRED_TEMPLATES = new Set<string>(["App Launch"]);

/**
 * Curated guidance notes, keyed by REAL template name — migrated verbatim
 * (PMT:stubborn-beck) from the old per-`type` RECORDING_INTENTS notes. Fires
 * for the resolved BASE template only (matching the old behavior: a
 * composed EXTRA template via `template`'s array form only ever got
 * expandTemplates' generic "expanded to X+Y" note, never a `type`-specific
 * one either) — see allocationsLeaksNote() below for the one recipe
 * (Allocations+Leaks) that genuinely needs to consider the full resolved
 * set, not just the base.
 */
export const TEMPLATE_NOTES: Record<string, string> = {
  "Time Profiler":
    "The Time Profiler template already bundles Hangs + Points of Interest + Thermal State " +
    "for free — after opening, query 'potential-hangs'/'hitches' and points-of-interest " +
    "schemas alongside the CPU samples, no extra instruments needed.",
  Network:
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
  "App Launch":
    "App Launch requires --launch: its purpose is capturing the startup sequence from process " +
    "creation. Use template: \"Time Profiler\" with attach for CPU profiling of an already-running " +
    "app. The App Launch template already bundles Time Profiler for free. IMPORTANT — if the target " +
    "app is ALREADY RUNNING, --launch does NOT start a fresh process: most macOS/iOS apps are " +
    "effectively singleton, so the OS just activates/foregrounds the existing instance instead of " +
    "launching a new one — there is no real launch event for this template to capture, so the " +
    "recording silently produces no startup data (not an error, just an empty/uninteresting trace). " +
    "Verified live (PMT:loam-merlin, FileActivity session): fully quit the target app first, THEN " +
    "start this recording, so --launch triggers a genuine process-creation event.",
  "CPU Profiler":
    "Records hangs and hang-risk events at low overhead — verified live: this template's real " +
    "schemas are 'potential-hangs' and 'hang-risks' (NOT 'hitches' — that schema only comes from " +
    "template: \"Animation Hitches\"; if you're chasing frame drops during scrolling/animation " +
    "specifically, use that instead). Points of Interest is already bundled for free. " +
    "IMPORTANT — decide this NOW, not after recording: 'potential-hangs' carries start/duration/" +
    "thread/process but NO backtrace column — it tells you WHEN a hang happened, never WHAT was " +
    "running, and this template has no CPU-sampling instrument to correlate against (its own " +
    "'cpu-profile' schema is a lightweight counter-based profile, not the tagged-backtrace " +
    "'time-profile' schema call_tree/correlate need). If you already know you'll want to see what " +
    "the app was doing during a hang, don't compose \"Time Profiler\" onto this — use template: " +
    "\"Time Profiler\" instead: its own template already bundles Hangs + Points of Interest + " +
    "Thermal State for free, so it's a strict superset of this recording plus full CPU attribution, " +
    "in one pass, without running two separate CPU-sampling instruments side by side. Reach for " +
    "template: \"CPU Profiler\" specifically when you want lower-overhead hang-watching over a long " +
    "session and don't need CPU attribution. To confirm whether the main thread was GENUINELY " +
    "busy during a hang investigation (rather than just parked waiting on a mach port, which a " +
    "sampled thread can look identical to), compose instruments: [\"Run Loops\"] into the recording " +
    "— its 'runloop-intervals' schema's interval-type: \"Busy\" rows are a direct, explicit signal " +
    "for real main-thread work, distinct from benign \"Waiting For Events\" idle time. " +
    "TRYING TO CAPTURE A SEVERE HANG specifically (not routine profiling)? This template's low " +
    "overhead is exactly what you want — a heavier instrument (e.g. full SwiftUI tracing) adds " +
    "real load that can worsen the exact condition you're trying to capture (verified live, " +
    "PMT:onyx-spark: an 852K-row swiftui-updates stream measurably worsened an already-severe hang " +
    "during capture). Pair with a bounded timeLimit rather than open-ended interactive recording " +
    "— auto-finalize can preserve bundle structure even if the recording host itself freezes mid-" +
    "session, which open-ended recording can't. See aidocs/howRecordingWorks.md for the full case, " +
    "including the harder limit: a hang severe enough to freeze the IDE hosting BOTH the target " +
    "and this recorder's own connection may not be reliably capturable from inside that same host " +
    "at all, regardless of instrument choice or timeLimit.",
  "Animation Hitches":
    "Records animation hitches (frame drops during scrolling, animations, and transitions). " +
    "After opening, query the 'hitches' schema — like 'potential-hangs', it carries no " +
    "backtrace of its own, but UNLIKE CPU Profiler's hang-only recording, you don't need to compose " +
    "anything extra to find out what was running: the Animation Hitches template already " +
    "bundles Hangs + Time Profiler for free (with a tighter 33ms hang threshold tuned for " +
    "hitch detection, vs. the default 250ms) — correlate a hitch's [start, start+duration] " +
    "against Time Profiler's samples directly, or call_tree(view: \"hot\" or \"spine\", " +
    "timeRange: <the hitch's window>), no re-recording needed. Its OWN os_signpost coverage is " +
    "partial (verified live, PMT:calm-starling): only a bare 'os-signpost' schema, missing " +
    "OSSignpostIntervals/os-signpost-arg/PointsOfInterestEvents. Composing instruments: " +
    "[\"Points of Interest\"] explicitly (safe to add bare — no fidelity loss) gets you " +
    "PointsOfInterestEvents for emitEvent-style instants, but NOT OSSignpostIntervals — " +
    "custom beginInterval/endInterval calls need the separate os_signpost instrument + " +
    "dynamicTracingEnabledSubsystems regardless (pass signpostSubsystems: [\"your.subsystem\"] " +
    "to start_recording — see PMT:vivid-rill).",
  "Swift Concurrency":
    "Records Swift Task and Actor lifetimes, executor queue depth, and task state transitions. " +
    "After opening, query SwiftTaskLifetime, SwiftActorLifetime, SwiftActorQueueSize, " +
    "SwiftTaskCreationEvent, and SwiftTaskStateTable schemas. The Swift Concurrency template " +
    "already bundles Hangs + Points of Interest + Time Profiler for free.",
  SwiftUI:
    "Records SwiftUI view body re-evaluations, state changes, and layout passes " +
    "(layout tracing is enabled by default). After opening, query 'swiftui-updates' " +
    "and 'swiftui-changes' for update/cause events, or 'swiftui-layout-updates' / " +
    "'SwiftUILayoutUpdates2' for per-view layout pass timing. The SwiftUI template already " +
    "bundles Hangs + Time Profiler for free (with highFrequencySampling enabled) — query " +
    "Time Profiler's schemas directly for CPU cost alongside the view-update data, no " +
    "extra instruments or a separate recording needed.",
  "Data Persistence":
    "Records Core Data and SwiftData object faults, relationship faults, fetches, and saves. " +
    "After opening, query 'core-data-fault', 'core-data-relationship-fault', " +
    "'core-data-fetch', and 'core-data-save' schemas. " +
    "To attribute this activity to the UI event that triggered it, pass " +
    "template: [\"Data Persistence\", \"SwiftUI\"] to start_recording — each row's Caller backtrace " +
    "already resolves the full call chain (e.g. a SwiftUI view body update through AttributeGraph " +
    "into the fetch), readable directly via get_row, no extra correlation step needed. " +
    "template's array form (not instruments) is what you want here: it records the COMPLETE SwiftUI " +
    "template — its own Hangs + Time Profiler bundle, layout tracing enabled — alongside " +
    "Data Persistence, in one recording. instruments: [\"SwiftUI\"] would give you only " +
    "the bare SwiftUI instrument, missing that bundle. ORDER MATTERS: \"Data Persistence\" must " +
    "be FIRST in the template array (the base) — the reverse (template: [\"SwiftUI\", \"Data " +
    "Persistence\"]) fails outright (\"Data Persistence\" has no bare --instrument form xctrace can " +
    "compose as an extra; verified live, error kind \"template-only-name\"). Data Persistence's OWN " +
    "os_signpost coverage is partial (verified live, PMT:calm-starling): only a bare 'os-signpost' " +
    "schema, missing OSSignpostIntervals/os-signpost-arg/PointsOfInterestEvents. Composing " +
    "instruments: [\"Points of Interest\"] explicitly (safe to add bare — no fidelity loss) gets " +
    "you PointsOfInterestEvents for emitEvent-style instants, but NOT OSSignpostIntervals — " +
    "custom beginInterval/endInterval calls need the separate os_signpost instrument + " +
    "dynamicTracingEnabledSubsystems regardless (pass signpostSubsystems: [\"your.subsystem\"] " +
    "to start_recording — see PMT:vivid-rill).",
  "Foundation Models":
    "Records all on-device Foundation Models inference calls: prompts, responses, " +
    "token counts, and latency. After opening, query ModelInferenceTable and ModelLoadingTable. " +
    "To confirm inference actually ran on the Neural Engine (rather than falling back to CPU/GPU) " +
    "and measure real hardware utilization, compose instruments: [\"Neural Engine\"] into this " +
    "recording — verified live: it adds the 'ane-hw-intervals' schema (start/duration per ANE-busy " +
    "interval, no thread/backtrace column), which correlate can pair against ModelInferenceTable's " +
    "own request timestamps on the shared clock to answer 'was the ANE busy for the full span of " +
    "this inference' — a provable hardware fact, not an assumption. Foundation Models' OWN " +
    "os_signpost coverage is partial (verified live, PMT:calm-starling): only a bare " +
    "'os-signpost' schema, missing OSSignpostIntervals/os-signpost-arg/PointsOfInterestEvents. " +
    "Composing instruments: [\"Points of Interest\"] explicitly (safe to add bare — no fidelity " +
    "loss) gets you PointsOfInterestEvents for emitEvent-style instants, but NOT " +
    "OSSignpostIntervals — custom beginInterval/endInterval calls need the separate os_signpost " +
    "instrument + dynamicTracingEnabledSubsystems regardless (pass signpostSubsystems: " +
    "[\"your.subsystem\"] to start_recording — see PMT:vivid-rill).",
};

/**
 * Migrated from RECORDING_INTENTS' old "memory"/"leaks"/"leaks-backtraces"
 * entries (PMT:stubborn-beck) — the two-Leaks behavior (Leaks alone yields
 * no backtraces; Allocations+Leaks together gives leaked objects their
 * responsible frames) was previously reachable only via picking the right
 * `type` key. It now fires off the ACTUAL resolved template/instrument set
 * (base + composed extras, whichever role each played), so it's correct
 * regardless of how the caller arrived at that combination — e.g. Leaks
 * composed as a bare extra instrument on an Allocations base (the old
 * "leaks-backtraces" shape) triggers the exact same guidance as Allocations
 * and Leaks both passed as a `template` array.
 */
export function allocationsLeaksNote(resolvedNames: Set<string>): string | undefined {
  const hasAllocations = resolvedNames.has("Allocations");
  const hasLeaks = resolvedNames.has("Leaks");
  if (hasAllocations && hasLeaks) {
    return (
      "Allocations + Leaks together: leaked objects carry responsible frames. Prefer launch over attach " +
      "when you actually need to see WHERE a leaked object came from: malloc stack logging only captures " +
      "allocations made DURING the recording, so with attach, anything already live when Instruments " +
      "attaches has no stack in principle, not from a symbolication failure — confirmed both by get_row's " +
      "PRE-ATTACHMENT label on Leaks/Leaks (join to Allocations/Allocations List shows timestamp 0) and by " +
      "Instruments.app's own UI (\"No stack trace is available for this leak. It may have been allocated " +
      "before the recording started.\"). Attach is fine when you only need the leak list/counts, not the " +
      "callsite. The Allocations base template already bundles Points of Interest for free."
    );
  }
  if (hasLeaks) {
    return (
      "Leaks alone — fast, gives the leak list without responsible call frames. Compose template: " +
      "[\"Allocations\", \"Leaks\"] together to also capture stack frames. The Leaks template already " +
      "bundles Points of Interest for free."
    );
  }
  if (hasAllocations) {
    return "The Allocations template already bundles Points of Interest for free.";
  }
  return undefined;
}

/**
 * Privacy notices keyed by template OR instrument name — covers BOTH the
 * resolved base template and any ad-hoc composition (extraInstruments, a
 * caller-supplied `instruments` or additional-`template` entry), so e.g.
 * composing "Foundation Models" as an extra on an unrelated base still
 * surfaces the warning, not just when it's the base itself.
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
 * in first-seen order. Pass every resolved name (base template + composed
 * extras + bare instruments) — there's no separate "intent-level" notice
 * layer anymore, this is the single source of truth.
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
 * Filesystem-safe slug for an output filename. A shipped custom
 * .tracetemplate (PMT:gold-haven, e.g. "memory-vm") passes its resolved
 * absolute FILE PATH here instead of a short template name — slug from the
 * basename (extension stripped), not the whole path, or the filename
 * balloons into a slugified copy of the entire directory tree (verified
 * live before this guard existed: "…-users-simonfortelny-git-instruments-
 * mcp-server-assets-allocvmtrackerauto3s-tracetemplate.trace").
 */
export function slugFromTemplate(template: string): string {
  const nameSource = /[\\/]/.test(template) ? basename(template).replace(/\.[^.]+$/, "") : template;
  return nameSource.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

/**
 * Generate a timestamped output path in the recordings directory — the
 * user-configured one (set_recordings_dir, PMT:serene-wind) if set, else the
 * OS-convention default (~/Library/Application Support/far-swan/recordings/
 * <ts>-<slug>.trace). Creates the directory if it doesn't exist.
 */
export async function defaultOutputPath(template: string): Promise<string> {
  const config = await getConfig();
  const dir = config.recordingsDir ?? defaultRecordingsDir();
  await mkdir(dir, { recursive: true });

  const ts = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .slice(0, 19);
  return join(dir, `${ts}-${slugFromTemplate(template)}.trace`);
}

/**
 * Write recordingOptions to a JSON file alongside the trace output (same
 * directory, same base name) so xctrace's --recording-options can find it.
 * Returns undefined when there are no recordingOptions — callers skip the flag.
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
