import type { MessagesEventData, ProtocolEvent, ToolsEventData } from "@langchain/langgraph";

export type AgentStreamEvent =
  | { type: "token"; delta: string }
  | {
      type: "tool";
      id: string;
      name?: string;
      status: "started" | "finished" | "error";
      input?: unknown;
      output?: unknown;
      message?: string;
    }
  | { type: "done"; answer: string; toolsUsed: string[] };

function parseJsonValue(value: unknown) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function normalizeToolOutput(output: unknown) {
  if (typeof output !== "object" || output === null) return parseJsonValue(output);

  const record = output as Record<string, unknown>;
  if ("content" in record) return parseJsonValue(record.content);

  const kwargs = record.kwargs;
  if (typeof kwargs === "object" && kwargs !== null && "content" in kwargs) {
    return parseJsonValue((kwargs as Record<string, unknown>).content);
  }

  return output;
}

export function projectProtocolEvent(event: ProtocolEvent): AgentStreamEvent | null {
  if (event.method === "messages") {
    const data = event.params.data as MessagesEventData;
    if (data.event !== "content-block-delta" || data.delta.type !== "text-delta") {
      return null;
    }
    const delta = data.delta.text.replaceAll("</think>", "");
    return delta ? { type: "token", delta } : null;
  }

  if (event.method === "tools") {
    const data = event.params.data as ToolsEventData;
    if (data.event === "tool-started") {
      return {
        type: "tool",
        id: data.tool_call_id,
        name: data.tool_name,
        status: "started",
        input: parseJsonValue(data.input),
      };
    }
    if (data.event === "tool-finished") {
      return {
        type: "tool",
        id: data.tool_call_id,
        status: "finished",
        output: normalizeToolOutput(data.output),
      };
    }
    if (data.event === "tool-error") {
      return {
        type: "tool",
        id: data.tool_call_id,
        status: "error",
        message: data.message,
      };
    }
    return null;
  }

  return null;
}
