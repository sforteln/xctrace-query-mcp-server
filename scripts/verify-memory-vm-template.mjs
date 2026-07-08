#!/usr/bin/env node
/**
 * Drift guard for the shipped "memory-vm" template (PMT:gold-haven).
 *
 * VM Tracker's "Regions Map" only populates when "Automatic Snapshotting" is
 * enabled — a setting xctrace's own --recording-options can't reach, which is
 * why assets/AllocVMTrackerAuto3s.tracetemplate exists as a custom,
 * offline-validated template in the first place. A future Xcode/xctrace
 * update could silently break either half of that: the template itself (a
 * private, undocumented NSKeyedArchiver format Apple gives no compatibility
 * guarantee on) or far-swan's OWN track-detail parser reading it back. This
 * script is NOT part of `npm test` — it needs a real, non-SIP-restricted
 * local process to attach to and takes several seconds, so it can't be fast
 * or deterministic enough for the CI-run suite (verified live: SIP blocks
 * attaching an injecting instrument like Allocations/VM Tracker to Finder,
 * Xcode itself, and other Apple system binaries — this needs YOUR OWN
 * locally-built dev app, or any other non-hardened process you can attach
 * to). Run this by hand after an Xcode update, or before publishing a new
 * package version.
 *
 * Usage:
 *   npm run build   (must be run first — this imports from dist/)
 *   node scripts/verify-memory-vm-template.mjs <pid>
 *
 * <pid> — PID of an ALREADY-RUNNING, non-SIP-restricted local process (e.g.
 * your own Xcode-built dev app). Exits 0 with "PASS" and the row count on
 * success; exits 1 with a diagnosis on failure.
 */
import { resolveAssetPath } from "../dist/core/assetPaths.js";
import { RECORDING_INTENTS } from "../dist/core/recording.js";
import { startSession, stopSession } from "../dist/core/recordingSession.js";
import { openTrace } from "../dist/engine/session.js";
import { queryTable } from "../dist/core/query.js";
import { existsSync } from "node:fs";

const pid = process.argv[2];
if (!pid || !/^\d+$/.test(pid)) {
  console.error("Usage: node scripts/verify-memory-vm-template.mjs <pid>");
  console.error("  <pid> — an already-running, non-SIP-restricted local process to attach to.");
  process.exit(1);
}

const templatePath = resolveAssetPath("AllocVMTrackerAuto3s.tracetemplate");
if (!existsSync(templatePath)) {
  console.error(`FAIL: template not found at resolved path ${templatePath}`);
  console.error("Did you run `npm run build`? Or is assets/ missing from the checkout?");
  process.exit(1);
}
console.log(`Template resolved: ${templatePath}`);

const intent = RECORDING_INTENTS["memory-vm"];
console.log(`Recording 4s against pid ${pid}...`);
const { recordingId } = await startSession({ intent, attach: pid, timeLimit: "4s" });
await new Promise((r) => setTimeout(r, 5000));
const stopped = await stopSession(recordingId);

if (stopped.status !== "done") {
  console.error(`FAIL: recording did not complete cleanly — status "${stopped.status}"`);
  if (stopped.finalizeWarning) console.error(`finalizeWarning: ${stopped.finalizeWarning}`);
  process.exit(1);
}
console.log(`Recorded: ${stopped.tracePath}`);

const { sessionId, instruments } = await openTrace(stopped.tracePath);
const regionsSchema = instruments.map((i) => i.schema).find((s) => s.toLowerCase().includes("regions"));
if (!regionsSchema) {
  console.error(`FAIL: no "Regions Map" schema found in the recorded trace.`);
  console.error(`Schemas present: ${instruments.map((i) => i.schema).join(", ")}`);
  console.error(`This means VM Tracker's Automatic Snapshotting is NOT populating — the template or xctrace itself regressed.`);
  process.exit(1);
}

const result = await queryTable(sessionId, regionsSchema, { limit: 1 });
if (result.totalRows === 0) {
  console.error(`FAIL: "${regionsSchema}" schema is present but has 0 rows.`);
  console.error("Automatic Snapshotting is not actually capturing data — the template regressed.");
  process.exit(1);
}

console.log(`PASS: "${regionsSchema}" has ${result.totalRows.toLocaleString("en-US")} rows.`);
process.exit(0);
