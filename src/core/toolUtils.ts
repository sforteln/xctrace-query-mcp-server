import { XctraceError } from "../engine/xctrace.js";
import { logToolCall } from "./sessionLogger.js";

type ToolContent = { content: Array<{ type: "text"; text: string }> };

export function text(str: string): ToolContent {
  return { content: [{ type: "text", text: str }] };
}

/** Wrap a tool handler so XctraceError becomes a structured text error. */
export async function safeTool(fn: () => Promise<ToolContent>): Promise<ToolContent> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof XctraceError) {
      return { content: [{ type: "text", text: JSON.stringify(err.toStructured(), null, 2) }] };
    }
    throw err as Error;
  }
}

/**
 * Like safeTool but logs the call to the session log when INSTRUMENTS_MCP_LOG=1.
 * Drop-in replacement: safeToolWithLog("tool_name", args, async () => { ... })
 */
export async function safeToolWithLog(
  tool: string,
  args: Record<string, unknown>,
  fn: () => Promise<ToolContent>
): Promise<ToolContent> {
  const start = Date.now();
  let result: ToolContent;
  let ok = true;
  try {
    result = await safeTool(fn);
  } catch (err) {
    ok = false;
    logToolCall(tool, args, null, Date.now() - start, false);
    throw err;
  }
  const responseText = result.content[0]?.text ?? null;
  logToolCall(tool, args, responseText, Date.now() - start, ok);
  return result;
}
