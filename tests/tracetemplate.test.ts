/**
 * PMT:pine-basin — the NSKeyedArchiver .tracetemplate decoder.
 *
 * These tests run WITHOUT shelling out to `plutil` (that's the only part of
 * decodeTraceTemplate that touches the OS): parsePlistXml and resolveArchive
 * are exercised directly, over an inline XML snippet, a hand-built archive
 * graph (all container kinds + a reference cycle), and a committed golden
 * fixture captured from a real stock template.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  parsePlistXml,
  resolveArchive,
  templateInstruments,
  type ArchivePlist,
  type DecodedTemplate,
} from "../src/core/tracetemplate.js";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "tracetemplate");

describe("parsePlistXml — Apple XML plist → JS tree", () => {
  it("parses every plist value kind, and CF$UID falls out as a plain { CF$UID } object", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>str</key><string>hello</string>
  <key>int</key><integer>42</integer>
  <key>real</key><real>1.5</real>
  <key>yes</key><true/>
  <key>no</key><false/>
  <key>ref</key><dict><key>CF$UID</key><integer>7</integer></dict>
  <key>list</key>
  <array>
    <string>a</string>
    <integer>1</integer>
  </array>
  <key>blob</key><data>aGk=</data>
</dict>
</plist>`;
    const v = parsePlistXml(xml) as Record<string, unknown>;
    expect(v.str).toBe("hello");
    expect(v.int).toBe(42);
    expect(v.real).toBe(1.5);
    expect(v.yes).toBe(true);
    expect(v.no).toBe(false);
    expect(v.ref).toEqual({ "CF$UID": 7 });
    expect(v.list).toEqual(["a", 1]);
    expect(Buffer.isBuffer(v.blob)).toBe(true);
    expect((v.blob as Buffer).toString("utf8")).toBe("hi");
  });
});

describe("resolveArchive — NSKeyedArchiver graph resolution", () => {
  // A hand-built archive graph exercising every container kind plus a cycle.
  //   idx 0  "$null"
  //   idx 1  "hello"              (bare string in the object table)
  //   idx 2  NSMutableString "world"
  //   idx 3  NSArray [ ->1, ->2 ]
  //   idx 4  NSSet   [ ->1 ]
  //   idx 5  NSOrderedSet [ ->2, ->1 ]  (NS.object.0 / NS.object.1)
  //   idx 6  NSData
  //   idx 7  NSDictionary { "k" -> "hello" }
  //   idx 8  XRThing { name->1, count:42, flag:true, self->8 (CYCLE), peer->9 }
  //   idx 9  XRThing2 { back->8 (CYCLE) }
  //   idx 10..18 class defs
  const classDef = (name: string) => ({ $classname: name, $classes: [name] });
  const ref = (n: number) => ({ "CF$UID": n });
  const plist: ArchivePlist = {
    $archiver: "NSKeyedArchiver",
    $version: 100000,
    $top: { root: ref(8), arr: ref(3), set: ref(4), oset: ref(5), dict: ref(7) },
    $objects: [
      "$null", // 0
      "hello", // 1
      { $class: ref(11), "NS.string": "world" }, // 2 NSMutableString
      { $class: ref(12), "NS.objects": [ref(1), ref(2)] }, // 3 NSArray
      { $class: ref(13), "NS.objects": [ref(1)] }, // 4 NSSet
      { $class: ref(14), "NS.object.0": ref(2), "NS.object.1": ref(1) }, // 5 NSOrderedSet
      { $class: ref(15), "NS.data": Buffer.from("xy") }, // 6 NSData
      { $class: ref(16), "NS.keys": [ref(1)], "NS.objects": [ref(1)] }, // 7 NSDictionary {"hello":"hello"}
      { $class: ref(17), name: ref(1), count: 42, flag: true, self: ref(8), peer: ref(9) }, // 8 XRThing (self-cycle)
      { $class: ref(18), back: ref(8) }, // 9 XRThing2 (back-cycle)
      classDef("NSObject"), // 10 (unused)
      classDef("NSMutableString"), // 11
      classDef("NSArray"), // 12
      classDef("NSSet"), // 13
      classDef("NSOrderedSet"), // 14
      classDef("NSData"), // 15
      classDef("NSDictionary"), // 16
      classDef("XRThing"), // 17
      classDef("XRThing2"), // 18
    ],
  };

  const top = resolveArchive(plist);

  it("resolves NS containers to plain objects/arrays/strings", () => {
    expect(top.arr).toEqual(["hello", "world"]);
    expect(top.set).toEqual(["hello"]);
    expect(top.oset).toEqual(["world", "hello"]); // NS.object.0, NS.object.1 order preserved
    expect(top.dict).toEqual({ hello: "hello" });
  });

  it("surfaces a private class as { __class__, …fields } following refs", () => {
    const root = top.root as Record<string, unknown>;
    expect(root.__class__).toBe("XRThing");
    expect(root.name).toBe("hello");
    expect(root.count).toBe(42);
    expect(root.flag).toBe(true);
  });

  it("breaks reference cycles by returning the same instance, not recursing forever", () => {
    const root = top.root as Record<string, unknown>;
    // self-cycle: root.self IS root
    expect(root.self).toBe(root);
    // mutual cycle: root.peer.back IS root
    const peer = root.peer as Record<string, unknown>;
    expect(peer.__class__).toBe("XRThing2");
    expect(peer.back).toBe(root);
  });
});

describe("decoder golden fixture — real Foundation Models template", () => {
  const xml = readFileSync(join(FIXTURE_DIR, "foundation-models.plist.xml"), "utf8");
  const plist = parsePlistXml(xml) as ArchivePlist;
  const decoded: DecodedTemplate = {
    archiver: plist.$archiver!,
    version: Number(plist.$version),
    objectCount: plist.$objects.length,
    top: resolveArchive(plist),
  };

  it("recognizes it as an NSKeyedArchiver archive", () => {
    expect(decoded.archiver).toBe("NSKeyedArchiver");
    expect(decoded.version).toBe(100000);
    expect(decoded.objectCount).toBeGreaterThan(50);
  });

  it("enumerates the bundled instruments from stubInfoByUUID", () => {
    // The stock Foundation Models template bundles exactly ONE instrument —
    // "Foundation Models" itself (the many FM tables/schemas are what that one
    // instrument emits, not separately-bundled instruments). This is the
    // authoritative answer the recording-options preview can't give.
    const instruments = templateInstruments(decoded);
    expect(instruments).toEqual([
      { identifier: "com.apple.FoundationModels", name: "Foundation Models" },
    ]);
  });
});
