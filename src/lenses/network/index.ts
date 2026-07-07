// Tool description format: see the comment above createServer() in src/index.ts.
// Enforced by tests/driftGuard.test.ts — verb-led openers, ⚠️ Not for blocks, no stale identifiers.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Lens, QuickStart } from "../types.js";
import type { NextAction } from "../../core/response.js";
import { hintFor } from "../../engine/roleHints.js";
import { peekTable, peekDb } from "../../engine/session.js";
import { fmtCol } from "../../engine/sqlHydrate.js";
import { quoteIdent } from "../../engine/sqliteStore.js";

const NETWORK_STATS_SCHEMA = "NetworkConnectionStats";
const NETWORK_UPDATE_SCHEMA = "network-connection-update";
const NETWORK_DETECTED_SCHEMA = "network-connection-detected";

// Pinned in roleHints.ts — read from there instead of re-hardcoding the mnemonic.
const STATS_WEIGHT = hintFor(NETWORK_STATS_SCHEMA)!.primaryWeight!;
const UPDATE_WEIGHT = hintFor(NETWORK_UPDATE_SCHEMA)!.primaryWeight!;

const NETWORK_SCHEMAS = [NETWORK_STATS_SCHEMA, NETWORK_UPDATE_SCHEMA, NETWORK_DETECTED_SCHEMA];

// Same sentinel xctrace uses everywhere for "this row predates the recording"
// (see the Leaks lens's ZERO_TIMESTAMP) — network-connection-detected mixes a
// one-shot snapshot of connections that already existed at attach/launch time
// (fmt "00:00.000.000", other pids, no real timeline) with connections that
// actually started during capture (real timestamps). Same shape as the leaks
// pre-attach snapshot, verified live against a real trace.
const ZERO_TIMESTAMP = "00:00.000.000";

/**
 * Flags when a network-connection-detected query is dominated by the t=0
 * pre-existing-connections snapshot rather than connections that actually
 * started during the recording — catches the exact plausible-but-wrong read
 * ("here are the connections") when most of them predate the capture
 * entirely. Peek-only (never triggers a fetch) — a bonus check on data the
 * caller already paid for.
 */
function preExistingSnapshotHint(sessionId: string, run: number, schema: string): NextAction | null {
  if (schema !== NETWORK_DETECTED_SCHEMA) return null;
  const table = peekTable(sessionId, run, NETWORK_DETECTED_SCHEMA);
  const db = table ? peekDb(sessionId) : undefined;
  if (!table || !db || table.rowCount === 0) return null;

  // A scalar COUNT(*) WHERE time__fmt = sentinel instead of fetching+hydrating
  // every row just to count a subset (PMT:warm-mica) — table.rowCount already
  // gives the denominator for free (peekTable/getTable's own row count).
  const preExisting = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(table.tableName)} WHERE ${quoteIdent(fmtCol("time"))} = ?`)
      .get(ZERO_TIMESTAMP) as { n: number }
  ).n;
  const total = table.rowCount;
  if (preExisting === 0 || preExisting / total < 0.3) return null;

  return {
    tool: "find",
    args: { sessionId, schema: NETWORK_DETECTED_SCHEMA, run, where: [{ col: "time", op: "gt", val: 0 }] },
    description:
      `${preExisting}/${total} connections have timestamp 0 — a snapshot of connections ` +
      "that already existed before the recording started (often other processes' traffic), not events " +
      "that happened during capture. Filter to non-zero timestamps to see connections that actually " +
      "started during this recording, and filter by pid/process to scope to one target — attach does " +
      "NOT scope this table (it's a system-wide interface tap, not per-process).",
  };
}

const networkLens: Lens = {
  instruments: NETWORK_SCHEMAS,

  registerTools(_server: McpServer): void {
    // No lens-specific tools — core verbs (query, aggregate, find) work directly on these schemas.
  },

  nextActions(sessionId: string, schema: string, run: number, _allSchemas: string[]): NextAction[] {
    if (!NETWORK_SCHEMAS.includes(schema)) return [];
    const actions: NextAction[] = [];
    const snapshotHint = preExistingSnapshotHint(sessionId, run, schema);
    if (snapshotHint) actions.push(snapshotHint);
    return actions;
  },

  quickStart(schemas: string[], sessionId: string, run: number): QuickStart | null {
    if (schemas.includes(NETWORK_STATS_SCHEMA)) {
      return {
        schema: NETWORK_STATS_SCHEMA,
        tool: "aggregate",
        args: {
          sessionId,
          schema: NETWORK_STATS_SCHEMA,
          run,
          groupBy: "process",
          measure: STATS_WEIGHT,
          op: "sum",
          topN: 10,
        },
        hint: `Network trace — aggregate ${STATS_WEIGHT} by process shows which apps received the most data; also try groupBy remote-address to see traffic by host, or measure bytes-out for send traffic`,
      };
    }

    if (schemas.includes(NETWORK_UPDATE_SCHEMA)) {
      return {
        schema: NETWORK_UPDATE_SCHEMA,
        tool: "aggregate",
        args: {
          sessionId,
          schema: NETWORK_UPDATE_SCHEMA,
          run,
          groupBy: "connection-serial",
          measure: UPDATE_WEIGHT,
          op: "sum",
          topN: 10,
        },
        hint: `Network trace — aggregate ${UPDATE_WEIGHT} by connection shows which connections transferred the most data; use NetworkConnectionStats if available for host and process info`,
      };
    }

    if (schemas.includes(NETWORK_DETECTED_SCHEMA)) {
      return {
        schema: NETWORK_DETECTED_SCHEMA,
        tool: "query",
        args: { sessionId, schema: NETWORK_DETECTED_SCHEMA, run, limit: 20 },
        hint: "Network trace — query lists detected connections; use describe_schema to see available columns for filtering",
      };
    }

    return null;
  },
};

export default networkLens;
