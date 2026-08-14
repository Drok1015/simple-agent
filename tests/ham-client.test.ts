import { describe, expect, it } from "vitest";

import {
  HamClient,
  PROJECT_STATUS,
  REQUISITION_STATUS,
  normalizePage,
} from "../src/mcp/ham-client.js";

describe("HamClient 状态归一化", () => {
  it("项目状态词转后端码值", () => {
    expect(HamClient.normalizeProjectStatus("生效")).toBe(9);
    expect(HamClient.normalizeProjectStatus("审批中")).toBe(3);
    expect(HamClient.normalizeProjectStatus("已取消")).toBe(8);
    expect(HamClient.normalizeProjectStatus(4)).toBe(4);
    // 未知词原样透传，交由后端判定
    expect(HamClient.normalizeProjectStatus("神秘状态")).toBe("神秘状态");
  });

  it("采购状态词转字母码", () => {
    expect(HamClient.normalizeRequisitionStatus("草稿")).toBe("D");
    expect(HamClient.normalizeRequisitionStatus("已提交")).toBe("U");
    expect(HamClient.normalizeRequisitionStatus("审批中")).toBe("P");
    expect(HamClient.normalizeRequisitionStatus("招标中")).toBe("B");
    expect(HamClient.normalizeRequisitionStatus("招标失败")).toBe("F");
    expect(HamClient.normalizeRequisitionStatus("已审批")).toBe("A");
    expect(HamClient.normalizeRequisitionStatus("已生成合同")).toBe("S");
    expect(HamClient.normalizeRequisitionStatus("W")).toBe("W");
  });

  it("状态枚举与 ham_ui 源码一致", () => {
    expect(PROJECT_STATUS["项目可审批"]).toBe(2);
    expect(PROJECT_STATUS["项目退回"]).toBe(4);
    expect(REQUISITION_STATUS["草稿"]).toBe("D");
  });
});

describe("normalizePage 分页结构归一化", () => {
  it("标准 records 结构", () => {
    expect(normalizePage({ total: 21, records: [{ id: 1 }] })).toEqual({
      total: 21,
      records: [{ id: 1 }],
    });
  });

  it("纯数组结构", () => {
    expect(normalizePage([{ a: 1 }, { a: 2 }])).toEqual({ total: 2, records: [{ a: 1 }, { a: 2 }] });
  });

  it("list 结构与非典型输入", () => {
    expect(normalizePage({ total: 3, list: [1] })).toEqual({ total: 3, records: [1] });
    expect(normalizePage(null)).toEqual({ total: 0, records: [] });
    expect(normalizePage({ foo: "bar" })).toEqual({ total: 0, records: [] });
  });
});

describe("HamClient 凭证守护", () => {
  it("未配置 token 时给出可操作错误", async () => {
    const client = new HamClient("https://ham-test.haier.net", "", "");
    expect(client.configured).toBe(false);
    await expect(client.parentProjects({})).rejects.toThrow(/HAM_TOKEN/);
  });
});
