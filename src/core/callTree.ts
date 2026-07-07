/**
 * callTree — folded call tree from backtrace columns, SQLite-backed.
 *
 * The `time-profile`/`cpu-profile` schemas carry inline symbolicated call
 * stacks as `<tagged-backtrace>` frames; Allocations (track-detail) carries a
 * resolved `<backtrace>` per row. Both now ingest through the normal streaming
 * path (PMT:elm-swamp) — the tagged-backtrace column is a backtrace column
 * like any other (see sqliteStore.ts's isBacktraceCol), its frames stored as
 * queryable rows in the shared `frames` table. call_tree issues ONE bounded
 * SELECT (weight + backtrace_id, filtered by thread/timeRange), resolves each
 * backtrace_id to its frames from that table, and folds — the full table's
 * rows never materialize at once, and there is no bespoke XML parser here
 * anymore (the old buffered ctParser existed only because fast-xml-parser
 * collapsed repeated <frame> siblings; the streaming MiniXmlBuilder arrays
 * them correctly, so time-profile parses through the same path as everything
 * else). Frames are LEAF-FIRST (deepest call first); we reverse for a
 * root-to-leaf prefix tree weighted by the sample's weight column.
 */
import type { DatabaseSync } from "node:sqlite";
import { XctraceError } from "../engine/xctrace.js";
import { getSession, getTable, getDb, lastRun as sessionLastRun } from "../engine/session.js";
import { classifyWithHints, hintFor } from "../engine/roleHints.js";
import { firstWithRole } from "../engine/roleInference.js";
import { quoteIdent, isBacktraceCol } from "../engine/sqliteStore.js";
import type { SchemaCol } from "../engine/parseTable.js";

// ─── Tree types ───────────────────────────────────────────────────────────────

interface TreeNode {
  name: string;
  binary: string | null;
  totalWeight: number;
  selfWeight: number;
  totalSamples: number;
  selfSamples: number;
  children: Map<string, TreeNode>;
}

export interface CallTreeNode {
  name: string;
  binary: string | null;
  totalSamples: number;
  selfSamples: number;
  totalWeightFmt: string;
  selfWeightFmt: string;
  pctOfTotal: number;
  children: CallTreeNode[];
  childrenOmitted?: number;
  isWait?: boolean;
}

/**
 * Frame names known to mean "this thread was idle/blocked here," not "CPU was
 * spent here" — a hot list or spine topped by one of these is a wait, not
 * work. Best-effort and non-exhaustive (macOS run-loop/mach/pthread wait
 * primitives, plus the AppKit/CF run-loop wrappers most commonly sampled as
 * the "hot" frame while idle) — extend as new ones turn up in real traces.
 * Time Profiler shows THAT a thread is blocked here, never WHAT it's blocked
 * on — that requires System Trace or thread-state instrumentation instead.
 */
const WAIT_FRAME_NAMES = new Set([
  "_DPSBlockUntilNextEventMatchingListInMode",
  "CFRunLoopRun",
  "CFRunLoopRunSpecific",
  "mach_msg2_trap",
  "mach_msg_trap",
  "mach_msg_overwrite_trap",
  "__psynch_cvwait",
  "__psynch_mutexwait",
  "semaphore_wait_trap",
  "semaphore_wait",
  "__semwait_signal",
  "__ulock_wait",
  "__ulock_wait2",
  "__workq_kernreturn",
  "__select",
  "__select_nocancel",
  "__ppoll",
  "kevent_qos",
  "__kevent",
  "usleep",
  "nanosleep",
]);

/**
 * A wait-frame NAME match only means "this is a known idle/blocking symbol" —
 * it does NOT mean the thread was actually idle here. Verified live: a
 * nested CFRunLoop callout (e.g. _DPSBlockUntilNextEventMatchingListInMode
 * hosting real window/layout work triggered from a menu action) matches the
 * name but has heavy children doing real work below it — nearly all of its
 * time is inclusive (passed through to descendants), not self. So "isWait"
 * only means "genuinely blocked/idle here" when the frame's OWN self-time
 * dominates its OWN total/inclusive time — i.e. most samples that pass
 * through this frame end right here, not deeper. A wait-named frame with
 * heavy descendants is running a callout, not blocked. 0.5 is a judgment
 * call, not a measured threshold.
 */
const WAIT_SELF_DOMINANCE_RATIO = 0.5;

function isBlockingWaitFrame(name: string, selfWeight: number, totalWeight: number): boolean {
  return WAIT_FRAME_NAMES.has(name) && totalWeight > 0 && selfWeight / totalWeight >= WAIT_SELF_DOMINANCE_RATIO;
}

