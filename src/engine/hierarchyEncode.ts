/**
 * Structural node-dedup for interned view-hierarchy / cause strings.
 *
 * The dominant remaining on-disk cost after interning is ~2.4 GB of genuinely-
 * DISTINCT large strings that no cross-row dedup touches: swiftui view-hierarchy
 * chains, ` ← `-delimited and ~111 nodes deep. Measured on a real trace: across
 * a sample only 0.9% of the ~552k node occurrences are distinct — the same view
 * nodes (LazyVStack, _PaddingLayout, …) recur across thousands of DIFFERENT full
 * chains. xctrace's XML dedups the whole chain across rows (id/ref, which our
 * interning mirrors) but NOT the shared nodes — each distinct chain is a flat
 * `fmt` string. So this is a step beyond xctrace: dedup the NODES.
 *
 * A value is tokenized on its delimiters (` ← ` for chains, `, ` for cause
 * lists — the same shared node vocabulary underlies both), each token interned
 * into a `hierarchy_nodes` table, and the value re-stored as a compact sequence
 * of node ids + delimiter codes. decode() rebuilds the exact original.
 *
 * Correctness: a JS capturing split then rejoin is lossless, and the two
 * delimiters map bijectively to codes, so decode(encode(x)) === x BY
 * CONSTRUCTION (not by a runtime check). Node names never appear literally in
 * the encoded form (only their numeric ids do), so a token containing any
 * character — including a delimiter substring inside a generic like `<A, B>` —
 * round-trips exactly (the inner `, ` simply becomes a delimiter that rejoins).
 * Values that don't tokenize (a single token, or delimiters not in the set) are
 * left raw.
 *
 * Markers are control chars absent from xctrace text (same discipline as
 * INTERN_SENTINEL): NODE_ENCODED_MARKER prefixes an encoded value; the delimiter
 * codes sit between ids. All are built via fromCharCode so no control char is
 * ever written literally in source (which is fragile — see the null-byte and
 * SOH incidents).
 */

const MARKER_CODE = 2; // STX
const DELIM_CODE_CHARS = [3, 4]; // index-aligned with DELIMS

/** Prefix on interned_values.content marking a node-encoded value. */
export const NODE_ENCODED_MARKER = String.fromCharCode(MARKER_CODE);
/** Delimiters we tokenize on, index-aligned with the codes below. */
const DELIMS = [" ← ", ", "]; // " ← " (LEFTWARDS ARROW), ", "
const DELIM_CODES = DELIM_CODE_CHARS.map((c) => String.fromCharCode(c));
/** Capturing split on any delimiter → [token, delim, token, delim, …, token]. */
const SPLIT_RE = /( ← |, )/;
/** Encoded body tokenizer: a run of digits (a node id) or one delimiter code. */
const DECODE_RE = new RegExp(`\\d+|[${DELIM_CODES.join("")}]`, "g");

/** True if a stored interned value is node-encoded (vs a raw string). */
export function isNodeEncoded(v: string): boolean {
  return v.charCodeAt(0) === MARKER_CODE;
}

/**
 * Encode `content` as a node-id sequence, interning each token via `internNode`.
 * Returns the encoded string, or null when the value isn't worth encoding (no
 * recognized delimiter → a single token, so node-dedup saves nothing). Never
 * touches a value that already begins with a control char.
 */
export function encodeNodeSequence(content: string, internNode: (name: string) => number): string | null {
  if (content.length === 0 || content.charCodeAt(0) <= 4) return null;
  const parts = content.split(SPLIT_RE); // even idx = tokens, odd idx = delimiters
  if (parts.length < 3) return null; // fewer than 2 tokens — nothing to dedup
  let out = NODE_ENCODED_MARKER;
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      out += internNode(parts[i]);
    } else {
      const di = DELIMS.indexOf(parts[i]);
      if (di < 0) return null; // unreachable given SPLIT_RE, but keeps it honest
      out += DELIM_CODES[di];
    }
  }
  return out;
}

/**
 * Rebuild the original string from a node-encoded value, resolving each id via
 * `nodeName`. Inverse of encodeNodeSequence.
 */
export function decodeNodeSequence(encoded: string, nodeName: (id: number) => string): string {
  const toks = encoded.slice(1).match(DECODE_RE) ?? [];
  let out = "";
  for (let i = 0; i < toks.length; i++) {
    if (i % 2 === 0) out += nodeName(Number(toks[i]));
    else out += DELIMS[DELIM_CODES.indexOf(toks[i])];
  }
  return out;
}
