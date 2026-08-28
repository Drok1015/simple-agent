import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";

const CONNECT_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 30_000;

export type McpTransportKind = "streamable-http" | "sse";

/**
 * 宽松版 tools/list 结果校验。
 * MCP 规范要求 outputSchema.type 必须是 "object"，但现实中远端服务存在
 * outputSchema.type = "array" 等不规范定义，SDK 内置严格校验会直接拒收整个工具列表，
 * 调试台需要展示真实数据，因此绕过 SDK 的 listTools/callTool 自行校验。
 */
const LooseToolSchema = z.looseObject({
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  inputSchema: z.unknown().optional(),
  outputSchema: z.unknown().optional(),
  annotations: z.unknown().optional(),
});

const LooseListToolsResultSchema = z.looseObject({
  tools: z.array(LooseToolSchema),
});

const LooseCallToolResultSchema = z.looseObject({
  content: z.array(z.unknown()).optional(),
  structuredContent: z.unknown().optional(),
  isError: z.boolean().optional(),
});

/**
 * 解析配置的 MCP 地址：根路径补 /sse（旧 SSE 习惯），其余原样保留。
 */
export function resolveMcpSseUrl(configuredUrl: string): URL {
  const url = new URL(configuredUrl);
  if (url.pathname === "" || url.pathname === "/") {
    url.pathname = "/sse";
  }
  return url;
}

/**
 * 根据路径推断传输方式：/sse 结尾走旧 SSE，其余走 streamable HTTP（2025-03 协议默认）。
 */
export function resolveTransportKind(url: URL): McpTransportKind {
  return url.pathname.endsWith("/sse") ? "sse" : "streamable-http";
}

export class McpDebugClient {
  /**
   * @param configuredUrl MCP 服务地址
   * @param authToken 可选 Bearer token，附加到 Authorization 头（部分 MCP 服务要求认证）
   */
  constructor(
    private readonly configuredUrl: string,
    private readonly authToken?: string,
  ) {}

  get targetUrl() {
    return resolveMcpSseUrl(this.configuredUrl).toString();
  }

  get transportKind(): McpTransportKind {
    return resolveTransportKind(resolveMcpSseUrl(this.configuredUrl));
  }

  private createTransport(url: URL) {
    const headers: Record<string, string> = {};
    if (this.authToken && this.authToken.trim().length > 0) {
      headers.Authorization = `Bearer ${this.authToken.trim()}`;
    }
    if (resolveTransportKind(url) === "sse") {
      return new SSEClientTransport(url, { requestInit: { headers } });
    }
    return new StreamableHTTPClientTransport(url, { requestInit: { headers } });
  }

  private async connect() {
    const client = new Client({ name: "simple-agent-mcp-debugger", version: "0.1.0" });
    const transport = this.createTransport(resolveMcpSseUrl(this.configuredUrl));
    // SDK 的 StreamableHTTPClientTransport.sessionId 类型声明（string | undefined）
    // 与 Transport 接口（string）在 exactOptionalPropertyTypes 下不兼容，此处安全断言
    await client.connect(transport as unknown as Transport, { timeout: CONNECT_TIMEOUT_MS });
    return client;
  }

  async inspect() {
    const client = await this.connect();
    try {
      const result = await client.request(
        { method: "tools/list" },
        LooseListToolsResultSchema,
        { timeout: CONNECT_TIMEOUT_MS },
      );
      return {
        configured_url: this.configuredUrl,
        target_url: this.targetUrl,
        transport: this.transportKind,
        server: client.getServerVersion() ?? null,
        capabilities: client.getServerCapabilities() ?? {},
        tools: result.tools,
      };
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  async callTool(name: string, args: Record<string, unknown>) {
    const client = await this.connect();
    try {
      const tools = await client.request(
        { method: "tools/list" },
        LooseListToolsResultSchema,
        { timeout: CONNECT_TIMEOUT_MS },
      );
      if (!tools.tools.some((tool) => tool.name === name)) {
        throw new Error(`远程 MCP 未注册工具：${name}`);
      }
      return await client.request(
        { method: "tools/call", params: { name, arguments: args } },
        LooseCallToolResultSchema,
        { timeout: CALL_TIMEOUT_MS },
      );
    } finally {
      await client.close().catch(() => undefined);
    }
  }
}
