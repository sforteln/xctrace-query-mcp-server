/**
 * explainOffCpu — "explain this off-CPU interval": the windowed wrapper around
 * offCpuClassifier.ts. Given a time window where a call_tree came back empty
 * (thread off-CPU), this reads the OFF-CPU-side schemas the trace carries —
 * `syscall` primarily (which captures the actual wait + its backtrace), with
 * `thread-state` as the scheduling-delay corroborator — and NAMES what the
 * thread was doing, classified idle-vs-blocked by BACKTRACE (not syscall name).
 *
 * This is the "dig" layer call_tree structurally cannot reach: Time Profiler
 * samples only ON-CPU threads, so the worst stalls (off-CPU) return 0 samples
 * and no reason. See offCpuClassifier.ts for the classification rule and the
 * two ground-truth cases it's pinned to.
 *
 * ThreadActivity (a ~494k-row firehose) is deliberately NOT read here — it's
 * offered as a scoped-window HANDLE for the deepest who-preempted/woke-whom
 * dig, never eager-ingested (parsing the whole table on every off-CPU
 * explanation call would dwarf the cost of the single window actually asked
 * about).
 */
import { getTable, getDb, getSchemaModel, lastRun as sessionLastRun } from "../engine/session.js";
import type { SqliteTableHandle } from "../engine/session.js";
import { classifyWithHints } from "../engine/roleHints.js";
import { makeFrameLookup } from "../engine/sqlHydrate.js";
import { quoteIdent, isBacktraceCol, ROW_IDX_COLUMN } from "../engine/sqliteStore.js";
import { fmtCol, rawCol, internResolved } from "../engine/sqlHydrate.js";
import { classifyOffCpuBacktrace, type OffCpuClassification } from "./offCpuClassifier.js";
import type { SchemaCol } from "../engine/parseTable.js";

const SYSCALL_SCHEMA = "syscall";
const THREAD_STATE_SCHEMA = "thread-state";

export interface ExplainOffCpuOptions {
  startNs: number;
  endNs: number;
  /** Substring-match against the wait's thread fmt (e.g. "Main Thread" or a tid like "350e17"). */
  thread?: string;
  run?: number;
  /** Override the wait-carrying schema (default "syscall"). */
  schema?: string;
}

export interface OffCpuWaitEvidence {
  /** tableIndex of the dominant wait row — get_row for the full backtrace. */
  rowIndex: number;
  schema: string;
  /** The leaf syscall name (e.g. "mach_msg2_trap", "kevent_id") — deliberately
   *  shown NEXT TO the class to make the point that the name doesn't determine it. */
  syscall: string | null;
  thread: string | null;
  waitMs: number;
  cpuMs: number | null;
  startNs: number;
  /** Leaf-first resolved frame names (capped) — the evidence trail. */
  stack: string[];
}

export interface ExplainOffCpuResult {
  window: { startNs: number; endNs: number };
  thread: string | null;
  /** The dominant off-CPU wait overlapping the window + its classification. */
  classification: OffCpuClassification | null;
  evidence: OffCpuWaitEvidence | null;
  /** How many waiting syscalls overlapped the window (the dominant one is classified). */
  waitsInWindow: number;
  /** Present only when thread-state shows a runnable-but-not-scheduled window
   *  (scheduling-delay) the syscall backtrace can't reveal. */
  schedulingDelay?: {
    runnableMs: number;
    note: string;
    handle: { schema: string; rowIndex: number };
  };
  /** Scoped-window handle for the deepest dig (never eager-ingested). */
  threadActivityHandle?: { schema: string; timeRange: { startNs: number; endNs: number }; note: string };
  /** The "show your work" narration line: what was queried → what was found. */
  summary: string;
  /** Self-describing note when nothing off-CPU was found in the window. */
  note?: string;
}

const MAX_STACK_FRAMES = 40;

/** Find a column by exact engineering-type, then by mnemonic fallback. */
function colByType(cols: SchemaCol[], engType: string, fallbackMnemonic?: string): string | null {
  const byType = cols.find((c) => c.engineeringType === engType);
  if (byType) return byType.mnemonic;
  if (fallbackMnemonic && cols.some((c) => c.mnemonic === fallbackMnemonic)) return fallbackMnemonic;
  return null;
}

