import path from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { HamClient, PROJECT_STATUS_LABELS, normalizePage } from "./ham-client.js";
import { OntologyStore } from "./ontology.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ham = new HamClient();
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

/** 通用分页查询入组：filters 透传后端字段，page/page_size 控制分页。 */
const pageInput = {
  page: z.number().int().min(1).optional().describe("页码，从 1 开始，默认 1"),
  page_size: z.number().int().min(1).max(50).optional().describe("每页条数，默认 10，最大 50"),
};

function pageMeta(
  result: { total: number; records: unknown[] },
  query: { page?: number | undefined; page_size?: number | undefined },
) {
  const page = query.page ?? 1;
  const pageSize = query.page_size ?? 10;
  return {
    total: result.total,
    page,
    page_size: pageSize,
    has_more: page * pageSize < result.total,
  };
}

server.registerTool(
  "query_parent_projects",
  {
    description:
      "查询资产中台的父项目列表（真实接口 ham-project/parent-project/page）。可按状态词（生效/审批中/退回/取消/可审批，自动转码）或字段过滤。常用 filters 字段：parentProjectCode、parentProjectName、orgCode、hbcParentProjectCode、projectManager。",
    inputSchema: {
      ...pageInput,
      status: z.string().optional().describe("项目状态词，如 生效、审批中、退回、取消、可审批"),
      filters: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("透传给后端的过滤字段，字段名与 ham_ui 一致"),
    },
  },
  async (query) => {
    const data = normalizePage(await ham.parentProjects(query));
    const records = data.records.map((row) => decorateProject(row));
    return toolResult({ ...pageMeta(data, query), records });
  },
);

server.registerTool(
  "query_child_projects",
  {
    description:
      "查询子项目列表（真实接口 ham-project/project-info/getProjectList）。不传 parent_project_code 时查全部子项目；常用 filters 字段：projectCode、projectName、orgCode、projectStatus。",
    inputSchema: {
      ...pageInput,
      parent_project_code: z.string().optional().describe("父项目编码（走 getProjectInfoListByParent）"),
      status: z.string().optional().describe("项目状态词，自动转码"),
      filters: z.record(z.string(), z.unknown()).optional().describe("透传给后端的过滤字段"),
    },
  },
  async (query) => {
    if (query.parent_project_code) {
      const data = normalizePage(await ham.childProjectsByParent(query.parent_project_code));
      const records = data.records.map((row) => decorateProject(row));
      return toolResult({ total: data.total, records, note: "按父项目编码查询" });
    }
    const { parent_project_code: _drop, status, ...rest } = query;
    const filters = { ...rest.filters };
    if (status) {
      filters.projectStatus = HamClient.normalizeProjectStatus(status);
    }
    const data = normalizePage(await ham.childProjects({ ...rest, filters }));
    const records = data.records.map((row) => decorateProject(row));
    return toolResult({ ...pageMeta(data, query), records });
  },
);

server.registerTool(
  "query_purchase_requisitions",
  {
    description:
      "查询采购申请单列表（真实接口 ham-purchasing/purchase-requisition/page）。可按状态词（草稿/审批中/已审批/已退回/已取消，自动转字母码）或字段过滤。常用 filters 字段：requisitionCode、requisitionName、projectCode、orgCode、supplierCode。",
    inputSchema: {
      ...pageInput,
      status: z.string().optional().describe("采购申请状态词，如 草稿、审批中、已审批"),
      filters: z.record(z.string(), z.unknown()).optional().describe("透传给后端的过滤字段"),
    },
  },
  async (query) => {
    const data = normalizePage(await ham.purchaseRequisitions(query));
    const records = data.records.map((row) => decorateRequisition(row));
    return toolResult({ ...pageMeta(data, query), records });
  },
);

server.registerTool(
  "query_purchase_contracts",
  {
    description:
      "查询采购合同列表（真实接口 ham-purchasing/purchase-contract/page）。filters 字段透传，如 contractCode、projectCode、orgCode。",
    inputSchema: {
      ...pageInput,
      filters: z.record(z.string(), z.unknown()).optional().describe("透传给后端的过滤字段"),
    },
  },
  async (query) => {
    const data = normalizePage(await ham.purchaseContracts(query));
    return toolResult({ ...pageMeta(data, query), records: data.records });
  },
);

server.registerTool(
  "query_assets_by_contract",
  {
    description:
      "按合同查询收货资产（真实接口 ham-assets/receiving-info/selectByContract）。filters 必须同时传合同号与公司编码：{\"purchaseContractNumber\": \"HT2026-...\", \"orgCode\": \"0NJ0\"}（可先查采购合同拿到这两个字段）。",
    inputSchema: {
      ...pageInput,
      filters: z.record(z.string(), z.unknown()).describe("合同过滤条件，如 {\"purchaseContractNumber\": \"HT2026-...\", \"orgCode\": \"0NJ0\"}"),
    },
  },
  async (query) => {
    const data = normalizePage(await ham.assetsByContract(query));
    return toolResult({ ...pageMeta(data, query), records: data.records });
  },
);

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

/** 项目记录：状态码转可读标签，保留原始字段。 */
function decorateProject(row: unknown) {
  if (!row || typeof row !== "object") return row;
  const record = row as Record<string, unknown>;
  const status = record.parentProjectStatus ?? record.projectStatus;
  const label =
    (typeof status === "string" || typeof status === "number") && PROJECT_STATUS_LABELS[String(status)]
      ? PROJECT_STATUS_LABELS[String(status)]
      : status;
  return {
    project_code: record.parentProjectCode ?? record.projectCode,
    project_name: record.parentProjectName ?? record.projectName,
    status: label,
    org_code: record.orgCode,
    budget_amount: record.projectTotalAmount,
    manager: record.projectPersonInChargeName,
    start_date: record.projectStartDate,
    end_date: record.projectEndDate,
    id: record.id,
    raw: record,
  };
}

/** 采购申请记录：挑出关键业务字段，原始数据放 raw。 */
function decorateRequisition(row: unknown) {
  if (!row || typeof row !== "object") return row;
  const record = row as Record<string, unknown>;
  return {
    requisition_code: record.requisitionCode,
    requisition_name: record.requisitionName,
    status: record.requisitionStatus,
    project_code: record.projectCode,
    project_name: record.projectName,
    org_code: record.orgCode,
    supplier: record.supplierName ?? record.supplierCode,
    amount: record.requisitionAmount,
    currency: record.currency,
    applicant: record.applicantName,
    id: record.id,
    raw: record,
  };
}

const transport = new StdioServerTransport();
await server.connect(transport);
