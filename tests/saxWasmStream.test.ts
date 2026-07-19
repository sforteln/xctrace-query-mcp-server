/**
 * PMT:amber-spark — sax-wasm tokenizer swap: entity-decoding and event-
 * translation correctness. sax-wasm doesn't decode XML entities itself
 * (verified live against 3.1.4 before writing saxWasmStream.ts) and its
 * OpenTag/CloseTag events carry text differently than sax.js's discrete
 * opentag/text/closetag stream — this locks in both translations.
 */
import { Readable } from "node:stream";
import { describe, it, expect } from "vitest";

import { decodeXmlEntities, saxWasmEvents, type SaxWasmStreamEvent } from "../src/engine/saxWasmStream.js";

describe("decodeXmlEntities", () => {
  it("decodes all five predefined XML entities", () => {
    expect(decodeXmlEntities("&lt;&gt;&amp;&quot;&apos;")).toBe(`<>&"'`);
  });

  it("decodes decimal and hex numeric character references", () => {
    expect(decodeXmlEntities("&#65;&#x42;")).toBe("AB");
  });

  it("leaves an unrecognized named entity verbatim", () => {
    expect(decodeXmlEntities("&nbsp;")).toBe("&nbsp;");
  });

  it("is a no-op on a string with no ampersand (fast path)", () => {
    expect(decodeXmlEntities("plain string")).toBe("plain string");
  });

  it("matches the real fixture case: a Core Data object URI", () => {
    expect(decodeXmlEntities("0xa9178bb8c6eca070 &lt;x-coredata://ABC/Feature/p95&gt;")).toBe(
      "0xa9178bb8c6eca070 <x-coredata://ABC/Feature/p95>"
    );
  });
});

async function collect(xml: string): Promise<SaxWasmStreamEvent[]> {
  const out: SaxWasmStreamEvent[] = [];
  for await (const ev of saxWasmEvents(Readable.from([Buffer.from(xml, "utf8")]))) out.push(ev);
  return out;
}

describe("saxWasmEvents", () => {
  it("translates attributes (with entity-decoding) and a self-closing tag", async () => {
    const events = await collect(`<row address="0x1" label="a &amp; b"/>`);
    expect(events).toEqual([
      { type: "opentag", tag: "row", attributes: { address: "0x1", label: "a & b" } },
      { type: "closetag", tag: "row" },
    ]);
  });

  it("yields text only for a tag that actually has content, in open->text->close order", async () => {
    const events = await collect(`<start-time id="1" fmt="00:06.179.347">6179347166</start-time>`);
    expect(events).toEqual([
      { type: "opentag", tag: "start-time", attributes: { id: "1", fmt: "00:06.179.347" } },
      { type: "text", text: "6179347166" },
      { type: "closetag", tag: "start-time" },
    ]);
  });

  it("decodes entities in text content, not just attributes", async () => {
    const events = await collect(`<string>a &lt;b&gt; c</string>`);
    expect(events).toContainEqual({ type: "text", text: "a <b> c" });
  });

  it("emits no text event for a container tag with only element children (no mixed content)", async () => {
    const events = await collect(`<row><a/><b/></row>`);
    expect(events.filter((e) => e.type === "text")).toEqual([]);
  });

  it("nests correctly for a real backtrace-shaped fragment, including a ref-only frame", async () => {
    const events = await collect(
      `<backtrace><frame id="0" name="fn0" addr="0x100"/><frame ref="0"/></backtrace>`
    );
    expect(events.map((e) => (e.type === "opentag" ? `open:${e.tag}` : e.type === "closetag" ? `close:${e.tag}` : `text:${e.text}`))).toEqual([
      "open:backtrace",
      "open:frame",
      "close:frame",
      "open:frame",
      "close:frame",
      "close:backtrace",
    ]);
  });

  it("parses a document well past the ~2.5KB threshold where sax-wasm's parse(reader) async-generator API broke", async () => {
    // Regression test for a real bug found while writing this adapter:
    // sax-wasm 3.1.4's own documented `parser.parse(reader)` API threw
    // "Cannot perform DataView constructor on a detached ArrayBuffer" on any
    // document past roughly 2.5KB (reproduced live, consistently, on both a
    // real fixture and a synthetic document) — this file drives sax-wasm
    // through its lower-level write()/eventHandler API instead specifically
    // to avoid that bug. This test locks in correct behavior well past that
    // threshold so a future change (e.g. reverting to parse()) can't
    // silently reintroduce it.
    let xml = "<root>";
    for (let i = 0; i < 200; i++) {
      xml += `<row id="${i}" name="item-${i}" value="hello world this is some text"/>`;
    }
    xml += "</root>";
    expect(xml.length).toBeGreaterThan(10_000);

    const events = await collect(xml);
    const rowOpens = events.filter((e) => e.type === "opentag" && e.tag === "row");
    const rowCloses = events.filter((e) => e.type === "closetag" && e.tag === "row");
    expect(rowOpens).toHaveLength(200);
    expect(rowCloses).toHaveLength(200);
    expect((rowOpens[199] as { attributes: Record<string, string> }).attributes).toEqual({
      id: "199",
      name: "item-199",
      value: "hello world this is some text",
    });
  });
});
