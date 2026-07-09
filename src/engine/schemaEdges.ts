/**
 * Cross-schema connection registry (PMT:rust-gravel) — the ONE codified source
 * for "how does schema A join / anti-join / window / contain schema B", feeding
 * describe_schema's edges+correlation sections, the ruddy-elk inventory
 * correlate-hint, and the lens nudges. Subsumes PMT:azure-forge (the
 * carries-its-own-backtrace-vs-points-elsewhere fact).
 *
 * TWO LAYERS, split by drift-risk (the same auto-derived vs. curated axis
 * aidocs/howHintsWork.md draws everywhere):
 *
 *  - DERIVED (deriveEdges): computed live from role classification, never
 *    stored — any two schemas sharing a primaryTime role are time-window
 *    joinable; sharing a thread role are tid-joinable; both → the tuple
 *    (tid+time) causal join. Version-proof: adding a new time-schema
 *    auto-joins it to every other with zero edits. MUST be order-invariant
 *    (a derivation that picked a join column by POSITION would silently
 *    produce a different join graph per export — the f3203f0 class of bug),
 *    so every column choice goes through a stable value-priority rule
 *    (preferredThreadColumn) or a pinned/lexicographic tie-break, never a
 *    position-dependent first-match.
 *
 *  - CURATED (CURATED_EDGES): the non-derivable facts, referentially guarded
 *    against the committed fixtures — keyed equi-joins (Leaks.address ↔
 *    Allocations.address), NEGATIVE edges (a join that looks plausible but
 *    returns 0 / different id-spaces — hitches.swap-id does NOT join
 *    display-surface-swap.swap-id), and semantic containment / anti-join
 *    edges that pin a meaningful DIRECTION onto a pair that's also
 *    time-window-derivable (runloop turns CONTAIN body evals; a hitch window
 *    with NO running CPU sample is GPU-bound).
 *
 * Directionality is modeled explicitly (see invert): symmetric kinds are
 * self-dual; directional kinds come in dual pairs (contains ↔ contained-by,
 * excludes ↔ excluded-by). Defining invert() per kind is the forcing function
 * that keeps the graph bidirectionally consistent — a curated A→B with no
 * matching B→A view would surface the connection from only one endpoint.
 */
import type { SchemaCol } from "./parseTable.js";
import { classifyWithHints, hintFor } from "./roleHints.js";
import { firstWithRole, preferredThreadColumn, type ClassifiedColumn } from "./roleInference.js";

// ─── Edge model ────────────────────────────────────────────────────────────────

export type EdgeKind =
  // Symmetric — the relationship reads identically from either endpoint (invert = swap endpoints, same kind).
  | "equi"          // A.col == B.col (a keyed join: address; or the derived thread-identity match)
  | "time-window"   // A's [start, start+duration] window vs B's timestamps — shared primaryTime, either side can be the interval
  | "tuple"         // same-thread AND time-window — the causal join ("the same thread did it")
  | "negative"      // A.col does NOT join B.col — a plausible-looking join that's actually a trap
  // Directional — carries a meaningful direction (from = the interval / the container). invert flips endpoints AND kind→dual.
  | "contains"      // A interval CONTAINS B events (correlate exists)
  | "contained-by"  // dual of contains
  | "excludes"      // A interval contains NO B events (anti-join / not-exists)
  | "excluded-by";  // dual of excludes

const SYMMETRIC_KINDS: ReadonlySet<EdgeKind> = new Set<EdgeKind>(["equi", "time-window", "tuple", "negative"]);

/** One join-column correspondence. For tuple edges `on` has two pairs (thread, then time). */
export interface EdgeColumnPair {
  fromCol: string;
  toCol: string;
}

/** A resolved edge — what deriveEdges / connectionsFor return, `on` always filled. */
export interface SchemaEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  layer: "derived" | "curated";
  /** Join column pairs, resolved. equi/negative: the keyed pair(s). time-window/contains/excludes: the two primaryTime cols. tuple: [threadPair, timePair]. */
  on: EdgeColumnPair[];
  /** AI-facing one-liner. Authored for a curated edge's canonical direction; regenerated generically when inverted (see invert). */
  note: string;
}

// ─── invert ──────────────────────────────────────────────────────────────────

const DUAL: Record<EdgeKind, EdgeKind> = {
  equi: "equi", "time-window": "time-window", tuple: "tuple", negative: "negative",
  contains: "contained-by", "contained-by": "contains",
  excludes: "excluded-by", "excluded-by": "excludes",
};

