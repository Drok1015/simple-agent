import { describe, expect, it } from "vitest";

import { resolveMcpSseUrl } from "../src/mcp/debug-client.js";

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
