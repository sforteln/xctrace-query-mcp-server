/**
 * PMT:lean-knoll corpus detector — QoS classes mismatch (the hitch "narrow"
 * layer, step 1 of show(vsync table) → narrow(QoS/priority) → dig(ThreadActivity)).
 *
 * ThreadQoSTable's `mismatch-qo-s` column IS the signal — Apple's own kernel
 * flags a thread "QoS classes mismatch" when its EFFECTIVE QoS class was
 * demoted below what it REQUESTED (e.g. UI-class work silently downgraded to
 * Background). Verified live against a real PromptManager trace: a thread
 * requested "Unspecified", effective landed at "Background" — a genuine
 * demotion, not noise. No numeric threshold to compute here — same "surface
 * Apple's own category" philosophy dim-chalk §3 documents for Hangs'
 * runtime-issue faults: the state IS the finding.
 *
 * Main-thread identification follows dim-chalk §3's technique exactly:
 * runloop-events' own `is-main` flag (per-thread, per Apple's own comment
 * "more reliable than symbolication"), NOT a symbolication-based guess. This
 * is deliberately NOT a SQL JOIN between the two tables — it's two small,
 * independent single-table queries (the tiny set of main-thread fmt strings
 * from runloop-events; the handful of mismatch rows from ThreadQoSTable),
 * reconciled in JS. Both queries are genuinely bounded: mismatch rows are
 * rare by construction (Apple's kernel only flags a real demotion, confirmed
 * live: exactly 1 such row across an entire ~1.3GB trace), and the main-
 * thread lookup is a single-table scan with no cross-table correlation at the
 * SQL level at all — unlike runloopContainsBodyEval's per-row correlated
 * EXISTS (which runs once per BUSY TURN against an 890K-row table), this
 * runs the small-table lookup ONCE, not once per mismatch row.
 *
 * cost: CHEAP — a single-table indexed label filter (mismatch-qo-s = "QoS
 * classes mismatch"), the same shape as fmMainActorSaturation's own
 * single-table filtered aggregate. requiredSchemas includes runloop-events
 * (not optional) — every template that carries ThreadQoSTable in practice
 * also carries Run Loops' own schemas (confirmed: Animation Hitches, the
 * System-Trace-family templates), so this stays a simple declarative gate
 * rather than ad-hoc runtime schema-presence probing (which the framework
 * doesn't otherwise do anywhere).
 */
import { quoteIdent, ROW_IDX_COLUMN } from "../engine/sqliteStore.js";
import { fmtCol, rawCol } from "../engine/sqlHydrate.js";
import type { Detector } from "./types.js";

const QOS_SCHEMA = "ThreadQoSTable";
const RUNLOOP_EVENTS_SCHEMA = "runloop-events";
const MISMATCH_STATE = "QoS classes mismatch";
const MAIN_YES = "Yes";

export const qosMismatch: Detector = {
  id: "qos-classes-mismatch",
  title: "QoS classes mismatch — requested-vs-effective demotion",
  requiredSchemas: [QOS_SCHEMA, RUNLOOP_EVENTS_SCHEMA],
  cost: "cheap",
  run(ctx) {
    const qos = quoteIdent(ctx.tableName(QOS_SCHEMA));
    const runloopEvents = quoteIdent(ctx.tableName(RUNLOOP_EVENTS_SCHEMA));
    const mismatchFmt = quoteIdent(fmtCol("mismatch-qo-s"));
    const requestedFmt = quoteIdent(fmtCol("requested-qo-s"));
    const effectiveFmt = quoteIdent(fmtCol("effective-qo-s"));
    const threadFmt = quoteIdent(fmtCol("thread"));
    const processFmt = quoteIdent(fmtCol("process"));
    const startRaw = quoteIdent(rawCol("start"));
    const durationRaw = quoteIdent(rawCol("duration"));
    const isMainFmt = quoteIdent(fmtCol("is-main"));
    const reThreadFmt = quoteIdent(fmtCol("thread"));

    const rows = ctx.db
      .prepare(
        `SELECT ${threadFmt} AS thread, ${processFmt} AS process, ${requestedFmt} AS requested, ` +
          `${effectiveFmt} AS effective, CAST(${startRaw} AS REAL) AS start, CAST(${durationRaw} AS REAL) AS duration, ` +
          `${quoteIdent(ROW_IDX_COLUMN)} AS idx FROM ${qos} WHERE ${mismatchFmt} = ?`
      )
      .all(MISMATCH_STATE) as Array<{
      thread: string; process: string; requested: string; effective: string; start: number; duration: number; idx: number;
    }>;
    if (rows.length === 0) return null;

    const mainThreads = new Set(
      (
        ctx.db
          .prepare(`SELECT DISTINCT ${reThreadFmt} AS thread FROM ${runloopEvents} WHERE ${isMainFmt} = ?`)
          .all(MAIN_YES) as Array<{ thread: string }>
      ).map((r) => r.thread)
    );

    const withMainFlag = rows.map((r) => ({ ...r, isMain: mainThreads.has(r.thread) }));
    const mainHit = withMainFlag.find((r) => r.isMain) ?? null;
    const worst = mainHit ?? withMainFlag[0];

    return {
      summary: mainHit
        ? `The MAIN thread (${mainHit.process}) was demoted from requested QoS "${mainHit.requested}" to effective ` +
          `"${mainHit.effective}" — a genuine QoS classes mismatch on the thread driving UI work, not a background task`
        : `${rows.length.toLocaleString("en-US")} thread(s) hit a QoS classes mismatch (worst: ${worst.process} ` +
          `requested "${worst.requested}" → effective "${worst.effective}") — none identified as the main thread`,
      firing: [{ metric: "QoS-mismatch occurrences", value: rows.length, threshold: 0, direction: "over" }],
      severity: mainHit ? "high" : undefined,
      callSpec: {
        verb: "find",
        schema: QOS_SCHEMA,
        args: { where: [{ col: "mismatch-qo-s", op: "eq", val: MISMATCH_STATE }] },
      },
      handles: [
        { kind: "row", schema: QOS_SCHEMA, rowIndex: worst.idx, label: "the QoS-mismatch row itself" },
        {
          kind: "window",
          schema: "ThreadActivity",
          timeRange: { startNs: worst.start, endNs: worst.start + worst.duration },
          label: "the expensive why-dig — open ThreadActivity in this exact window to see what preempted or made-runnable this thread (not eager-ingested)",
        },
      ],
    };
  },
};
