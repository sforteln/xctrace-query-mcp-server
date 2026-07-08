/**
 * PMT:rust-gravel — cross-schema connection registry, PURE-LOGIC tests
 * (synthetic schemas, no fixtures): invert round-trips, deriveEdges is
 * order-invariant and emits the right kinds, connectionsFor shadows/orients
 * correctly, matchRecovery is evidence-gated. The fixture-backed drift guards
 * (referential, negative-edge, kind-consistency, order-invariance over the
 * REAL fixtures) live in tests/driftGuard.test.ts.
 */
import { describe, it, expect } from "vitest";
import type { SchemaCol } from "../src/engine/parseTable.js";
import {
  invert,
  deriveEdges,
  connectionsFor,
  matchRecovery,
  carriesOwnBacktrace,
  type SchemaEdge,
  type EdgeKind,
} from "../src/engine/schemaEdges.js";

// ─── Synthetic schemas ──────────────────────────────────────────────────────────

const col = (mnemonic: string, engineeringType: string): SchemaCol => ({ mnemonic, name: mnemonic, engineeringType });

// A time+thread schema (both roles) → derives tuple + time-window against another.
const intervalsA: SchemaCol[] = [col("start", "start-time"), col("duration", "duration"), col("thread", "thread"), col("label", "string")];
// Another time+thread schema.
const eventsB: SchemaCol[] = [col("time", "event-time"), col("thread", "thread")];
// A time-only schema (no thread) → only time-window.
const timeOnlyC: SchemaCol[] = [col("start", "start-time"), col("duration", "duration")];
// A thread-only schema (no time) → only weak equi(thread).
const threadOnlyD: SchemaCol[] = [col("tid", "tid"), col("state", "string")];

function canon(e: SchemaEdge): string {
  return `${e.from}|${e.to}|${e.kind}|${e.layer}|${e.on.map((p) => `${p.fromCol}=${p.toCol}`).join(",")}`;
}
function edgeSet(edges: SchemaEdge[]): Set<string> {
  return new Set(edges.map(canon));
}

// ─── invert ────────────────────────────────────────────────────────────────────

describe("invert", () => {
  const base: SchemaEdge = { from: "A", to: "B", kind: "contains", layer: "curated", on: [{ fromCol: "x", toCol: "y" }], note: "n" };

  it("flips a directional kind to its dual and swaps endpoints + columns", () => {
    const inv = invert(base);
    expect(inv.from).toBe("B");
    expect(inv.to).toBe("A");
    expect(inv.kind).toBe("contained-by");
    expect(inv.on).toEqual([{ fromCol: "y", toCol: "x" }]);
  });

  it("is an involution — invert(invert(e)) is structurally e", () => {
    const rt = invert(invert(base));
    expect(rt.from).toBe(base.from);
    expect(rt.to).toBe(base.to);
    expect(rt.kind).toBe(base.kind);
    expect(rt.on).toEqual(base.on);
  });

  it("keeps symmetric kinds' kind unchanged, swapping only endpoints", () => {
    for (const kind of ["equi", "time-window", "tuple", "negative"] as EdgeKind[]) {
      const e: SchemaEdge = { from: "A", to: "B", kind, layer: "curated", on: [{ fromCol: "x", toCol: "y" }], note: "n" };
      const inv = invert(e);
      expect(inv.kind).toBe(kind);
      expect(inv.from).toBe("B");
      expect(inv.on).toEqual([{ fromCol: "y", toCol: "x" }]);
    }
  });

  it("maps excludes ↔ excluded-by", () => {
    expect(invert({ from: "A", to: "B", kind: "excludes", layer: "curated", on: [], note: "" }).kind).toBe("excluded-by");
    expect(invert({ from: "A", to: "B", kind: "excluded-by", layer: "curated", on: [], note: "" }).kind).toBe("excludes");
  });
});

// ─── deriveEdges ─────────────────────────────────────────────────────────────────

describe("deriveEdges", () => {
  it("emits a time-window AND a tuple edge for two time+thread schemas", () => {
    const edges = deriveEdges([{ schema: "A-ints", cols: intervalsA }, { schema: "B-evts", cols: eventsB }]);
    const kinds = edges.map((e) => e.kind).sort();
    expect(kinds).toEqual(["time-window", "tuple"]);
    const tuple = edges.find((e) => e.kind === "tuple")!;
    expect(tuple.on).toHaveLength(2); // thread pair + time pair
  });

  it("emits ONLY a time-window edge when one schema has no thread role", () => {
    const edges = deriveEdges([{ schema: "A-ints", cols: intervalsA }, { schema: "C-time", cols: timeOnlyC }]);
    expect(edges.map((e) => e.kind)).toEqual(["time-window"]);
  });

  it("emits ONLY a weak equi(thread) edge when the pair shares thread but not time", () => {
    const edges = deriveEdges([{ schema: "A-ints", cols: intervalsA }, { schema: "D-thread", cols: threadOnlyD }]);
    expect(edges.map((e) => e.kind)).toEqual(["equi"]);
    expect(edges[0].on).toEqual([{ fromCol: "thread", toCol: "tid" }]); // canonical: A-ints < D-thread
  });

  it("stores every edge in canonical (lexicographically-smaller-first) direction", () => {
    // Pass in reverse name order; edge should still be from the smaller name.
    const edges = deriveEdges([{ schema: "zzz", cols: timeOnlyC }, { schema: "aaa", cols: timeOnlyC }]);
    expect(edges).toHaveLength(1);
    expect(edges[0].from).toBe("aaa");
    expect(edges[0].to).toBe("zzz");
  });

  it("is ORDER-INVARIANT — permuting schema order and column order yields the identical edge set", () => {
    const schemas = [
      { schema: "A-ints", cols: intervalsA },
      { schema: "B-evts", cols: eventsB },
      { schema: "C-time", cols: timeOnlyC },
      { schema: "D-thread", cols: threadOnlyD },
    ];
    const baseline = edgeSet(deriveEdges(schemas));

    // Reverse schema order + reverse each schema's columns.
    const permuted = [...schemas].reverse().map((s) => ({ schema: s.schema, cols: [...s.cols].reverse() }));
    expect(edgeSet(deriveEdges(permuted))).toEqual(baseline);

    // A different permutation (rotate) + a different column shuffle.
    const rotated = [schemas[2], schemas[0], schemas[3], schemas[1]].map((s) => ({ schema: s.schema, cols: [s.cols[s.cols.length - 1], ...s.cols.slice(0, -1)] }));
    expect(edgeSet(deriveEdges(rotated))).toEqual(baseline);
  });
});

