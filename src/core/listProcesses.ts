/**
 * Process discovery for `list_processes` / the `attach` param's PID resolution.
 *
 * Previously the search and list-all cases sourced process info two
 * different ways — `pgrep -fl` (search) vs `ps -axo pid,user,args` (no
 * search) — and `pgrep -l` has no STAT column, so a zombie/defunct process
 * (already exited — unattachable and unkillable, waiting only for its
 * parent to reap it) was indistinguishable from a live one in the response
 * (PMT:ash-lagoon: a real xcodeAI session hit exactly this, guessed the dead
 * PID, and wasted a round-trip). Unified on `ps -axo pid,user,stat,args` for
 * both cases, filtering by search substring in JS instead of shelling out to
 * pgrep a second way.
 */

export interface ProcessInfo {
  pid: number;
  name: string;
  command: string;
  /** Human-readable process state, derived from ps's STAT column. */
  status: string;
  /** Present only for zombies — guidance needed BEFORE the AI tries attach/kill. */
  note?: string;
}

const SYSTEM_PREFIXES = ["/System/", "/usr/", "/sbin/", "/bin/", "sysmond", "launchd"];

const ZOMBIE_NOTE =
  "This process has already exited (zombie/defunct) — it cannot be attached to and cannot be killed " +
  "(there is no live process left to signal). It clears automatically once its parent process reaps it.";

/** Map ps's STAT column (leading character is the run state) to a readable label. */
export function statusFromStat(stat: string | undefined): string {
  switch (stat?.charAt(0)) {
    case "R": return "running";
    case "S": return "sleeping";
    case "I": return "idle";
    case "T": return "stopped";
    case "U": return "waiting"; // uninterruptible wait, e.g. disk I/O
    case "Z": return "zombie";
    default: return "unknown";
  }
}

/**
 * Parse `ps -axo pid,user,stat,args` output into filtered, labeled rows.
 *
 * `search`, when present, matches case-insensitively anywhere in the command
 * line and does NOT restrict to `currentUser` — mirrors the old `pgrep -f`
 * behavior, which could find any user's process, not just the caller's own.
 * `pgrep -f` treated its argument as a regex; this does a plain substring
 * match instead, matching the tool's own description ("substring") and
 * avoiding regex-metacharacter surprises (e.g. a "." in a bundle ID).
 * Omitting search lists only `currentUser`'s non-system processes, same as
 * before.
 */
export function parsePsOutput(
  stdout: string,
  opts: { currentUser: string; search?: string }
): ProcessInfo[] {
  const searchLower = opts.search?.toLowerCase();

  return stdout
    .split("\n")
    .slice(1) // header row
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const cols = l.split(/\s+/);
      return { pid: Number(cols[0]), user: cols[1], stat: cols[2], command: cols.slice(3).join(" ") };
    })
    .filter((p) => {
      if (p.command.includes("xctrace") || p.command.includes("instruments-mcp-server")) return false;
      if (searchLower !== undefined) return p.command.toLowerCase().includes(searchLower);
      return p.user === opts.currentUser && !SYSTEM_PREFIXES.some((prefix) => p.command.startsWith(prefix));
    })
    .map((p) => {
      const name = p.command.split("/").pop()?.split(" ")[0] ?? p.command;
      const status = statusFromStat(p.stat);
      const info: ProcessInfo = { pid: p.pid, name, command: p.command, status };
      if (status === "zombie") info.note = ZOMBIE_NOTE;
      return info;
    });
}
