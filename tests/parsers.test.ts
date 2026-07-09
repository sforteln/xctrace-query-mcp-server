/**
 * Snapshot tests for parseTableStream and parseTrackDetailStream — the only
 * XML-to-object parsing path since PMT:black-jay removed DOM/fast-xml-parser
 * row parsing (parseTableXml/parseTrackDetailXml).
 *
 * Fixtures live in tests/fixtures/<xcode-version>/{schema-table,track-detail}/<name>.xml.
 * The xcode version in the path is informational — tests always run against
 * every fixture in the tree, regardless of the local Xcode version.
 *
 * To update snapshots after a parser change: vitest run --update-snapshots
 * To add a new fixture: export XML from xctrace and drop it in the correct subdirectory.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename, relative } from "node:path";
import { Readable } from "node:stream";
import { describe, it, expect } from "vitest";

import { parseTableStream } from "../src/engine/parseTable.js";
import { parseTrackDetailStream } from "../src/engine/parseTrackDetail.js";

// ─── Fixture discovery ────────────────────────────────────────────────────────

const FIXTURES_ROOT = new URL("./fixtures", import.meta.url).pathname;

interface Fixture {
  /** Human-readable label: "xcode-16.0 / schema-table / ModelInferenceTable" */
  label: string;
  kind: "schema-table" | "track-detail";
  /** Synthetic schema name derived from filename. "__" in name becomes "/" (trackName/detailName). */
  schema: string;
  xml: string;
}

function collectFixtures(dir: string): Fixture[] {
  const fixtures: Fixture[] = [];

  function walk(current: string): void {
    for (const entry of readdirSync(current)) {
      const fullPath = join(current, entry);
      if (statSync(fullPath).isDirectory()) {
        walk(fullPath);
      } else if (entry.endsWith(".xml")) {
        const rel = relative(FIXTURES_ROOT, fullPath);
        // rel = "xcode-16.0/schema-table/ModelInferenceTable.xml"
        const parts = rel.split("/");
        const kindSegment = parts[parts.length - 2];
        if (kindSegment !== "schema-table" && kindSegment !== "track-detail") continue;

        const schemaFile = basename(entry, ".xml");
        const schema = schemaFile.replace(/__/g, "/");
        const label = parts.join(" / ").replace(".xml", "");

        fixtures.push({
          label,
          kind: kindSegment as "schema-table" | "track-detail",
          schema,
          xml: readFileSync(fullPath, "utf8"),
        });
      }
    }
  }

  walk(dir);
  return fixtures;
}

const fixtures = collectFixtures(FIXTURES_ROOT);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("parser snapshots", () => {
  for (const fixture of fixtures) {
    it(fixture.label, async () => {
      const result =
        fixture.kind === "schema-table"
          ? await parseTableStream(Readable.from([fixture.xml]))
          : await parseTrackDetailStream(Readable.from([fixture.xml]), fixture.schema);

      expect(result).toMatchSnapshot();
    });
  }
});
