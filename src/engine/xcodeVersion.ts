/**
 * Xcode version detection — runs once and caches for the process lifetime.
 *
 * `xcodebuild -version` outputs:
 *   Xcode 16.2
 *   Build version 16C5032a
 *
 * We extract the version number ("16.2") and cache it. If xcodebuild is
 * unavailable (CI without Xcode, or CLI tools not installed), we cache null
 * and return it without throwing.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// undefined = not yet detected; null = unavailable; string = version
let cached: string | null | undefined = undefined;

/**
 * Return the installed Xcode version string (e.g. "16.2"), or null if
 * xcodebuild is not available. The result is cached after the first call —
 * xcodebuild is never invoked more than once per process.
 */
export async function detectXcodeVersion(): Promise<string | null> {
  if (cached !== undefined) return cached;
  try {
    const { stdout } = await execFileAsync("xcodebuild", ["-version"]);
    const match = /^Xcode\s+(\S+)/m.exec(stdout);
    cached = match ? match[1] : null;
  } catch {
    cached = null;
  }
  return cached;
}
