// Tool description format: see the comment above createServer() in src/index.ts.
// Enforced by tests/driftGuard.test.ts — verb-led openers, ⚠️ Not for blocks, no stale identifiers.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Lens } from "../types.js";
import type { NextAction } from "../../core/response.js";
import { envelope, toMcpText } from "../../core/response.js";
import { safeTool, text } from "../../core/toolUtils.js";
import { explainOffCpuInterval } from "../../core/explainOffCpu.js";

const SYSCALL_SCHEMA = "syscall";
const THREAD_STATE_SCHEMA = "thread-state";

/**
 * PMT:lean-pass — the off-CPU "dig" lens. Time Profiler samples only ON-CPU
 * threads, so call_tree returns empty exactly on the stalls that matter most
 * (off-CPU) and can't say WHY. This lens reads the OFF-CPU-side schemas
 * (syscall + thread-state) and classifies a stall window idle-vs-blocked-vs-
 * scheduling-delay by BACKTRACE (never by syscall name — the load-bearing
 * lesson: mach_msg2_trap AND kevent_id each span both benign idle and real
 * blocks). See offCpuClassifier.ts / explainOffCpu.ts.
 */
const offCpuLens: Lens = {
  instruments: [SYSCALL_SCHEMA, THREAD_STATE_SCHEMA],

  registerTools(server: McpServer): void {
    server.registerTool(
      "explain_off_cpu_interval",
      {
        title: "Explain an off-CPU interval",
        description:
          "Explain WHY a thread was off-CPU in a time window — the dig layer call_tree can't reach. " +
          "Time Profiler samples only ON-CPU threads, so a call_tree over a stall window returns 0 " +
          "samples and no reason; this reads the syscall backtrace that IS captured during the wait and " +
          "classifies it by STACK, not by syscall name: idle-in-runloop (benign held-frame, e.g. parked " +
          "at _DPSNextEvent), blocked-on-work (a real synchronous stall, e.g. dispatch_sync into the " +
          "render server), or scheduling-delay (runnable but not scheduled, from thread-state). " +
          "Names the blocking call + what it's waiting on, and always shows the stack as evidence — an " +
          "unrecognized wait is reported \"unclassified, here's the stack\", never a confident \"benign\". " +
          "Reach for this the moment a windowed call_tree comes back empty (\"0 samples, likely off-CPU\"). " +
          "`run` defaults to the most recent run. " +
          "⚠️ Not for ON-CPU work — if the thread had samples in the window, use call_tree for the busy " +
          "spine/hot instead; this explains the GAPS where call_tree is empty.",
        inputSchema: {
          sessionId: z.string().describe("The sessionId returned by open_trace."),
          startNs: z.number().describe("Window start in nanoseconds (e.g. a hitch/hang window's start)."),
          endNs: z.number().describe("Window end in nanoseconds."),
          thread: z
            .string()
            .optional()
            .describe(
              "Optional substring to match the waiting thread's name/tid (e.g. \"Main Thread\" or a tid " +
                "like \"350e17\"). Omit to classify the dominant off-CPU wait across all threads in the window."
            ),
          schema: z
            .string()
            .optional()
            .describe("Wait-carrying schema (default \"syscall\"). Override only for a non-standard System Trace schema."),
          run: z.number().int().optional().describe("Run number. Optional — defaults to the most recent run."),
        },
      },
      async ({ sessionId, startNs, endNs, thread, schema, run }) =>
        safeTool(async () => {
          const result = await explainOffCpuInterval(sessionId, { startNs, endNs, thread, schema, run });
          const actions: NextAction[] = [];
          if (result.evidence) {
            actions.push({
              tool: "get_row",
              args: { sessionId, schema: result.evidence.schema, run, rowIndex: result.evidence.rowIndex },
              description:
                "Read the full backtrace of the classified wait (already symbolicated inline — no call_tree needed).",
            });
          }
          if (result.schedulingDelay) {
            actions.push({
              tool: "get_row",
              args: { sessionId, schema: result.schedulingDelay.handle.schema, run, rowIndex: result.schedulingDelay.handle.rowIndex },
              description:
                "Read the runnable (scheduling-delay) interval — check its preempted-by-thread / made-runnable-by-thread for who contended for the CPU.",
            });
          }
          if (result.threadActivityHandle) {
            actions.push({
              tool: "query",
              args: {
                sessionId,
                schema: result.threadActivityHandle.schema,
                run,
                timeRange: result.threadActivityHandle.timeRange,
                limit: 50,
              },
              description: result.threadActivityHandle.note,
            });
          }
          return text(toMcpText(envelope(result, actions, { summary: result.summary })));
        })
    );
  },

  nextActions(sessionId: string, schema: string, run: number): NextAction[] {
    if (schema !== SYSCALL_SCHEMA && schema !== THREAD_STATE_SCHEMA) return [];
    return [
      {
        tool: "explain_off_cpu_interval",
        args: { sessionId, run, startNs: 0, endNs: 0, thread: "Main Thread" },
        description:
          "Classify an off-CPU stall window (idle vs blocked vs scheduling-delay) by its backtrace — pass " +
          "the startNs/endNs of a hitch/hang window (and optionally a thread substring). Reach for this " +
          "instead of reading raw " + schema + " rows: the wait's CLASS is in the stack, not the syscall " +
          "name (mach_msg2_trap and kevent_id each span both benign idle and real blocks).",
      },
    ];
  },
};

export default offCpuLens;
