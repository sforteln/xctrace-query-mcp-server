/**
 * Xcode version detection — runs once and caches for the process lifetime.
 *
 * Strategy (tried in order, first success wins):
 *
 * 1. Parse the active Xcode bundle's Info.plist via `xcode-select -p`.
 *    Works for Xcode.app, Xcode-beta.app, and any custom-named bundle,
 *    including setups where `xcode-select` still points at CommandLineTools
 *    but a beta .app exists at a known path. The developer dir
 *    ("/Applications/Xcode-beta.app/Contents/Developer") is walked up
 *    until a ".app" bundle root is found, then PlistBuddy reads the version.
 *
 * 2. Fall back to `xcodebuild -version`. Works when xcode-select points at
 *    full Xcode and xcodebuild is available.
 *
 * Returns null if neither works (CI without Xcode, CLT-only machines).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";

const execFileAsync = promisify(execFile);

// undefined = not yet detected; null = unavailable; string = version
let cached: string | null | undefined = undefined;

async function versionFromXcodeSelect(): Promise<string | null> {
  let devDir: string;
  try {
    const { stdout } = await execFileAsync("xcode-select", ["-p"]);
    devDir = stdout.trim();
  } catch {
    return null;
  }

  // Walk up from the developer dir to find the enclosing .app bundle.
  // "/Applications/Xcode-beta.app/Contents/Developer" → "/Applications/Xcode-beta.app"
  let candidate = devDir;
  let bundlePath: string | null = null;
  while (candidate !== "/" && candidate !== dirname(candidate)) {
    if (candidate.endsWith(".app")) {
      bundlePath = candidate;
      break;
    }
    candidate = dirname(candidate);
  }

  // If xcode-select points at CommandLineTools (no .app in path), look for
  // Xcode bundles in the standard locations. Prefer beta over stable since
  // if both exist the beta is likely what's being used for new traces.
  if (!bundlePath) {
    for (const candidate of [
      "/Applications/Xcode-beta.app",
      "/Applications/Xcode.app",
    ]) {
      const version = await readXcodeVersion(candidate);
      if (version) return version;
    }
    return null;
  }

  return readXcodeVersion(bundlePath);
}

async function readXcodeVersion(bundlePath: string): Promise<string | null> {
  try {
    const plist = join(bundlePath, "Contents", "Info.plist");
    const { stdout } = await execFileAsync("/usr/libexec/PlistBuddy", [
      "-c",
      "Print CFBundleShortVersionString",
      plist,
    ]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function versionFromXcodebuild(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("xcodebuild", ["-version"]);
    const match = /^Xcode\s+(\S+)/m.exec(stdout);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Return the installed Xcode version string (e.g. "27.0"), or null if no
 * Xcode installation is detectable. Cached after the first call.
 */
export async function detectXcodeVersion(): Promise<string | null> {
  if (cached !== undefined) return cached;
  cached = (await versionFromXcodeSelect()) ?? (await versionFromXcodebuild());
  return cached;
}
