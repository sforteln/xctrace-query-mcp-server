// Tool description format: see the comment above createServer() in src/index.ts.
// Enforced by tests/driftGuard.test.ts — verb-led openers, ⚠️ Not for blocks, no stale identifiers.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Lens, QuickStart } from "../types.js";
import type { NextAction } from "../../core/response.js";
import type { CellDetail } from "../../core/getRow.js";
import { peekTable, peekDb } from "../../engine/session.js";
import { hintFor } from "../../engine/roleHints.js";
import { fmtCol } from "../../engine/sqlHydrate.js";
import { quoteIdent, ROW_IDX_COLUMN } from "../../engine/sqliteStore.js";

const LEAKS_SCHEMA = "Leaks/Leaks";
const ALLOCATIONS_LIST_SCHEMA = "Allocations/Allocations List";
const ALLOCATIONS_STATS_SCHEMA = "Allocations/Statistics";
const UNRESOLVED_CALLER = "<Call stack limit reached>";
// Pinned in roleHints.ts — Allocations/Allocations List's weight column is
// "size" (bytes allocated); Allocations/Statistics' is "persistent-bytes"
// (live retained footprint) — a DIFFERENT column that only exists on that
// schema. Reading both from roleHints instead of hardcoding catches this
// kind of mismatch instead of silently aggregating on a missing column.
const LEAKS_WEIGHT = hintFor(LEAKS_SCHEMA)!.primaryWeight!;
const LIST_WEIGHT = hintFor(ALLOCATIONS_LIST_SCHEMA)!.primaryWeight!;
const STATS_WEIGHT = hintFor(ALLOCATIONS_STATS_SCHEMA)!.primaryWeight!;
// Pre-attach snapshot rows all carry this exact sentinel timestamp. This
// detection keys off the fmt string (the `timestamp__fmt` column), which is
// the direct, exact representation of the sentinel. (As of PMT:light-reed the
// track-detail timestamp's `.raw` is now numeric ns — parsed from the
// "MM:SS.mmm.µµµ" fmt at ingest — so `raw === 0` would work equally, but the
// fmt match stays the clearest expression of "this specific sentinel value".)
//
// Independently verified against Instruments.app itself (not just inferred
// from this timestamp): opening the same trace directly in the Leaks/
// Allocations UI, some leak backtraces show "No stack trace is available for
// this leak. It may have been allocated before the recording started." —
// Apple's own UI confirms the same root cause this sentinel detects: malloc
// stack logging only captures allocations that happen DURING the recording,
// so anything already live when Instruments attached has no stack to show,
// in principle, not just in this parser.
const ZERO_TIMESTAMP = "00:00.000.000";

/**
 * Build the Leaks -> Allocations address-join nextAction, labeling the two
 * failure modes distinctly when the target row is already cached: pre-
 * attachment (allocated before Instruments attached — no stack recoverable
 * in principle, joined timestamp is 0) vs. unresolved (allocated during the
 * recording but the stack wasn't captured — a different, potentially
 * transient cause). Only peeks the cache — never triggers a fetch, so this
 * never turns a fast get_row call into a slow one on a cold Allocations table.
 */
function buildAllocationJoinAction(
  sessionId: string,
  run: number,
  address: string
): NextAction {
  const baseArgs = { sessionId, schema: ALLOCATIONS_LIST_SCHEMA, run, filter: { address } };
  const cached = peekTable(sessionId, run, ALLOCATIONS_LIST_SCHEMA);
  const db = cached ? peekDb(sessionId) : undefined;
  // A scoped single-row lookup (LIMIT 1, first match in _row_idx order —
  // matching the original Array.find's first-match semantics exactly) instead
  // of fetchAllRowsHydrated's whole-table fetch (PMT:warm-mica). peek-only:
  // db is only defined when the table is already cached, so this never
  // triggers a fetch/ingestion of its own.
  const match =
    cached && db
      ? (db
          .prepare(
            `SELECT ${quoteIdent(fmtCol("timestamp"))} AS ts, ${quoteIdent(fmtCol("responsible-caller"))} AS caller ` +
              `FROM ${quoteIdent(cached.tableName)} WHERE ${quoteIdent(fmtCol("address"))} = ? ` +
              `ORDER BY ${quoteIdent(ROW_IDX_COLUMN)} ASC LIMIT 1`
          )
          .get(address) as { ts: string | null; caller: string | null } | undefined)
      : undefined;

  if (match) {
    const isPreAttach = match.ts === ZERO_TIMESTAMP;
    const callerFmt = match.caller ?? null;
    const isUnresolved = !isPreAttach && (callerFmt === null || callerFmt === UNRESOLVED_CALLER);

    if (isPreAttach) {
      return {
        tool: "query",
        args: baseArgs,
        description:
          "PRE-ATTACHMENT — this leak's joined allocation has timestamp 0, meaning it was allocated " +
          "before Instruments attached. No stack is recoverable in principle — relaunch with launch " +
          "mode instead of attach to capture this object's allocation from t=0.",
      };
    }
    if (isUnresolved) {
      return {
        tool: "query",
        args: baseArgs,
        description:
          "UNRESOLVED — allocated during the recording but the stack wasn't captured (too deep, or " +
          "logging missed it) — not the same as pre-attachment. Still useful for category/size/" +
          "responsible-library even without a backtrace.",
      };
    }
    return {
      tool: "query",
      args: baseArgs,
      description:
        "Look up this leak's allocation record for its resolved backtrace — the address join to " +
        "Allocations is deterministic 1:1.",
    };
  }

  return {
    tool: "query",
    args: baseArgs,
    description:
      "Look up this leak's allocation record for its backtrace — Leaks has no backtrace column; " +
      "the address join to Allocations is deterministic 1:1.",
  };
}

