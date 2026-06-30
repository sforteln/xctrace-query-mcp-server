# Installing an MCP Server in Xcode's Claude Agent

The Claude assistant **inside Xcode** ("Claude Agent") is a separate install from the
`claude` CLI in your terminal. They share your Anthropic login but **not** their config.
So `claude mcp list` showing a server connected in a terminal means nothing to the Xcode
agent — it reads a different file.

## The one file that matters

Register the server in the Claude Agent's **own** config:

```
~/Library/Developer/Xcode/CodingAssistant/ClaudeAgentConfig/.claude.json
```

Add (or merge into) an `mcpServers` block — same shape as the global `~/.claude.json`.

**HTTP server** (e.g. an app that hosts the MCP over a local port):

```json
{
  "mcpServers": {
    "promptmanager": {
      "type": "http",
      "url": "http://localhost:3456"
    }
  }
}
```

**stdio server** (a command the agent spawns) — note Xcode's minimal `PATH`, so use
**absolute binary paths**:

```json
{
  "mcpServers": {
    "my-tool": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/Users/you/git/my-tool/dist/index.js"]
    }
  }
}
```

### Files that do NOT work (tried and confirmed)

- `~/.claude.json` — read by the **terminal CLI only**; the Xcode agent ignores it.
- `~/Library/Developer/Xcode/CodingAssistant/mcp-servers.json` — not the Claude Agent's
  source. Xcode regenerates it (it kept resetting to empty), so hand-edits vanish.

## How loading works (the key mental model)

- The `mcpServers` config is read **once, at session start**. That registration is the
  durable thing — it's what marks the server "active" for the session.
- For a **stateless HTTP** server the process is forgiving: if the host app dies and
  relaunches, the agent reconnects on the next call. **It survives restarts.**
- What you *cannot* do is change the config and expect the **current** session to notice.
  Edit the file, then **start a new Claude conversation** (or restart Xcode).

## Steps

1. Make sure the server is reachable. For an HTTP server, quick check in Terminal:

   ```bash
   curl -sS http://localhost:3456 -o /dev/null -w "%{http_code}\n"
   ```

   (Any HTTP response = up.)

2. Add the `mcpServers` block above to `ClaudeAgentConfig/.claude.json`.

3. Start a **new** Claude conversation in the Xcode panel.

4. Run `/mcp` → confirm the server is connected.

## Gotchas

- **Edited the config but nothing changed?** You're still in the old session. Open a new
  conversation.
- **HTTP vs stdio:** HTTP servers don't care about Xcode's minimal `PATH`. Only
  stdio/command servers need full absolute binary paths (`/opt/homebrew/bin/...`).
- **A build/test run can kill an app-hosted server.** If the MCP lives inside an app you
  launch from this same Xcode, building or running tests can terminate it; relaunch the
  app before the next MCP call.
