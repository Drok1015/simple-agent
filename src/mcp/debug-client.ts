import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const CONNECT_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 30_000;

export function resolveMcpSseUrl(configuredUrl: string): URL {
  const url = new URL(configuredUrl);
  if (url.pathname === "" || url.pathname === "/") {
    url.pathname = "/sse";
  }
  return url;
}

export class McpDebugClient {
  constructor(private readonly configuredUrl: string) {}

  get targetUrl() {
    return resolveMcpSseUrl(this.configuredUrl).toString();
  }

  private async connect() {
    const client = new Client({ name: "simple-agent-mcp-debugger", version: "0.1.0" });
    const transport = new SSEClientTransport(resolveMcpSseUrl(this.configuredUrl));
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
    return client;
  }

  async inspect() {
    const client = await this.connect();
    try {
      const result = await client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS });
      return {
        configured_url: this.configuredUrl,
        target_url: this.targetUrl,
        transport: "sse" as const,
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
      const tools = await client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS });
      if (!tools.tools.some((tool) => tool.name === name)) {
        throw new Error(`远程 MCP 未注册工具：${name}`);
      }
      return await client.callTool(
        { name, arguments: args },
        undefined,
        { timeout: CALL_TIMEOUT_MS },
      );
    } finally {
      await client.close().catch(() => undefined);
    }
  }
}