export async function explainOffCpuInterval(
  sessionId: string,
  opts: ExplainOffCpuOptions
): Promise<ExplainOffCpuResult> {
  const run = opts.run ?? sessionLastRun(sessionId);
  const schema = opts.schema ?? SYSCALL_SCHEMA;
  const { startNs, endNs, thread } = opts;

  // Kick off thread-state's ingestion NOW, concurrently with the primary
  // schema's export below, instead of waiting until maybeSchedulingDelay is
  // called after the primary schema's full SQL query completes (PMT:lark-buck
  // — a real, measured ~15-17s fixed xctrace startup cost dominates a small
  // schema like this, and concurrent exports against the same trace don't
  // contend). The cheap presence check stays synchronous and up-front, same
  // as before — only forces an actual ingest when thread-state is genuinely
  // present in this run.
  const threadStatePresent = getSchemaModel(sessionId).some(
    (e) => e.run === run && e.toc.schema === THREAD_STATE_SCHEMA
  );
  const threadStateHandle = threadStatePresent ? getTable(sessionId, run, THREAD_STATE_SCHEMA) : null;

  const handle = await getTable(sessionId, run, schema);
  const db = await getDb(sessionId);
  const classified = classifyWithHints(schema, handle.cols);

  const timeCol = colByType(handle.cols, "start-time", "start") ?? classified.find((c) => c.roleInfo.role === "time")?.mnemonic ?? null;
  const waitCol = colByType(handle.cols, "duration-waiting", "waittime");
  const cpuCol = colByType(handle.cols, "duration-on-core", "cputime");
  const btCol = handle.cols.find(isBacktraceCol)?.mnemonic ?? null;
  const threadCol = colByType(handle.cols, "thread", "thread");
  const callCol = colByType(handle.cols, "syscall", "call");

  if (!timeCol || !waitCol || !btCol) {
    return {
      window: { startNs, endNs },
      thread: thread ?? null,
      classification: null,
      evidence: null,
      waitsInWindow: 0,
      summary: `explain off-CPU [${fmtMs(startNs)}, ${fmtMs(endNs)}] → schema "${schema}" lacks a wait/time/backtrace column; can't classify`,
      note:
        `Schema "${schema}" doesn't carry the start-time + duration-waiting + backtrace columns this needs ` +
        `(it has: ${handle.cols.map((c) => c.mnemonic).join(", ")}). This dig needs a System Trace / syscall-style ` +
        `schema. If the trace has "syscall" or "thread-state", pass one of those as \`schema\`.`,
    };
  }

  const durCol = colByType(handle.cols, "duration") ?? "duration";
  // A wait explains the off-CPU gap when its interval [start, start+duration]
  // OVERLAPS the window — the dominant one (largest waittime) is the anchor
  // (e.g. the 1.92s mach_msg2_trap that CONTAINS the 83ms hitch). Thread filter
  // is a substring match on the thread fmt (matches "Main Thread"/"350e17"/…).
  const conds: string[] = [
    `CAST(${quoteIdent(rawCol(timeCol))} AS REAL) <= ?`,
    `CAST(${quoteIdent(rawCol(timeCol))} AS REAL) + CAST(${quoteIdent(rawCol(durCol))} AS REAL) >= ?`,
    `${quoteIdent(fmtCol(waitCol))} IS NOT NULL`,
    `${quoteIdent(`${btCol}__backtrace_id`)} IS NOT NULL`,
  ];
  const params: Array<string | number> = [endNs, startNs];
  // The thread fmt is commonly INTERNED (stored as a sentinel token, not the
  // literal), so a bare LIKE against the stored column silently matches
  // nothing — resolve the intern first (same UDF path find()'s content
  // predicates use). Verified live: syscall.thread is interned in the
  // animation-hitches trace.
  if (thread && threadCol) {
    conds.push(`${internResolved(quoteIdent(fmtCol(threadCol)))} LIKE ?`);
    params.push(`%${thread}%`);
  }

  const rows = db
    .prepare(
      `SELECT ${quoteIdent(ROW_IDX_COLUMN)} AS idx, ` +
        `CAST(${quoteIdent(rawCol(timeCol))} AS REAL) AS startNs, ` +
        `CAST(${quoteIdent(rawCol(waitCol))} AS REAL) AS waitNs, ` +
        (cpuCol ? `CAST(${quoteIdent(rawCol(cpuCol))} AS REAL) AS cpuNs, ` : `NULL AS cpuNs, `) +
        (threadCol ? `${internResolved(quoteIdent(fmtCol(threadCol)))} AS thread, ` : `NULL AS thread, `) +
        (callCol ? `${internResolved(quoteIdent(fmtCol(callCol)))} AS syscall, ` : `NULL AS syscall, `) +
        `${quoteIdent(`${btCol}__backtrace_id`)} AS btId ` +
        `FROM ${quoteIdent(handle.tableName)} WHERE ${conds.join(" AND ")} ` +
        `ORDER BY CAST(${quoteIdent(rawCol(waitCol))} AS REAL) DESC LIMIT 200`
    )
    .all(...params) as Array<{
    idx: number; startNs: number; waitNs: number; cpuNs: number | null; thread: string | null; syscall: string | null; btId: number | null;
  }>;

  const scheduling = await maybeSchedulingDelay(sessionId, startNs, endNs, threadStateHandle, thread);

  if (rows.length === 0) {
    // No blocking syscall overlaps the window, but thread-state shows a real
    // Runnable gap — the thread WAS off-CPU, just not because of a syscall
    // wait a backtrace could show. That's the scheduling-delay class itself,
    // not an absence of classification.
    const classification: OffCpuClassification | null = scheduling
      ? {
          class: "scheduling-delay",
          headline: `Thread was runnable for ${scheduling.runnableMs.toFixed(1)}ms but not scheduled — CPU contention, not a blocking wait`,
          evidence: scheduling.note,
          deepestWaitFrame: null,
        }
      : null;

    return {
      window: { startNs, endNs },
      thread: thread ?? null,
      classification,
      evidence: null,
      waitsInWindow: 0,
      ...(scheduling ? { schedulingDelay: scheduling } : {}),
      summary: scheduling
        ? `explain off-CPU [${fmtMs(startNs)}, ${fmtMs(endNs)}]${thread ? ` thread~${thread}` : ""} in ${schema} → ` +
          `0 waiting syscalls overlap this window → classified scheduling-delay (runnable ${scheduling.runnableMs.toFixed(1)}ms, not scheduled)`
        : `explain off-CPU [${fmtMs(startNs)}, ${fmtMs(endNs)}]${thread ? ` thread~${thread}` : ""} in ${schema} → ` +
          `0 waiting syscalls overlap this window`,
      note: scheduling
        ? undefined
        : `No off-CPU wait covers this window${thread ? ` for thread ~"${thread}"` : ""}. The thread may have been ` +
          `ON-CPU here (use call_tree for the busy work), the window may be off, or this schema doesn't capture it. ` +
          `An absent wait is NOT proof of "blocked" — it's the opposite (on-CPU) or a coverage gap.`,
    };
  }

  const dominant = rows[0];
  const getFrames = makeFrameLookup(db);
  const frames = getFrames(dominant.btId).map((f) => f.name);
  const classification = classifyOffCpuBacktrace(frames, dominant.cpuNs, dominant.waitNs);

  const evidence: OffCpuWaitEvidence = {
    rowIndex: dominant.idx,
    schema,
    syscall: dominant.syscall,
    thread: dominant.thread,
    waitMs: dominant.waitNs / 1e6,
    cpuMs: dominant.cpuNs != null ? dominant.cpuNs / 1e6 : null,
    startNs: dominant.startNs,
    stack: frames.slice(0, MAX_STACK_FRAMES),
  };

  return {
    window: { startNs, endNs },
    thread: thread ?? null,
    classification,
    evidence,
    waitsInWindow: rows.length,
    ...(scheduling ? { schedulingDelay: scheduling } : {}),
    threadActivityHandle: {
      schema: "ThreadActivity",
      timeRange: { startNs, endNs },
      note:
        "For the deepest who-woke/who-preempted dig, open ThreadActivity SCOPED to this exact window " +
        "(it's a ~500k-row firehose — query it windowed, never whole; not eager-ingested).",
    },
    summary:
      `explain off-CPU [${fmtMs(startNs)}, ${fmtMs(endNs)}]${thread ? ` thread~${thread}` : ""} → dominant wait: ` +
      `${dominant.syscall ?? "?"} for ${(dominant.waitNs / 1e6).toFixed(1)}ms → classified ${classification.class} ` +
      `(${classification.headline})` +
      // Verified live that a co-occurring scheduling delay was
      // ALREADY attached (schedulingDelay), but this one-line narration never
      // mentioned it — an agent skimming just this line had no cue to look for
      // it, which is the real mechanism behind the retrospective's "a Thread.sleep
      // buried a real scheduling-delay finding" failure (not literal data loss).
      (scheduling
        ? ` — NOTE: thread-state ALSO shows a ${scheduling.runnableMs.toFixed(1)}ms scheduling delay overlapping ` +
          "this window (see schedulingDelay)"
        : ""),
  };
}