/**
 * Table-wide version of the same PRE-ATTACHMENT/UNRESOLVED check
 * buildAllocationJoinAction does per-row — catches the exact plausible-but-
 * wrong-looking result this whole check exists for: a Leaks/Leaks query
 * that comes back with real rows (looks usable) but where most/all of them
 * join to unattributable Allocations records, because the recording was
 * made via attach and these objects were already live before Instruments
 * attached. Only runs when Allocations/Allocations List is ALREADY cached
 * (peek, never fetch) — this is a bonus check on data the caller already
 * paid for, not a reason to trigger an expensive fetch just for a hint.
 */
function unattributableFractionHint(
  sessionId: string,
  run: number,
  allSchemas: string[]
): NextAction | null {
  if (!allSchemas.includes(ALLOCATIONS_LIST_SCHEMA)) return null;
  const leaksTable = peekTable(sessionId, run, LEAKS_SCHEMA);
  const allocTable = peekTable(sessionId, run, ALLOCATIONS_LIST_SCHEMA);
  const db = leaksTable && allocTable ? peekDb(sessionId) : undefined;
  if (!leaksTable || !allocTable || !db || leaksTable.rowCount === 0) return null;

  // A direct SQL semi-join + property-check (PMT:warm-mica) — NOT relate(),
  // which only answers "matched / not matched"; this needs "matched, AND a
  // property of the specific match". CAREFUL semantic preserved from the
  // original: an address can legitimately recur in Allocations List (alloc
  // -> free -> realloc reuse), so the original built a JS Map that let a
  // LATER row overwrite an earlier one for the same address ("last-wins").
  // ROW_NUMBER() OVER (PARTITION BY address ORDER BY _row_idx DESC) picks
  // the exact same winner (rn=1 = highest _row_idx per address) in one SQL
  // pass over just the 3 columns needed, instead of hydrating every column
  // of every row in both tables into JS Cell objects first.
  const leaksT = quoteIdent(leaksTable.tableName);
  const allocT = quoteIdent(allocTable.tableName);
  const addrCol = quoteIdent(fmtCol("address"));
  const tsCol = quoteIdent(fmtCol("timestamp"));
  const callerCol = quoteIdent(fmtCol("responsible-caller"));
  const sql =
    `WITH ranked_alloc AS (` +
    `  SELECT ${addrCol} AS addr, ${tsCol} AS ts, ${callerCol} AS caller, ` +
    `         ROW_NUMBER() OVER (PARTITION BY ${addrCol} ORDER BY ${quoteIdent(ROW_IDX_COLUMN)} DESC) AS rn ` +
    `  FROM ${allocT} WHERE ${addrCol} IS NOT NULL` +
    `), best_alloc AS (SELECT addr, ts, caller FROM ranked_alloc WHERE rn = 1) ` +
    `SELECT ` +
    `  SUM(CASE WHEN ba.addr IS NOT NULL THEN 1 ELSE 0 END) AS matched, ` +
    `  SUM(CASE WHEN ba.addr IS NOT NULL AND (ba.ts = ? OR ba.caller IS NULL OR ba.caller = ?) THEN 1 ELSE 0 END) AS unattributable ` +
    `FROM ${leaksT} l LEFT JOIN best_alloc ba ON ba.addr = l.${addrCol} ` +
    `WHERE l.${addrCol} IS NOT NULL`;

  const row = db.prepare(sql).get(ZERO_TIMESTAMP, UNRESOLVED_CALLER) as { matched: number | null; unattributable: number | null };
  const matched = row.matched ?? 0;
  const unattributable = row.unattributable ?? 0;

  if (matched === 0 || unattributable / matched < 0.5) return null;

  return {
    tool: "start_recording",
    args: { type: "leaks-backtraces" },
    description:
      `${unattributable}/${matched} leaks have no recoverable stack — most were already ` +
      "allocated before this recording started capturing (a signature of an attach-mode " +
      "recording; malloc stack logging only sees allocations made DURING the recording). " +
      "If you need real callsites, relaunch with launch mode instead of attach and reproduce " +
      "the leak fresh — attach can never symbolicate these same objects after the fact.",
  };
}

