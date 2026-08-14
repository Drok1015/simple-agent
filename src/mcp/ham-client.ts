import { settings } from "../config.js";

/**
 * ham_ui（资产中台）网关客户端。
 *
 * 协议事实（来自 ham_ui 源码分析）：
 * - 网关：HAM_API_BASE（默认测试环境 https://ham-test.haier.net），路径前缀 /ham-api。
 * - 认证：Authorization: Bearer <token> 与 Access-Token 同值；多租户头 cz-tenantID。
 * - 响应包裹：{ code, msg, data }，code ∈ {0, 20000, 20001, 300} 视为成功。
 * - 分页请求：{ pageNo, pageSize, ...过滤字段 }；分页响应：data: { total, records }。
 * - 列表接口均为 POST JSON。
 */

const SUCCESS_CODES = new Set([0, 20000, 20001, 300]);

/** 父/子项目状态枚举（ham_ui project-approval/parent/config/enums.js）。 */
export const PROJECT_STATUS: Record<string, number> = {
  项目可审批: 2,
  项目审批中: 3,
  审批中: 3,
  项目退回: 4,
  退回: 4,
  项目取消: 8,
  已取消: 8,
  项目生效: 9,
  已生效: 9,
  生效: 9,
};

export const PROJECT_STATUS_LABELS: Record<string, string> = {
  "2": "项目可审批",
  "3": "项目审批中",
  "4": "项目退回",
  "8": "项目取消",
  "9": "项目生效",
};

/** 采购申请状态字母码（ham_ui requisitionStatus；D=草稿 为源码确认，其余为流程态）。 */
export const REQUISITION_STATUS: Record<string, string> = {
  草稿: "D",
  审批中: "P",
  已审批: "A",
  已退回: "R",
  已取消: "C",
};

export class HamApiError extends Error {
  constructor(
    message: string,
    readonly code: number | undefined,
  ) {
    super(message);
    this.name = "HamApiError";
  }
}

export interface PageQuery {
  page?: number | undefined;
  page_size?: number | undefined;
}

/** MCP 工具入参 → 客户端查询：zod 可选输出显式带 undefined。 */
export type ToolPageQuery = PageQuery & {
  filters?: Record<string, unknown> | undefined;
  status?: string | number | undefined;
};

export class HamClient {
  constructor(
    private readonly baseUrl = settings.hamApiBase,
    private readonly token = settings.hamToken,
    private readonly tenantId = settings.hamTenantId,
  ) {}

  get configured() {
    return this.token.trim().length > 0;
  }