/** Flat, ranked-by-self-time entry — one per unique (name, binary), regardless of how many call sites it appears under. */
export interface HotFunctionEntry {
  name: string;
  binary: string | null;
  selfSamples: number;
  selfWeightFmt: string;
  pctSelfOfTotal: number;
  totalSamples: number;
  totalWeightFmt: string;
  /** % of the run's total weight spent anywhere under this function (inclusive) — "which subsystem dominates". */
  pctTotalOfTotal: number;
  /** True when self-time genuinely dominates at a known idle/blocking frame (see isBlockingWaitFrame) — not just a name match. */
  isWait?: boolean;
}

/**
 * One frame of the single heaviest root-to-leaf path (the branch with the
 * most total weight at every level). Deliberately compact — a GUI main-
 * thread spine can run 100+ frames deep, and this view's job is path SHAPE
 * and dominance, not full per-frame weight detail (use "hot" for magnitude
 * ranking of any specific frame instead).
 */
export interface SpineFrame {
  depth: number;
  name: string;
  binary: string | null;
  /** % of the run's total weight (falls monotonically with depth). */
  pctOfTotal: number;
  /** % of THIS node's parent's weight — how dominant this specific branch choice was, independent of overall depth. */
  pctOfParent: number;
  /** Other children at this depth not on the dominant path (their combined weight, not shown). */
  siblingsOmitted?: number;
  isWait?: boolean;
}

export interface CallTreeResult {
  schema: string;
  run: number;
  totalSamples: number;
  totalWeightFmt: string;
  threadFilter: string | null;
  view: "tree" | "hot" | "spine";
  /** Present when view is "tree" (the default). */
  roots?: CallTreeNode[];
  /** Present when view is "hot". */
  hotFunctions?: HotFunctionEntry[];
  /** Present when view is "spine". */
  spine?: SpineFrame[];
  /**
   * Present when view is "spine" and a known run-loop/wait frame (see
   * WAIT_FRAME_NAMES) appears above the leaf — the depth immediately after
   * the DEEPEST such frame. On the main thread that chain (NSApplicationMain
   * → ... → RunCurrentEventLoopInMode → ...) is mandatory scaffolding present
   * in EVERY sample, idle or busy, so its presence/inclusive-% carries zero
   * signal — this depth is where the sample's actual, distinguishing work
   * starts. null if no such frame appears, or if it IS the leaf (genuinely
   * idle — nothing runs past it). The full spine array is never trimmed;
   * this is a pointer into it, not a replacement for it.
   */
  appCodeStartsAtDepth?: number | null;
  note?: string;
}

// ─── Tree building ────────────────────────────────────────────────────────────

function getOrCreate(map: Map<string, TreeNode>, key: string, name: string, binary: string | null): TreeNode {
  let node = map.get(key);
  if (!node) {
    node = { name, binary, totalWeight: 0, selfWeight: 0, totalSamples: 0, selfSamples: 0, children: new Map() };
    map.set(key, node);
  }
  return node;
}

/**
 * Add one distinct stack to the tree with its AGGREGATED weight + sample count
 * (PMT:elm-swamp folds per distinct backtrace, not per row — identical stacks
 * share a backtrace_id, so `weight` is the SUM and `count` the COUNT across all
 * that stack's samples). Arithmetically identical to `count` individual
 * single-sample adds, because every accumulation here is additive.
 */
function addSample(roots: Map<string, TreeNode>, frames: Array<{ name: string; binary: string | null }>, weight: number, count: number): void {
  let level = roots;
  for (let i = 0; i < frames.length; i++) {
    const { name, binary } = frames[i];
    const key = `${name}@${binary ?? "?"}`;
    const node = getOrCreate(level, key, name, binary);
    node.totalWeight += weight;
    node.totalSamples += count;
    if (i === frames.length - 1) {
      node.selfWeight += weight;
      node.selfSamples += count;
    }
    level = node.children;
  }
}

interface HotAccum {
  name: string;
  binary: string | null;
  totalWeight: number;
  totalSamples: number;
  selfWeight: number;
  selfSamples: number;
}

/**
 * Accumulate self/total time per unique (name, binary) regardless of call
 * path — unlike the folded tree above (which keys nodes by path, so the same
 * function called from two different call sites becomes two separate nodes),
 * this sums a function's self time everywhere it appears. Dedupes within one
 * sample's own frame list so a recursive function's total-time isn't counted
 * once per recursion level.
 */
function addHotSample(
  hot: Map<string, HotAccum>,
  frames: Array<{ name: string; binary: string | null }>,
  weight: number,
  count: number
): void {
  const seenThisSample = new Set<string>();
  for (let i = 0; i < frames.length; i++) {
    const { name, binary } = frames[i];
    const key = `${name}@${binary ?? "?"}`;
    let entry = hot.get(key);
    if (!entry) {
      entry = { name, binary, totalWeight: 0, totalSamples: 0, selfWeight: 0, selfSamples: 0 };
      hot.set(key, entry);
    }
    // Dedup within this one distinct stack (a recursive function counts once
    // for total), same as the per-sample dedup was — all `count` samples of
    // this backtrace share the identical stack, so their aggregate lands here.
    if (!seenThisSample.has(key)) {
      seenThisSample.add(key);
      entry.totalWeight += weight;
      entry.totalSamples += count;
    }
    if (i === frames.length - 1) {
      entry.selfWeight += weight;
      entry.selfSamples += count;
    }
  }
}

