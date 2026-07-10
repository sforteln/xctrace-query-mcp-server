/**
 * PMT:lean-pass — the off-CPU classifier, verified against the TWO real
 * ground-truth backtraces from 2026-07-07T20-27-57-animation-hitches.trace
 * (scratchpad 055→056→062). These are the exact resolved frame sequences
 * pulled from the trace's SQLite ingest (frames/symbols join), leaf-first.
 */
import { describe, it, expect } from "vitest";
import { classifyOffCpuBacktrace } from "../src/core/offCpuClassifier.js";

// Row 150080: the worst "hitch" (35.997, 83ms) — a FALSE ALARM. 41.5µs cpu / 1.92s wait.
const IDLE_STACK = [
  "mach_msg2_trap",
  "mach_msg2_internal",
  "mach_msg_overwrite",
  "mach_msg",
  "__CFRunLoopServiceMachPort",
  "__CFRunLoopRun",
  "_CFRunLoopRunSpecificWithOptions",
  "RunCurrentEventLoopInMode",
  "ReceiveNextEventCommon",
  "_BlockUntilNextEventMatchingListInMode",
  "_DPSBlockUntilNextEventMatchingListInMode",
  "_DPSNextEvent",
  "-[NSApplication(NSEventRouting) _nextEventMatchingEventMask:untilDate:inMode:dequeue:]",
  "-[NSApplication(NSEventRouting) nextEventMatchingMask:untilDate:inMode:dequeue:]",
  "-[NSApplication run]",
  "NSApplicationMain",
  "specialized runApp(_:)",
  "runApp<A>(_:)",
  "static App.main()",
  "static PromptManagerApp.$main()",
  "__debug_main_executable_dylib_entry_point",
  "start",
];

// Row 24232: mechanism #3 — a REAL render-server block hidden inside kevent_id. 411µs cpu / 61.71ms wait.
const BLOCKED_STACK = [
  "kevent_id",
  "_dispatch_kq_poll",
  "_dispatch_event_loop_wait_for_ownership",
  "__DISPATCH_WAIT_FOR_QUEUE__",
  "_dispatch_sync_f_slow",
  "CABackingStoreGetFrontTexture(CABackingStore*, CGColorSpace*)",
  "-[NSObject(CARenderValue) CA_prepareRenderValue]",
  "CA::Layer::prepare_contents(CALayer*, CA::Transaction*)",
  "CA::Layer::prepare_commit(CA::Transaction*)",
  "CA::Context::commit_transaction(CA::Transaction*, double, double*)",
  "CA::Transaction::commit()",
  "CA::Transaction::flush()",
  "CA::Transaction::flush_as_runloop_observer(bool)",
  "stepTransactionFlush",
  "UC::DriverCore::continueProcessing()",
  "__CFMachPortPerform",
  "__CFRUNLOOP_IS_CALLING_OUT_TO_A_SOURCE1_PERFORM_FUNCTION__",
  "__CFRunLoopDoSource1",
  "__CFRunLoopRun",
  "_CFRunLoopRunSpecificWithOptions",
  "RunCurrentEventLoopInMode",
  "ReceiveNextEventCommon",
  "_BlockUntilNextEventMatchingListInMode",
  "_DPSBlockUntilNextEventMatchingListInMode",
  "_DPSNextEvent",
  "-[NSApplication(NSEventRouting) _nextEventMatchingEventMask:untilDate:inMode:dequeue:]",
  "-[NSApplication(NSEventRouting) nextEventMatchingMask:untilDate:inMode:dequeue:]",
  "-[NSApplication run]",
  "NSApplicationMain",
  "specialized runApp(_:)",
  "runApp<A>(_:)",
  "static App.main()",
  "static PromptManagerApp.$main()",
  "__debug_main_executable_dylib_entry_point",
  "start",
];

describe("classifyOffCpuBacktrace — the two ground-truth cases", () => {
  it("classifies the 35.997 max hitch as IDLE (run-loop _DPSNextEvent)", () => {
    const r = classifyOffCpuBacktrace(IDLE_STACK, 41_540, 1_920_000_000);
    expect(r.class).toBe("idle-in-runloop");
    expect(r.idleMarker).toBe("_DPSNextEvent");
    expect(r.headline).toMatch(/IDLE/);
    expect(r.evidence).toMatch(/_DPSNextEvent/);
    // The whole point: it must NOT be read as a block despite the long wait.
    expect(r.blockingCall).toBeUndefined();
  });

  it("classifies mechanism #3 as BLOCKED (dispatch_sync → CABackingStoreGetFrontTexture) despite the kevent_id leaf", () => {
    const r = classifyOffCpuBacktrace(BLOCKED_STACK, 411_040, 61_710_000);
    expect(r.class).toBe("blocked-on-work");
    expect(r.blockingCall).toBe("_dispatch_sync_f_slow");
    expect(r.waitingOn).toBe("CABackingStoreGetFrontTexture(CABackingStore*, CGColorSpace*)");
    expect(r.headline).toMatch(/BLOCKED/);
    // The load-bearing lesson: the leaf syscall name (kevent_id) also covers
    // benign kqueue idle — the verdict must come from the stack, not the name.
    expect(r.deepestWaitFrame).toBe("kevent_id");
  });
});

// Real resolved backtrace from 2026-07-09T03-31-24-system-trace.trace (PMT:serene-elk),
// row 7808 — a Thread.sleep call inside OffCPUTestHarness.scenario2_lockContention, on a
// plain (non-GCD) worker thread. 355.00ms wait / 26.9µs cpu.
const NSTHREAD_SLEEP_STACK = [
  "__semwait_signal",
  "nanosleep",
  "+[NSThread sleepForTimeInterval:]",
  "closure #1 in static OffCPUTestHarness.scenario2_lockContention()",
  "thunk for @escaping @callee_guaranteed @Sendable () -> ()",
  "__NSThread__block_start__",
  "_pthread_start",
  "thread_start",
];

