/**
 * Detector surfacing — turn fired cheap detectors into ranked nextActions.
 * This also implements the EAGER bounded-schema sweep: at
 * stop_recording (nothing ingested yet) and open_trace on a cold trace, the
 * old detectorNextActions() below always returned [] — its own doc comment
 * admitted it ("Empty when nothing is ingested yet"). eagerSweep() fixes the
 * exact moment the user most wants "here's what I found": it eager-ingests a
 * small CURATED allowlist of schemas that are bounded BY NAME (never probed —
 * see eagerSchemas.ts's header for why no cheap size probe exists), then runs
 * EVERY detector (cheap AND expensive) whose requiredSchemas are now ingested
 * — an "expensive" p95/p99 scan over a bounded ~800-row table runs in ms; the
 * `expensive` flag exists to keep a scan off a firehose, not off a bounded
 * table. It also returns an annotated inventory of every present schema so
 * the AI can reason over what else is there, and a clean-sweep note so "swept
 * and found nothing alarming" is always distinguishable from silence.
 */
import type { DatabaseSync } from "node:sqlite";
import type { NextAction } from "../core/response.js";
import { getDb, getSession, getTable, lastRun } from "../engine/session.js";
import { hintFor, type SchemaHint } from "../engine/roleHints.js";
import { quoteIdent } from "../engine/sqliteStore.js";
import { DETECTORS } from "./index.js";
import { runCheapDetectors, runDetectorsOverIngested } from "./framework.js";
import { resolveFrameBudgetMs } from "./frameBudget.js";
import { EAGER_ALLOWLIST, EAGER_SCHEMA_MAX, isBoundedKind, kindDescriptor, schemaKind, selectEagerSchemas, type SchemaKind } from "./eagerSchemas.js";
import type { Detector, DetectorContext, RankedFinding } from "./types.js";

/** Verbs whose tool takes a single `schema` arg (vs relate/timeline's own schema params). */
const SINGLE_SCHEMA_VERBS = new Set(["query", "aggregate", "find", "call_tree"]);

/** Map a fired finding's re-runnable callSpec to a NextAction the AI can invoke. */
export function findingToNextAction(f: RankedFinding, sessionId: string): NextAction {
  const schemaArg = SINGLE_SCHEMA_VERBS.has(f.callSpec.verb) ? { schema: f.callSpec.schema } : {};
  return {
    tool: f.callSpec.verb,
    args: { sessionId, ...schemaArg, ...f.callSpec.args },
    description: `Detector — ${f.summary}  [fired: ${f.criterion}; severity ${f.severity}]. Tweak the args and re-run to explore.`,
  };
}

/** Fired-detector nextActions over this session's already-ingested tables. */
export async function detectorNextActions(sessionId: string): Promise<NextAction[]> {
  let db;
  try {
    db = await getDb(sessionId);
  } catch {
    return [];
  }
  let rows: Array<{ table_name: string }>;
  try {
    rows = db.prepare("SELECT DISTINCT table_name FROM _ingested_schema").all() as Array<{ table_name: string }>;
  } catch {
    return []; // no ingested tables yet
  }
  if (rows.length === 0) return [];

  // A schema name maps to its physical (run:schema) table; keep the first seen.
  const schemaToTable = new Map<string, string>();
  for (const r of rows) {
    const schema = r.table_name.replace(/^\d+:/, "");
    if (!schemaToTable.has(schema)) schemaToTable.set(schema, r.table_name);
  }

  const ctx: DetectorContext = {
    db,
    sessionId,
    run: lastRun(sessionId),
    tableName: (schema) => schemaToTable.get(schema) ?? schema,
  };
  const ranked = runCheapDetectors(DETECTORS, ctx, new Set(schemaToTable.keys()));
  return ranked.map((f) => findingToNextAction(f, sessionId));
}

// ─── Annotated schema inventory ────────────────────────────────────────────────