/**
 * The relationship viewed from the OTHER endpoint. Symmetric kinds swap
 * endpoints only; directional kinds swap endpoints AND flip the kind to its
 * dual. The note is structural, not prose-inverted — a directional inverted
 * edge gets a generic "(inverse of …)" wrapper, since a curated prose note
 * ("runloop turns contain body evals") doesn't cleanly reverse. The drift
 * guards check STRUCTURAL bidirectional consistency (endpoints + kind + cols),
 * never note equality.
 */
export function invert(edge: SchemaEdge): SchemaEdge {
  const invertedKind = DUAL[edge.kind];
  return {
    from: edge.to,
    to: edge.from,
    kind: invertedKind,
    layer: edge.layer,
    on: edge.on.map((p) => ({ fromCol: p.toCol, toCol: p.fromCol })),
    note: SYMMETRIC_KINDS.has(edge.kind) ? edge.note : `(inverse of ${edge.from}→${edge.to}) ${edge.note}`,
  };
}

// ─── Role resolution (order-invariant) ──────────────────────────────────────────

/**
 * The primary time column — mirrors relate.ts's primaryTime EXACTLY (same
 * `hintFor(schema)?.primaryTime ?? firstWithRole(classified,"time")` logic),
 * kept inline so this stays a pure module (no SQL-engine import). Exported so
 * a drift guard can assert it never diverges from relate.primaryTime.
 * Deterministic ONLY when either a primaryTime is pinned, or the schema has ≤1
 * time-role column; an unpinned multi-time schema would make this
 * position-dependent, which the order-invariance guard is specifically built
 * to catch (fix = pin it in roleHints).
 */
export function edgeTimeColumn(schema: string, cols: SchemaCol[]): string | null {
  const classified = classifyWithHints(schema, cols);
  return hintFor(schema)?.primaryTime ?? firstWithRole(classified, "time")?.mnemonic ?? null;
}

interface Resolved {
  schema: string;
  time: string | null;
  thread: string | null;
}

function resolve(schema: string, cols: SchemaCol[]): Resolved {
  const classified = classifyWithHints(schema, cols);
  return {
    schema,
    time: edgeTimeColumn(schema, cols),
    thread: preferredThreadColumn(classified)?.mnemonic ?? null,
  };
}

/**
 * True when this schema carries its OWN backtrace in SOME form (a backtrace-
 * role column, of ANY engineering-type) vs. merely points at work living
 * elsewhere (join to get the stack) — PMT:azure-forge, folded in. A per-schema
 * NODE property, derived from classification, so it's version-proof and needs
 * no curated list.
 *
 * Deliberately does NOT distinguish foldable (tagged-backtrace, a per-sample
 * stack call_tree aggregates across many rows) from resolved-per-row (a plain
 * "backtrace" column — ONE already-symbolicated stack per row, e.g.
 * core-data-fetch/fault/save, syscall). Both are real, useful backtraces for
 * THIS purpose — "does correlating INTO this schema get you a stack to read
 * at all" — so this stays the broad check for that caller (queryHints.ts's
 * sibling-search: any backtrace-carrying sibling is worth joining to). Use
 * {@link carriesFoldableBacktrace} instead when the question is specifically
 * "can call_tree fold this schema's OWN backtrace column" — conflating the
 * two produced a real, verified-live wrong hint (PMT:onyx-spark's SwiftUI ×
 * Core Data retrospective): queryHints told an agent to "call_tree this
 * schema directly" for core-data-fetch, which actually returns 0 samples
 * with "use get_row instead" — call_tree itself already gets this right
 * (src/core/callTree.ts checks engineering-type "tagged-backtrace"
 * specifically); queryHints just wasn't asking the same question.
 */
export function carriesOwnBacktrace(schema: string, cols: SchemaCol[]): boolean {
  return classifyWithHints(schema, cols).some((c) => c.roleInfo.role === "backtrace");
}

/**
 * True only when this schema has a FOLDABLE backtrace — engineering-type
 * "tagged-backtrace" specifically, the per-sample-stack shape call_tree
 * aggregates across many rows into a tree/hot-list/spine. False for a schema
 * whose backtrace is a single already-resolved stack per row (engineering-
 * type "backtrace"/"text-backtrace") — that kind answers via get_row(rowIndex)
 * directly, and call_tree on it returns 0 samples (see the exact check this
 * mirrors: src/core/callTree.ts's `taggedBtCol` lookup). This is the
 * discriminator queryHints.ts's "call_tree this schema directly" recommendation
 * needs — carriesOwnBacktrace alone is NOT enough (see its own doc comment).
 */