// Same trace, row 7863 — the identical Thread.sleep pattern, but on a GCD
// workloop worker thread (scenario3_gcdCongestion). The dispatch-drain frames
// here (_dispatch_lane_serial_drain etc.) are the NORMAL async drain loop, not
// a synchronous block — none are in EXPLICIT_BLOCK_FRAMES — so this must still
// classify as a voluntary sleep, not blocked-on-work.
const NSTHREAD_SLEEP_ON_GCD_WORKER_STACK = [
  "__semwait_signal",
  "nanosleep",
  "+[NSThread sleepForTimeInterval:]",
  "closure #1 in static OffCPUTestHarness.scenario3_gcdCongestion()",
  "thunk for @escaping @callee_guaranteed @Sendable () -> ()",
  "_dispatch_call_block_and_release",
  "_dispatch_client_callout",
  "_dispatch_lane_serial_drain",
  "_dispatch_lane_invoke",
  "_dispatch_root_queue_drain_deferred_wlh",
  "_dispatch_workloop_worker_thread",
  "_pthread_wqthread",
  "start_wqthread",
];

describe("classifyOffCpuBacktrace — timer-wait (PMT:serene-elk)", () => {
  it("classifies a real Thread.sleep call as timer-wait, not unclassified", () => {
    const r = classifyOffCpuBacktrace(NSTHREAD_SLEEP_STACK, 26_875, 355_004_375);
    expect(r.class).toBe("timer-wait");
    expect(r.timerMarker).toBe("+[NSThread sleepForTimeInterval:]");
    expect(r.deepestWaitFrame).toBe("__semwait_signal");
    expect(r.headline).toMatch(/TIMER-WAIT/);
    expect(r.headline).toMatch(/355\.0ms/);
  });

  it("still classifies as timer-wait when the sleep happens on a GCD worker thread (drain frames aren't a block)", () => {
    const r = classifyOffCpuBacktrace(NSTHREAD_SLEEP_ON_GCD_WORKER_STACK, 67_168, 11_037_125);
    expect(r.class).toBe("timer-wait");
    expect(r.timerMarker).toBe("+[NSThread sleepForTimeInterval:]");
  });

  it("a real synchronous block still wins over a co-occurring sleep marker (block checked first)", () => {
    const stack = [
      "kevent_id",
      "_dispatch_kq_poll",
      "_dispatch_event_loop_wait_for_ownership",
      "__DISPATCH_WAIT_FOR_QUEUE__",
      "_dispatch_sync_f_slow",
      "SomeClass.doRealWork()",
      "+[NSThread sleepForTimeInterval:]", // hypothetical: a sleep further up an unrelated frame
      "main",
    ];
    const r = classifyOffCpuBacktrace(stack);
    expect(r.class).toBe("blocked-on-work");
  });

  it("a bare nanosleep/usleep leaf (no NSThread wrapper) also classifies as timer-wait", () => {
    const r = classifyOffCpuBacktrace(["__semwait_signal", "nanosleep", "MyWorker.pollLoop()", "main"]);
    expect(r.class).toBe("timer-wait");
    expect(r.timerMarker).toBe("nanosleep");
  });
});

describe("classifyOffCpuBacktrace — safety (fail toward evidence)", () => {
  it("a kevent_id idle-park (NO block marker, NO idle marker recognized) is UNCLASSIFIED, not benign", () => {
    // A bare kqueue wait with only generic scaffolding — must NOT be called idle
    // just because nothing looks blocked. Fail toward showing the stack.
    const r = classifyOffCpuBacktrace(["kevent_id", "__dispatch_something_unknown", "start"], 0, 5_000_000);
    expect(r.class).toBe("unclassified");
    expect(r.headline).toMatch(/UNCLASSIFIED/);
    expect(r.deepestWaitFrame).toBe("kevent_id");
  });

  it("a block marker WINS over an idle marker in the same stack (blocked checked first)", () => {
    // A stack that has both _DPSNextEvent (outer scaffolding) AND a real sync
    // block below a callout must classify BLOCKED — exactly the BLOCKED_STACK
    // shape, which contains _DPSNextEvent too.
    const r = classifyOffCpuBacktrace(BLOCKED_STACK);
    expect(r.class).toBe("blocked-on-work");
  });

  it("a GCD worker parked at __workq_kernreturn is IDLE", () => {
    const r = classifyOffCpuBacktrace(
      ["__workq_kernreturn", "_pthread_wqthread", "start_wqthread"],
      0,
      10_000_000
    );
    expect(r.class).toBe("idle-in-runloop");
    expect(r.idleMarker).toBeDefined();
  });

  it("a psynch mutex block names the waiting-on frame", () => {
    const r = classifyOffCpuBacktrace(
      ["__psynch_mutexwait", "_pthread_mutex_firstfit_lock_slow", "pthread_mutex_lock", "MyClass.doWork()", "main"],
      0,
      20_000_000
    );
    expect(r.class).toBe("blocked-on-work");
    expect(r.waitingOn).toBe("MyClass.doWork()");
  });

  it("an empty stack is unclassified, not a crash", () => {
    const r = classifyOffCpuBacktrace([]);
    expect(r.class).toBe("unclassified");
    expect(r.deepestWaitFrame).toBeNull();
  });
});
