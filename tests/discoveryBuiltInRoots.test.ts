/**
 * PMT:serene-wind — builtInRootPaths always includes the ACTIVE recordings
 * directory (default or user-configured) as a built-in root, alongside the
 * two Xcode autosave paths — a trace made in one session must stay
 * discoverable via list_traces/find_trace in a later one without a separate
 * add_search_root call for the server's own output directory.
 */
import { describe, it, expect } from "vitest";
import { builtInRootPaths } from "../src/core/discovery.js";

describe("builtInRootPaths", () => {
  it("includes the passed recordings directory alongside the Xcode autosave paths", () => {
    const roots = builtInRootPaths("/Volumes/External/my-recordings");
    expect(roots).toContain("/Volumes/External/my-recordings");
    expect(roots.some((r) => r.includes("Xcode/Instruments"))).toBe(true);
    expect(roots.some((r) => r.includes("com.apple.dt.instruments"))).toBe(true);
  });

  it("reflects whichever recordings directory is passed — default or reconfigured", () => {
    const withDefault = builtInRootPaths("/Users/x/Library/Application Support/far-swan/recordings");
    const withCustom = builtInRootPaths("/Volumes/External/traces");
    expect(withDefault).toContain("/Users/x/Library/Application Support/far-swan/recordings");
    expect(withCustom).toContain("/Volumes/External/traces");
    expect(withCustom).not.toContain("/Users/x/Library/Application Support/far-swan/recordings");
  });
});