/**
 * A spine frame whose weight is below this fraction of its PARENT's weight
 * means the "dominant child" choice at that step wasn't actually dominant —
 * the profile branches meaningfully there, and the spine past this point is
 * one branch among several comparable ones, not "the whole story." 80% is a
 * judgment call, not a measured threshold — tune if it proves noisy in practice.
 */
const SPINE_DOMINANCE_THRESHOLD_PCT = 80;

/**
 * Walk the already-built tree following the highest-totalWeight child at
 * every level, all the way to a true leaf — no depth cap, since a single
 * path can't branch-explode the way a full tree can. This is what a caller
 * manually reconstructs by hand when call_tree's default tree view truncates
 * before the interesting frame (childrenOmitted at the depth cap, with the
 * real payload one level deeper) — see the RunCurrentEventLoopInMode case
 * that motivated this view.
 */
function buildSpine(
  roots: Map<string, TreeNode>,
  totalWeight: number
): { frames: SpineFrame[]; divergesAtDepth: number | null } {
  const spine: SpineFrame[] = [];
  let level: Map<string, TreeNode> | undefined = roots;
  let parentWeight = totalWeight;
  let depth = 0;
  let divergesAtDepth: number | null = null;
  while (level && level.size > 0) {
    const sorted: TreeNode[] = [...level.values()].sort((a: TreeNode, b: TreeNode) => b.totalWeight - a.totalWeight);
    const node: TreeNode = sorted[0];
    const pctOfParent = parentWeight > 0 ? Math.round((node.totalWeight / parentWeight) * 1000) / 10 : 0;
    if (divergesAtDepth === null && pctOfParent < SPINE_DOMINANCE_THRESHOLD_PCT) {
      divergesAtDepth = depth;
    }
    spine.push({
      depth,
      name: node.name,
      binary: node.binary,
      pctOfTotal: totalWeight > 0 ? Math.round((node.totalWeight / totalWeight) * 1000) / 10 : 0,
      pctOfParent,
      ...(sorted.length > 1 ? { siblingsOmitted: sorted.length - 1 } : {}),
      ...(isBlockingWaitFrame(node.name, node.selfWeight, node.totalWeight) ? { isWait: true } : {}),
    });
    parentWeight = node.totalWeight;
    level = node.children;
    depth++;
  }
  return { frames: spine, divergesAtDepth };
}

/**
 * Find where a spine's mandatory run-loop/wait scaffolding ends and the
 * sample's own distinguishing work begins — the depth right after the
 * DEEPEST frame matching WAIT_FRAME_NAMES. On the main thread, everything
 * from the entry point down to that frame (NSApplicationMain → ... →
 * RunCurrentEventLoopInMode → ...) is present in every sample regardless of
 * whether the thread is idle or busy, so it carries zero signal on its own —
 * this marks where that stops being true. Returns null if no such frame
 * appears on this path, or if it IS the leaf (genuinely idle, nothing runs
 * past it — the spine array itself already shows that).
 */
function findAppCodeStartDepth(spine: SpineFrame[]): number | null {
  let lastWaitDepth = -1;
  for (const frame of spine) {
    if (WAIT_FRAME_NAMES.has(frame.name)) lastWaitDepth = frame.depth;
  }
  if (lastWaitDepth === -1) return null;
  const nextDepth = lastWaitDepth + 1;
  return nextDepth < spine.length ? nextDepth : null;
}

// ─── Formatting ───────────────────────────────────────────────────────────────

function formatNs(ns: number): string {
  if (ns >= 1e9) return `${(ns / 1e9).toFixed(2)} s`;
  if (ns >= 1e6) return `${(ns / 1e6).toFixed(2)} ms`;
  if (ns >= 1e3) return `${(ns / 1e3).toFixed(2)} µs`;
  return `${Math.round(ns)} ns`;
}

/**
 * CPU cycles — a genuinely different physical quantity from wall-clock time,
 * not just a different scale. Verified live: cpu-profile's own weight column
 * (engineering-type "cycle-weight") holds a raw cycle count, e.g. 104884 —
 * feeding that through formatNs() would silently mislabel it "104.88 µs",
 * which is wrong in kind, not just wrong in magnitude (cycles are hardware-
 * invariant; nanoseconds vary with clock speed/throttling — that's the whole
 * reason to reach for cycle-based profiling in the first place). Matches
 * xctrace's own fmt convention for this column (e.g. "104.88 k").
 */
