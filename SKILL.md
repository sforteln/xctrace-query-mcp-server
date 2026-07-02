---
name: mcp-server-design
description: Style guide for designing an MCP server's tool surface — parameter design, naming, error handling, response shape, lens/intent priority, drift guards, suggested-next-action freshness. TRIGGER — load before adding or changing tools, params, error kinds, nextActions/quickStart logic, or recording/session config in an MCP server. Recognize the task-shape (designing what an agent-facing tool surface looks like) rather than waiting for an explicit command.
---

# MCP Server Design

Principles below are each grounded in a real failure or a real validated decision from building a production MCP server (not theoretical). Apply them as you design — don't treat this as a checklist to run once at the end. Most apply at every single decision (naming, descriptions, params); a few are decide-once-then-maintain (priority ordering, error taxonomy) and only need revisiting when something new is added that could conflict with them.

## Minimize the tool surface deliberately

Prefer baked-in defaults over exposing raw underlying knobs as parameters. If a setting has no real tradeoff an agent would ever want to opt out of (more data for free, no real cost), just turn it on by default inside the relevant intent/tool — don't make the agent learn it exists.

When a knob *does* represent a genuine decision, prefer a single named, friendly choice (an enum, a named tool variant) over a raw mechanism parameter. A `kind: "view-body" | "representable" | "other"` enum is fine — the agent reasons about *what it wants*, not *how the underlying system is structured*.

The thing to actively avoid is combinatorial explosion: once a feature has two or more *independent* toggles, naming a separate tool/intent per combination doesn't scale (2 toggles → 4 variants, 4 toggles → 16). At that point, additive boolean parameters (each documented with its own "why you'd want this") beat named-combination explosion — but reach for that only when the toggles are genuinely independent and each represents a real tradeoff, not as a default pattern.

## No overlapping tool responsibility

Distinct from the param-surface point above: don't ship two *tools* whose jobs overlap enough that an agent can't tell which one to reach for from the names and descriptions alone. If two tools would return overlapping or near-identical data for the same request, either merge them or make the boundary between them sharp and explicit — and say so in each one's "Not for X" steering text — rather than leaving the agent to guess based on subtle wording differences.

## Fail fast on structural ambiguity — don't silently degrade

If a request could resolve to more than one real target (e.g., the same logical resource exists multiple times under one name), don't guess, don't merge, and don't let it fall through to a slow, generic failure. Detect the ambiguity structurally and reject immediately with a clear, actionable error that lists the actual options and how to disambiguate. An instant "this is ambiguous, here are your 3 choices" error is a better outcome than a request that succeeds with silently wrong data, and far better than one that fails confusingly after a long timeout.

This generalizes past one specific bug: any place your server resolves "the" target for a name should ask whether "the" is actually well-defined, and if not, make that fact loud and immediate rather than discoverable only through wrong output.

## One best-guess entry point, not several

If your server offers an upfront "here's where to start" suggestion (a single recommended next call), keep it singular — don't try to return a ranked list of several. A capable agent that has the full list of available resources/capabilities will construct its own multi-option orientation when a task genuinely has several reasonable starting points; that's not a gap to fill server-side. A single best-guess shortcut is for the *unambiguous* common case ("get me to real data in 2 calls"); when there's no unambiguous best guess, the honest move is to give full information and let the agent reason, not to fabricate a forced ranking among options you can't actually rank.

## Priority/ordering between overlapping capabilities is a design decision

When multiple tools/handlers could plausibly match the same request (e.g., several recognize overlapping underlying resources), whichever wins by default needs to reflect actual user intent, not just registration order. Capabilities that get auto-bundled as a side effect of using something else (an auxiliary instrument pulled in by an unrelated recording template, a generic profiler embedded in a domain-specific one) should rank *below* the more specific/intentional capabilities — their mere presence is not a strong signal of what the user actually wanted. Write down *why* the ordering is what it is; it's easy for this to silently rot as new capabilities are added.

## Unbounded per-item payload is a default-response design problem

A row-count limit (`limit: 30`) does not bound response size if individual rows can carry unbounded-size fields (a full ancestor chain, a graph serialized as a string, an arbitrarily long array). Default responses to a compact, curated field set; require fields known to be large/unbounded to be requested explicitly. Don't wait to discover this from a production overflow — if a field's size scales with something other than "one value," audit it before shipping the tool, not after an agent's tool call gets silently truncated or spilled to disk by the calling client.

## Name tools as verb + scoped object

Core/generic verbs that work on any resource get bare names (`query`, `aggregate`, `get_row`). Tools specific to one domain or family of resources should be prefixed by that domain, so an agent scanning the full tool list can tell at a glance which family a tool belongs to without reading its description (`list_swiftui_view_body_updates`, `aggregate_swiftui_filtered_updates` vs. the generic `query`/`aggregate`). This also structurally prevents two different domains from squatting on the same generic-sounding name as the surface grows.

## Tool descriptions are a behavioral spec, not API documentation

A tool description is re-injected into context on every relevant turn — it steers the *decision* to call the tool, not just documents its signature. Structure: open with a verb describing when to call it (never a vacuous "the"/"this"/"a"); include an explicit "Not for X — use Y instead" block to steer away the most plausible misuse, since that's the highest-leverage sentence in the whole description; name the cheaper/more-specific sibling tool when one exists. Don't restate the parameter schema in prose, and don't duplicate the same sentence between the tool description and a parameter description — that's two places for the same fact to drift out of sync.

## Treat every cross-reference as a drift risk

Anywhere your code asserts a fact about a *different* part of the codebase — a tool name mentioned in another tool's description, a schema name baked into hint text, a column mnemonic hardcoded into default args, a pre-filled "suggested next action" payload (`tool` + `args`) — that fact can go stale silently when the other part changes. It is very easy to add a new required parameter to a tool and forget every other place that already calls it with a stale payload, including your own server's self-suggestions.

The fix is structurally the same for every category: write one automated check per category that reads the live, authoritative source (the actual registered tool list, the actual schema) and validates every place referencing it — run on every change, not re-derived by a human reading the code occasionally. Don't stop at the categories you've already been burned by; the next one is just as easy to introduce.

## Progressive disclosure, not eager completeness

Default to compact, summarized output; offer an explicit drill-down path (a "get full detail for this one item" call) rather than returning everything in case it's needed. Same instinct as the unbounded-payload point above, generalized: design every response around "what does the agent need to decide its *next* call," not "what's the complete record."

## Errors are structured data the agent reasons over, not strings it pastes back

Give every distinct failure mode a discriminable kind/category, plus structured details relevant to that kind (the actual list of valid options, the actual conflicting values) — not a formatted sentence that's only useful if a human reads it. An agent can branch on a `kind` field and act differently per failure mode; it can't reliably parse English out of a stderr dump.
