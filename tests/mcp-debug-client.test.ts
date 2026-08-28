import { describe, expect, it } from "vitest";

import { resolveMcpSseUrl, resolveTransportKind } from "../src/mcp/debug-client.js";

describe("resolveMcpSseUrl", () => {
  it("为服务根地址补充 SSE 路径", () => {
    expect(resolveMcpSseUrl("http://101.200.220.45:8050").toString()).toBe(
      "http://101.200.220.45:8050/sse",
    );
  });

  it("保留显式配置的 MCP 路径", () => {
    expect(resolveMcpSseUrl("http://127.0.0.1:9000/custom-sse").pathname).toBe("/custom-sse");
  });
});

describe("resolveTransportKind", () => {
  it("/sse 结尾走旧 SSE 传输", () => {
    expect(resolveTransportKind(new URL("http://127.0.0.1:9000/sse"))).toBe("sse");
  });

  it("/mcp 走 streamable HTTP 传输", () => {
    expect(resolveTransportKind(new URL("http://10.249.244.76:31046/mcp"))).toBe(
      "streamable-http",
    );
  });

  it("非 /sse 结尾的自定义路径默认 streamable HTTP", () => {
    expect(resolveTransportKind(new URL("http://127.0.0.1:9000/api/mcp"))).toBe(
      "streamable-http",
    );
  });
});
