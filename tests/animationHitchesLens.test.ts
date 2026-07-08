/**
 * PMT:silver-pillar — Animation Hitches / Display lens: read-time correlate
 * advice (the swap-id gotcha, working join keys, off-CPU classification
 * caveat) plus the bounded quickStart entry point.
 */
import { describe, it, expect } from "vitest";
import animationHitchesLens from "../src/lenses/animationHitches/index.js";

describe("animation hitches lens — swap-id gotcha", () => {
  it("surfaces the swap-id gotcha for the hitches schema, pointing at a time-window correlate", () => {
    const actions = animationHitchesLens.nextActions("s", "hitches", 1, ["hitches"]);
    const gotcha = actions.find((a) => a.tool === "correlate" && a.args.eventsSchema === "displayed-surfaces-interval");
    expect(gotcha).toBeDefined();
    expect(gotcha!.description).toMatch(/DIFFERENT ID SPACES/);
    expect(gotcha!.description).toMatch(/0 rows/);
  });

  it("surfaces the same gotcha from the display-surface-swap schema too", () => {
    const actions = animationHitchesLens.nextActions("s", "display-surface-swap", 1, ["display-surface-swap"]);
    expect(actions.some((a) => a.description.includes("DIFFERENT ID SPACES"))).toBe(true);
  });
});

describe("animation hitches lens — off-CPU classification caveat", () => {
  it("recommends a Time Profiler correlate when time-sample is already present", () => {
    const actions = animationHitchesLens.nextActions("s", "hitches", 1, ["hitches", "time-sample"]);
    const classify = actions.find((a) => a.tool === "correlate" && a.args.eventsSchema === "time-sample");
    expect(classify).toBeDefined();
    expect(classify!.description).toMatch(/off-CPU/i);
    expect(classify!.description).toMatch(/not a verdict/);
  });

  it("recommends re-recording with type hitches when no Time Profiler data is present", () => {
    const actions = animationHitchesLens.nextActions("s", "hitches", 1, ["hitches"]);
    const redirect = actions.find((a) => a.tool === "start_recording");
    expect(redirect).toBeDefined();
    expect(redirect!.args).toMatchObject({ type: "hitches" });
  });
});

describe("animation hitches lens — working join keys", () => {
  it("surfaces the surface-id equality join for hitches-renders", () => {
    const actions = animationHitchesLens.nextActions("s", "hitches-renders", 1, ["hitches-renders"]);
    expect(actions.length).toBe(1);
    expect(actions[0]).toMatchObject({
      tool: "relate",
      args: { schemaA: "hitches-renders", schemaB: "displayed-surfaces-interval", joinCondition: "equality" },
    });
  });

  it("surfaces the display-id vs display-name distinction for device-display-info", () => {
    const actions = animationHitchesLens.nextActions("s", "device-display-info", 1, ["device-display-info"]);
    expect(actions.length).toBe(1);
    expect(actions[0].description).toMatch(/Display N/);
  });

  it("returns nothing for a schema outside this lens's claimed set", () => {
    expect(animationHitchesLens.nextActions("s", "time-sample", 1, ["time-sample"])).toEqual([]);
  });

  it("returns nothing once a specific row is already in hand (table-level advice only)", () => {
    expect(animationHitchesLens.nextActions("s", "hitches", 1, ["hitches"], {})).toEqual([]);
  });
});

describe("animation hitches lens — quickStart", () => {
  it("recommends a bounded aggregate by display, not a raw sorted query", () => {
    const quickStart = animationHitchesLens.quickStart!(["hitches"], "s", 1);
    expect(quickStart).not.toBeNull();
    expect(quickStart!.tool).toBe("aggregate");
    expect(quickStart!.args).toMatchObject({ schema: "hitches", groupBy: "display", op: "sum" });
    expect(quickStart!.hint).toMatch(/frames held/i);
  });

  it("returns null when hitches isn't present", () => {
    expect(animationHitchesLens.quickStart!(["time-sample"], "s", 1)).toBeNull();
  });
});