function formatCycles(cycles: number): string {
  if (cycles >= 1e9) return `${(cycles / 1e9).toFixed(2)} B cycles`;
  if (cycles >= 1e6) return `${(cycles / 1e6).toFixed(2)} M cycles`;
  if (cycles >= 1e3) return `${(cycles / 1e3).toFixed(2)} k cycles`;
  return `${Math.round(cycles)} cycles`;
}

/**
 * Matches aggregate.ts's formatValue "bytes" case, for the track-detail
 * (Allocations) call tree — weighted by allocated bytes (the `size`
 * attribute), a third physical quantity distinct from both time and cycles.
 */
function formatBytes(bytes: number): string {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${Math.round(bytes)} B`;
}

/**
 * The three physical quantities a call_tree weight column can hold — resolved
 * once per call_tree() invocation from the column's real engineering-type
 * (schema-table: "cycle-weight" → cycles, anything else → ns) or from the
 * schema's shape (track-detail → bytes), never assumed from the schema name.
 */
type WeightKind = "ns" | "cycles" | "bytes";

function formatWeight(value: number, kind: WeightKind): string {
  switch (kind) {
    case "cycles": return formatCycles(value);
    case "bytes": return formatBytes(value);
    default: return formatNs(value);
  }
}

/**
 * Below this fraction, a windowed call_tree call captured far less CPU time
 * than the window it was scoped to — a judgment call, not a measured
 * threshold, same spirit as SPINE_DOMINANCE_THRESHOLD_PCT.
 */
const WINDOW_CAPTURE_THRESHOLD_PCT = 50;

/**
 * Verified live: call_tree scoped to a 1.88s hitch window returned only 71ms
 * of main-thread CPU — sparse, but NOT evidence that "nothing happened."
 * CPU sampling only captures CPU time; the rest of a windowed duration can
 * be render/GPU work, scheduling delay, or waiting on another thread/
 * process, none of which show up as samples here. Only meaningful for
 * time-based weight (nanoseconds) — comparing a CPU-cycle count to a
 * wall-clock window span would be comparing different physical quantities,
 * the same mistake formatWeight()'s weightKind split already guards
 * against elsewhere in this file.
 */
function windowCaptureNote(
  totalWeight: number,
  weightKind: WeightKind,
  timeRange: { startNs?: number; endNs?: number } | undefined
): string | null {
  if (weightKind) return null;
  if (!timeRange || timeRange.startNs === undefined || timeRange.endNs === undefined) return null;
  const windowNs = timeRange.endNs - timeRange.startNs;
  if (windowNs <= 0) return null;
  const capturedPct = Math.round((totalWeight / windowNs) * 1000) / 10;
  if (capturedPct >= WINDOW_CAPTURE_THRESHOLD_PCT) return null;
  return (
    `Only ${capturedPct}% of this ${formatNs(windowNs)} window was captured as CPU time ` +
    `(${formatNs(totalWeight)}) — the remainder is likely non-CPU latency (render/GPU work, ` +
    "scheduling delay, waiting on another thread), not \"nothing happened here\". A sparse " +
    "sample count in a windowed call_tree does not mean the window was idle."
  );
}

// ─── Tree serialization ───────────────────────────────────────────────────────

function serializeNode(
  node: TreeNode,
  totalWeight: number,
  depth: number,
  maxDepth: number,
  topN: number,
  weightKind: WeightKind
): CallTreeNode {
  const sorted = [...node.children.values()].sort((a, b) => b.totalWeight - a.totalWeight);
  const children: CallTreeNode[] = [];
  let childrenOmitted = 0;

  if (depth < maxDepth) {
    const toShow = sorted.slice(0, topN);
    childrenOmitted = Math.max(0, sorted.length - topN);
    for (const child of toShow) {
      children.push(serializeNode(child, totalWeight, depth + 1, maxDepth, topN, weightKind));
    }
  } else if (sorted.length > 0) {
    childrenOmitted = sorted.length;
  }

  return {
    name: node.name,
    binary: node.binary,
    totalSamples: node.totalSamples,
    selfSamples: node.selfSamples,
    totalWeightFmt: formatWeight(node.totalWeight, weightKind),
    selfWeightFmt: formatWeight(node.selfWeight, weightKind),
    pctOfTotal: totalWeight > 0 ? Math.round((node.totalWeight / totalWeight) * 1000) / 10 : 0,
    ...(isBlockingWaitFrame(node.name, node.selfWeight, node.totalWeight) ? { isWait: true } : {}),
    children,
    ...(childrenOmitted > 0 ? { childrenOmitted } : {}),
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface CallTreeOptions {
  run?: number;
  /**
   * 1-based instance index — only needed when the schema appears multiple
   * times in this run's TOC. Omitting it on an ambiguous schema throws a
   * structured "ambiguous-schema" error listing the available instances.
   */
  position?: number;
  /** Substring filter on thread fmt (e.g. "MyApp" or "0x25cc66"). */
  thread?: string;
  timeRange?: { startNs?: number; endNs?: number };
  /** Max tree depth (default 6). Ignored for view "spine", which always walks to a true leaf. */
  maxDepth?: number;
  /** Max children shown per node ("tree") or max ranked entries returned ("hot"). Ignored for "spine". */
  topN?: number;
  /**
   * "tree" (default): the branching, depth-capped tree — good for browsing
   * structure, but a real hot frame can end up past the depth cap
   * (childrenOmitted) with no signal that the interesting part is missing.
   * "hot": flat list of functions ranked by self-time, summed across every
   * call site — immune to tree truncation entirely, answers "where did the
   * time actually go" directly.
   * "spine": the single heaviest root-to-leaf path, walked with no depth
   * cap — answers "what's the one path that matters" without needing to
   * manually re-derive it from a truncated tree.
   */
  view?: "tree" | "hot" | "spine";
}

/**
 * Shared by both sample sources (schema-table tagged-backtrace and
 * track-detail resolved backtraces) — given an already-accumulated tree +
 * hot-function map, produces the view-specific CallTreeResult. Neither
 * caller needs to know or care how `roots`/`hot` were populated; this is
 * pure serialization + the notes computed from the final shape.
 */
function buildViewResult(
  schema: string,
  run: number,
  view: "tree" | "hot" | "spine",
  thread: string | undefined,
  timeRange: { startNs?: number; endNs?: number } | undefined,
  maxDepth: number,
  topN: number,
  weightKind: WeightKind,
  roots: Map<string, TreeNode>,
  hot: Map<string, HotAccum>,
  totalWeight: number,
  totalSamples: number
): CallTreeResult {
  if (view === "hot") {
    const ranked = [...hot.values()].sort((a, b) => b.selfWeight - a.selfWeight);
    const hotFunctions: HotFunctionEntry[] = ranked.slice(0, topN).map((e) => ({
      name: e.name,
      binary: e.binary,
      selfSamples: e.selfSamples,
      selfWeightFmt: formatWeight(e.selfWeight, weightKind),
      pctSelfOfTotal: totalWeight > 0 ? Math.round((e.selfWeight / totalWeight) * 1000) / 10 : 0,
      totalSamples: e.totalSamples,
      totalWeightFmt: formatWeight(e.totalWeight, weightKind),
      pctTotalOfTotal: totalWeight > 0 ? Math.round((e.totalWeight / totalWeight) * 1000) / 10 : 0,
      ...(isBlockingWaitFrame(e.name, e.selfWeight, e.totalWeight) ? { isWait: true } : {}),
    }));
    const notes: string[] = [];
    if (ranked.length > hotFunctions.length) {
      notes.push(`${ranked.length - hotFunctions.length} additional functions omitted (ranked below top ${topN} by self time).`);
    }
    if (hotFunctions[0]?.isWait) {
      notes.push(
        `The top self-time entry ("${hotFunctions[0].name}") is a known wait/blocking frame — this thread ` +
        "was idle/blocked there, not CPU-bound. Time Profiler shows the wait, not what it's blocked on — " +
        "use System Trace or thread-state instrumentation to find the blocking cause."
      );
    }
    const captureNote = windowCaptureNote(totalWeight, weightKind, timeRange);
    if (captureNote) notes.push(captureNote);
    return {
      schema,
      run,
      totalSamples,
      totalWeightFmt: formatWeight(totalWeight, weightKind),
      threadFilter: thread ?? null,
      view,
      hotFunctions,
      ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
    };
  }

  if (view === "spine") {
    const { frames: spine, divergesAtDepth } = buildSpine(roots, totalWeight);
    const notes: string[] = [];
    if (spine.length === 0) {
      notes.push(`No data found for schema "${schema}" in run ${run}.`);
    } else if (divergesAtDepth !== null) {
      const at = spine[divergesAtDepth];
      notes.push(
        `Spine dominance holds ≥${SPINE_DOMINANCE_THRESHOLD_PCT}% of parent weight through depth ${divergesAtDepth - 1}; ` +
        `at depth ${divergesAtDepth} ("${at.name}", ${at.pctOfParent}% of its parent) the profile branches — ` +
        "frames beyond this point are one branch among several comparable ones, not the whole story."
      );
    }
    const leaf = spine[spine.length - 1];
    if (leaf?.isWait) {
      notes.push(
        `The spine's deepest frame ("${leaf.name}") is a known wait/blocking frame — this thread was ` +
        "idle/blocked there, not CPU-bound. Time Profiler shows the wait, not what it's blocked on — " +
        "use System Trace or thread-state instrumentation to find the blocking cause."
      );
    }
    const appCodeStartsAtDepth = spine.length > 0 ? findAppCodeStartDepth(spine) : null;
    if (appCodeStartsAtDepth !== null) {
      const at = spine[appCodeStartsAtDepth];
      notes.push(
        `Depths 0–${appCodeStartsAtDepth - 1} are standard run-loop/wait scaffolding present in every ` +
        `sample on this thread, idle or busy — carries no signal on its own. This sample's distinguishing ` +
        `work starts at depth ${appCodeStartsAtDepth} ("${at.name}").`
      );
    }
    const captureNote = windowCaptureNote(totalWeight, weightKind, timeRange);
    if (captureNote) notes.push(captureNote);
    return {
      schema,
      run,
      totalSamples,
      totalWeightFmt: formatWeight(totalWeight, weightKind),
      threadFilter: thread ?? null,
      view,
      spine,
      ...(spine.length > 0 ? { appCodeStartsAtDepth } : {}),
      ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
    };
  }

  // Serialize top-N roots sorted by total weight descending.
  const rootsSorted = [...roots.values()].sort((a, b) => b.totalWeight - a.totalWeight);
  const rootsOut: CallTreeNode[] = rootsSorted
    .slice(0, topN)
    .map(r => serializeNode(r, totalWeight, 0, maxDepth, topN, weightKind));

  const rootsOmitted = rootsSorted.length - rootsOut.length;

  // Walk the heaviest-child chain in the SERIALIZED tree (mirrors what an
  // agent would eyeball first) to check whether the depth cap truncated
  // exactly the branch that matters. A GUI main-thread spine is commonly
  // ~15 frames of run-loop boilerplate before any payload frame, so bumping
  // maxDepth and re-fetching is often a wasted round-trip — surface this
  // instead of leaving the agent to discover it the hard way.
  let deepest: CallTreeNode | undefined = rootsOut[0];
  while (deepest?.children.length) deepest = deepest.children[0];
  const notes: string[] = [];
  if (rootsOmitted > 0) {
    notes.push(`${rootsOmitted} additional root frames omitted (filtered to top ${topN}).`);
  }
  if (deepest?.childrenOmitted) {
    notes.push(
      `The heaviest branch's deepest shown frame ("${deepest.name}") has ${deepest.childrenOmitted} ` +
      "children omitted at the maxDepth cap — bumping maxDepth may not help if this is run-loop/dispatch " +
      "boilerplate above the real payload frame; try view: \"hot\" (depth-independent self-time ranking) " +
      "or view: \"spine\" (single dominant path, no depth cap) instead."
    );
  }
  const captureNote = windowCaptureNote(totalWeight, weightKind, timeRange);
  if (captureNote) notes.push(captureNote);

  return {
    schema,
    run,
    totalSamples,
    totalWeightFmt: formatWeight(totalWeight, weightKind),
    threadFilter: thread ?? null,
    view,
    roots: rootsOut,
    ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
  };
}

