import type { ProtocolEvent } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";

import { projectProtocolEvent } from "../src/stream-events.js";

function protocolEvent(method: string, data: unknown): ProtocolEvent {
  return {
    type: "event",
    seq: 1,
    method,
    params: { namespace: [], timestamp: Date.now(), data },
  };
}

describe("projectProtocolEvent", () => {
  it("投影文本增量", () => {
    const result = projectProtocolEvent(
      protocolEvent("messages", {
        event: "content-block-delta",
        index: 0,
        delta: { type: "text-delta", text: "你好" },
      }),
    );

    expect(result).toEqual({ type: "token", delta: "你好" });
  });

  it("投影工具开始事件", () => {
    const result = projectProtocolEvent(
      protocolEvent("tools", {
        event: "tool-started",
        tool_call_id: "call-1",
        tool_name: "query_orders",
      }),
    );

    expect(result).toEqual({
      type: "tool",
      id: "call-1",
      name: "query_orders",
      status: "started",
    });
  });

  it("投影并解包工具完成结果", () => {
    const result = projectProtocolEvent(
      protocolEvent("tools", {
        event: "tool-finished",
        tool_call_id: "call-1",
        output: {
          kwargs: {
            content: '{"count":1,"items":[{"order_id":"SO-1001"}]}',
          },
        },
      }),
    );

    expect(result).toEqual({
      type: "tool",
      id: "call-1",
      status: "finished",
      output: { count: 1, items: [{ order_id: "SO-1001" }] },
    });
  });

  it("解包运行时 ToolMessage 的 content", () => {
    const result = projectProtocolEvent(
      protocolEvent("tools", {
        event: "tool-finished",
        tool_call_id: "call-2",
        output: {
          content: '{"valid":true,"draft":{"asset_name":"空压机 A"}}',
        },
      }),
    );

    expect(result).toEqual({
      type: "tool",
      id: "call-2",
      status: "finished",
      output: { valid: true, draft: { asset_name: "空压机 A" } },
    });
  });

  it("过滤兼容接口偶发的思考结束标记", () => {
    const result = projectProtocolEvent(
      protocolEvent("messages", {
        event: "content-block-delta",
        index: 0,
        delta: { type: "text-delta", text: "</think>" },
      }),
    );

    expect(result).toBeNull();
  });

  it("忽略推理和其他事件", () => {
    const result = projectProtocolEvent(
      protocolEvent("messages", {
        event: "content-block-delta",
        index: 0,
        delta: { type: "reasoning-delta", reasoning: "内部推理" },
      }),
    );

    expect(result).toBeNull();
  });
});
