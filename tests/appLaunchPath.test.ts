/**
 * isAppLaunchPath governs whether a `--launch` recording passes
 * -ApplePersistenceIgnoreState YES to dodge the liboainject × window-state-
 * restoration crash (xctrace exit 54) under Allocations/Leaks. The bare
 * `.endsWith(".app")` check it replaced missed the executable-inside-the-bundle
 * form — exactly what profiling a debug build hands you — so those launches
 * silently crashed on restoration. These cases pin both forms as apps and keep
 * genuine CLI targets excluded.
 */
import { describe, it, expect } from "vitest";
import { isAppLaunchPath } from "../src/core/recordingSession.js";

describe("isAppLaunchPath", () => {
  it("recognizes the .app bundle directory", () => {
    expect(isAppLaunchPath("/Applications/PromptManager.app")).toBe(true);
    expect(isAppLaunchPath("PromptManager.app")).toBe(true);
  });

  it("recognizes the executable inside the bundle (the debug-build case)", () => {
    expect(
      isAppLaunchPath(
        "/Users/me/Library/Developer/Xcode/DerivedData/PromptManager-abc/Build/Products/Debug/PromptManager.app/Contents/MacOS/PromptManager"
      )
    ).toBe(true);
  });

  it("excludes a genuine non-app CLI target", () => {
    expect(isAppLaunchPath("/usr/local/bin/mytool")).toBe(false);
    expect(isAppLaunchPath("/Users/me/bin/some-test-binary")).toBe(false);
  });

  it("excludes undefined (no --launch)", () => {
    expect(isAppLaunchPath(undefined)).toBe(false);
  });
});
