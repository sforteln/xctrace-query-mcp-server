import { XctraceError } from "../engine/xctrace.js";

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