// ─── carriesOwnBacktrace ─────────────────────────────────────────────────────────

describe("carriesOwnBacktrace", () => {
  it("is true for a schema with a backtrace-role column", () => {
    expect(carriesOwnBacktrace("synthetic", [col("time", "start-time"), col("stack", "tagged-backtrace")])).toBe(true);
  });
  it("is false for a schema with no backtrace column", () => {
    expect(carriesOwnBacktrace("synthetic", [col("time", "start-time"), col("duration", "duration")])).toBe(false);
  });
});

// ─── connectionsFor ──────────────────────────────────────────────────────────────

describe("connectionsFor", () => {
  it("orients derived edges from the queried schema's perspective", () => {
    const present = [
      { schema: "zzz", cols: intervalsA },
      { schema: "aaa", cols: eventsB },
    ];
    const fromZzz = connectionsFor("zzz", present).edges;
    // Canonical storage is aaa→zzz; queried from zzz it must read zzz→aaa.
    expect(fromZzz.every((e) => e.from === "zzz")).toBe(true);
  });

  it("a curated edge SHADOWS the derived time-window edge for the same pair", () => {
    // runloop-intervals ⊃ swiftui-updates is a curated `contains`; both also
    // share primaryTime so a derived time-window would otherwise appear.
    const present = [
      { schema: "runloop-intervals", cols: [col("start", "start-time"), col("duration", "duration"), col("thread", "thread")] },
      { schema: "swiftui-updates", cols: [col("start", "start-time"), col("duration", "duration"), col("thread", "thread")] },
    ];
    const edges = connectionsFor("runloop-intervals", present).edges;
    const pairEdges = edges.filter((e) => e.to === "swiftui-updates");
    // Exactly the curated `contains` — the derived time-window/tuple for this
    // pair is shadowed out.
    expect(pairEdges).toHaveLength(1);
    expect(pairEdges[0].kind).toBe("contains");
    expect(pairEdges[0].layer).toBe("curated");
  });

  it("surfaces a curated edge from the `to` side as its inverse", () => {
    const present = [
      { schema: "runloop-intervals", cols: [col("start", "start-time"), col("duration", "duration"), col("thread", "thread")] },
      { schema: "swiftui-updates", cols: [col("start", "start-time"), col("duration", "duration"), col("thread", "thread")] },
    ];
    const edges = connectionsFor("swiftui-updates", present).edges;
    const back = edges.find((e) => e.to === "runloop-intervals");
    expect(back).toBeDefined();
    expect(back!.kind).toBe("contained-by"); // dual of contains
    expect(back!.from).toBe("swiftui-updates");
  });

  it("returns an absent curated sibling as a LATENT recovery candidate, not an edge", () => {
    // Only swiftui-updates present; its curated core-data-fetch sibling is absent.
    const present = [
      { schema: "swiftui-updates", cols: [col("start", "start-time"), col("duration", "duration"), col("thread", "thread")] },
    ];
    const conn = connectionsFor("swiftui-updates", present);
    expect(conn.edges.some((e) => e.to === "core-data-fetch")).toBe(false);
    const rec = conn.latentRecovery.find((r) => r.absentSchema === "core-data-fetch");
    expect(rec).toBeDefined();
    expect(rec!.reRecordType).toBe("core-data");
  });
});

// ─── matchRecovery ──────────────────────────────────────────────────────────────

describe("matchRecovery", () => {
  const present = [{ schema: "swiftui-updates", cols: [col("start", "start-time"), col("thread", "thread")] }];
  const latent = connectionsFor("swiftui-updates", present).latentRecovery;

  it("fires only when an absent schema's domain frame appears in the evidence", () => {
    const triggered = matchRecovery(latent, "frame: -[NSManagedObjectContext executeFetchRequest:error:]");
    expect(triggered.map((r) => r.absentSchema)).toContain("core-data-fetch");
  });

  it("stays silent when no domain frame is present (never noise)", () => {
    expect(matchRecovery(latent, "frame: -[UIView layoutSubviews]")).toEqual([]);
  });
});