/** One compact line per present schema — the annotated inventory returned by
 *  open_trace and stop_recording. Bounded by schema COUNT (dozens at most),
 *  never row count; no full finding detail (that stays behind the nextStep
 *  drill-down). One narrow, deliberate exception: `topColumns` (below) — up
 *  to 5 mnemonics, only for bounded-kind schemas with a pinned hint, a free
 *  static lookup rather than a live describe_schema round-trip. Column lists
 *  in general still stay out of the inventory; this is a name allowlist, not
 *  the schema's full description. */
export interface SchemaInventoryEntry {
  name: string;
  /** Ingested this session (a fresh fetch, or a zero-cost reuse of a
   *  ruby-peak-cached table) — the CHEAPEST correlate/relate anchor. */
  warm: boolean;
  /** Exact row count when warm; null otherwise (never a live-but-uncounted number). */
  count: number | null;
  /** Human-readable size: the exact count when warm, else a "~estimate (kind)" tier. */
  countLabel: string;
  kind: SchemaKind;
  /** "fired N" / "clean" — present only when this schema was actually swept
   *  (i.e. ingested AND covered by at least one detector that ran). */
  detectorResult?: string;
  correlateHint: "carries-own-backtrace" | "needs-join/correlate";
  /** No-silent-cap note for anything not warm — so "no finding" here never
   *  silently reads as "no problem" for a schema that was simply skipped. */
  scanNote?: string;
  /** Up to 5 column mnemonics, present only for diagnosed/metadata (bounded)
   *  schemas — a static lookup from the pinned roleHints map, zero query
   *  cost. A curated "synthetic diagnosis table" schema (detected-fs-
   *  antipattern, hitches, ...) has non-guessable column names, and a cold
   *  analyst otherwise pays a full describe_schema round-trip just to learn
   *  them before the first real query (field finding: PMT-review of a File
   *  Activity audit session hit this exact friction). Omitted for anything
   *  not bounded-kind or with no pinned hint — never a guess. */
  topColumns?: string[];
}

/** correlateHint = a simplified, buildable-today check: a schema carries its
 *  own backtrace if its pinned role-hint map (roleHints.ts) declares a
 *  role==="backtrace" column; otherwise it needs a join/correlate to reach
 *  one. A fuller version — keyed to each schema's live-verified backtrace
 *  shape instead of the pinned map — is known future work, not built here. */
function correlateHintFor(schema: string): SchemaInventoryEntry["correlateHint"] {
  const hint = hintFor(schema);
  const carriesBacktrace = hint ? Object.values(hint.columns).some((c) => c.role === "backtrace") : false;
  return carriesBacktrace ? "carries-own-backtrace" : "needs-join/correlate";
}

/** First 5 pinned column mnemonics for a bounded-kind (diagnosed/metadata)
 *  schema, or undefined when there's no pinned hint to draw from (never
 *  falls back to a guess). */
function topColumnsFor(schema: string): string[] | undefined {
  if (!isBoundedKind(schema)) return undefined;
  const hint: SchemaHint | undefined = hintFor(schema);
  if (!hint) return undefined;
  const names = Object.keys(hint.columns).slice(0, 5);
  return names.length > 0 ? names : undefined;
}

/** For every detector whose requiredSchemas are fully ingested, tally how
 *  many touched each schema and how many of those fired — the basis for each
 *  inventory line's `detectorResult`. */
function schemaDetectorOutcomes(
  detectors: readonly Detector[],
  ingestedSchemas: ReadonlySet<string>,
  ranked: readonly RankedFinding[]
): Map<string, { ran: number; fired: number }> {
  const firedIds = new Set(ranked.map((f) => f.detectorId));
  const outcomes = new Map<string, { ran: number; fired: number }>();
  for (const d of detectors) {
    if (!d.requiredSchemas.every((s) => ingestedSchemas.has(s))) continue;
    for (const s of d.requiredSchemas) {
      const cur = outcomes.get(s) ?? { ran: 0, fired: 0 };
      cur.ran += 1;
      if (firedIds.has(d.id)) cur.fired += 1;
      outcomes.set(s, cur);
    }
  }
  return outcomes;
}

/**
 * Build the annotated inventory for every distinct schema present in
 * `instruments`. Decoupled from TraceSession (only the {schema, rowCount}
 * shape it needs) so it's directly unit-testable without a live session.
 */
