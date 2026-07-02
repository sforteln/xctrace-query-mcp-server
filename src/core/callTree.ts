/**
 * callTree — folded call tree from tagged-backtrace columns.
 *
 * The `time-profile` schema carries inline symbolicated call stacks as
 * `<tagged-backtrace>` elements with `<frame name="fn" addr="0x...">` children.
 * Frames are stored LEAF-FIRST (deepest call first), so we reverse them to
 * build a root-to-leaf prefix tree weighted by sample duration (the `weight`
 * column in nanoseconds).
 *
 * The generic `parseTableXml` can't handle `tagged-backtrace` because it uses
 * a global `isArray: () => false` config that collapses repeated `<frame>`
 * siblings. This module uses its own parser config with `isArray` for frame
 * and row arrays.
 *
 * Other schemas: if the schema has no `tagged-backtrace` column we return a
 * structured note suggesting `time-profile` instead.
 */
import { XMLParser } from "fast-xml-parser";
import { exportXPath, buildTableXPath, buildTableXPathAtPosition } from "../engine/xctrace.js";
import { exportToc } from "../engine/xctrace.js";
import { getSession, lastRun as sessionLastRun } from "../engine/session.js";
import { assertUnambiguousSchema } from "../engine/schemaModel.js";

// ─── XML parser ───────────────────────────────────────────────────────────────

const ctParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: (tagName) => tagName === "frame" || tagName === "row" || tagName === "node",
  allowBooleanAttributes: true,
});

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

// ─── Ref/id resolution ────────────────────────────────────────────────────────

type RefCache = Map<number, Record<string, any>>;

/** Recursively register every element with @_id into the cache. */
function registerIds(obj: unknown, cache: RefCache): void {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const item of obj) registerIds(item, cache);
    return;
  }
  const record = obj as Record<string, any>;
  const id = record["@_id"];
  if (id !== undefined) {
    cache.set(Number(id), record);
  }
  for (const key of Object.keys(record)) {
    if (!key.startsWith("@_") && key !== "#text") {
      registerIds(record[key], cache);
    }
  }
}

/** Resolve a node that may be a ref-only placeholder. */
function resolveRef(obj: Record<string, any> | undefined, cache: RefCache): Record<string, any> | null {
  if (!obj) return null;
  const ref = obj["@_ref"];
  if (ref !== undefined) {
    return cache.get(Number(ref)) ?? null;
  }
  return obj;
}

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

