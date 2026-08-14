import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { DemoBusinessBackend } from "./backend.js";

const backend = new DemoBusinessBackend();
const server = new McpServer({ name: "business-mcp", version: "0.1.0" });

function toolResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
}

server.registerTool(
  "query_orders",
  {
    description: "按订单号、客户名称或项目名称查询当前用户有权查看的订单。",
    inputSchema: { query: z.string().describe("订单号、客户名称或项目名称") },
  },
  async ({ query }) => toolResult(backend.queryOrders(query)),
);

server.registerTool(
  "get_asset_form",
  {
    description: "读取指定订单对应的资产申报字段结构、订单数据和建议值。",
    inputSchema: { order_id: z.string().describe("唯一订单号") },
  },
  async ({ order_id }) => toolResult(backend.getAssetForm(order_id)),
);

server.registerTool(
  "prepare_asset_draft",
  {
    description: "校验并生成资产申报草稿预览；不会保存或提交业务数据。",
    inputSchema: {
      order_id: z.string().describe("唯一订单号"),
      fields: z.record(z.string(), z.unknown()).describe("用户明确要求覆盖的字段"),
    },
  },
  async ({ order_id, fields }) => toolResult(backend.prepareAssetDraft(order_id, fields)),
);

const transport = new StdioServerTransport();
await server.connect(transport);
