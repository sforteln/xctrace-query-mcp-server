/**
 * resolveAttachTarget — turn an attach target (CFBundleIdentifier, app name, or
 * PID) into a live PID for a device/Simulator recording, so far-swan attaches by
 * PID (PMT:sleek-vault).
 *
 * Why this exists: xctrace's attach-by-NAME does NOT resolve on a device or
 * Simulator even when the named process is running (verified — "cannot find
 * process matching name"), and the name a human/AI reads off the Home Screen or
 * Instruments' process picker is CFBundleDisplayName ("Goldfish"), NOT the
 * process's CFBundleExecutable ("NoSky") — the trap every caller falls into. So
 * the caller passes the stable CFBundleIdentifier and far-swan finds the PID via
 * the platform's own tools:
 *   - Simulator: `simctl spawn <udid> launchctl list` — the launchd LABEL carries
 *     the bundle id (ps-via-spawn is unreliable on modern sims).
 *   - Device:    `devicectl device info processes --device <udid>` — match the
 *     app's executable path.
 *
 * The app must already be RUNNING: far-swan attaches to a dev-started app, it
 * never launches/deploys (a freshly-launched PID isn't immediately attachable —
 * attach a STABLE instance). On the host Mac attach-by-name works, so the caller
 * path skips this for Mac targets.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { XctraceError } from "../engine/xctrace.js";
import { isSimulatorTarget } from "./listDevices.js";

const pExecFile = promisify(execFile);

/**
 * Match candidates for a target: the target verbatim, plus the last dot-segment
 * of a bundle id (so "simonfortelny.NoSky" also matches an executable path
 * ".../NoSky.app/NoSky" whose basename is just "NoSky").
 */
export function candidatesFor(target: string): string[] {
  const t = target.trim();
  const cands = [t];
  if (t.includes(".")) {
    const last = t.split(".").pop();
    if (last && last !== t) cands.push(last);
  }
  return cands;
}

/**
 * PID from `simctl spawn <udid> launchctl list` output — the first column of a
 * line whose launchd LABEL (e.g. "UIKitApplication:simonfortelny.NoSky[..]")
 * matches a candidate. Skips the header and non-running ("-") entries.
 */
export function parseLaunchctlPid(output: string, candidates: string[]): string | null {
  const needles = candidates.map((c) => c.toLowerCase());
  for (const line of output.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 3) continue;
    const pid = cols[0];
    const label = cols.slice(2).join(" ").toLowerCase();
    if (/^\d+$/.test(pid) && needles.some((n) => label.includes(n))) return pid;
  }
  return null;
}

/** Escape a string for literal use inside a RegExp. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * PID from `devicectl device info processes` output — the leading number of a
 * line whose executable PATH contains a candidate as a WHOLE path component
 * ("/<cand>.app/" or a "/<cand>" basename). A loose substring would let a
 * short/generic bundle-id segment like "App" false-match ".app/".
 */
export function parseDevicectlPid(output: string, candidates: string[]): string | null {
  const res = candidates.map((c) => new RegExp(`/${escapeRegex(c)}(\\.app/|$)`, "i"));
  for (const line of output.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!m) continue;
    const [, pid, path] = m;
    if (res.some((re) => re.test(path))) return pid;
  }
  return null;
}

/**
 * Resolve `attach` (PID | CFBundleIdentifier | app name) to a live PID on the
 * given device/Simulator. A numeric value is already a PID and is returned as-is.
 * Throws a `target-not-found` XctraceError (steering to "start the app first")
 * when no running process matches.
 */
export async function resolveAttachTarget(attach: string, device: string): Promise<string> {
  const t = attach.trim();
  if (/^\d+$/.test(t)) return t; // already a PID

  const cands = candidatesFor(t);
  let pid: string | null = null;
  if (await isSimulatorTarget(device)) {
    try {
      const { stdout } = await pExecFile("xcrun", ["simctl", "spawn", device, "launchctl", "list"]);
      // launchd LABELs carry the FULL bundle id, so match the full target — a
      // generic last-segment ("App") would false-match "UIKitApplication".
      pid = parseLaunchctlPid(stdout, [t]);
    } catch {
      pid = null;
    }
  } else {
    try {
      const { stdout } = await pExecFile("xcrun", [
        "devicectl", "device", "info", "processes", "--device", device,
      ]);
      pid = parseDevicectlPid(stdout, cands);
    } catch {
      pid = null;
    }
  }

  if (!pid) {
    throw new XctraceError(
      "target-not-found",
      `No running process for "${attach}" on device ${device}. far-swan attaches to an app you have ` +
        `ALREADY started — run it (Xcode → Run) on the device/Simulator, then try again. Note: ` +
        `attach-by-NAME doesn't resolve on a device/sim, so far-swan resolves the CFBundleIdentifier to a ` +
        `PID; and the process name is CFBundleExecutable, NOT the display name shown on the Home Screen.`,
      {}
    );
  }
  return pid;
}