/**
 * Empty-result shape shared by every early-return branch (no data at all, no
 * usable backtrace column, etc.) across both sample sources.
 */
function emptyCallTreeResult(
  schema: string,
  run: number,
  view: "tree" | "hot" | "spine",
  thread: string | undefined,
  weightUnitLabel: string,
  note: string
): CallTreeResult {
  return {
    schema, run,
    totalSamples: 0,
    totalWeightFmt: `0 ${weightUnitLabel}`,
    threadFilter: thread ?? null,
    view,
    ...(view === "tree" ? { roots: [] } : view === "hot" ? { hotFunctions: [] } : { spine: [] }),
    note,
  };
}

/**
 * Fold a call tree from the ingested SQLite table (PMT:elm-swamp), bounded in
 * memory: AGGREGATE weight + sample count per DISTINCT backtrace_id in SQL
 * first (identical stacks already share a backtrace_id via the frames dedup),
 * then process each distinct stack ONCE — resolving its frames on the spot and
 * letting them GC before the next. This is what keeps the fold bounded to
 * (tree size + one backtrace): the earlier version memoized every unique
 * backtrace's full frame array across the whole fold and OOM'd at ~74K
 * backtraces on a real Allocations trace (found live). Aggregating and folding
 * per distinct stack is arithmetically identical to per-row folding because
 * every accumulation in addSample/addHotSample is additive. Shared by both
 * call_tree sources.
 */
