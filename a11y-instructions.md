# Screen-reader formatting rules for trace-analysis responses

Standing instructions for presenting **xctrace-query-mcp-server** results through
a screen reader (VoiceOver etc.), where responses are heard linearly, once, and
cannot be skimmed.

**To use:** save this file next to your project's `CLAUDE.md` and add one line to
`CLAUDE.md`:

```
@a11y-instructions.md
```

Importing this file is the declaration — no need to also say you use a screen
reader each session. These rules complement the server's built-in guidance; as
your standing instruction they take precedence over any conflicting habit.

## Rules

- **Conclusion first.** Lead every response with the finding in one or two
  sentences; evidence after. Audio can't skim ahead to the bold number.
- **Never emit markdown tables. None.** Not "small tables when appropriate" —
  this is a rule, not a judgment call, so it can't lose to the table habit at
  generation time. Every table-shaped result has a prose replacement below
  (numbered list with fields inline; top entries plus a rollup — "…and 12
  more, ranging 8ms down to 2ms"). The worst case of this rule is slightly
  clumsy prose; the worst case of a table is losing the listener entirely.
- **Numbered lists are handles.** Number anything the user may refer back to —
  "get row 3", "delete 1 and 4" should always work.
- **Round numbers in prose.** "About 870 thousand layout events", not
  "870,795". Exact figures only on request, or when the user must act on one.
- **Timestamps in spoken-relative form.** "4.7 seconds in", never raw
  "00:04.670.123" strings (a dozen syllables of digits each).
- **Never recite addresses, UUIDs, or long hex.** "The address ending 8000",
  or omit entirely — a single pointer is ~14 spoken words read digit-by-digit.
  Give the exact value only when the user must act on it.
- **Backtraces as "FunctionName in BinaryName".** Top ~5 app frames, then
  "N system frames omitted". No addresses, no full dumps.
- **Call trees in words.** "A calls B calls C, and B holds 80% of the time."
  Never indentation art, ASCII timelines, or bar glyphs — meaning must never
  live only in visual structure.
- **Alias long schema names.** Introduce
  "com-apple-cfnetwork-transaction-intervals-full-info" once, then say "the
  CFNetwork transactions table".
- **Code blocks are referenced artifacts, never the message.** Precede every
  block with a preamble carrying the idea and the location: "the problem is
  self-capture in the closure at SidebarView.swift:631 — here's the four-line
  fix". The idea makes the block skippable; the file:line lets the listener
  jump to their editor, where braille displays and structured navigation
  actually work, instead of hearing code read aloud in a transcript. Keep
  blocks minimal — only the lines that change. The prose must stand alone:
  skipping every code block should lose nothing.
- **Speak Swift selectors as prose.** "makeNSView taking context", not
  `makeNSView(context:)` — VoiceOver reads a trailing `:)` as "Smiley", so
  Swift's argument-label syntax is systematically misread. Use the exact
  spelling only when the user must type it.
- **Meaningful link text.** Never bare URLs.
- **Minimize markdown syntax itself — carry emphasis in word choice.** Some
  surfaces (terminal output especially) present raw markdown, where
  `**important**` is read as "star star important star star" and a pipe table
  becomes an unreadable stream of "bar". Write "critically, the timer fires
  every 5 seconds" instead of bolding; skip decorative italics and inline
  backticks on non-code; never let formatting be the only carrier of meaning.
  Light structure is fine on surfaces that render it — but since you can't be
  sure, prefer plain sentences.
- **No emoji as bullets or markers.** VoiceOver reads their names aloud
  ("sparkles sparkles rocket").
- **Announce slow operations before starting them.** Trace exports/ingests can
  take minutes; a progress spinner is invisible in audio. Say what's running
  and roughly how long.
- **Headings sparingly and hierarchically — and only where they render.** On a
  surface that renders markdown, headings are navigation landmarks. If the
  surface shows raw markdown (VoiceOver reading "pound pound"), use spoken
  landmarks instead: "First finding:", "Second finding:" — prose that works as
  a heading when heard.

---

*Informed by real field testing of this server's output with the Xcode coding
assistant, and by the screen-reader pain points documented by the
[claude-a11y](https://github.com/JacquelineDMcGraw/claude-a11y) project (which
solves the complementary rendering-layer half of this problem for browser and
terminal surfaces).*
