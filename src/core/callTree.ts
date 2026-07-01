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
}

export interface CallTreeResult {
  schema: string;
  run: number;
  totalSamples: number;
  totalWeightFmt: string;
  threadFilter: string | null;
  roots: CallTreeNode[];
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
  /** Max tree depth (default 6). */
  maxDepth?: number;
  /** Max children shown per node (default 8). */
  topN?: number;
}

export async function callTree(
  sessionId: string,
  schema: string,
  opts: CallTreeOptions = {}
): Promise<CallTreeResult> {
  const run = opts.run ?? sessionLastRun(sessionId);
  const session = getSession(sessionId);
  const { maxDepth = 6, topN = 8, thread, timeRange, position } = opts;

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
      roots: [],
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
      roots: [],
      note: hasResolvedBt
        ? `Schema "${schema}" has one resolved backtrace per row, not a sample tree to aggregate — call get_row on a specific row instead of call_tree.`
        : `Schema "${schema}" has no tagged-backtrace column. For Time Profiler, use schema "time-profile" which carries inline symbolicated frames.`,
    };
  }

  // Build the call tree.
  const roots: Map<string, TreeNode> = new Map();
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
      totalWeight += weightNs;
      totalSamples++;
    }
  }

  // Serialize top-N roots sorted by total weight descending.
  const rootsSorted = [...roots.values()].sort((a, b) => b.totalWeight - a.totalWeight);
  const rootsOut: CallTreeNode[] = rootsSorted
    .slice(0, topN)
    .map(r => serializeNode(r, totalWeight, 0, maxDepth, topN));

  const rootsOmitted = rootsSorted.length - rootsOut.length;

  return {
    schema,
    run,
    totalSamples,
    totalWeightFmt: formatNs(totalWeight),
    threadFilter: thread ?? null,
    roots: rootsOut,
    ...(rootsOmitted > 0 ? { note: `${rootsOmitted} additional root frames omitted (filtered to top ${topN}).` } : {}),
  };
}