interface FoldResult {
  roots: Map<string, TreeNode>;
  hot: Map<string, HotAccum>;
  totalWeight: number;
  totalSamples: number;
}

function foldFromSql(
  db: DatabaseSync,
  tableName: string,
  weightMnemonic: string,
  btMnemonic: string,
  view: "tree" | "hot" | "spine",
  filters: {
    threadCol?: string | null;
    thread?: string;
    timeCol?: string | null;
    timeRange?: { startNs?: number; endNs?: number };
  } = {}
): FoldResult {
  const roots = new Map<string, TreeNode>();
  const hot = new Map<string, HotAccum>();
  let totalWeight = 0;
  let totalSamples = 0;

  const btIdCol = quoteIdent(`${btMnemonic}__backtrace_id`);
  const conds: string[] = [`${btIdCol} IS NOT NULL`];
  const params: Array<string | number> = [];
  if (filters.threadCol && filters.thread) {
    conds.push(`${quoteIdent(`${filters.threadCol}__fmt`)} LIKE ?`);
    params.push(`%${filters.thread}%`);
  }
  if (filters.timeCol && filters.timeRange) {
    if (filters.timeRange.startNs !== undefined) {
      conds.push(`CAST(${quoteIdent(filters.timeCol)} AS REAL) >= ?`);
      params.push(filters.timeRange.startNs);
    }
    if (filters.timeRange.endNs !== undefined) {
      conds.push(`CAST(${quoteIdent(filters.timeCol)} AS REAL) <= ?`);
      params.push(filters.timeRange.endNs);
    }
  }

  // One (weight, count) per distinct stack — the filters apply per-row BEFORE
  // the grouping, so thread/timeRange scoping stays correct.
  const aggStmt = db.prepare(
    `SELECT ${btIdCol} AS btid, SUM(CAST(${quoteIdent(weightMnemonic)} AS REAL)) AS w, COUNT(*) AS cnt ` +
    `FROM ${quoteIdent(tableName)} WHERE ${conds.join(" AND ")} GROUP BY ${btIdCol}`
  );
  const framesStmt = db.prepare(
    // Frame content is deduped into `symbols` — join to read it (PMT:tidy-warbler).
    "SELECT s.name AS name, s.binary AS binary FROM frames f JOIN symbols s ON f.symbol_id = s.id " +
      "WHERE f.backtrace_id = ? ORDER BY f.frame_index ASC"
  );

  for (const g of aggStmt.iterate(...params) as Iterable<{ btid: number; w: number; cnt: number }>) {
    const weight = Number(g.w);
    if (!isFinite(weight) || weight <= 0) continue;
    const frameRows = framesStmt.all(g.btid) as Array<{ name: string; binary: string | null }>;
    if (frameRows.length === 0) continue;
    // Frames are leaf-first (frame_index 0 = deepest) — reverse for a root-first tree.
    const frames = [];
    for (let i = frameRows.length - 1; i >= 0; i--) {
      frames.push({ name: frameRows[i].name || "?", binary: frameRows[i].binary });
    }
    // Build only what this view consumes (buildViewResult reads `roots` for
    // tree/spine, `hot` for hot) — building both is wasted memory, and the
    // tree is the heavier structure, so skipping it for "hot" matters most.
    if (view === "hot") addHotSample(hot, frames, weight, g.cnt);
    else addSample(roots, frames, weight, g.cnt);
    totalWeight += weight;
    totalSamples += g.cnt;
  }
  return { roots, hot, totalWeight, totalSamples };
}

