/**
 * PMT:gravel-kite — list_devices parser.
 *
 * Pins the classification of `xctrace list devices` output into the host Mac vs
 * physical devices vs simulators, online/offline/booted state, and the trailing-
 * paren UDID extraction (incl. paired "iPhone + Apple Watch" simulator lines,
 * where the UDID must be the simulator's, not the watch's). Fixture-based — no
 * live devices needed.
 */
import { describe, it, expect } from "vitest";
import { parseDevicesOutput } from "../src/core/listDevices.js";

// A representative capture: Mac + an ONLINE physical device (both in Devices, so
// the Mac-vs-device disambiguation by OS-version presence is exercised), an
// offline device, a plain simulator, and a paired iPhone+Watch simulator.
const FIXTURE = `== Devices ==
Simon's MacBook Air (32D0933B-4ACF-5447-843D-08EDBE1B1471)
Test iPhone (17.0) (00008130-AAAAAAAAAAAAAAAA)

== Devices Offline ==
Simon (26.5) (00008130-00045D9E30E1401C)

== Simulators ==
iPhone 17 Pro Simulator (27.0) (74D241BA-A90B-43CD-9A3C-EC05D55DA5FE)
iPhone 17 Simulator (27.0) + Apple Watch Ultra 3 (49mm) (27.0) (DE78AB78-3644-492A-ACE0-8A12799FDF5C)
`;

const BOOTED = new Set(["74D241BA-A90B-43CD-9A3C-EC05D55DA5FE"]);

describe("PMT:gravel-kite list_devices parser", () => {
  const byName = (out: ReturnType<typeof parseDevicesOutput>, needle: string) =>
    out.find((d) => d.name.includes(needle))!;

  it("classifies the host Mac (no OS version) as kind=mac, online", () => {
    const d = byName(parseDevicesOutput(FIXTURE, BOOTED), "MacBook Air");
    expect(d).toMatchObject({ kind: "mac", os: null, state: "online" });
    expect(d.udid).toBe("32D0933B-4ACF-5447-843D-08EDBE1B1471");
  });

  it("classifies an online physical device (has OS version) as kind=device, online", () => {
    const d = byName(parseDevicesOutput(FIXTURE, BOOTED), "Test iPhone");
    expect(d).toMatchObject({ kind: "device", os: "17.0", state: "online" });
  });

  it("marks a device in the Offline section as offline", () => {
    // Exact match: "Simon" (the phone) is a substring of "Simon's MacBook Air"
    // (the Mac) — the very name ambiguity that's why the parser keys on
    // UDID + section, never on name.
    const d = parseDevicesOutput(FIXTURE, BOOTED).find((x) => x.name === "Simon")!;
    expect(d).toMatchObject({ kind: "device", os: "26.5", state: "offline" });
  });

  it("marks a simulator booted only when its UDID is in the booted set", () => {
    const out = parseDevicesOutput(FIXTURE, BOOTED);
    expect(byName(out, "iPhone 17 Pro Simulator")).toMatchObject({ kind: "simulator", state: "booted" });
    const paired = byName(out, "+ Apple Watch");
    expect(paired.state).toBe("shutdown");
  });

  it("takes the simulator's UDID (last paren), not the paired watch's", () => {
    const paired = byName(parseDevicesOutput(FIXTURE, BOOTED), "+ Apple Watch");
    expect(paired.udid).toBe("DE78AB78-3644-492A-ACE0-8A12799FDF5C");
    expect(paired.kind).toBe("simulator");
  });

  it("skips section headers and blank lines (no phantom devices)", () => {
    const out = parseDevicesOutput(FIXTURE, BOOTED);
    expect(out).toHaveLength(5);
    expect(out.some((d) => d.name.includes("=="))).toBe(false);
  });
});
