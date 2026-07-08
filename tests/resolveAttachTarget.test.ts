/**
 * PMT:sleek-vault — attach-target → PID resolution.
 *
 * attach-by-NAME doesn't resolve on a device/Simulator, so far-swan resolves a
 * CFBundleIdentifier / app name to a live PID (simctl launchctl on a sim,
 * devicectl on a device) and attaches by PID. Pins the parsing of both tools'
 * output + the bundle-id candidate matching (no live hardware needed).
 */
import { describe, it, expect } from "vitest";
import {
  candidatesFor,
  parseLaunchctlPid,
  parseDevicectlPid,
  resolveAttachTarget,
} from "../src/core/resolveAttachTarget.js";

describe("PMT:sleek-vault candidatesFor", () => {
  it("adds the last dot-segment of a bundle id (so it matches an executable path)", () => {
    expect(candidatesFor("simonfortelny.NoSky")).toEqual(["simonfortelny.NoSky", "NoSky"]);
  });
  it("leaves a plain name alone", () => {
    expect(candidatesFor("NoSky")).toEqual(["NoSky"]);
  });
});

describe("PMT:sleek-vault parseLaunchctlPid (Simulator)", () => {
  const OUT = [
    "PID\tStatus\tLabel",
    "88912\t0\tUIKitApplication:simonfortelny.NoSky[d80e][rb-legacy]",
    "-\t0\tcom.apple.SomeBackgroundDaemon",
  ].join("\n");

  it("finds the PID whose launchd LABEL carries the full bundle id", () => {
    expect(parseLaunchctlPid(OUT, ["simonfortelny.NoSky"])).toBe("88912");
  });
  it("skips the header and non-running ('-') entries; null when nothing matches", () => {
    // Full bundle id only (no generic last-segment) so "App" can't match "Application".
    expect(parseLaunchctlPid(OUT, ["com.other.App"])).toBeNull();
  });
});

describe("PMT:sleek-vault parseDevicectlPid (device)", () => {
  const OUT = [
    "1    /sbin/launchd",
    "860    /private/var/containers/Bundle/Application/2497E5CF/NoSky.app/NoSky",
  ].join("\n");

  it("finds the PID whose executable PATH matches (by bundle-id basename)", () => {
    expect(parseDevicectlPid(OUT, candidatesFor("simonfortelny.NoSky"))).toBe("860");
  });
  it("null when no path matches", () => {
    expect(parseDevicectlPid(OUT, candidatesFor("com.other.App"))).toBeNull();
  });
});

describe("PMT:sleek-vault resolveAttachTarget", () => {
  it("passes a numeric PID straight through (no lookup / no shell-out)", async () => {
    await expect(resolveAttachTarget("88912", "SOME-UDID")).resolves.toBe("88912");
    await expect(resolveAttachTarget("  88912 ", "SOME-UDID")).resolves.toBe("88912");
  });
});
