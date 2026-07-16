/**
 * Server-owned runtime config at ~/Library/Application Support/xctrace-query-mcp-server/config.json.
 *
 * Two-owner model:
 *   Client-owned: `claude mcp add … -- npx xctrace-query-mcp-server` (launch + scope, static)
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
  /**
   * Fallback cache directory for a persisted trace .db when the trace's own
   * directory isn't writable (a read-only mount, a permissions issue, an
   * Xcode-managed autosave dir). null = use the OS-convention
   * default (`defaultFallbackCacheDir()`); user-configurable via
   * set_cache_dir, mirroring the searchRoots pattern above. See
   * howSessionsWork.md for why each trace gets a persisted SQLite cache at all.
   */
  fallbackCacheDir: string | null;
  /**
   * Directory new recordings are saved to. null = use the
   * set_recordings_dir, mirroring fallbackCacheDir's pattern exactly. Whichever
   * directory is active (default or configured) is always scanned by
   * listTraces/findTrace as a built-in root (discovery.ts) — a recording made
   * in one session must stay discoverable by name in a later one without a
   * separate add_search_root call for the server's own output directory.
   */
  recordingsDir: string | null;
}

const DEFAULT_CONFIG: ServerConfig = {
  searchRoots: [],
  fallbackCacheDir: null,
  recordingsDir: null,
};

// ─── Path ─────────────────────────────────────────────────────────────────────

export function configPath(): string {
  return join(homedir(), "Library", "Application Support", "xctrace-query-mcp-server", "config.json");
}

/** OS-convention default for the fallback trace-cache directory — sibling to config.json. */
export function defaultFallbackCacheDir(): string {
  return join(homedir(), "Library", "Application Support", "xctrace-query-mcp-server", "trace-cache");
}

/** OS-convention default for where new recordings are saved — sibling to config.json. */
export function defaultRecordingsDir(): string {
  return join(homedir(), "Library", "Application Support", "xctrace-query-mcp-server", "recordings");
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
      fallbackCacheDir: typeof parsed.fallbackCacheDir === "string" ? parsed.fallbackCacheDir : null,
      recordingsDir: typeof parsed.recordingsDir === "string" ? parsed.recordingsDir : null,
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
