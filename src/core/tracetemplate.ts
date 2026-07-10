/**
 * PMT:pine-basin — read-only NSKeyedArchiver decoder for `.tracetemplate`
 * files, so far-swan can AUTHORITATIVELY enumerate every instrument and every
 * private config key a stock Instruments template actually configures —
 * instead of `plutil` + grepping for known key-name substrings, which only
 * ever finds what you already thought to look for.
 *
 * WHY THIS SHAPE (decided PMT:pine-basin, after live recon):
 *   A `.tracetemplate` is a `bplist00` binary plist wrapping an NSKeyedArchiver
 *   object graph ($archiver="NSKeyedArchiver", $version=100000, $objects[],
 *   $top{}). Two layers are needed to read it: (1) parse the binary plist into
 *   a tree, (2) un-flatten the archiver graph (resolve CF$UID references,
 *   dereference $class, rebuild NS containers). The prompt framed the build as
 *   "Python subprocess (bpylist/ccl_bplist) vs. a from-scratch TS port of the
 *   whole format" — but recon changed both sides of that trade:
 *     - Neither Python decoder is installed on the target machine, so that path
 *       means a runtime `pip install` into the user's env — a poor fit for a
 *       `npx far-swan` pure-Node npm package.
 *     - `plutil -convert xml1` (a macOS system tool; far-swan already shells
 *       out to `xcrun xctrace`, so this is fully in-band) does layer (1) — the
 *       binary-plist parse — for free. So layer (2), the ONLY new code, is a
 *       small pure-data graph resolver over ~a dozen known classes. No new npm
 *       or Python dependency, and no risky hand-rolled binary-plist parser.
 *   `plutil -convert json` was rejected: it errors out whole-file whenever any
 *   NSData blob is present (icons, color archives), which stock templates carry.
 *   xml1 base64-encodes those instead, so it's the reliable conversion target.
 *
 * SCOPE: read-only. Composing/writing templates is deliberately OUT of scope
 * (PMT:pine-basin item 5) — the archive encodes private, undocumented
 * Instruments.app object instances with no compatibility guarantee, and a
 * subtly-wrong synthesized template can silently misrecord or crash xctrace.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sax from "sax";

const execFileAsync = promisify(execFile);

/** A CF$UID reference as it appears in the parsed plist: `{ "CF$UID": n }`. */
interface UidRef {
  "CF$UID": number;
}

/** The raw parsed archive plist — before graph resolution. */
export interface ArchivePlist {
  $archiver?: string;
  $version?: number;
  /** The flat object table; index 0 is always the "$null" sentinel. */
  $objects: unknown[];
  /** The named entry points into the graph (NOT always a single "root"). */
  $top: Record<string, unknown>;
}

/** A fully resolved template: every $top entry with its CF$UID graph inlined. */
export interface DecodedTemplate {
  archiver: string;
  version: number;
  /** Number of objects in the flat $objects table (diagnostic). */
  objectCount: number;
  /** Every $top key with its object graph resolved. Private Instruments
   *  classes surface as `{ __class__: "XR…", …fields }`. */
  top: Record<string, unknown>;
}

/** One instrument a template bundles, as recorded authoritatively in the archive. */
export interface TemplateInstrument {
  /** The stable instrument-type identifier, e.g. "com.apple.xray.instrument-type.coresampler2". */
  identifier: string;
  /** The human-readable display name, e.g. "Time Profiler" — matches `xctrace list instruments`. */
  name: string;
}

// ─── Layer 1: Apple XML plist → plain JS tree ───────────────────────────────

function isUidRef(v: unknown): v is UidRef {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.keys(v as object).length === 1 &&
    typeof (v as UidRef)["CF$UID"] === "number"
  );
}

/**
 * Parse Apple's XML plist (as emitted by `plutil -convert xml1`) into a plain
 * JS value tree. A `<dict>` becomes a plain object, `<array>` an array,
 * `<integer>`/`<real>` numbers, `<true/>`/`<false/>` booleans, `<data>` a
 * Buffer, `<string>`/`<date>` strings. A CF$UID reference, encoded by plutil as
 * `<dict><key>CF$UID</key><integer>n</integer></dict>`, falls out naturally as
 * `{ "CF$UID": n }`.
 *
 * Exported for testing without a live `plutil` (a committed XML fixture drives
 * the parser + resolver end-to-end in CI where shelling to plutil is undesirable).
 */
