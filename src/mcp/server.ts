import path from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { OntologyStore } from "./ontology.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ontology = new OntologyStore(
  path.join(projectRoot, "ontology.json"),
  path.join(projectRoot, "ontology.seed.json"),
  new Set([
    "query_parent_projects",
    "query_child_projects",
    "query_purchase_requisitions",
    "query_purchase_contracts",
    "query_assets_by_contract",
  ]),
);
const server = new McpServer({ name: "business-mcp", version: "0.2.0" });

function toolResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
}

server.registerTool(
  "search_ontology",
  {
    description:
      "在本体（资产项目/采购分类知识库）中查询一个概念：返回定义、别名、完整分类链、直接子类、以及 suggested_call（该概念对应的业务查询工具与参数，沿祖先链解析）。用户问『X 是什么 / 属于哪类 / 该用哪个工具查』时使用。",
    inputSchema: { term: z.string().describe("概念名称或别名，例如：父项目、采购申请、生效") },
  },
  async ({ term }) => toolResult(await ontology.search(term)),
);

server.registerTool(
  "add_ontology_concept",
  {
    description:
      "在会话中建设本体：新增一个概念并挂到已有父概念下，可选提供别名、描述、工具映射（tool 必须是业务查询工具名）和关联关系（relations 的 target 必须是已有概念）。写入持久化到 ontology.json，立即影响后续 search_ontology 的 suggested_call 与 relations。",
    inputSchema: {
      label: z.string().describe("新概念名称，例如：设备类采购"),
      parent: z.string().describe("父概念名称或别名，必须已存在，例如：采购申请"),
      description: z.string().optional().describe("概念的业务含义说明"),
      aliases: z.array(z.string()).optional().describe("概念别名列表"),
      tool: z
        .string()
        .optional()
        .describe("概念对应的业务查询工具名，如 query_purchase_requisitions"),
      params: z.record(z.string(), z.unknown()).optional().describe("工具调用提示参数"),
      relations: z
        .array(
          z.object({
            target: z.string().describe("目标概念名称或别名，必须已存在"),
            type: z.string().describe("关系类型，如 生成/包含/归属/同步"),
            label: z.string().describe("关系的业务含义"),
            via: z.string().optional().describe("外键字段，如 projectCode"),
          }),
        )
        .optional()
        .describe("与其他主体的关联关系"),
    },
  },
  async ({ label, parent, description, aliases, tool, params, relations }) =>
    toolResult(
      await ontology.addConcept({ label, parent, description, aliases, tool, params, relations }),
    ),
);

server.registerTool(
  "get_ontology",
  {
    description: "返回本体全图（全部概念与实例），用于浏览可用概念或向用户解释资产项目/采购分类体系。",
    inputSchema: {},
  },
  async () => toolResult(await ontology.getGraph()),
);

const transport = new StdioServerTransport();
await server.connect(transport);