  private assertConfigured() {
    if (this.configured) return;
    throw new HamApiError(
      "未配置资产中台凭证：请在 .env 中设置 HAM_TOKEN（登录 ham_ui 后从浏览器 cookie `token` 复制）",
      undefined,
    );
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    this.assertConfigured();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.token}`,
      "Access-Token": this.token,
      lang: "zh",
    };
    if (this.tenantId) headers["cz-tenantID"] = this.tenantId;

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/ham-api${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new HamApiError(
        `资产中台网络请求失败（${path}）：${error instanceof Error ? error.message : String(error)}`,
        undefined,
      );
    }

    const payload = (await response.json().catch(() => null)) as
      | { code?: number; msg?: string; message?: string; data?: unknown }
      | null;

    if (!response.ok || !payload || !SUCCESS_CODES.has(payload.code ?? -1)) {
      const detail =
        payload?.msg ?? payload?.message ?? `HTTP ${response.status}（${path}）`;
      // 401/403 大概率是 token 过期，给出可操作的提示。
      if (response.status === 401 || response.status === 403) {
        throw new HamApiError(`资产中台凭证无效或已过期（${detail}），请更新 .env 中的 HAM_TOKEN`, response.status);
      }
      throw new HamApiError(`资产中台接口返回错误：${detail}`, payload?.code ?? response.status);
    }
    return payload.data as T;
  }

  /** 统一分页体：过滤字段透传（与 ham_ui 列表页一致，字段名以后端为准）。 */
  private pageBody(query: PageQuery & { filters?: Record<string, unknown> | undefined }) {
    const { page = 1, page_size = 10, filters = {} } = query;
    const body: Record<string, unknown> = {
      pageNo: page,
      pageSize: page_size,
    };
    for (const [key, value] of Object.entries(filters)) {
      if (value === undefined || value === null || value === "") continue;
      body[key] = value;
    }
    return body;
  }

  /** 状态词 → 项目状态码；数字/已是码值则原样返回。 */
  static normalizeProjectStatus(status: string | number): number | string {
    if (typeof status === "number") return status;
    const trimmed = status.trim();
    if (trimmed in PROJECT_STATUS) return PROJECT_STATUS[trimmed]!;
    return trimmed;
  }

  /** 状态词 → 采购申请状态字母码。 */
  static normalizeRequisitionStatus(status: string): string {
    const trimmed = status.trim();
    if (trimmed in REQUISITION_STATUS) return REQUISITION_STATUS[trimmed]!;
    return trimmed;
  }

  /** 父项目分页（ham-project/parent-project/page）。 */
  async parentProjects(query: ToolPageQuery) {
    const { status, ...rest } = query;
    const filters = { ...rest.filters };
    if (status !== undefined && status !== null && status !== "") {
      filters.parentProjectStatus = HamClient.normalizeProjectStatus(status);
    }
    return this.post<{ total: number; records: unknown[] } | unknown[]>(
      "/ham-project/parent-project/page",
      this.pageBody({ ...rest, filters }),
    );
  }

  /** 子项目分页（ham-project/project-info/getProjectList）。 */
  async childProjects(query: ToolPageQuery) {
    return this.post<{ total: number; records: unknown[] } | unknown[]>(
      "/ham-project/project-info/getProjectList",
      this.pageBody(query),
    );
  }

  /** 按父项目查子项目（ham-project/parent-project/getProjectInfoListByParent）。 */
  async childProjectsByParent(parentProjectCode: string) {
    return this.post<unknown[] | { records?: unknown[] }>(
      "/ham-project/parent-project/getProjectInfoListByParent",
      { parentProjectCode },
    );
  }

  /** 采购申请单分页（ham-purchasing/purchase-requisition/page）。 */
  async purchaseRequisitions(query: ToolPageQuery) {
    const { status, ...rest } = query;
    const filters = { ...rest.filters };
    if (typeof status === "string" && status !== "") {
      filters.requisitionStatus = HamClient.normalizeRequisitionStatus(status);
    } else if (typeof status === "number") {
      filters.requisitionStatus = status;
    }
    return this.post<{ total: number; records: unknown[] } | unknown[]>(
      "/ham-purchasing/purchase-requisition/page",
      this.pageBody({ ...rest, filters }),
    );
  }

  /** 采购合同分页（ham-purchasing/purchase-contract/page）。 */
  async purchaseContracts(query: ToolPageQuery) {
    return this.post<{ total: number; records: unknown[] } | unknown[]>(
      "/ham-purchasing/purchase-contract/page",
      this.pageBody(query),
    );
  }

  /** 按合同查资产（ham-assets/receiving-info/selectByContract）。 */
  async assetsByContract(query: ToolPageQuery) {
    return this.post<{ total: number; records: unknown[] } | unknown[]>(
      "/ham-assets/receiving-info/selectByContract",
      this.pageBody(query),
    );
  }
}

/** 把后端分页结构归一化成 { total, records }。 */
export function normalizePage(data: unknown): { total: number; records: unknown[] } {
  if (Array.isArray(data)) return { total: data.length, records: data };
  if (data && typeof data === "object" && "records" in data) {
    const page = data as { total?: unknown; records?: unknown };
    const records = Array.isArray(page.records) ? page.records : [];
    return {
      total: typeof page.total === "number" ? page.total : records.length,
      records,
    };
  }
  if (data && typeof data === "object" && "list" in data) {
    const page = data as { total?: unknown; list?: unknown };
    const list = Array.isArray(page.list) ? page.list : [];
    return {
      total: typeof page.total === "number" ? page.total : list.length,
      records: list,
    };
  }
  return { total: 0, records: [] };
}
