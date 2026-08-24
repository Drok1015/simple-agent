import { tool } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";

import { settings } from "./config.js";
import {
  HamClient,
  PROJECT_STATUS_LABELS,
  REQUISITION_STATUS_LABELS,
  normalizePage,
  type ToolPageQuery,
} from "./mcp/ham-client.js";

/**
 * 业务查询工具（主进程注册，非 MCP 子进程）。
 *
 * token 不进模型上下文：由 /api/chat 请求头 X-HAM-Token 提供，
 * 经 LangGraph configurable（ham_token）在工具执行时按请求读取；
 * 未提供时回退 .env 的 HAM_TOKEN（直接打开页面场景）。
 */

function requestToken(config: RunnableConfig | undefined): string {
  const fromRequest = config?.configurable?.["ham_token"];
  return typeof fromRequest === "string" && fromRequest.trim() ? fromRequest : settings.hamToken;
}

function clientOf(config: RunnableConfig | undefined): HamClient {
  return new HamClient(settings.hamApiBase, requestToken(config), settings.hamTenantId);
}

/** 通用分页查询入参：filters 透传后端字段，page/page_size 控制分页。 */
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

/** 采购申请记录：状态码转可读标签，挑出关键业务字段，原始数据放 raw。 */
function decorateRequisition(row: unknown) {
  if (!row || typeof row !== "object") return row;
  const record = row as Record<string, unknown>;
  const status = record.requisitionStatus;
  const label =
    (typeof status === "string" || typeof status === "number") && REQUISITION_STATUS_LABELS[String(status)]
      ? REQUISITION_STATUS_LABELS[String(status)]
      : status;
  return {
    requisition_code: record.requisitionCode,
    requisition_name: record.requisitionName,
    status: label,
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

const parentProjectsSchema = z.object({
  ...pageInput,
  status: z.string().optional().describe("项目状态词，如 生效、审批中、退回、取消、可审批"),
  filters: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("透传给后端的过滤字段，字段名与 ham_ui 一致"),
});

const parentProjectsTool = tool(
  async (query: z.infer<typeof parentProjectsSchema>, config) => {
    // HamClient.parentProjects 内部处理 status → parentProjectStatus 转码
    const data = normalizePage(await clientOf(config).parentProjects(query));
    const records = data.records.map((row) => decorateProject(row));
    return { ...pageMeta(data, query), records };
  },
  {
    name: "query_parent_projects",
    description:
      "查询资产中台的父项目列表（真实接口 ham-project/parent-project/page）。可按状态词（生效/审批中/退回/取消/可审批，自动转码）或字段过滤。常用 filters 字段：parentProjectCode、parentProjectName、orgCode、hbcParentProjectCode、projectManager。",
    schema: parentProjectsSchema,
  },
);

const childProjectsSchema = z.object({
  ...pageInput,
  parent_project_code: z.string().optional().describe("父项目编码（走 getProjectInfoListByParent）"),
  status: z.string().optional().describe("项目状态词，自动转码"),
  filters: z.record(z.string(), z.unknown()).optional().describe("透传给后端的过滤字段"),
});

const childProjectsTool = tool(
  async (query: z.infer<typeof childProjectsSchema>, config) => {
    if (query.parent_project_code) {
      const data = normalizePage(await clientOf(config).childProjectsByParent(query.parent_project_code));
      const records = data.records.map((row) => decorateProject(row));
      return { total: data.total, records, note: "按父项目编码查询" };
    }
    const { parent_project_code: _drop, status, ...rest } = query;
    const filters = { ...rest.filters };
    if (status !== undefined && status !== null && status !== "") {
      filters.projectStatus = HamClient.normalizeProjectStatus(status);
    }
    const typed: ToolPageQuery = { ...rest, filters };
    const data = normalizePage(await clientOf(config).childProjects(typed));
    const records = data.records.map((row) => decorateProject(row));
    return { ...pageMeta(data, query), records };
  },
  {
    name: "query_child_projects",
    description:
      "查询子项目列表（真实接口 ham-project/project-info/getProjectList）。不传 parent_project_code 时查全部子项目；常用 filters 字段：projectCode、projectName、orgCode、projectStatus。",
    schema: childProjectsSchema,
  },
);

const requisitionsSchema = z.object({
  ...pageInput,
  status: z.string().optional().describe("采购申请状态词，如 草稿、审批中、招标中、已批准"),
  filters: z.record(z.string(), z.unknown()).optional().describe("透传给后端的过滤字段"),
});

const requisitionsTool = tool(
  async (query: z.infer<typeof requisitionsSchema>, config) => {
    // HamClient.purchaseRequisitions 内部处理 status → requisitionStatus 转码
    const data = normalizePage(await clientOf(config).purchaseRequisitions(query));
    const records = data.records.map((row) => decorateRequisition(row));
    return { ...pageMeta(data, query), records };
  },
  {
    name: "query_purchase_requisitions",
    description:
      "查询采购申请单列表（真实接口 ham-purchasing/purchase-requisition/page）。可按状态词（草稿/已提交/审批中/招标中/招标失败/已批准/已退回/已取消/已生成合同，自动转字母码）或字段过滤。常用 filters 字段：requisitionCode、requisitionName、projectCode、orgCode、supplierCode。",
    schema: requisitionsSchema,
  },
);

const contractsSchema = z.object({
  ...pageInput,
  filters: z.record(z.string(), z.unknown()).optional().describe("透传给后端的过滤字段"),
});

const contractsTool = tool(
  async (query: z.infer<typeof contractsSchema>, config) => {
    const data = normalizePage(await clientOf(config).purchaseContracts(query));
    return { ...pageMeta(data, query), records: data.records };
  },
  {
    name: "query_purchase_contracts",
    description:
      "查询采购合同列表（真实接口 ham-purchasing/purchase-contract/page）。filters 字段透传，如 contractCode、projectCode、orgCode。",
    schema: contractsSchema,
  },
);

const assetsSchema = z.object({
  ...pageInput,
  filters: z
    .record(z.string(), z.unknown())
    .describe('合同过滤条件，如 {"purchaseContractNumber": "HT2026-...", "orgCode": "0NJ0"}'),
});

const assetsTool = tool(
  async (query: z.infer<typeof assetsSchema>, config) => {
    const data = normalizePage(await clientOf(config).assetsByContract(query));
    return { ...pageMeta(data, query), records: data.records };
  },
  {
    name: "query_assets_by_contract",
    description:
      '按合同查询收货资产（真实接口 ham-assets/receiving-info/selectByContract）。filters 必须同时传合同号与公司编码：{"purchaseContractNumber": "HT2026-...", "orgCode": "0NJ0"}（可先查采购合同拿到这两个字段）。',
    schema: assetsSchema,
  },
);

/** 全部业务查询工具（主进程版，token 按请求注入）。 */
export const hamTools = [
  parentProjectsTool,
  childProjectsTool,
  requisitionsTool,
  contractsTool,
  assetsTool,
];

export const hamToolNames = hamTools.map((item) => item.name);
