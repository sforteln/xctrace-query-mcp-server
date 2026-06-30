/**
 * Example lens — demonstrates the lens pattern using only framework helpers.
 *
 * NOT registered in LENSES[]. Exists to verify the helpers API composes
 * correctly and to serve as a copy-paste starting point for real lenses.
 *
 * A real lens (e.g. Foundation Models) follows this exact pattern:
 *   1. Declare which schema names it handles.
 *   2. registerTools(): add MCP tools that call getTable + classifyWithHints,
 *      then project each row with projectRow().
 *   3. nextActions(): return domain-specific suggestions for the schema.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Lens } from "./types.js";
import type { NextAction } from "../core/response.js";
import { getTable, lastRun as sessionLastRun } from "../engine/session.js";
import { classifyWithHints } from "../engine/roleHints.js";
import { projectRow } from "./helpers.js";

/** Domain row type produced by this lens. */
interface ExampleRow {
  startTime: string | null;
  duration: string | null;
  name: string | null;
  thread: string | null;
}

export const exampleLens: Lens = {
  instruments: ["example-schema"],

  registerTools(server: McpServer): void {
    server.registerTool(
      "example_list",
      {
        title: "Example List",
        description: "List rows from example-schema in domain vocabulary.",
        inputSchema: {}, // real lenses add z.string() fields here
      },
      async (_args: Record<string, never>) => {
        // Illustrates the full lens pattern:
        //   getTable → classifyWithHints → projectRow per row

        // In a real tool: sessionId and run come from the MCP args.
        const sessionId = "<sessionId>";
        const schema = "example-schema";
        const run = sessionLastRun(sessionId);
        const table = await getTable(sessionId, run, schema);
        const classified = classifyWithHints(schema, table.cols);

        const rows: ExampleRow[] = table.rows.map((row) =>
          projectRow(
            row,
            classified,
            // Role-based: generic columns that transfer across schemas.
            { time: "startTime", weight: "duration", thread: "thread" },
            // Mnemonic-based: schema-specific columns.
            { "event-name": "name" }
          ) as unknown as ExampleRow
        );

        return {
          content: [{ type: "text" as const, text: JSON.stringify({ rows }, null, 2) }],
        };
      }
    );
  },

  nextActions(sessionId: string, schema: string, run: number, _allSchemas: string[]): NextAction[] {
    return [
      {
        tool: "example_list",
        args: { sessionId, schema, run },
        description: "List rows in domain vocabulary.",
      },
    ];
  },
};