/** The backtrace column's mnemonic for a schema (isBacktraceCol picks the one the writer stored as __backtrace_id). */
function backtraceMnemonic(cols: SchemaCol[]): string | null {
  return cols.find(isBacktraceCol)?.mnemonic ?? null;
}

/**
 * call_tree for track-detail schemas (Allocations/Allocations List) — weighted
 * by allocated bytes (the schema's pinned primaryWeight, "size") instead of
 * sample duration, folding from the SQLite table (PMT:elm-swamp) the same way
 * the schema-table path does.
 *
 * Supports `timeRange` now that track-detail's timestamp is parsed to numeric
 * ns at ingest (PMT:light-reed) — the filter pushes into foldFromSql's SELECT
 * exactly like the schema-table path. `thread` is still unsupported: an
 * Allocations row's thread is a bare hex `thread-id` (engineering-type
 * "string"), not a "thread"-role column with a display name to substring-match
 * — noted honestly in the response when passed.
 */
async function buildTrackDetailCallTree(
  sessionId: string,
  schema: string,
  run: number,
  position: number | undefined,
  view: "tree" | "hot" | "spine",
  thread: string | undefined,
  timeRange: { startNs?: number; endNs?: number } | undefined,
  maxDepth: number,
  topN: number
): Promise<CallTreeResult> {
  let handle;
  try {
    handle = await getTable(sessionId, run, schema, position);
  } catch (err) {
    if (err instanceof XctraceError && err.kind === "empty-result") {
      return emptyCallTreeResult(schema, run, view, thread, "B", `No data found for schema "${schema}" in run ${run}.`);
    }
    throw err;
  }

  const btMnemonic = backtraceMnemonic(handle.cols);
  if (!btMnemonic) {
    const isLeaks = schema.startsWith("Leaks/");
    return emptyCallTreeResult(
      schema, run, view, thread, "B",
      isLeaks
        ? `Schema "${schema}" has no backtrace column by design — Instruments cross-references leaked ` +
          "objects by address into Allocations/Allocations List for responsible frames instead. Join by " +
          "address (see the Leaks lens's nextActions) rather than calling call_tree on Leaks directly, or " +
          "call call_tree(schema: \"Allocations/Allocations List\") for allocation call trees in general."
        : `Schema "${schema}" has no backtrace column — call_tree needs one to build a tree from.`
    );
  }

  const weightMnemonic = hintFor(schema)?.primaryWeight ?? "size";
  // Time filter pushes into the fold's SELECT (PMT:light-reed) — the timestamp
  // is now a numeric-ns column just like a schema-table time role. thread has
  // no comparable column here, so it's still ignored (noted below).
  const classified = classifyWithHints(schema, handle.cols);
  const timeCol = hintFor(schema)?.primaryTime ?? firstWithRole(classified, "time")?.mnemonic ?? null;
  const db = await getDb(sessionId);
  const { roots, hot, totalWeight, totalSamples } = foldFromSql(
    db, handle.tableName, weightMnemonic, btMnemonic, view,
    { timeCol, timeRange }
  );

  const result = buildViewResult(schema, run, view, thread, timeRange, maxDepth, topN, "bytes", roots, hot, totalWeight, totalSamples);

  if (thread) {
    const filterNote =
      `thread was ignored — not yet supported for track-detail schemas like "${schema}" ` +
      "(an allocation's thread-id is a bare hex value, not a named thread column to match on).";
    result.note = result.note ? `${filterNote} ${result.note}` : filterNote;
  }

  return result;
}

