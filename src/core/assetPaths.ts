/**
 * PMT:gold-haven — package-relative asset path resolution.
 *
 * far-swan occasionally ships a custom, offline-validated .tracetemplate
 * alongside its own code (see RECORDING_INTENTS' "memory-vm" entry) — a
 * genuinely different, safer risk category than composing a template
 * dynamically at request time (PMT:pine-basin explicitly descoped that): a
 * shipped template was validated ONCE, by a human, in Instruments.app,
 * before it's ever used for anything real.
 *
 * Mirrors serverInfo.ts's MODULE_DIR/REPO_ROOT pattern (the only prior
 * import.meta.url usage in this codebase) — this file compiles to
 * dist/core/assetPaths.js, so package root is two levels up. `assets/` ships
 * as its OWN top-level directory in package.json's "files" array, a sibling
 * of "dist" rather than copied INTO dist/ at build time — one canonical
 * on-disk location for the file, so there's no separate "did you rebuild
 * after editing the template" footgun, and the same relative directory
 * structure (dist/core/../.. == package root) resolves identically whether
 * running from a git checkout or a published npm install.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(MODULE_DIR, "..", "..");

/** Absolute path to a file under this package's `assets/` directory. */
export function resolveAssetPath(filename: string): string {
  return join(PACKAGE_ROOT, "assets", filename);
}
