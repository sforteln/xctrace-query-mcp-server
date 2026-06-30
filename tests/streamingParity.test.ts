/**
 * Equivalence tests for the SAX-streaming parsers against the existing
 * string/DOM-based parsers, using the same fixtures parsers.test.ts snapshots.
 *
 * parseTableStream / parseTrackDetailStream exist so multi-GB table exports
 * (which blow Node's execFile maxBuffer and fast-xml-parser's DOM-style
 * materialization) can be parsed without holding the whole document in memory.
 * These tests prove the streaming path produces byte-for-byte identical
 * ParsedTable output to the original parser on every known-good fixture,
 * before relying on it for production traffic.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename, relative } from "node:path";
import { Readable } from "node:stream";
import { describe, it, expect } from "vitest";

import { parseTableXml, parseTableStream } from "../src/engine/parseTable.js";
import { parseTrackDetailXml, parseTrackDetailStream } from "../src/engine/parseTrackDetail.js";

const FIXTURES_ROOT = new URL("./fixtures", import.meta.url).pathname;

interface Fixture {
  label: string;
  kind: "schema-table" | "track-detail";
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

describe("streaming parser parity with the string-based parser", () => {
  for (const fixture of fixtures) {
    it(fixture.label, async () => {
      if (fixture.kind === "schema-table") {
        const expected = parseTableXml(fixture.xml);
        const actual = await parseTableStream(Readable.from([fixture.xml]));
        expect(actual).toEqual(expected);
      } else {
        const expected = parseTrackDetailXml(fixture.xml, fixture.schema);
        const actual = await parseTrackDetailStream(Readable.from([fixture.xml]), fixture.schema);
        expect(actual).toEqual(expected);
      }
    });
  }
});