/**
 * Scheduling-delay is invisible in a syscall backtrace (the thread isn't
 * waiting on a syscall — it's runnable, waiting for a CPU). thread-state's
 * `state='Runnable'` names it, and preempted-by / made-runnable-by give the
 * contention causality. Best-effort — only fires when thread-state is present
 * in this run AND shows a runnable interval meaningfully overlapping the
 * window. Returns undefined on any lookup miss (never blocks the primary
 * syscall classification).
 *
 * `handleP` is already-in-flight (or null when thread-state isn't present in
 * this run at all) — started by the caller alongside the primary schema's
 * own export, not fetched here, so the two independent schemas' xctrace
 * exports run concurrently instead of this one waiting for the primary
 * schema's full SQL query to finish first (PMT:lark-buck).
 */
async function maybeSchedulingDelay(
  sessionId: string,
  startNs: number,
  endNs: number,
  handleP: Promise<SqliteTableHandle> | null,
  thread?: string
): Promise<ExplainOffCpuResult["schedulingDelay"]> {
  if (!handleP) return undefined;

  try {
    const handle = await handleP;
    const db = await getDb(sessionId);
    const timeCol = colByType(handle.cols, "start-time", "start");
    const durCol = colByType(handle.cols, "duration", "duration");
    const stateCol = colByType(handle.cols, "thread-state", "state");
    const threadCol = colByType(handle.cols, "thread", "thread");
    if (!timeCol || !durCol || !stateCol) return undefined;

    const conds: string[] = [
      `CAST(${quoteIdent(rawCol(timeCol))} AS REAL) <= ?`,
      `CAST(${quoteIdent(rawCol(timeCol))} AS REAL) + CAST(${quoteIdent(rawCol(durCol))} AS REAL) >= ?`,
      `${quoteIdent(fmtCol(stateCol))} = 'Runnable'`,
    ];
    const params: Array<string | number> = [endNs, startNs];
    if (thread && threadCol) {
      conds.push(`${internResolved(quoteIdent(fmtCol(threadCol)))} LIKE ?`);
      params.push(`%${thread}%`);
    }

    const row = db
      .prepare(
        `SELECT ${quoteIdent(ROW_IDX_COLUMN)} AS idx, CAST(${quoteIdent(rawCol(durCol))} AS REAL) AS durNs ` +
          `FROM ${quoteIdent(handle.tableName)} WHERE ${conds.join(" AND ")} ` +
          `ORDER BY CAST(${quoteIdent(rawCol(durCol))} AS REAL) DESC LIMIT 1`
      )
      .get(...params) as { idx: number; durNs: number } | undefined;

    // Sub-millisecond runnable blips are routine scheduler churn, not a delay
    // worth surfacing — require a meaningful window.
    if (!row || row.durNs < 1_000_000) return undefined;

    return {
      runnableMs: row.durNs / 1e6,
      note:
        `thread-state shows a 'Runnable' interval of ${(row.durNs / 1e6).toFixed(1)}ms overlapping this window — ` +
        `the thread was READY to run but not scheduled (a SCHEDULING DELAY / CPU contention), which a syscall ` +
        `backtrace can't show. get_row on it, then check its preempted-by-thread / made-runnable-by-thread for who ` +
        `contended.`,
      handle: { schema: THREAD_STATE_SCHEMA, rowIndex: row.idx },
    };
  } catch {
    return undefined;
  }
}

function fmtMs(ns: number): string {
  return `${(ns / 1e6).toFixed(1)}ms`;
}
