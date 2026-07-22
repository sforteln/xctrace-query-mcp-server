/**
 * Best-effort extraction of a trace's recording description from
 * form.template — an NSKeyedArchiver-serialized binary plist Instruments
 * writes into every .trace bundle, describing the template/instruments used
 * to record it. Confirmed cheap: `plutil -p` on even a 133MB form.template
 * took ~0.6s in testing, entirely local — no xctrace subprocess involved,
 * unlike every other trace-metadata read in this codebase.
 *
 * NSKeyedArchiver stores object VALUES in a flat $objects array and
 * references them elsewhere via a UID (plutil -p renders this as
 * `<CFKeyedArchiverUID ...>{value = N}`). This resolves exactly ONE such
 * reference — the top-level "com.apple.xray.owner.template.description" key
 * — rather than implementing a general unarchiver; that key was confirmed
 * present and pointing at a plain NS.string object across every trace type
 * checked (SwiftUI, Allocations, System Trace). Returns null on any
 * failure — missing file, unexpected structure, plutil itself missing —
 * this is a manifest enrichment, not a required field.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

const execFileAsync = promisify(execFile);
// plutil -p's TEXT rendering is far smaller than the source plist (a 133MB
// form.template produced ~6MB of text in testing) — 64MB is generous headroom.
const MAX_BUFFER = 64 * 1024 * 1024;

const DESCRIPTION_REF = /"com\.apple\.xray\.owner\.template\.description" => <CFKeyedArchiverUID[^>]*>\{value = (\d+)\}/;

export async function getTraceDescription(tracePath: string): Promise<string | null> {
  const templatePath = join(tracePath, "form.template");
  let dump: string;
  try {
    const { stdout } = await execFileAsync("plutil", ["-p", templatePath], {
      maxBuffer: MAX_BUFFER,
      encoding: "utf8",
    });
    dump = stdout;
  } catch {
    return null;
  }

  const refMatch = dump.match(DESCRIPTION_REF);
  if (!refMatch) return null;
  const targetIndex = refMatch[1];

  const lines = dump.split("\n");
  const startPattern = new RegExp(`^\\s*${targetIndex} => \\{\\s*$`);
  let startLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (startPattern.test(lines[i])) {
      startLine = i;
      break;
    }
  }
  if (startLine === -1) return null;

  // Capture the $objects[targetIndex] block by tracking brace depth until it closes.
  let depth = 0;
  let blockEnd = -1;
  for (let i = startLine; i < lines.length; i++) {
    const opens = (lines[i].match(/\{/g) ?? []).length;
    const closes = (lines[i].match(/\}/g) ?? []).length;
    depth += opens - closes;
    if (depth === 0) {
      blockEnd = i;
      break;
    }
  }
  if (blockEnd === -1) return null;

  const block = lines.slice(startLine, blockEnd + 1).join("\n");
  const stringMatch = block.match(/"NS\.string" => "((?:[^"\\]|\\.)*)"/);
  if (!stringMatch) return null;

  return stringMatch[1].replace(/\\(.)/g, "$1");
}
