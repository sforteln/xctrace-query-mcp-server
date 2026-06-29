#!/usr/bin/env node
/**
 * instruments-mcp-server — headless stdio MCP server entry point.
 *
 * This is the runnable skeleton: it completes the MCP handshake over stdio and
 * registers a single placeholder `ping` tool. No trace logic lives here yet —
 * the universal core verbs (openTrace, listInstruments, query, aggregate, …)
 * and the per-instrument lenses are layered on in later work. See src/engine,
 * src/core, and src/lenses.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const SERVER_NAME = "instruments-mcp-server";
const SERVER_VERSION = "0.1.0";

function createServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  // Placeholder tool. Confirms the handshake and tool-list round-trip end to
  // end; replaced by the real trace tools in subsequent prompts.
  server.registerTool(
    "ping",
    {
      title: "Ping",
      description:
        "Health check. Returns 'pong' to confirm the server is connected and responding over stdio.",
    },
    async () => ({
      content: [{ type: "text", text: "pong" }],
    })
  );

  return server;
}

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdio transport keeps the process alive; nothing else to do here. Logging
  // must go to stderr so it never corrupts the stdio JSON-RPC stream on stdout.
  console.error(`${SERVER_NAME} v${SERVER_VERSION} ready (stdio)`);
}

main().catch((err) => {
  console.error(`${SERVER_NAME} failed to start:`, err);
  process.exit(1);
});
