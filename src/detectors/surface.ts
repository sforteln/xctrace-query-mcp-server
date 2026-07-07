/**
 * PMT:pure-hail surfacing — turn fired cheap detectors into ranked nextActions.
 *
 * Runs the cheap, schema-gated detectors over whatever this session has already
 * ingested (from the .db's _ingested_schema), and returns their findings as
 * nextActions, most-alarming first. The caller (open_trace, and later the
 * query/aggregate responses) merges the top one as `recommended: true`,
 * demoting the navigational default to a plain alternative. Empty when nothing
 * is ingested yet (a fresh trace — findings appear once tables are queried) or
 * no detector fired — never a fabricated ranking.
 */
import type { NextAction } from "../core/response.js";
import { getDb, lastRun } from "../engine/session.js";
import { DETECTORS } from "./index.js";
import { runCheapDetectors } from "./framework.js";
import type { DetectorContext, RankedFinding } from "./types.js";

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