export function parsePlistXml(xml: string): unknown {
  const parser = sax.parser(true, { trim: false, position: false });

  // Each frame builds one plist value. `key` holds a dict's pending key name.
  interface Frame {
    tag: string;
    obj?: Record<string, unknown>;
    arr?: unknown[];
    key?: string | null;
    text: string;
    /** The finished value of the single child of a <plist> wrapper. */
    result?: unknown;
  }
  const stack: Frame[] = [];
  let rootValue: unknown = undefined;

  const attach = (value: unknown, wasKey: boolean): void => {
    const parent = stack[stack.length - 1];
    if (!parent) {
      rootValue = value;
      return;
    }
    if (wasKey) {
      parent.key = value as string;
      return;
    }
    if (parent.obj) {
      // A dict child that is NOT a <key> is the value for the pending key.
      parent.obj[parent.key as string] = value;
      parent.key = null;
    } else if (parent.arr) {
      parent.arr.push(value);
    } else if (parent.tag === "plist") {
      parent.result = value;
    }
  };

  parser.onopentag = (node: { name: string }) => {
    const name = node.name.toLowerCase();
    if (name === "dict") stack.push({ tag: "dict", obj: {}, key: null, text: "" });
    else if (name === "array") stack.push({ tag: "array", arr: [], text: "" });
    else stack.push({ tag: name, text: "" });
  };

  parser.ontext = (t: string) => {
    const top = stack[stack.length - 1];
    if (top) top.text += t;
  };
  parser.oncdata = parser.ontext;

  parser.onclosetag = (rawName: string) => {
    const name = rawName.toLowerCase();
    const frame = stack.pop();
    if (!frame) return;
    let value: unknown;
    let wasKey = false;
    switch (name) {
      case "dict":
        value = frame.obj;
        break;
      case "array":
        value = frame.arr;
        break;
      case "key":
        value = frame.text;
        wasKey = true;
        break;
      case "string":
        value = frame.text;
        break;
      case "integer":
        value = parseInt(frame.text.trim(), 10);
        break;
      case "real":
        value = parseFloat(frame.text.trim());
        break;
      case "true":
        value = true;
        break;
      case "false":
        value = false;
        break;
      case "data":
        value = Buffer.from(frame.text.replace(/\s+/g, ""), "base64");
        break;
      case "date":
        value = frame.text.trim();
        break;
      case "plist":
        rootValue = frame.result;
        return;
      default:
        // Unknown/ignored wrapper (e.g. stray) — carry nothing up.
        return;
    }
    attach(value, wasKey);
  };

  parser.write(xml).close();
  return rootValue;
}

// ─── Layer 2: NSKeyedArchiver graph → resolved values ───────────────────────

const DICT_CLASSES = new Set(["NSDictionary", "NSMutableDictionary"]);
const ARRAY_CLASSES = new Set([
  "NSArray",
  "NSMutableArray",
  "NSSet",
  "NSMutableSet",
]);
const STRING_CLASSES = new Set(["NSString", "NSMutableString"]);
const DATA_CLASSES = new Set(["NSData", "NSMutableData"]);

/**
 * Resolve an NSKeyedArchiver graph (already parsed by {@link parsePlistXml})
 * into plain JS values: NS containers become objects/arrays/strings, CF$UID
 * references are followed, and private Instruments classes (XRRecordingOptions,
 * PFTInstrumentCommand, …) surface as `{ __class__, …resolvedFields }`.
 *
 * Memoized per object index, which also breaks reference cycles: a container's
 * shell is inserted into the memo BEFORE its children are resolved, so a child
 * that points back at an ancestor gets the same (still-filling) instance rather
 * than recursing forever.
 *
 * Exported (taking the already-parsed plist) so the resolver is unit-testable
 * with zero external process dependency.
 */