const leaksLens: Lens = {
  instruments: [LEAKS_SCHEMA],

  registerTools(_server: McpServer): void {
    // No lens-specific tools — core verbs (query, aggregate, find) work directly on these schemas.
  },

  nextActions(
    sessionId: string,
    schema: string,
    run: number,
    allSchemas: string[],
    row?: Record<string, CellDetail | null>
  ): NextAction[] {
    if (schema !== LEAKS_SCHEMA) return [];
    const actions: NextAction[] = [];

    // Leaks/Leaks has no backtrace column — Instruments' own design is to
    // cross-reference by address into Allocations for the responsible frames.
    // Only offer this when get_row supplied a specific leak's address (query/
    // aggregate/find have no single row in context, so row is undefined there).
    const address = row?.["address"]?.fmt;
    if (address && allSchemas.includes(ALLOCATIONS_LIST_SCHEMA)) {
      actions.push(buildAllocationJoinAction(sessionId, run, address));
    }

    // Table-wide check — fires regardless of whether get_row supplied a
    // single row, since this is the strongest signal right after a plain
    // query/aggregate on Leaks/Leaks (the quickStart's own first call).
    const wideHint = unattributableFractionHint(sessionId, run, allSchemas);
    if (wideHint) actions.unshift(wideHint);

    actions.push({
      tool: "aggregate",
      args: {
        sessionId,
        schema: LEAKS_SCHEMA,
        run,
        groupBy: "responsible-library",
        measure: LEAKS_WEIGHT,
        op: "sum",
        topN: 20,
      },
      description:
        "Group leaks by owning library — shows whether leaked bytes are app-owned or framework-owned.",
    });
    if (allSchemas.includes(ALLOCATIONS_LIST_SCHEMA)) {
      actions.push({
        tool: "aggregate",
        args: {
          sessionId,
          schema: ALLOCATIONS_LIST_SCHEMA,
          run,
          groupBy: "category",
          measure: LIST_WEIGHT,
          op: "sum",
          topN: 20,
        },
        description:
          `Summarise allocated bytes by category alongside the leaks — ${LIST_WEIGHT} is total bytes allocated (including freed), grouped by framework or class name.`,
      });
    }
    if (allSchemas.includes(ALLOCATIONS_STATS_SCHEMA)) {
      actions.push({
        tool: "aggregate",
        args: {
          sessionId,
          schema: ALLOCATIONS_STATS_SCHEMA,
          run,
          groupBy: "category",
          measure: STATS_WEIGHT,
          op: "sum",
          topN: 20,
        },
        description:
          `Pre-summarised Allocations view — ${STATS_WEIGHT} shows the live persistent footprint by category, faster than Allocations List. Try this if Allocations List is slow or empty.`,
      });
    }
    return actions;
  },

  quickStart(schemas: string[], sessionId: string, run: number): QuickStart | null {
    if (!schemas.includes(LEAKS_SCHEMA)) return null;
    // Deliberately KEPT as a raw sorted query, unlike the other quickStart
    // branches PMT:spare-goat swapped to aggregate — Leaks/Leaks is different
    // in kind from those high-volume event logs (thermal-state samples,
    // hang/hitch occurrences, Core Data fetches/saves): a leak is a DIAGNOSED
    // object, not a raw per-event log entry, so this table is realistically
    // bounded regardless of trace length or duration. Grouping by
    // responsible-library (already offered elsewhere in this lens's
    // nextActions) answers a genuinely different, less immediately actionable
    // question ("which library leaked most") than seeing the actual leaked
    // objects biggest-first — the raw sort IS the more useful default here,
    // and the size risk the other branches guard against doesn't apply.
    return {
      schema: LEAKS_SCHEMA,
      tool: "query",
      args: {
        sessionId,
        schema: LEAKS_SCHEMA,
        run,
        sort: { by: LEAKS_WEIGHT, dir: "desc" },
        limit: 20,
      },
      hint: `Leaks trace — query sorted by ${LEAKS_WEIGHT} shows all leaks largest-first; zero rows means no leaks detected`,
    };
  },
};

export default leaksLens;
