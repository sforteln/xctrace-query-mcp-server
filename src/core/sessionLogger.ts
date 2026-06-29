/**
 * Session call logger for A/B testing tool navigation behaviour.
 *
 * Activated by passing --log on the command line when starting the server:
 *   npx instruments-mcp-server --log
 * When enabled, every tool call is appended as a JSON line to:
 *   ~/Library/Logs/instruments-mcp-server/session-<timestamp>.jsonl
 *
 * Each line:
 *   { seq, ts, tool, args, responseKeys, durationMs, ok }
 *
 * Use this to compare unprimed vs. primed AI call sequences:
 *   - Unprimed: let the AI navigate naturally, review the log after.
 *   - Primed: ask the AI to explain its choices, log that session separately.
 * Diff the two sequence files to measure how much priming changes call order
 * and tool selection (especially generic query/aggregate vs. lens tools).
 *
 * args are sanitized: strings longer than 120 chars are truncated.
 * responseKeys: top-level keys of the parsed JSON response (not full content).
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const LOG_DIR = join(homedir(), "Library", "Logs", "instruments-mcp-server");
const enabled = process.argv.includes("--log");

let logPath: string | null = null;
let seq = 0;

function logFilePath(): string {
  if (logPath) return logPath;
  mkdirSync(LOG_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  logPath = join(LOG_DIR, `session-${ts}.jsonl`);
  return logPath;
}

export function logToolCall(
  tool: string,
  args: Record<string, unknown>,
  responseText: string | null,
  durationMs: number,
  ok: boolean
): void {
  if (!enabled) return;
  const entry = {
    seq: ++seq,
    ts: new Date().toISOString(),
    tool,
    args: sanitizeArgs(args),
    responseKeys: extractResponseKeys(responseText),
    durationMs,
    ok,
  };
  appendFileSync(logFilePath(), JSON.stringify(entry) + "\n");
}

function sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string" && v.length > 120) {
      out[k] = v.slice(0, 120) + "…";
    } else {
      out[k] = v;
    }
  }
  return out;
}

function extractResponseKeys(responseText: string | null): string[] {
  if (!responseText) return [];
  try {
    const parsed = JSON.parse(responseText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.keys(parsed);
    }
  } catch {
    // non-JSON response (error text etc.)
  }
  return [];
}