export function resolveArchive(plist: ArchivePlist): Record<string, unknown> {
  const objects = plist.$objects;
  const memo = new Map<number, unknown>();

  const classNameOf = (raw: Record<string, unknown>): string | undefined => {
    const classRef = raw["$class"];
    if (!isUidRef(classRef)) return undefined;
    const classObj = objects[classRef["CF$UID"]];
    if (classObj && typeof classObj === "object" && "$classname" in classObj) {
      return String((classObj as Record<string, unknown>)["$classname"]);
    }
    return undefined;
  };

  // Resolve a value that may be a CF$UID ref, a primitive, or an inline object.
  const resolveValue = (v: unknown): unknown => {
    if (isUidRef(v)) return resolveIndex(v["CF$UID"]);
    return v;
  };

  const resolveIndex = (idx: number): unknown => {
    if (memo.has(idx)) return memo.get(idx);
    const raw = objects[idx];

    if (raw === "$null" || raw === undefined || raw === null) {
      memo.set(idx, null);
      return null;
    }
    if (typeof raw !== "object") {
      // A bare primitive in the object table (string/number/bool).
      memo.set(idx, raw);
      return raw;
    }

    const rawObj = raw as Record<string, unknown>;
    const cls = classNameOf(rawObj);

    // NSDictionary / NSMutableDictionary — NS.keys[] paired with NS.objects[].
    if (cls && DICT_CLASSES.has(cls)) {
      const out: Record<string, unknown> = {};
      memo.set(idx, out);
      const keys = (rawObj["NS.keys"] as unknown[]) ?? [];
      const vals = (rawObj["NS.objects"] as unknown[]) ?? [];
      for (let i = 0; i < keys.length; i++) {
        out[String(resolveValue(keys[i]))] = resolveValue(vals[i]);
      }
      return out;
    }

    // NSArray / NSMutableArray / NSSet / NSMutableSet — NS.objects[].
    if (cls && ARRAY_CLASSES.has(cls)) {
      const out: unknown[] = [];
      memo.set(idx, out);
      for (const el of (rawObj["NS.objects"] as unknown[]) ?? []) {
        out.push(resolveValue(el));
      }
      return out;
    }

    // NSOrderedSet — elements are individual NS.object.0, NS.object.1, … keys.
    if (cls === "NSOrderedSet" || cls === "NSMutableOrderedSet") {
      const out: unknown[] = [];
      memo.set(idx, out);
      for (let i = 0; ; i++) {
        const key = `NS.object.${i}`;
        if (!(key in rawObj)) break;
        out.push(resolveValue(rawObj[key]));
      }
      return out;
    }

    if (cls && STRING_CLASSES.has(cls)) {
      const s = (rawObj["NS.string"] as string) ?? "";
      memo.set(idx, s);
      return s;
    }
    if (cls && DATA_CLASSES.has(cls)) {
      const data = rawObj["NS.data"] ?? null;
      memo.set(idx, data);
      return data;
    }
    if (cls === "NSNull") {
      memo.set(idx, null);
      return null;
    }

    // Any other archived object — a private Instruments class (XRRecordingOptions,
    // PFTInstrumentCommand, …) or a plain dict. Surface every field (following
    // refs), tagged with its class so callers can recognize what they're reading.
    const out: Record<string, unknown> = {};
    memo.set(idx, out);
    if (cls) out["__class__"] = cls;
    for (const [k, val] of Object.entries(rawObj)) {
      if (k === "$class") continue;
      out[k] = resolveValue(val);
    }
    return out;
  };

  const top: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(plist.$top)) {
    top[k] = resolveValue(v);
  }
  return top;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Decode a `.tracetemplate` file end to end: shell to `plutil -convert xml1`,
 * parse the XML plist, and resolve the NSKeyedArchiver graph. Read-only.
 */
export async function decodeTraceTemplate(path: string): Promise<DecodedTemplate> {
  let xml: string;
  try {
    const { stdout } = await execFileAsync(
      "plutil",
      ["-convert", "xml1", "-o", "-", path],
      { maxBuffer: 64 * 1024 * 1024, encoding: "utf8" }
    );
    xml = stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === "ENOENT") {
      throw new Error(
        "`plutil` not found — it ships with macOS command line tools, which far-swan already requires for xctrace."
      );
    }
    throw new Error(
      `plutil could not convert "${path}" (${e.stderr?.trim() || e.message}). Is it a valid .tracetemplate (binary plist)?`
    );
  }

  const parsed = parsePlistXml(xml);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`"${path}" did not parse as a plist.`);
  }
  const plist = parsed as ArchivePlist;
  if (plist.$archiver !== "NSKeyedArchiver" || !Array.isArray(plist.$objects) || !plist.$top) {
    throw new Error(
      `"${path}" is a plist but not an NSKeyedArchiver archive (missing $archiver/$objects/$top).`
    );
  }

  return {
    archiver: plist.$archiver,
    version: Number(plist.$version ?? 0),
    objectCount: plist.$objects.length,
    top: resolveArchive(plist),
  };
}

/**
 * The authoritative list of instruments a template bundles, read from the
 * archive's `stubInfoByUUID` map (instrument-type-id → stub{name,identifier}).
 * This is the source of truth the recording-options preview CANNOT match: a
 * no-configurable-options instrument (e.g. Thermal State, Power Profiler's
 * Location Energy Model) is invisible to `--show-recording-options` but is
 * present here, named, every time.
 *
 * Works on an already-decoded template so callers that also want the config
 * graph don't pay for a second plutil round-trip.
 */
export function templateInstruments(decoded: DecodedTemplate): TemplateInstrument[] {
  const stubs = decoded.top["stubInfoByUUID"];
  if (!stubs || typeof stubs !== "object") return [];
  const out: TemplateInstrument[] = [];
  for (const [identifier, stub] of Object.entries(stubs as Record<string, unknown>)) {
    if (!stub || typeof stub !== "object") continue;
    const name = (stub as Record<string, unknown>)["name"];
    out.push({ identifier, name: typeof name === "string" ? name : identifier });
  }
  // Stable order: by display name, so a diff of two templates' bundles reads cleanly.
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Convenience: decode a file and return just its bundled instruments. */
export async function enumerateTemplateInstruments(path: string): Promise<TemplateInstrument[]> {
  return templateInstruments(await decodeTraceTemplate(path));
}
