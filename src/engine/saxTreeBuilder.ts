/**
 * SAX-driven mini-tree builder.
 *
 * Streaming xctrace exports one bounded subtree at a time (one <row>, one
 * <schema>) instead of the whole multi-GB document. This builder reconstructs
 * a single subtree from a flat stream of open/text/close events into the SAME
 * object shape fast-xml-parser produces for that subtree — `@_`-prefixed
 * attributes, `#text` for leaf text content, repeated child tags collapsed
 * into arrays — so the existing (already-correct, fixture-tested) cell/row
 * resolution functions in parseTable.ts / parseTrackDetail.ts can consume it
 * completely unchanged. The only new code is this reconstruction + the
 * outer path-tracking loop that decides when to start/stop capturing.
 */

interface BuilderFrame {
  tagName: string;
  obj: Record<string, unknown>;
  textChunks: string[];
}

export class MiniXmlBuilder {
  private stack: BuilderFrame[] = [];
  /** Populated once the outermost captured tag closes (onCloseTag returns true). */
  result: Record<string, unknown> | null = null;

  onOpenTag(tag: string, attributes: Record<string, string>): void {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(attributes)) {
      // fast-xml-parser's default trimValues:true (never overridden by either
      // parser config in this codebase) trims attribute values too, not just
      // text content — match it so e.g. fmt="Suspended for " (real trailing
      // space in the XML) comes out the same "Suspended for" both parsers give.
      obj["@_" + k] = v.trim();
    }
    this.stack.push({ tagName: tag, obj, textChunks: [] });
  }

  onText(text: string): void {
    const top = this.stack[this.stack.length - 1];
    if (top) top.textChunks.push(text);
  }

  /** Returns true when this close matched the outermost captured tag (capture complete). */
  onCloseTag(_tag: string): boolean {
    const frame = this.stack.pop();
    if (!frame) return false;

    // Mirrors fast-xml-parser's behavior here: a leaf with text content gets
    // #text; a node with child elements never mixes in text (this XML format
    // has no genuinely mixed content — an element is either a leaf or a
    // container, never both).
    const hasAttrs = Object.keys(frame.obj).some((k) => k.startsWith("@_"));
    const hasChildren = Object.keys(frame.obj).some((k) => !k.startsWith("@_"));
    let text = "";
    if (!hasChildren) {
      text = frame.textChunks.join("").trim();
      if (text.length > 0) frame.obj["#text"] = text;
    }

    if (this.stack.length === 0) {
      this.result = frame.obj;
      return true;
    }

    // fast-xml-parser collapses an attribute-less, child-less leaf straight to
    // its text string (or "" if empty) rather than wrapping it in an object —
    // e.g. <mnemonic>start</mnemonic> becomes "start", not {"#text":"start"}.
    // Match that so callers reading e.g. col.mnemonic as a bare string see the
    // same shape the DOM-based parser would have given them.
    const value: unknown = !hasAttrs && !hasChildren ? text : frame.obj;

    const parent = this.stack[this.stack.length - 1];
    const existing = parent.obj[frame.tagName];
    if (existing === undefined) {
      parent.obj[frame.tagName] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      parent.obj[frame.tagName] = [existing, value];
    }
    return false;
  }
}
