/**
 * sax-wasm-backed tokenizer, translated to the same {opentag, text, closetag}
 * event vocabulary sax.js's event stream gave — a drop-in swap for callers
 * already driving a pathStack/MiniXmlBuilder state machine from that
 * vocabulary (parseTable.ts, parseTrackDetail.ts). See PMT:amber-spark: a
 * CPU profile of real track-detail ingestion found sax.js's own tokenizing
 * internals responsible for ~55% of all Node-side CPU time; sax-wasm
 * (Rust/WASM) benchmarks ~4x faster.
 *
 * Real gaps a naive port would miss, found via live spikes against
 * sax-wasm 3.1.4 before/while writing this:
 *
 * 1. sax-wasm does NOT decode XML entities anywhere — attribute values and
 *    text content come back with `&lt;`/`&gt;`/`&amp;`/`&#NN;`/`&#xHH;`
 *    literally intact. sax.js decodes these by default, and real trace XML
 *    uses them (e.g. Core Data's `&lt;x-coredata://...&gt;` object URIs) —
 *    {@link decodeXmlEntities} restores that behavior.
 * 2. OpenTag's own `textNodes` is always empty (text hasn't been parsed yet
 *    at that point in the stream) — CloseTag's `textNodes` carries the tag's
 *    accumulated direct text content instead, so text is yielded there.
 *    Attribute values are read from OpenTag's own `.attributes` array — the
 *    separate `SaxEventType.Attribute` event is redundant with that and is
 *    deliberately not subscribed to, cutting real event volume.
 * 3. sax-wasm silently yields zero events when fed a raw JS string chunk
 *    instead of Uint8Array — a real Readable can legally push either, so
 *    input is normalized through a plain non-object-mode PassThrough first:
 *    Node's Writable.write() auto-encodes a string chunk to a Buffer via its
 *    configured encoding (default utf8) before any non-object-mode stream
 *    ever sees it. This guarantees every chunk reaching the parser is real
 *    bytes without every caller needing to know or care what kind of
 *    Readable it was handed.
 * 4. THE PARSE(READER) ASYNC-GENERATOR API IS BROKEN ON REAL-SIZED INPUT.
 *    sax-wasm's own documented, "primary" API — `for await (const [e, d] of
 *    parser.parse(reader))` — throws "Cannot perform DataView constructor on
 *    a detached ArrayBuffer" partway through any document past roughly 2.5KB
 *    (reproduced live: broke consistently around byte 2540 on a real 3.5KB
 *    fixture, and immediately on an even larger synthetic 13KB document —
 *    every real trace export is far bigger than this). This reproduced
 *    identically whether reading raw getters, reading them all before any
 *    yield, or calling `.toJSON()` immediately per the library's own
 *    documented safe-access pattern — so it isn't a usage-order mistake on
 *    this side, it's the async wrapper's own internal buffer/growth handling
 *    detaching a Reader's backing ArrayBuffer out from under it. The lower-
 *    level `parser.write(chunk)` + synchronous `parser.eventHandler`
 *    callback API does NOT share this bug — verified live against the same
 *    large document that broke `.parse()` — so this file drives sax-wasm
 *    through that API instead and bridges it back into an async generator,
 *    keeping the same external interface callers already expect.
 *
 * Self-closing tags fire BOTH OpenTag and CloseTag (verified — same as
 * sax.js), so existing activeBuilder push/pop logic needs no changes for it.
 */
import { readFileSync } from "node:fs";
import { PassThrough, Readable } from "node:stream";
import { SAXParser, SaxEventType } from "sax-wasm";
import type { Tag } from "sax-wasm";

let wasmBytesCache: Uint8Array | null = null;

/** Loaded once per process and reused — the .wasm binary itself never changes mid-run. */
function loadWasmBytes(): Uint8Array {
  if (!wasmBytesCache) {
    const wasmUrl = import.meta.resolve("sax-wasm/lib/sax-wasm.wasm");
    wasmBytesCache = new Uint8Array(readFileSync(new URL(wasmUrl)));
  }
  return wasmBytesCache;
}

const NAMED_ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};

/**
 * Decodes the five predefined XML entities plus decimal/hex numeric
 * character references — sax.js's default behavior, which sax-wasm doesn't
 * replicate (verified live: `&lt;x&gt;` stays literal, never becomes `<x>`).
 * An unrecognized named entity (not one of the five predefined ones — this
 * format never declares custom entities via DOCTYPE) is left verbatim rather
 * than guessed at.
 */
export function decodeXmlEntities(s: string): string {
  if (!s.includes("&")) return s; // fast path — most values carry no entities at all
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, ent: string) => {
    if (ent[0] === "#") {
      const codePoint =
        ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return NAMED_ENTITIES[ent] ?? match;
  });
}

export type SaxWasmStreamEvent =
  | { type: "opentag"; tag: string; attributes: Record<string, string> }
  | { type: "text"; text: string }
  | { type: "closetag"; tag: string };

/**
 * Async-iterates a Node Readable's bytes through sax-wasm, yielding the same
 * {opentag, text, closetag} vocabulary sax.js's event stream gave. Callers
 * pipe through their own Transform first (e.g. parseTrackDetail.ts's
 * PercentAttributeNameSanitizer) exactly as before — this just replaces what
 * used to be `stdout.pipe(saxStream)` + `.on(...)` with a `for await` loop.
 *
 * Internally driven by sax-wasm's write()/eventHandler API, not its parse()
 * async generator — see point 4 in this file's header comment for why.
 * Events are queued synchronously inside eventHandler (called from within
 * write()) and drained after each chunk, before the next chunk is written —
 * this preserves the exact ordering parse() would have given, one input
 * chunk fully processed at a time.
 */
export async function* saxWasmEvents(stdout: Readable): AsyncGenerator<SaxWasmStreamEvent> {
  const parser = new SAXParser(SaxEventType.OpenTag | SaxEventType.CloseTag);
  await parser.prepareWasm(loadWasmBytes());

  const queue: SaxWasmStreamEvent[] = [];
  parser.eventHandler = (event, detail) => {
    // Raw getters, not .toJSON() — eventHandler fires synchronously inside
    // write(), with no suspension point between receiving `detail` and
    // reading it here, so the async-generator-specific memory-lifetime risk
    // (see point 4 above) doesn't apply. .toJSON() was measured to cost real
    // CPU beyond what's needed here: it also decodes byteOffsets/position
    // data for every attribute and text node, which nothing here reads —
    // profiled live: switching to targeted getters (only .name/.value on
    // exactly the fields used) was needed to make this swap a net win at
    // all against sax.js on real data (see PMT:amber-spark's completion
    // notes for the before/after numbers).
    const tag = detail as Tag;
    if (event === SaxEventType.OpenTag) {
      const attributes: Record<string, string> = {};
      for (const attr of tag.attributes) {
        attributes[attr.name.value] = decodeXmlEntities(attr.value.value);
      }
      queue.push({ type: "opentag", tag: tag.name, attributes });
    } else {
      for (const textNode of tag.textNodes) {
        const decoded = decodeXmlEntities(textNode.value);
        if (decoded.length > 0) queue.push({ type: "text", text: decoded });
      }
      queue.push({ type: "closetag", tag: tag.name });
    }
  };

  // See point 3 in this file's header comment — normalizes string OR Buffer
  // input to guaranteed real bytes before anything reaches the parser.
  const bytes = stdout.pipe(new PassThrough());

  for await (const chunk of bytes) {
    parser.write(chunk as Uint8Array);
    while (queue.length > 0) yield queue.shift()!;
  }
  parser.end();
  while (queue.length > 0) yield queue.shift()!;
}