export function buildSchemaInventory(
  instruments: ReadonlyArray<{ schema: string; rowCount: number | null }>,
  ingestedSchemas: ReadonlySet<string>,
  ranked: readonly RankedFinding[]
): SchemaInventoryEntry[] {
  const outcomes = schemaDetectorOutcomes(DETECTORS, ingestedSchemas, ranked);
  const seen = new Set<string>();
  const entries: SchemaInventoryEntry[] = [];

  for (const inst of instruments) {
    if (seen.has(inst.schema)) continue; // one line per schema even if it appears multiple times (ambiguous positions)
    seen.add(inst.schema);

    const kind = schemaKind(inst.schema);
    const warm = inst.rowCount !== null;
    const outcome = outcomes.get(inst.schema);
    const topColumns = topColumnsFor(inst.schema);

    entries.push({
      name: inst.schema,
      warm,
      count: warm ? inst.rowCount : null,
      countLabel: warm ? String(inst.rowCount) : `~estimate (${kindDescriptor(kind)})`,
      kind,
      ...(outcome ? { detectorResult: outcome.fired > 0 ? `fired ${outcome.fired}` : "clean" } : {}),
      correlateHint: correlateHintFor(inst.schema),
      ...(warm ? {} : { scanNote: `present, not auto-scanned (${kindDescriptor(kind)}); open to run its detector.` }),
      ...(topColumns ? { topColumns } : {}),
    });
  }
  return entries;
}

/**
 * The clean-sweep-reports-negatives note: even when nothing fires, say what
 * was swept and that it came back clean — a clean sweep is DIRECTION (look
 * elsewhere), never silence. Best-effort narrative only (never throws) — a
 * missing detail just shortens the note, it never breaks the sweep.
 */
