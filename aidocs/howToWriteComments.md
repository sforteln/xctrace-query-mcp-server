# How to write comments that help AI readers

Code comments have a new reader: AI assistants that scan your codebase to understand it before making changes. A well-placed comment dramatically changes what the AI does next. A bad one wastes its attention or, worse, misleads it.

The rules below are not about style. They are about information density.

---

## The core rule: why, never what

The code already says what it does. A comment that restates it adds noise:

```typescript
// increment the counter
count++

// filter out null values
const valid = items.filter(x => x !== null)
```

These comments say nothing the code doesn't already say. An AI reading them gains nothing — but now has more tokens to process.

A comment earns its place only when it says something the code cannot say:

```typescript
// xcrun requires an absolute path here — Xcode's minimal PATH strips node
count++  // no comment needed

// the API silently returns an empty array instead of 404 for missing resources
const valid = items.filter(x => x !== null)
```

The test: if removing the comment would confuse a future reader, keep it. If not, delete it.

---

## Comments as signposts for AI readers

When an AI is asked to make a change, it scans the codebase looking for relevant context. Comments are high-signal anchors in that scan — especially for embedding-based search, where the text of a comment is often more semantically meaningful than variable names and control flow.

A comment that says **why** something exists gives an AI a foothold:

- It knows the constraint the code is working around
- It can judge whether the constraint still applies before touching the code
- It knows where to look for more context

A comment that says **what** the code does gives an AI nothing it couldn't derive itself — and trains it to trust comments over code, which is dangerous when comments drift.

Write comments as if you're leaving a note for a competent colleague (human or AI) who can read the code but has no memory of the meeting where you made the decision.

---

## The historical reason: context that can't be read from code

Some decisions look wrong from the outside. Without the history, the next reader either leaves them alone out of fear or removes them and breaks something.

A comment that captures the original constraint makes the code self-defending:

```typescript
// batch size capped at 50 — the v1 API silently drops requests larger than this
// safe to increase once we confirm the v2 endpoint is in use everywhere
const BATCH_SIZE = 50

// double render intentional — SwiftUI layout pass needs a committed size
// before measuring children; single pass produces zero-height cells
.frame(height: measured ? cellHeight : 0)
```

The reader now knows:
- Why the magic number exists
- What assumption it encodes
- When it is safe to change

Without the comment, `50` is just a number someone put there. With it, it is a documented contract.

---

## Exit conditions: encode when it is safe to remove

Workarounds and temporary fixes become permanent when no one can remember why they were added or when the underlying issue was fixed. The exit condition pattern prevents this.

**Format:** state the workaround, then say exactly what has to be true before it can be removed.

```typescript
// URLSession silently drops the Authorization header on redirect —
// safe to remove this manual redirect handler once rdar://12345 is resolved
// or once we stop supporting macOS 13

// using string comparison here instead of enum equality — the SDK does not
// expose the enum publicly until version 3.2; revert once we update the dependency
if response.status == "rate_limited" {
```

This transforms a "don't touch it, I don't know why it's here" comment into a clear contract: here is the condition, here is what happens when it is met, here is how you confirm it is safe.

---

## Unexpected-but-intentional: prevent AI "fixes"

An AI reading code that returns `null`, skips a case, or leaves an array empty may treat it as a bug and "fix" it. If the behavior is intentional, flag it.

```typescript
// returns null intentionally — the caller handles the missing case
// by showing an empty state; see howSessionsWork.md
func findSession(id: String) -> Session? {

// empty array is a valid result here — the API distinguishes
// "no results" from "error" by status code, not by presence of data
return []

// this branch is unreachable in production — only exists to satisfy
// the exhaustive switch; compiler requires it, runtime never hits it
default:
    assertionFailure("unreachable")
```

Without these flags, an AI that sees "returns null" or "returns empty array" in a function named `findSession` will assume it found a bug. With the flag, it knows the shape is correct and looks for the real issue elsewhere.

---

## Pointing to arch docs for the bigger picture

Some decisions span multiple files and cannot be explained in a single comment without making the comment longer than the code. For these, don't try — point to the arch doc that explains the full picture.

```typescript
// session cache is load-once; don't call xctrace again here
// — see howSessionsWork.md

// version resolution order matters here; override wins before base
// — see howVersionResolutionWorks.md

// lenses are purely additive — this schema still works without one
// — see howLensesWork.md
```

The filename is the reference. This gives you two things for free:

1. Anyone reading the comment can find the full explanation immediately
2. Searching the repo for `howSessionsWork.md` finds every place that depends on the session design — an automatic impact list when you change it

Keep the inline comment short: one line saying what the constraint is, one line pointing to where the reasoning lives.

---

## What not to comment

**Don't describe what the code does:**
```typescript
// loop over all items  ← no
for item in items {
```

**Don't reference the PR, issue, or task that introduced the code:**
```typescript
// added for the Help AI feature  ← no — this rots immediately
// fixes bug #4521  ← no — look at git blame for that
```

**Don't write multi-paragraph docstrings that restate the function signature:**
```typescript
/// Returns the session for the given ID.
/// - Parameter id: The session ID to look up.
/// - Returns: The session, or nil if not found.
/// ← all of this is in the signature already
func getSession(id: String) -> Session?
```

**Don't add a comment just because the code is complex.** Complex code that needs explaining is a signal to simplify the code, not to add prose on top of it.

---

## Summary

| Use a comment when… | Skip the comment when… |
|---|---|
| The why is non-obvious | The code already says what it does |
| There's a historical constraint | The name explains the intent |
| The behavior looks like a bug but isn't | The logic is straightforward |
| There's a specific exit condition | It would just restate the signature |
| You're pointing to an arch doc | The reason is in git history |

The goal is a codebase where an AI can read a file, immediately understand which decisions are load-bearing and why, and make changes with confidence — without needing to re-derive every past decision from first principles.
