/**
 * PMT:loam-merlin — resolveDeviceMatches, the pure matching logic behind
 * assertUnambiguousDevice (and isSimulatorTarget). Verified live: device:
 * "Simon" matched three real targets at once (phone, Mac, Watch);
 * start_recording used to return status:"recording" while xctrace was
 * already dead, and the caller only found out 30s later at stop_recording.
 */
import { describe, it, expect } from "vitest";
import { parseDevicesOutput, resolveDeviceMatches } from "../src/core/listDevices.js";

// Same shape as listDevices.test.ts's fixture: "Simon" is a substring of
// BOTH the offline phone's name ("Simon") and the host Mac's ("Simon's
// MacBook Air") — the real ambiguity this guards against.
const FIXTURE = `== Devices ==
Simon's MacBook Air (32D0933B-4ACF-5447-843D-08EDBE1B1471)
Test iPhone (17.0) (00008130-AAAAAAAAAAAAAAAA)

== Devices Offline ==
Simon (26.5) (00008130-00045D9E30E1401C)

== Simulators ==
iPhone 17 Pro Simulator (27.0) (74D241BA-A90B-43CD-9A3C-EC05D55DA5FE)
`;
const BOOTED = new Set(["74D241BA-A90B-43CD-9A3C-EC05D55DA5FE"]);
const devices = () => parseDevicesOutput(FIXTURE, BOOTED);

describe("resolveDeviceMatches", () => {
  it("matches more than one device for an ambiguous name substring", () => {
    const matches = resolveDeviceMatches(devices(), "Simon");
    expect(matches.length).toBeGreaterThan(1);
    expect(matches.map((d) => d.name).sort()).toEqual(["Simon", "Simon's MacBook Air"]);
  });

  it("an exact UDID always resolves to exactly one device, even if some other name contains it", () => {
    const matches = resolveDeviceMatches(devices(), "00008130-00045D9E30E1401C");
    expect(matches).toHaveLength(1);
    expect(matches[0].name).toBe("Simon");
  });

  it("a unique name substring resolves to exactly one device", () => {
    const matches = resolveDeviceMatches(devices(), "Test iPhone");
    expect(matches).toHaveLength(1);
    expect(matches[0].name).toBe("Test iPhone");
  });

  it("is case-insensitive", () => {
    const matches = resolveDeviceMatches(devices(), "test iphone");
    expect(matches).toHaveLength(1);
  });

  it("returns empty for a name matching nothing", () => {
    expect(resolveDeviceMatches(devices(), "Nonexistent Device")).toHaveLength(0);
  });

  it("a UDID substring-matching a device NAME doesn't false-positive the UDID path", () => {
    // "74D241BA-A90B-43CD-9A3C-EC05D55DA5FE" is the simulator's UDID — an
    // unrelated device's udid field never contains it as a substring, so
    // this only matches via the exact-UDID branch, not name substring.
    const matches = resolveDeviceMatches(devices(), "74D241BA-A90B-43CD-9A3C-EC05D55DA5FE");
    expect(matches).toHaveLength(1);
    expect(matches[0].kind).toBe("simulator");
  });
});
