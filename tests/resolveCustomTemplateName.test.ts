/**
 * PMT:stubborn-beck — resolveCustomTemplateName: the ONE category of
 * "friendly name" that survives the removal of the old `type` enum. Unlike
 * every former `type` key (a pure alias for an independently-discoverable
 * real xctrace template name), a custom shipped .tracetemplate has no real
 * name at all — it's an absolute file path resolved at runtime, which a
 * caller has no way to guess. Everything else passes through unchanged.
 */
import { describe, it, expect } from "vitest";
import { resolveCustomTemplateName, CUSTOM_TEMPLATE_PATHS, CUSTOM_TEMPLATE_NOTES } from "../src/core/recording.js";

describe("resolveCustomTemplateName", () => {
  it("resolves the memory-vm shortcut to its real asset path", () => {
    expect(resolveCustomTemplateName("memory-vm")).toBe(CUSTOM_TEMPLATE_PATHS["memory-vm"]);
    expect(resolveCustomTemplateName("memory-vm")).toMatch(/AllocVMTrackerAuto3s\.tracetemplate$/);
  });

  it("passes a real xctrace template name through unchanged", () => {
    expect(resolveCustomTemplateName("Time Profiler")).toBe("Time Profiler");
    expect(resolveCustomTemplateName("Data Persistence")).toBe("Data Persistence");
  });

  it("passes a former `type` enum key through unchanged (no more type-key resolution)", () => {
    // "core-data" used to resolve to "Data Persistence" via the old `type`
    // enum — that resolution is gone; only genuine custom-template
    // shortcuts (CUSTOM_TEMPLATE_PATHS) resolve transparently now.
    expect(resolveCustomTemplateName("core-data")).toBe("core-data");
    expect(resolveCustomTemplateName("leaks-backtraces")).toBe("leaks-backtraces");
  });

  it("every CUSTOM_TEMPLATE_PATHS key has a matching CUSTOM_TEMPLATE_NOTES entry", () => {
    for (const key of Object.keys(CUSTOM_TEMPLATE_PATHS)) {
      expect(CUSTOM_TEMPLATE_NOTES[key], `expected a note for custom template "${key}"`).toBeDefined();
    }
  });
});