export function carriesFoldableBacktrace(schema: string, cols: SchemaCol[]): boolean {
  return cols.some((c) => c.engineeringType === "tagged-backtrace");
}

// ─── Derived layer ───────────────────────────────────────────────────────────

/**
 * Recompute the derived edges among a set of schemas. Order-invariant by
 * construction: each edge is emitted in a CANONICAL direction (from = the
 * lexicographically smaller schema name) and column pairs are assigned by that
 * same canonical order, so the returned edge SET is identical under any
 * permutation of the input schemas or of the columns within each schema
 * (columns only reach this via preferredThreadColumn's value-priority rule and
 * edgePrimaryTime, both position-free for pinned/single-role schemas).
 */
export function deriveEdges(schemas: Array<{ schema: string; cols: SchemaCol[] }>): SchemaEdge[] {
  const resolved = schemas.map((s) => resolve(s.schema, s.cols));
  const edges: SchemaEdge[] = [];

  for (let i = 0; i < resolved.length; i++) {
    for (let j = i + 1; j < resolved.length; j++) {
      // Canonical: `a` is the lexicographically smaller schema name.
      const [a, b] = resolved[i].schema < resolved[j].schema ? [resolved[i], resolved[j]] : [resolved[j], resolved[i]];
      const sharedTime = a.time !== null && b.time !== null;
      const sharedThread = a.thread !== null && b.thread !== null;

      if (sharedTime) {
        edges.push({
          from: a.schema, to: b.schema, kind: "time-window", layer: "derived",
          on: [{ fromCol: a.time!, toCol: b.time! }],
          note: `Both carry a time column — window-join ${a.schema}'s [start, start+duration] against ${b.schema}'s ${b.time} timestamps (correlate/relate time-range). Either side can be the interval.`,
        });
      }
      if (sharedThread && sharedTime) {
        edges.push({
          from: a.schema, to: b.schema, kind: "tuple", layer: "derived",
          on: [{ fromCol: a.thread!, toCol: b.thread! }, { fromCol: a.time!, toCol: b.time! }],
          note: `Same-thread AND time-window — the causal join (matchThread:true) that turns "co-occurred" into "the same thread did it". Falls back to the plain time-window (matchThread:false) if the thread identity strings don't align.`,
        });
      } else if (sharedThread) {
        edges.push({
          from: a.schema, to: b.schema, kind: "equi", layer: "derived",
          on: [{ fromCol: a.thread!, toCol: b.thread! }],
          note: `Share a thread identity — joinable on it, but a thread persists the whole trace, so this is a weak join alone; usually only meaningful combined with a time window.`,
        });
      }
    }
  }
  return edges;
}

// ─── Curated layer ─────────────────────────────────────────────────────────────

/**
 * A curated edge as AUTHORED — stored in one canonical direction. `onKeys` is
 * present ONLY for keyed kinds (equi/negative), whose columns are fixed and
 * referentially guarded against the fixtures; directional/window kinds resolve
 * their columns from primaryTime at query time (kind-consistency-guarded
 * instead). `recovery` marks a pair worth a re-record suggestion when the
 * absent sibling's domain shows up in evidence (see connectionsFor / matchRecovery).
 */
interface CuratedEdgeDef {
  from: string;
  to: string;
  kind: EdgeKind;
  note: string;
  /** Fixed join columns — equi/negative only. Referentially guarded. */
  onKeys?: EdgeColumnPair[];
  /** Absent-sibling recovery metadata: how to get this data if the `to` schema isn't in the trace. */
  recovery?: { reRecordType: string; domainHints: string[] };
}

/**
 * The curated registry. Every schema named here MUST have a committed fixture
 * (the coverage gate — you can't reference-check an edge for a schema you
 * haven't fixtured); tests/driftGuard.test.ts enforces it. Authored in one
 * canonical direction; connectionsFor surfaces the inverse view automatically.
 */
