# Architecture docs — what they are and how to maintain them

## What these docs are for

These docs exist to orient an AI that arrives with no memory of past sessions. They are not tutorials for human readers — they assume you can read code. Their job is to answer the question "before I touch anything, what do I need to know about how this area works and why it is shaped this way?"

A doc in this folder should tell you:
- Which files are involved in a subsystem
- The key terms and symbols to look for in those files
- The relationships between the files
- Why the design is shaped the way it is — constraints, tradeoffs, decisions that look surprising but are intentional

Never explain what code does. The code says what. These docs say why, and flag what is unexpected.

## The two-level structure

**`overallArch.md`** is permanent and always small. It contains:
- A Mermaid diagram of the major subsystems and how they connect
- One sentence per subsystem
- A link to that subsystem's detail doc

It is safe to drop into any AI context regardless of the task because it is always short. It gives the AI just enough to know which detail doc to read next.

**`howXWorks.md`** files cover individual subsystems in depth. Each one is only loaded when the task touches that subsystem.

## When to create a new subsystem doc

Extract a subsystem from `overallArch.md` when its section grows beyond a short paragraph. The overview should never explain *how* something works — only *what* it is and *where* the detail lives. When you find yourself writing more than that, it is time for a new file.

Name the file `howXWorks.md` where X is the subsystem name. The filename is a reference — other files and comments will point to it by name.

## What goes in a subsystem doc

1. **One sentence on what this subsystem does**
2. **The files involved** — list them so an AI knows exactly where to look
3. **A diagram** if the relationships between files are non-obvious (Mermaid preferred)
4. **Key terms** — the symbols, types, and function names that will appear in those files
5. **Why it is shaped this way** — the constraint or decision that explains the design
6. **What looks surprising but is intentional** — the things an AI might try to "fix"

## The filename-as-reference convention

When a code comment needs to point to an arch doc, use this format:

```typescript
// exit condition for this workaround — see howVersionResolutionWorks.md
```

The filename is the reference. This gives you a free search index: to find every place that references a doc, search the repo for its filename. When you update a doc, run that search and review every hit to see if it needs updating too.

## Rules for maintaining these docs

**When you touch code covered by an arch doc:**
- Read the doc before making changes
- If your change affects anything the doc describes, update the doc

**When you modify an arch doc:**
- Search the entire repo for the doc's filename
- Review every hit — comments, other docs, CLAUDE.md
- Update anything that is no longer accurate
- Include the search results and any updates in the completion report

**When you make a significant architectural change:**
- Decide whether it warrants a new subsystem doc or updates to an existing one
- If a new subsystem is emerging that `overallArch.md` doesn't cover, add it

## Comment style that pairs with these docs

Code comments should only say why — never what. Two patterns are especially useful:

**Exit condition comments** — encode when a workaround or constraint is safe to remove:
```typescript
// xcrun requires absolute path here — Xcode's minimal PATH won't find node otherwise
// safe to remove if Xcode ever passes a full PATH to spawned processes
```

**Unexpected-but-intentional flags** — prevent an AI from "fixing" things that aren't broken:
```typescript
// returns null intentionally — caller handles the missing case, see howSessionsWork.md
```

Without the second pattern an AI reading the file may treat the null return as a bug.

## Adding a new doc — checklist

- [ ] Named `howXWorks.md`
- [ ] Starts with one sentence on what the subsystem does
- [ ] Lists the files involved
- [ ] Explains the why, not the what
- [ ] Flags anything that looks surprising but is intentional
- [ ] Added to `overallArch.md` — diagram updated, one-line entry, link added
- [ ] Any existing comments that covered this ground now point to the doc instead
