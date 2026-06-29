/**
 * listInstruments — cheap per-run schema inventory.
 *
 * All data comes from the session TOC and instruments summary (populated by
 * openTrace). No xctrace calls are made. Row counts are included when a table
 * has already been fetched; null otherwise.
 *
 * Multi-run support: groups schemas by run, marks schemas that do not appear in
 * every run, and generates a crossRunDiff note so the agent can see at a glance
 * which run has which instruments.
 */
import { getSession, lastRun as sessionLastRun } from "../engine/session.js";
import { findOne } from "../engine/schemaModel.js";
import { resolveRules, type RulesConfidence } from "../engine/versionRules.js";

export interface SchemaInfo {
  schema: string;
  /** "schema-table" = /data/table format; "track-detail" = /tracks/track/details/detail format. */
  source: "schema-table" | "track-detail";
  rowCount: number | null;
  documentation: string | null;
  hasCallstack: boolean;
  isFoundationModels: boolean;
  /**
   * False when this schema is absent from at least one run — signals the agent
   * that picking the right run matters for this table.
   */
  presentInAllRuns: boolean;
  /** The rules-version governing parsing for this schema (e.g. "27.0"). */
  rulesVersion: string;
  /**
   * "verified" — this (rulesVersion, schema) has a fixture and is known good.
   * "nearest"  — fell back to an adjacent Xcode version; behaviour may differ.
   */
  confidence: RulesConfidence;
}

export interface RunGroup {
  run: number;
  schemas: SchemaInfo[];
}

export interface ListInstrumentsResult {
  tracePath: string;
  runCount: number;
  lastRun: number;
  runs: RunGroup[];
  /**
   * Human-readable diff note — present only when runs differ in their schema
   * sets. E.g. "All runs share: ModelInferenceTable. Run 3 adds: time-sample,
   * context-switch-sample."
   */
  crossRunDiff?: string;
  xcodeVersion: string | null;
}

export function listInstruments(sessionId: string): ListInstrumentsResult {
  const session = getSession(sessionId);
  const lastRun = sessionLastRun(sessionId);

  // Ordered, unique run numbers ascending.
  const runNumbers = [...new Set(session.runs.map((r) => r.number))].sort(
    (a, b) => a - b
  );

  // Schema set per run (preserving order from session.instruments).
  const schemasByRun = new Map<number, string[]>();
  for (const run of runNumbers) {
    schemasByRun.set(
      run,
      session.instruments.filter((i) => i.run === run).map((i) => i.schema)
    );
  }

  // Schemas present in ALL runs (intersection).
  const firstRunSchemas = new Set(schemasByRun.get(runNumbers[0]) ?? []);
  const commonSchemas = runNumbers.reduce<Set<string>>((acc, run) => {
    const runSet = new Set(schemasByRun.get(run) ?? []);
    return new Set([...acc].filter((s) => runSet.has(s)));
  }, firstRunSchemas);

  // Build per-run groups, enriching from schemaModel TOC metadata.
  const xcodeVersion = session.xcodeVersion ?? "";

  const runs: RunGroup[] = runNumbers.map((run) => {
    const runInstruments = session.instruments.filter((i) => i.run === run);
    return {
      run,
      schemas: runInstruments.map((inst) => {
        const entry = findOne(session.schemaModel, run, inst.schema);
        const { rulesVersion, confidence } = resolveRules(xcodeVersion, inst.schema);
        return {
          schema: inst.schema,
          source: entry?.source ?? "schema-table",
          rowCount: inst.rowCount,
          documentation: entry?.toc.documentation ?? null,
          hasCallstack: (entry?.toc.callstack ?? null) !== null,
          isFoundationModels: (entry?.toc.swiftTable ?? null) !== null,
          presentInAllRuns: commonSchemas.has(inst.schema),
          rulesVersion,
          confidence,
        };
      }),
    };
  });

  // Cross-run diff note — only when schema sets differ.
  let crossRunDiff: string | undefined;
  if (runNumbers.length > 1) {
    const diffParts: string[] = [];
    for (const run of runNumbers) {
      const runSchemas = schemasByRun.get(run) ?? [];
      const additions = runSchemas.filter((s) => !commonSchemas.has(s));
      if (additions.length > 0) {
        diffParts.push(`run ${run} adds: ${additions.join(", ")}`);
      }
    }
    if (diffParts.length > 0) {
      const commonList = [...commonSchemas];
      const baseNote =
        commonList.length > 0
          ? `All runs share: ${commonList.join(", ")}. `
          : "Runs have no schemas in common. ";
      crossRunDiff = baseNote + diffParts.join("; ") + ".";
    }
  }

  return {
    tracePath: session.tracePath,
    runCount: runNumbers.length,
    lastRun,
    runs,
    ...(crossRunDiff !== undefined ? { crossRunDiff } : {}),
    xcodeVersion: session.xcodeVersion,
  };
}