export async function callTree(
  sessionId: string,
  schema: string,
  opts: CallTreeOptions = {}
): Promise<CallTreeResult> {
  const run = opts.run ?? sessionLastRun(sessionId);
  const session = getSession(sessionId);
  const view = opts.view ?? "tree";
  const { maxDepth = 6, thread, timeRange, position } = opts;
  const topN = opts.topN ?? (view === "hot" ? 20 : 8);

  // Track-detail schemas (Allocations/Allocations List) have a completely
  // different XML shape (no <schema>/<col> block, no tagged-backtrace sample
  // tree) — dispatch to the dedicated path instead of building a
  // table[@schema=...] xpath that structurally can't match a track/detail
  // resource. See PMT:spare-cairn.
  const modelEntry = session.schemaModel.find((e) => e.run === run && e.toc.schema === schema);
  if (modelEntry?.source === "track-detail") {
    return buildTrackDetailCallTree(sessionId, schema, run, position, view, thread, timeRange, maxDepth, topN);
  }

  // Ingest via the NORMAL streaming path — no bespoke XML parser anymore
  // (getTable handles the ambiguity guard + position). tagged-backtrace is a
  // backtrace column like any other now (PMT:elm-swamp).
  let handle;
  try {
    handle = await getTable(sessionId, run, schema, position);
  } catch (err) {
    if (err instanceof XctraceError && err.kind === "empty-result") {
      return emptyCallTreeResult(schema, run, view, thread, "ns", `No data found for schema "${schema}" in run ${run}.`);
    }
    throw err;
  }

  const taggedBtCol = handle.cols.find((c) => c.engineeringType === "tagged-backtrace");
  if (!taggedBtCol) {
    // A plain "backtrace"-typed column (distinct from "tagged-backtrace")
    // carries one already-resolved stack per row, not a sample tree to
    // aggregate — get_row already returns it directly, no call_tree needed.
    const hasResolvedBt = handle.cols.some((c) => c.engineeringType === "backtrace");
    return emptyCallTreeResult(
      schema, run, view, thread, "ns",
      hasResolvedBt
        ? `Schema "${schema}" has one resolved backtrace per row, not a sample tree to aggregate — call get_row on a specific row instead of call_tree.`
        : `Schema "${schema}" has no tagged-backtrace column. For Time Profiler, use schema "time-profile" which carries inline symbolicated frames.`
    );
  }

  // Verified live: cpu-profile's weight column is engineering-type
  // "cycle-weight" (raw CPU cycles) — a different physical quantity from
  // time-profile's "weight" (nanoseconds despite the generic type name).
  // Detected from the real column, never assumed from the schema name.
  const weightCol = handle.cols.find((c) => c.mnemonic === "weight");
  const weightKind: WeightKind = weightCol?.engineeringType === "cycle-weight" ? "cycles" : "ns";

  // Thread (substring on fmt) and timeRange (on the primary time column, which
  // for time-profile is the sample-time column) filters push into the SELECT.
  const classified = classifyWithHints(schema, handle.cols);
  const threadCol = handle.cols.find((c) => c.engineeringType === "thread")?.mnemonic ?? null;
  const timeCol = hintFor(schema)?.primaryTime ?? firstWithRole(classified, "time")?.mnemonic ?? null;

  const db = await getDb(sessionId);
  const { roots, hot, totalWeight, totalSamples } = foldFromSql(
    db, handle.tableName, weightCol?.mnemonic ?? "weight", taggedBtCol.mnemonic, view,
    { threadCol, thread, timeCol, timeRange }
  );

  return buildViewResult(schema, run, view, thread, timeRange, maxDepth, topN, weightKind, roots, hot, totalWeight, totalSamples);
}
