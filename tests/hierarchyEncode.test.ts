/**
 * PMT:dry-glen node-encoding round-trip.
 *
 * The correctness guarantee is decode(encode(x)) === x for anything encode
 * accepts — proven here across every real value shape (chain, comma-list,
 * prefix+chain, generics whose `<A, B>` contains the comma delimiter, empty
 * tokens) — plus that node content is genuinely deduped (shared tokens across
 * distinct values map to one id) and that non-tokenizable values are left raw.
 */
import { describe, it, expect } from "vitest";
import { encodeNodeSequence, decodeNodeSequence, isNodeEncoded, NODE_ENCODED_MARKER } from "../src/engine/hierarchyEncode.js";

/** Bidirectional in-memory node interner (ids from 1, like the real table). */
function fakeNodes() {
  const byName = new Map<string, number>();
  const byId: string[] = [];
  return {
    internNode: (name: string): number => {
      let id = byName.get(name);
      if (id === undefined) {
        byId.push(name);
        id = byId.length; // 1-based
        byName.set(name, id);
      }
      return id;
    },
    nodeName: (id: number): string => byId[id - 1],
    distinct: () => byId.length,
  };
}

function roundtrips(content: string): boolean {
  const n = fakeNodes();
  const enc = encodeNodeSequence(content, n.internNode);
  if (enc === null) return false; // not encoded
  return decodeNodeSequence(enc, n.nodeName) === content;
}

describe("PMT:dry-glen hierarchyEncode round-trip", () => {
  it("round-trips a view-hierarchy ` ← ` chain exactly", () => {
    expect(roundtrips("SidebarRow ← ForEach ← LazyVStack ← _PaddingLayout")).toBe(true);
  });

  it("round-trips a comma cause-list exactly", () => {
    expect(roundtrips("HoverChanged, SidebarRow.body, Button.body, ButtonActionModifier.body")).toBe(true);
  });

  it("round-trips a metadata-prefix + chain (full-cause-graph-node shape)", () => {
    expect(roundtrips("SidebarRow.body, blue, square.text.square, n/a, SidebarRow ← ForEach ← LazyVStack")).toBe(true);
  });

  it("round-trips a token whose generic contains the comma delimiter", () => {
    // `<A, B>` contains ', ' — it gets split but rejoins byte-identical.
    expect(roundtrips("Foo<A, B> ← _EnvironmentKeyWritingModifier<RefreshAction?> ← Bar")).toBe(true);
  });

  it("round-trips adjacent/empty tokens", () => {
    expect(roundtrips("A ← , ← B")).toBe(true); // empty token between ' ← ' and ', '
  });

  it("leaves a single non-delimited token raw (returns null)", () => {
    const n = fakeNodes();
    expect(encodeNodeSequence("PlaceholderContentView", n.internNode)).toBeNull();
    expect(encodeNodeSequence("View List DynamicViewList<ModifiedContent>", n.internNode)).toBeNull(); // no ' ← ' or ', '
  });

  it("never touches a value already starting with a control char", () => {
    const n = fakeNodes();
    expect(encodeNodeSequence("abc ← def", n.internNode)).toBeNull();
  });

  it("dedups shared nodes across distinct values (same token → one id)", () => {
    const n = fakeNodes();
    // Two DIFFERENT chains that share the LazyVStack ← _PaddingLayout tail.
    encodeNodeSequence("SidebarRow ← LazyVStack ← _PaddingLayout", n.internNode);
    encodeNodeSequence("Button ← LazyVStack ← _PaddingLayout", n.internNode);
    // distinct nodes: SidebarRow, LazyVStack, _PaddingLayout, Button = 4 (not 6)
    expect(n.distinct()).toBe(4);
  });

  it("marks encoded values and is byte-identical after decode", () => {
    const n = fakeNodes();
    const content = "A ← B ← C ← A ← B"; // repeats A,B within one value too
    const enc = encodeNodeSequence(content, n.internNode)!;
    expect(isNodeEncoded(enc)).toBe(true);
    expect(enc.startsWith(NODE_ENCODED_MARKER)).toBe(true);
    expect(enc.length).toBeLessThan(content.length); // smaller than the original
    expect(isNodeEncoded(content)).toBe(false);
    expect(decodeNodeSequence(enc, n.nodeName)).toBe(content);
  });
});
