/**
 * listDevices — enumerate recordable targets (the host Mac, physical iOS
 * devices, and booted/shutdown Simulators) by shelling out to
 * `xcrun xctrace list devices`.
 *
 * Unlike listInstruments (which reads an OPEN trace's session state), this makes
 * no session assumptions — it's the "discover a target before picking a `device`
 * value" step, mirroring list_instruments' cheap-enumeration shape but for the
 * recording side (PMT:gravel-kite).
 *
 * `xctrace list devices` groups output into three sections — `== Devices ==`
 * (online, INCLUDING the host Mac), `== Devices Offline ==`, and
 * `== Simulators ==`. A physical device line carries an `(<os>)` version before
 * its `(<udid>)`; the host Mac line has no version. Simulator booted-state isn't
 * in that output, so it's cross-referenced from `simctl list devices booted`.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pExecFile = promisify(execFile);

export type DeviceKind = "mac" | "device" | "simulator";
export type DeviceState = "online" | "offline" | "booted" | "shutdown";

export interface DeviceInfo {
  name: string;
  udid: string;
  kind: DeviceKind;
  /** OS version (e.g. "27.0"); null for the host Mac. */
  os: string | null;
  state: DeviceState;
}

export interface ListDevicesResult {
  devices: DeviceInfo[];
  /** Actionable guidance when relevant (e.g. offline physical devices). */
  note?: string;
}

/** Split a device line into its trailing "(...)" group (the UDID) and the rest. */
function splitTrailingParen(line: string): { head: string; last: string } | null {
  const m = line.match(/^(.*)\(([^()]+)\)\s*$/);
  if (!m) return null;
  return { head: m[1].trim(), last: m[2].trim() };
}

/** If the name ends in "(<version>)", peel it off as the OS version. */
function peelOsVersion(name: string): { name: string; os: string | null } {
  const m = name.match(/^(.*)\((\d+(?:\.\d+)*)\)\s*$/);
  if (!m) return { name: name.trim(), os: null };
  return { name: m[1].trim(), os: m[2] };
}

/**
 * Parse `xctrace list devices` stdout into structured DeviceInfo[]. Exported for
 * unit testing against a captured fixture (no live devices needed).
 */
export function parseDevicesOutput(stdout: string, bootedUdids: Set<string>): DeviceInfo[] {
  const devices: DeviceInfo[] = [];
  let section: "devices" | "offline" | "simulators" | null = null;
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const sec = line.match(/^==\s*(.+?)\s*==$/);
    if (sec) {
      const label = sec[1].toLowerCase();
      section = label.startsWith("devices offline")
        ? "offline"
        : label.startsWith("simulators")
          ? "simulators"
          : label.startsWith("devices")
            ? "devices"
            : null;
      continue;
    }
    if (!section) continue;
    const split = splitTrailingParen(line);
    if (!split) continue;
    const udid = split.last;
    const { name, os } = peelOsVersion(split.head);
    if (!name) continue;
    if (section === "simulators") {
      devices.push({
        name,
        udid,
        kind: "simulator",
        os,
        state: bootedUdids.has(udid) ? "booted" : "shutdown",
      });
    } else {
      // Devices / Devices Offline: a line with NO OS version is the host Mac.
      const kind: DeviceKind = os === null ? "mac" : "device";
      const state: DeviceState = section === "offline" ? "offline" : "online";
      devices.push({ name, udid, kind, os, state });
    }
  }
  return devices;
}

/** UDIDs of currently-booted simulators, from `simctl list devices booted`. */
async function bootedSimulatorUdids(): Promise<Set<string>> {
  try {
    const { stdout } = await pExecFile("xcrun", ["simctl", "list", "devices", "booted"]);
    const udids = new Set<string>();
    for (const m of stdout.matchAll(/\(([0-9A-Fa-f-]{36})\)\s*\(Booted\)/g)) {
      udids.add(m[1]);
    }
    return udids;
  } catch {
    return new Set(); // simctl unavailable → treat all sims as shutdown
  }
}

/**
 * Whether a `device` value (name or UDID given to start_recording/record) names
 * an iOS Simulator. LIVE (no cache) — used to recognize the "Simulator launched
 * but the injection instrument captured nothing" edge case (PMT:gravel-kite) and
 * turn xctrace's diagnostic-free exit into actionable guidance. Best-effort:
 * returns false on any lookup failure rather than throwing.
 */
export async function isSimulatorTarget(device: string): Promise<boolean> {
  if (!device) return false;
  try {
    const { devices } = await listDevices();
    const needle = device.trim().toLowerCase();
    return devices.some(
      (d) =>
        d.kind === "simulator" &&
        (d.udid.toLowerCase() === needle || d.name.toLowerCase().includes(needle))
    );
  } catch {
    return false;
  }
}

export async function listDevices(): Promise<ListDevicesResult> {
  const { stdout } = await pExecFile("xcrun", ["xctrace", "list", "devices"]);
  const booted = await bootedSimulatorUdids();
  const devices = parseDevicesOutput(stdout, booted);

  // Offline physical devices are a RECOVERABLE state, not "no device" — surface
  // the fix instead of silently dropping them (self-describing negative).
  const offline = devices.filter((d) => d.state === "offline" && d.kind === "device");
  let note: string | undefined;
  if (offline.length > 0) {
    note =
      `${offline.length} physical device(s) are OFFLINE and can't be targeted yet ` +
      `(${offline.map((d) => d.name).join(", ")}) — connect via USB, unlock the device, ` +
      `and tap "Trust This Computer", then re-run list_devices.`;
  }
  return { devices, ...(note !== undefined ? { note } : {}) };
}