function addSample(roots: Map<string, TreeNode>, frames: Array<{ name: string; binary: string | null }>, weight: number): void {
  let level = roots;
  for (let i = 0; i < frames.length; i++) {
    const { name, binary } = frames[i];
    const key = `${name}@${binary ?? "?"}`;
    const node = getOrCreate(level, key, name, binary);
    node.totalWeight += weight;
    node.totalSamples += 1;
    if (i === frames.length - 1) {
      node.selfWeight += weight;
      node.selfSamples += 1;
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
  weight: number
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
    if (!seenThisSample.has(key)) {
      seenThisSample.add(key);
      entry.totalWeight += weight;
      entry.totalSamples += 1;
    }
    if (i === frames.length - 1) {
      entry.selfWeight += weight;
      entry.selfSamples += 1;
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

// ─── Tree serialization ───────────────────────────────────────────────────────

function serializeNode(
  node: TreeNode,
  totalWeight: number,
  depth: number,
  maxDepth: number,
  topN: number
): CallTreeNode {
  const sorted = [...node.children.values()].sort((a, b) => b.totalWeight - a.totalWeight);
  const children: CallTreeNode[] = [];
  let childrenOmitted = 0;

  if (depth < maxDepth) {
    const toShow = sorted.slice(0, topN);
    childrenOmitted = Math.max(0, sorted.length - topN);
    for (const child of toShow) {
      children.push(serializeNode(child, totalWeight, depth + 1, maxDepth, topN));
    }
  } else if (sorted.length > 0) {
    childrenOmitted = sorted.length;
  }

  return {
    name: node.name,
    binary: node.binary,
    totalSamples: node.totalSamples,
    selfSamples: node.selfSamples,
    totalWeightFmt: formatNs(node.totalWeight),
    selfWeightFmt: formatNs(node.selfWeight),
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

  // Export the raw XML for this schema. callTree builds its own xpath rather
  // than going through session.getTable, so it needs its own ambiguity guard.
  let xpath: string;
  if (position !== undefined) {
    xpath = buildTableXPathAtPosition(run, schema, position);
  } else {
    assertUnambiguousSchema(session.schemaModel, run, schema);
    xpath = buildTableXPath(run, schema);
  }
  const xml = await exportXPath(session.tracePath, xpath);

  const doc = ctParser.parse(xml) as Record<string, any>;
  const nodes = asArray<Record<string, any>>(doc?.["trace-query-result"]?.node);

  if (nodes.length === 0) {
    return {
      schema, run,
      totalSamples: 0,
      totalWeightFmt: "0 ns",
      threadFilter: thread ?? null,
      view,
      ...(view === "tree" ? { roots: [] } : view === "hot" ? { hotFunctions: [] } : { spine: [] }),
      note: `No data found for schema "${schema}" in run ${run}.`,
    };
  }

  // Check whether the schema has a tagged-backtrace column.
  const firstSchema = nodes[0].schema as Record<string, any>;
  const cols = asArray<Record<string, any>>(firstSchema?.col);
  const hasTaggedBt = cols.some(c => String(c["engineering-type"] ?? "") === "tagged-backtrace");

  if (!hasTaggedBt) {
    // A plain "backtrace"-typed column (distinct from "tagged-backtrace")
    // carries one already-resolved stack per row, not a sample tree to
    // aggregate — get_row already returns it directly, no call_tree needed.
    const hasResolvedBt = cols.some((c) => String(c["engineering-type"] ?? "") === "backtrace");
    return {
      schema, run,
      totalSamples: 0,
      totalWeightFmt: "0 ns",
      threadFilter: thread ?? null,
      view,
      ...(view === "tree" ? { roots: [] } : view === "hot" ? { hotFunctions: [] } : { spine: [] }),
      note: hasResolvedBt
        ? `Schema "${schema}" has one resolved backtrace per row, not a sample tree to aggregate — call get_row on a specific row instead of call_tree.`
        : `Schema "${schema}" has no tagged-backtrace column. For Time Profiler, use schema "time-profile" which carries inline symbolicated frames.`,
    };
  }

  // Build the call tree (always — "spine" walks it too). "hot" additionally
  // accumulates a path-independent per-function map alongside it, same pass.
  const roots: Map<string, TreeNode> = new Map();
  const hot: Map<string, HotAccum> = new Map();
  let totalWeight = 0;
  let totalSamples = 0;

  for (const node of nodes) {
    const cache: RefCache = new Map();

    for (const rowNode of asArray<Record<string, any>>(node.row)) {
      // Register all id definitions in this row first (forward-ref safety).
      registerIds(rowNode, cache);

      // Weight — skip sentinel rows.
      const weightNode = resolveRef(rowNode.weight as Record<string, any>, cache);
      if (!weightNode || weightNode["@_fmt"] === undefined) continue;
      const weightNs = Number(weightNode["#text"] ?? "0");
      if (!isFinite(weightNs) || weightNs <= 0) continue;

      // Thread filter.
      if (thread) {
        const threadNode = resolveRef(rowNode.thread as Record<string, any>, cache);
        const fmt = threadNode?.["@_fmt"] ?? "";
        if (!fmt.includes(thread)) continue;
      }

      // TimeRange filter on sample-time.
      if (timeRange) {
        const timeNode = resolveRef(rowNode["sample-time"] as Record<string, any>, cache);
        const timeNs = Number(timeNode?.["#text"] ?? "0");
        if (timeRange.startNs !== undefined && timeNs < timeRange.startNs) continue;
        if (timeRange.endNs !== undefined && timeNs > timeRange.endNs) continue;
      }

      // Frames from tagged-backtrace.
      const btNode = resolveRef(rowNode["tagged-backtrace"] as Record<string, any>, cache);
      if (!btNode) continue;
      const frameNodes = asArray<Record<string, any>>(btNode.frame);
      if (frameNodes.length === 0) continue;

      const frames: Array<{ name: string; binary: string | null }> = [];
      for (const fNode of frameNodes) {
        const resolved = resolveRef(fNode, cache);
        if (!resolved) continue;
        const name = resolved["@_name"] ?? "?";
        const binaryNode = resolveRef(resolved.binary as Record<string, any>, cache);
        const binary = binaryNode?.["@_name"] ?? null;
        frames.push({ name, binary });
      }

      if (frames.length === 0) continue;

      // Frames are leaf-first in the XML; reverse for root-first tree.
      frames.reverse();

      addSample(roots, frames, weightNs);
      if (view === "hot") addHotSample(hot, frames, weightNs);
      totalWeight += weightNs;
      totalSamples++;
    }
  }

  if (view === "hot") {
    const ranked = [...hot.values()].sort((a, b) => b.selfWeight - a.selfWeight);
    const hotFunctions: HotFunctionEntry[] = ranked.slice(0, topN).map((e) => ({
      name: e.name,
      binary: e.binary,
      selfSamples: e.selfSamples,
      selfWeightFmt: formatNs(e.selfWeight),
      pctSelfOfTotal: totalWeight > 0 ? Math.round((e.selfWeight / totalWeight) * 1000) / 10 : 0,
      totalSamples: e.totalSamples,
      totalWeightFmt: formatNs(e.totalWeight),
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
    return {
      schema,
      run,
      totalSamples,
      totalWeightFmt: formatNs(totalWeight),
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
    return {
      schema,
      run,
      totalSamples,
      totalWeightFmt: formatNs(totalWeight),
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
    .map(r => serializeNode(r, totalWeight, 0, maxDepth, topN));

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

  return {
    schema,
    run,
    totalSamples,
    totalWeightFmt: formatNs(totalWeight),
    threadFilter: thread ?? null,
    view,
    roots: rootsOut,
    ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
  };
}
