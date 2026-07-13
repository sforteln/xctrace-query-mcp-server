/**
 * listDevices — enumerate recordable targets (the host Mac, physical iOS
 * devices, and booted/shutdown Simulators) by shelling out to
 * `xcrun xctrace list devices`.
 *
 * Unlike listInstruments (which reads an OPEN trace's session state), this makes
 * no session assumptions — it's the "discover a target before picking a `device`
 * value" step, mirroring list_instruments' cheap-enumeration shape but for the
 * recording side.
 *
 * `xctrace list devices` groups output into three sections — `== Devices ==`
 * (online, INCLUDING the host Mac), `== Devices Offline ==`, and
 * `== Simulators ==`. A physical device line carries an `(<os>)` version before
 * its `(<udid>)`; the host Mac line has no version. Simulator booted-state isn't
 * in that output, so it's cross-referenced from `simctl list devices booted`.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { XctraceError } from "../engine/xctrace.js";

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

/**
 * UDIDs of currently-booted simulators, from `simctl list devices booted --json`.
 * The JSON form is sturdier than regex-parsing the text output (per xcodeAI):
 * `{ devices: { "<runtime>": [{ udid, state: "Booted", ... }] } }`.
 */
async function bootedSimulatorUdids(): Promise<Set<string>> {
  try {
    const { stdout } = await pExecFile("xcrun", ["simctl", "list", "devices", "booted", "--json"]);
    const parsed = JSON.parse(stdout) as {
      devices?: Record<string, Array<{ udid?: string; state?: string }>>;
    };
    const udids = new Set<string>();
    for (const list of Object.values(parsed.devices ?? {})) {
      for (const d of list) if (d.state === "Booted" && d.udid) udids.add(d.udid);
    }
    return udids;
  } catch {
    return new Set(); // simctl unavailable / unparseable → treat all sims as shutdown
  }
}

/**
 * Whether a `device` value (name or UDID given to start_recording/record) names
 * an iOS Simulator. LIVE (no cache) — used to recognize the "Simulator launched
 * but the injection instrument captured nothing" edge case and turn xctrace's
 * diagnostic-free exit into actionable guidance. Best-effort: returns false on
 * any lookup failure rather than throwing.
 */
export async function isSimulatorTarget(device: string): Promise<boolean> {
  if (!device) return false;
  try {
    const { devices } = await listDevices();
    return resolveDeviceMatches(devices.filter((d) => d.kind === "simulator"), device).length > 0;
  } catch {
    return false;
  }
}

/**
 * Pure matching logic shared by isSimulatorTarget and assertUnambiguousDevice
 * — mirrors xctrace's own device resolution: a UDID exact match wins
 * outright (never ambiguous even if some OTHER device's NAME happens to also
 * contain that string, since a UDID is the caller's unambiguous
 * disambiguation signal by construction); otherwise every device whose name
 * case-insensitively CONTAINS the needle matches. Exported for direct unit
 * testing against a parsed device list (no live `xctrace`/`simctl` needed).
 */
export function resolveDeviceMatches(devices: DeviceInfo[], device: string): DeviceInfo[] {
  const needle = device.trim().toLowerCase();
  const matches = devices.filter(
    (d) => d.udid.toLowerCase() === needle || d.name.toLowerCase().includes(needle)
  );
  const exactUdid = matches.find((d) => d.udid.toLowerCase() === needle);
  return exactUdid ? [exactUdid] : matches;
}

/**
 * Fail BEFORE spawning xctrace when `device` name-substring-matches more
 * than one real target. Verified live: device:"Simon" matched three targets
 * at once (an iPhone, "Simon's MacBook Air", "Simon's Apple Watch") —
 * start_recording optimistically returned
 * status:"recording" while xctrace was already dead with "Provided device
 * parameter 'Simon' is ambiguous" (exit 28), and the caller only found out
 * 30s later at stop_recording, after driving the app for nothing.
 *
 * Best-effort: a listDevices() failure here must not block a recording that
 * might still succeed — this is a pre-flight convenience check, not the
 * source of truth (xctrace itself remains the backstop for a genuinely
 * malformed device value this check doesn't catch).
 */
export async function assertUnambiguousDevice(device: string | undefined): Promise<void> {
  if (!device) return;
  let devices: DeviceInfo[];
  try {
    ({ devices } = await listDevices());
  } catch {
    return;
  }
  const effective = resolveDeviceMatches(devices, device);
  if (effective.length <= 1) return;
  throw new XctraceError(
    "ambiguous-device",
    `device "${device}" matches ${effective.length} targets (${effective.map((d) => d.name).join(", ")}) — ` +
      "use the UDID instead of a name substring to disambiguate (see list_devices).",
    { deviceMatches: effective.map((d) => ({ name: d.name, udid: d.udid, kind: d.kind })) }
  );
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