export const CURATED_EDGES: readonly CuratedEdgeDef[] = [
  // Leaks carries NO backtrace of its own — its responsible frames come from
  // Allocations by an address equi-join (the canonical azure-forge "points at
  // the work elsewhere" example).
  {
    from: "Leaks/Leaks", to: "Allocations/Allocations List", kind: "equi",
    onKeys: [{ fromCol: "address", toCol: "address" }],
    note: `Leaks has no backtrace of its own — join a leaked object's address to Allocations/Allocations List (equality) to get its responsible allocation frames.`,
    recovery: { reRecordType: "leaks-backtraces", domainHints: [] },
  },
  // THE swap-id gotcha (scratchpad 054 #2): different id-spaces, a 0-row join
  // that reads as "no presentation." Steer to the time-window join instead.
  {
    from: "hitches", to: "display-surface-swap", kind: "negative",
    onKeys: [{ fromCol: "swap-id", toCol: "swap-id" }],
    note: `hitches.swap-id and display-surface-swap.swap-id are DIFFERENT id-spaces — joining them on swap-id returns 0 rows, which is NOT "no presentation." Use a time-window correlate (hitch [start,duration] ↔ displayed-surfaces-interval), or hitches-renders ↔ displayed-surfaces-interval on surface-id.`,
  },
  // The display-name string vs the numeric display-id: another different-id-space trap.
  {
    from: "hitches", to: "device-display-info", kind: "negative",
    onKeys: [{ fromCol: "display", toCol: "display-id" }],
    note: `hitches.display is a "Display N" STRING; device-display-info.display-id is a numeric id — they do NOT join directly. Match on the shared "Display N" string form (display-vsyncs-interval / displayed-surfaces-interval carry it as display-name) instead.`,
  },
  // The real working surface-id equi-join the swap-id gotcha steers toward.
  {
    from: "hitches-renders", to: "displayed-surfaces-interval", kind: "equi",
    onKeys: [{ fromCol: "surface-id", toCol: "surface-id" }],
    note: `hitches-renders and displayed-surfaces-interval share a real surface-id key (equality) — join to map render passes to on-screen surface presentations. (Unlike swap-id, which does NOT join across the hitches/display-swap boundary.)`,
  },
  // Semantic CONTAINMENT — runloop turns contain body evals (the
  // runloopContainsBodyEval detector's edge). Both share primaryTime so a
  // time-window edge is also derivable; this pins the meaningful direction.
  {
    from: "runloop-intervals", to: "swiftui-updates", kind: "contains",
    note: `A main-thread "Busy" runloop turn's window CONTAINS SwiftUI view-body evaluations — correlate (exists) to test whether SwiftUI re-evaluation is what's keeping the main thread busy. (runloopContainsBodyEval encodes this as a cost-gated detector.)`,
    recovery: { reRecordType: "swiftui", domainHints: ["View Body", "AttributeGraph", "SwiftUI", "body"] },
  },
  // Semantic ANTI-JOIN — a hitch window with NO running CPU sample is
  // GPU/compositor-bound (the hitchCauseSplit detector's edge).
  {
    from: "hitches", to: "time-sample", kind: "excludes",
    note: `A hitch [start,duration] window that CONTAINS NO running CPU sample (anti-join / not-exists) is GPU/compositor-bound, not main-thread compute-bound — the absence IS the finding. (hitchCauseSplit encodes this.) When samples DO fall inside, correlate (exists) to see the on-CPU work.`,
    recovery: { reRecordType: "hitches", domainHints: [] },
  },
  // Cross-domain recovery: SwiftUI work that faults through Core Data — if a
  // CoreData frame shows up in a SwiftUI backtrace but Data Persistence wasn't
  // recorded, that's the trigger to suggest a re-record.
  {
    from: "swiftui-updates", to: "core-data-fetch", kind: "time-window",
    note: `SwiftUI view updates can trigger Core Data fetches on the same thread within the update window — correlate to attribute a fetch storm to the view that drove it (the still-pine causal story).`,
    recovery: { reRecordType: "core-data", domainHints: ["CoreData", "NSManagedObject", "fetchRequest", "NSFetchRequest", "executeFetchRequest", "SwiftData", "PersistentContainer"] },
  },
];

// ─── TOC-scoped query ──────────────────────────────────────────────────────────

/** An absent-sibling edge kept latent until in-hand evidence makes it relevant. */
export interface RecoveryEdge {
  /** The schema NOT present in this trace, whose data the edge would connect to. */
  absentSchema: string;
  /** The `type` to pass start_recording to capture it. */
  reRecordType: string;
  /** Symbol/frame substrings whose appearance in a backtrace triggers the suggestion. */
  domainHints: string[];
  /** The re-record suggestion, phrased for the caller. */
  note: string;
}

