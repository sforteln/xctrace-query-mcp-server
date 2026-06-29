/**
 * Server-owned runtime config at ~/Library/Application Support/far-swan/config.json.
 *
 * Two-owner model:
 *   Client-owned: `claude mcp add … -- npx instruments-mcp-server` (launch + scope, static)
 *   Server-owned: this file (runtime prefs that must survive the short-lived subprocess)
 *
 * Writes are atomic: write to a .tmp sibling then fs.rename(), which is an
 * atomic inode swap on the same filesystem. A crash mid-write leaves the old
 * file intact.
 */
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

// ─── Schema ───────────────────────────────────────────────────────────────────

export interface ServerConfig {
  /** User-added directories to scan for .trace files. */
  searchRoots: string[];
}

const DEFAULT_CONFIG: ServerConfig = {
  searchRoots: [],
};

// ─── Path ─────────────────────────────────────────────────────────────────────

export function configPath(): string {
  return join(homedir(), "Library", "Application Support", "far-swan", "config.json");
}

// ─── Load ─────────────────────────────────────────────────────────────────────

/**
 * Load config from disk. Returns defaults when the file is missing, empty,
 * or malformed — never throws for expected missing-file conditions.
 */
export async function loadConfig(): Promise<ServerConfig> {
  const path = configPath();
  try {
    const raw = await readFile(path, "utf8");
    if (!raw.trim()) return { ...DEFAULT_CONFIG };
    const parsed = JSON.parse(raw) as Partial<ServerConfig>;
    return {
      searchRoots: Array.isArray(parsed.searchRoots) ? parsed.searchRoots : [],
    };
  } catch (err: unknown) {
    // ENOENT (missing) and SyntaxError (malformed) both get defaults.
    if (isNodeError(err) && err.code === "ENOENT") return { ...DEFAULT_CONFIG };
    if (err instanceof SyntaxError) return { ...DEFAULT_CONFIG };
    throw err;
  }
}

// ─── Save ─────────────────────────────────────────────────────────────────────

/**
 * Atomically save config to disk.
 * Ensures the parent directory exists before writing.
 */
export async function saveConfig(config: ServerConfig): Promise<void> {
  const path = configPath();
  const dir = dirname(path);
  const tmp = path + ".tmp";

  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }

  await writeFile(tmp, JSON.stringify(config, null, 2) + "\n", "utf8");
  await rename(tmp, path);
}

// ─── Process-wide singleton ───────────────────────────────────────────────────

let _config: ServerConfig | null = null;

/** Load once at startup; subsequent calls return the cached value. */
export async function getConfig(): Promise<ServerConfig> {
  if (_config === null) {
    _config = await loadConfig();
  }
  return _config;
}

/** Mutate, persist, and update the in-process cache. */
export async function updateConfig(fn: (c: ServerConfig) => ServerConfig): Promise<ServerConfig> {
  const current = await getConfig();
  const next = fn({ ...current });
  await saveConfig(next);
  _config = next;
  return next;
}

// ─── Util ─────────────────────────────────────────────────────────────────────

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