export function buildSweepNote(
  ctx: DetectorContext,
  sweptSchemas: readonly string[],
  ranked: readonly RankedFinding[]
): string {
  const schemaList = sweptSchemas.join(", ");
  if (ranked.length > 0) {
    const names = ranked.map((f) => f.detectorId).join(", ");
    return `Swept ${schemaList} — ${ranked.length} finding${ranked.length === 1 ? "" : "s"} fired (${names}); see the recommended nextStep.`;
  }

  let detail = "";
  if (sweptSchemas.includes("hitches")) {
    try {
      const table = ctx.tableName("hitches");
      const count = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)}`).get() as { n: number }).n;
      const budget = resolveFrameBudgetMs(ctx);
      const accuracy =
        budget.source === "device-display-info" ? ` (device-accurate @${Math.round(1000 / budget.budgetMs)}Hz)` : "";
      detail = ` — ${count} hitch${count === 1 ? "" : "es"}${accuracy}, none over 2× budget; no severe frame drops`;
    } catch {
      // best-effort narrative only — the note is directional, not load-bearing
    }
  }
  return `Swept ${schemaList}${detail}; clean — no findings crossed a threshold.`;
}

// ─── The eager sweep itself ────────────────────────────────────────────────────

export interface EagerSweepResult {
  /** The single top-ranked fired finding, as a re-runnable NextAction — or
   *  null when nothing fired (never fabricate a ranking). */
  recommended: NextAction | null;
  /** Remaining fired findings, unranked-relative-to-recommended but still in
   *  score order, for the caller to fold into its own alternatives list. */
  alternatives: NextAction[];
  /** Every present schema, one compact line each — unranked reference. */
  inventory: SchemaInventoryEntry[];
  /** Clean-sweep-reports-negatives note; null only when nothing was actually
   *  eager-ingested this pass (e.g. none of the allowlisted schemas are
   *  present in this trace at all). */
  sweepNote: string | null;
  /** Every schema this session currently has ingested (the eager set just
   *  ingested, union anything already warm from a prior fetch/ruby-peak reuse). */
  ingestedSchemas: string[];
}

/**
 * Eager-ingest the curated bounded allowlist (EAGER_ALLOWLIST, capped at
 * EAGER_SCHEMA_MAX) for the session's last run, then run EVERY detector
 * (cheap and expensive) whose schemas are now ingested, and build the
 * annotated inventory + clean-sweep note. Called from both open_trace (cold
 * OR warm) and stop_recording (always cold) — a warm re-open of a
 * ruby-peak-cached trace pays zero extra ingest cost for schemas already on
 * disk (getTable's own reuse path), so this stays fast there too.
 */
export async function eagerSweep(sessionId: string): Promise<EagerSweepResult> {
  const session = getSession(sessionId);
  const run = lastRun(sessionId);
  const presentSchemas = session.instruments.filter((i) => i.run === run).map((i) => i.schema);

  // Step 1 — eager-ingest the bounded allowlist so the sweep has something to
  // bootstrap from even on a stone-cold trace. A schema present in the TOC
  // but not actually fetchable this time (ambiguous position, a transient
  // export hiccup) must never break the sweep — it just won't end up warm.
  //
  // Fired concurrently via Promise.all, not a sequential for-await loop —
  // measured live (PMT:lark-buck): each xctrace export subprocess pays a
  // fixed ~15-17s startup cost before a single byte arrives, which dominates
  // wall time for a set of small/cheap schemas like this allowlist, and
  // concurrent xctrace subprocesses against the same trace do NOT contend
  // (see session.ts's getTable, which already exploits this for
  // relate()/correlate()). getTable's own chain bookkeeping
  // (sessionIngestChain) is updated synchronously before its first real
  // await, so calling it here for every schema without awaiting in between
  // still correctly serializes only the shared-connection WRITE step, not
  // the export spawn — the exact mechanism relate()/correlate() already rely
  // on, just applied across more than two schemas at once. A sequential
  // for-await loop defeats that: it doesn't even START the next schema's
  // export until the current one's entire pipeline (spawn AND write) has
  // finished.
  const eagerCandidates = selectEagerSchemas(presentSchemas);
  await Promise.all(
    eagerCandidates.map(async (schema) => {
      try {
        await getTable(sessionId, run, schema);
      } catch {
        // see above — degrade to "not warm", never throw
      }
    })
  );

  // Step 2 — ingestedSchemas = the eager set just ingested UNION anything
  // already ingested this session (a re-open of a ruby-peak-cached trace, or
  // prior tool calls earlier in this session).
  let db: DatabaseSync | undefined;
  const schemaToTable = new Map<string, string>();
  try {
    db = await getDb(sessionId);
    const rows = db.prepare("SELECT DISTINCT table_name FROM _ingested_schema").all() as Array<{ table_name: string }>;
    for (const r of rows) {
      const schema = r.table_name.replace(/^\d+:/, "");
      if (!schemaToTable.has(schema)) schemaToTable.set(schema, r.table_name);
    }
  } catch {
    db = undefined;
  }
  const ingestedSchemas = new Set(schemaToTable.keys());

  // Step 3 — run EVERY detector (cheap AND expensive) whose requiredSchemas
  // are now ingested; the schema-boundedness gate, not the detector's own
  // cost flag, is what made this set eager-ingestible in the first place.
  let ranked: RankedFinding[] = [];
  let ctx: DetectorContext | null = null;
  if (db) {
    ctx = { db, sessionId, run, tableName: (schema) => schemaToTable.get(schema) ?? schema };
    ranked = runDetectorsOverIngested(DETECTORS, ctx, ingestedSchemas);
  }

  const actions = ranked.map((f) => findingToNextAction(f, sessionId));
  const recommended = actions.length > 0 ? actions[0] : null;
  const alternatives = actions.slice(1);

  const inventory = buildSchemaInventory(
    session.instruments.filter((i) => i.run === run),
    ingestedSchemas,
    ranked
  );

  const sweptThisPass = eagerCandidates.filter((s) => ingestedSchemas.has(s));
  const sweepNote = sweptThisPass.length > 0 && ctx ? buildSweepNote(ctx, sweptThisPass, ranked) : null;

  return { recommended, alternatives, inventory, sweepNote, ingestedSchemas: [...ingestedSchemas] };
}

// Re-exported for callers that just need the allowlist/cap without importing
// eagerSchemas.js directly (kept minimal — most callers should import from
// eagerSchemas.js itself).
export { EAGER_ALLOWLIST, EAGER_SCHEMA_MAX };