export interface Connections {
  /** Resolved edges from `schema` to each PRESENT sibling — derived ∪ curated, curated shadowing a redundant derived edge for the same pair. */
  edges: SchemaEdge[];
  /** Absent-sibling edges, LATENT — surface one only when matchRecovery finds an in-hand trigger, never always-on. */
  latentRecovery: RecoveryEdge[];
}

/** Resolve a curated edge's columns against present schemas' cols (keyed edges use onKeys as-is; window/directional resolve both primaryTime cols). */
function resolveCurated(def: CuratedEdgeDef, colsBySchema: Map<string, SchemaCol[]>): SchemaEdge | null {
  if (def.onKeys) {
    return { from: def.from, to: def.to, kind: def.kind, layer: "curated", on: def.onKeys, note: def.note };
  }
  const fromCols = colsBySchema.get(def.from);
  const toCols = colsBySchema.get(def.to);
  if (!fromCols || !toCols) return null;
  const fromTime = edgeTimeColumn(def.from, fromCols);
  const toTime = edgeTimeColumn(def.to, toCols);
  if (!fromTime || !toTime) return null;
  return { from: def.from, to: def.to, kind: def.kind, layer: "curated", on: [{ fromCol: fromTime, toCol: toTime }], note: def.note };
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a} ${b}` : `${b} ${a}`;
}

/**
 * Every connection FROM `schema` given the schemas actually present in the
 * trace. Curated edges are surfaced from `schema`'s perspective (inverted when
 * `schema` is the curated edge's `to`) and SHADOW a redundant derived edge for
 * the same schema-pair (the curated one is richer — a keyed key, a negative
 * warning, a pinned direction). Absent curated siblings become latent recovery
 * candidates (not returned as edges — they're not joinable now).
 */
export function connectionsFor(
  schema: string,
  present: Array<{ schema: string; cols: SchemaCol[] }>
): Connections {
  const presentNames = new Set(present.map((p) => p.schema));
  const colsBySchema = new Map(present.map((p) => [p.schema, p.cols] as const));
  if (!presentNames.has(schema)) {
    // Caller passed a schema not in `present`; nothing to scope against.
    return { edges: [], latentRecovery: [] };
  }

  // Curated edges touching `schema`, oriented from its side, for present siblings.
  const curatedEdges: SchemaEdge[] = [];
  const latentRecovery: RecoveryEdge[] = [];
  const curatedPairs = new Set<string>();

  for (const def of CURATED_EDGES) {
    const touchesFrom = def.from === schema;
    const touchesTo = def.to === schema;
    if (!touchesFrom && !touchesTo) continue;
    const other = touchesFrom ? def.to : def.from;

    if (!presentNames.has(other)) {
      // Absent sibling → a latent recovery candidate (only when there's re-record metadata).
      if (def.recovery && touchesFrom) {
        latentRecovery.push({
          absentSchema: other,
          reRecordType: def.recovery.reRecordType,
          domainHints: def.recovery.domainHints,
          note: `${other} is not in this trace. If you hit a dead end here whose cause looks like it lives in ${other}'s domain, that's worth re-recording with type: "${def.recovery.reRecordType}" (compose it alongside the current instruments).`,
        });
      }
      continue;
    }
    const resolved = resolveCurated(def, colsBySchema);
    if (!resolved) continue;
    curatedEdges.push(touchesFrom ? resolved : invert(resolved));
    curatedPairs.add(pairKey(def.from, def.to));
  }

  // Derived edges among all present schemas, then keep those touching `schema`,
  // oriented from its side, and DROP any pair a curated edge already covers.
  const derived = deriveEdges(present);
  const derivedEdges: SchemaEdge[] = [];
  for (const e of derived) {
    if (e.from !== schema && e.to !== schema) continue;
    if (curatedPairs.has(pairKey(e.from, e.to))) continue;
    derivedEdges.push(e.from === schema ? e : invert(e));
  }

  return { edges: [...curatedEdges, ...derivedEdges], latentRecovery };
}

/**
 * Filter latent recovery candidates to those actually triggered by in-hand
 * evidence — a symbol/frame substring from the absent schema's domain appearing
 * in a backtrace being read (case-insensitive). Keeps the "worth another run"
 * suggestion LATENT (never noise on every schema) and EVIDENCE-triggered.
 */
export function matchRecovery(latent: RecoveryEdge[], evidenceText: string): RecoveryEdge[] {
  const hay = evidenceText.toLowerCase();
  return latent.filter((r) => r.domainHints.some((h) => hay.includes(h.toLowerCase())));
}
