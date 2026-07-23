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
- **Prose over tables.** Prefer short prose or numbered lists. When a table is
  genuinely needed: one sentence first saying what it shows and which row
  matters, at most ~5 rows, and a rollup for the rest ("…and 12 more, ranging
  8ms down to 2ms").
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
- **Introduce code blocks in prose.** "A six-line Swift fix follows", then the
  block, then resume with a clear transition — screen readers announce fences
  poorly, so the prose must carry the framing.
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
- **Headings sparingly and hierarchically.** They are navigation landmarks,
  not decoration.

---

*Informed by real field testing of this server's output with the Xcode coding
assistant, and by the screen-reader pain points documented by the
[claude-a11y](https://github.com/JacquelineDMcGraw/claude-a11y) project (which
solves the complementary rendering-layer half of this problem for browser and
terminal surfaces).*
