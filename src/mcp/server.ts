import path from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { DemoBusinessBackend } from "./backend.js";
import { OntologyStore } from "./ontology.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const backend = new DemoBusinessBackend();
const ontology = new OntologyStore(
  path.join(projectRoot, "ontology.json"),
  path.join(projectRoot, "ontology.seed.json"),
);
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

server.registerTool(
  "search_ontology",
  {
    description:
      "在本体（资产分类知识库）中查询一个概念：返回它的定义、别名、完整分类链（根到当前）、直接子类和已有实例。用户问『X 是什么 / 属于哪类 / 有哪些子类』时使用。",
    inputSchema: { term: z.string().describe("概念名称或别名，例如：空压机、HVAC") },
  },
  async ({ term }) => toolResult(await ontology.search(term)),
);

server.registerTool(
  "query_orders_by_concept",
  {
    description:
      "按本体概念做语义订单查询：自动把父概念展开为全部子类（例如『动力设备』会匹配到空压机、电动机下的实例），再聚合关联订单。适合『查某类设备的订单』这类按类别提问，与 query_orders 的关键字匹配形成对照。",
    inputSchema: { concept: z.string().describe("本体概念名称或别名，例如：动力设备、后处理设备") },
  },
  async ({ concept }) => {
    const result = await ontology.queryByConcept(concept);
    if (!result.found) {
      return toolResult({
        ...result,
        hint: `本体中没有匹配『${concept}』的概念；可从 expansion 列表选择，或用 add_ontology_concept 新增后重试`,
      });
    }
    const orders = result.order_ids.flatMap((orderId) => backend.queryOrders(orderId).items);
    return toolResult({ ...result, orders: { items: orders, count: orders.length } });
  },
);

server.registerTool(
  "add_ontology_concept",
  {
    description:
      "在会话中建设本体：新增一个概念并挂到已有父概念下，可选提供别名和描述，可选关联订单形成实例。写入会持久化到 ontology.json，立即影响后续语义查询。",
    inputSchema: {
      label: z.string().describe("新概念名称，例如：冷干机"),
      parent: z.string().describe("父概念名称或别名，必须已存在，例如：后处理设备"),
      description: z.string().optional().describe("概念的业务含义说明"),
      aliases: z.array(z.string()).optional().describe("概念别名列表"),
      order_id: z.string().optional().describe("可选：把该概念作为实例关联到的订单号"),
    },
  },
  async ({ label, parent, description, aliases, order_id }) =>
    toolResult(await ontology.addConcept({ label, parent, description, aliases, order_id })),
);

server.registerTool(
  "get_ontology",
  {
    description: "返回本体全图（全部概念与实例），用于浏览可用概念或向用户解释分类体系。",
    inputSchema: {},
  },
  async () => toolResult(await ontology.getGraph()),
);

const transport = new StdioServerTransport();
await server.connect(transport);
