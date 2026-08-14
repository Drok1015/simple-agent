import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OntologyStore } from "../src/mcp/ontology.js";

let workspace: string;
let store: OntologyStore;

const seed = {
  version: 3,
  concepts: [
    { id: "ham", label: "资产业务对象", parent_id: null, description: "根概念" },
    {
      id: "project",
      label: "资产项目",
      aliases: ["项目"],
      parent_id: "ham",
      description: "项目概念",
      tool: "query_parent_projects",
    },
    {
      id: "approved",
      label: "项目生效",
      aliases: ["生效"],
      parent_id: "project",
      description: "状态=9",
      tool: "query_parent_projects",
      params: { status: "生效" },
    },
    {
      id: "requisition",
      label: "采购申请",
      aliases: ["PR"],
      parent_id: "ham",
      description: "采购申请概念",
      tool: "query_purchase_requisitions",
      relations: [
        { target: "project", type: "归属", label: "采购申请归属项目", via: "projectCode" },
      ],
    },
  ],
  instances: [],
};

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "ontology-test-"));
  const seedPath = path.join(workspace, "ontology.seed.json");
  await writeFile(seedPath, JSON.stringify(seed), "utf8");
  store = new OntologyStore(
    path.join(workspace, "ontology.json"),
    seedPath,
    new Set(["query_parent_projects", "query_purchase_requisitions"]),
  );
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("OntologyStore", () => {
  it("首次访问时从种子初始化运行时本体", async () => {
    const graph = await store.getGraph();
    expect(graph.concepts.map((concept) => concept.label)).toContain("采购申请");
  });

  it("search 支持别名解析并返回完整分类链与工具映射", async () => {
    const result = await store.search("PR");
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.concept.label).toBe("采购申请");
    expect(result.concept.path.map((node) => node.label)).toEqual([
      "资产业务对象",
      "采购申请",
    ]);
    expect(result.concept.suggested_call).toEqual({
      tool: "query_purchase_requisitions",
      params: {},
    });
  });

  it("状态概念带自己的提示参数（suggested_call.params）", async () => {
    const result = await store.search("生效");
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.concept.label).toBe("项目生效");
    expect(result.concept.suggested_call?.params).toEqual({ status: "生效" });
  });

  it("无工具映射的概念 suggested_call 为 null", async () => {
    const result = await store.search("资产业务对象");
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.concept.suggested_call).toBeNull();
  });

  it("关系汇总：出边与入边双向返回", async () => {
    const pr = await store.search("PR");
    expect(pr.found).toBe(true);
    if (!pr.found) return;
    expect(pr.concept.relations).toHaveLength(1);
    const [outEdge] = pr.concept.relations;
    expect(outEdge).toMatchObject({
      target_label: "资产项目",
      type: "归属",
      via: "projectCode",
      inverse: false,
    });

    // 反向：资产项目 应看到来自采购申请的入边。
    const project = await store.search("资产项目");
    expect(project.found).toBe(true);
    if (!project.found) return;
    const incoming = project.concept.relations.filter((relation) => relation.inverse);
    expect(incoming).toHaveLength(1);
    expect(incoming[0]).toMatchObject({
      target_label: "采购申请",
      type: "归属",
      inverse: true,
    });
  });

  it("会话中建设：新增概念持久化并带工具映射", async () => {
    const added = await store.addConcept({
      label: "设备类采购",
      parent: "采购申请",
      description: "设备类资产采购",
      aliases: ["设备采购"],
      tool: "query_purchase_requisitions",
      params: { filters: { requisitionName: "设备" } },
    });
    expect(added.created).toBe(true);
    if (!added.created) return;
    expect(added.concept.suggested_call?.tool).toBe("query_purchase_requisitions");
    expect(added.concept.suggested_call?.params).toEqual({ filters: { requisitionName: "设备" } });

    const query = await store.search("设备采购");
    expect(query.found).toBe(true);
    if (!query.found) return;
    expect(query.concept.label).toBe("设备类采购");
  });

  it("本体治理：拒绝重复概念、不存在父概念与未知工具名", async () => {
    const duplicate = await store.addConcept({ label: "采购申请", parent: "资产业务对象" });
    expect(duplicate.created).toBe(false);

    const orphan = await store.addConcept({ label: "虚构概念", parent: "不存在的父类" });
    expect(orphan.created).toBe(false);
    if (orphan.created) return;
    expect(orphan.reason).toContain("父概念不存在");

    const badTool = await store.addConcept({
      label: "危险概念",
      parent: "采购申请",
      tool: "drop_database",
    });
    expect(badTool.created).toBe(false);
    if (badTool.created) return;
    expect(badTool.reason).toContain("未知的工具名");
  });

  it("会话中建设支持关联关系，且校验目标存在", async () => {
    const added = await store.addConcept({
      label: "工程类采购",
      parent: "采购申请",
      tool: "query_purchase_requisitions",
      relations: [{ target: "资产项目", type: "归属", label: "工程类采购归属项目", via: "projectCode" }],
    });
    expect(added.created).toBe(true);
    if (!added.created) return;
    expect(added.concept.relations).toHaveLength(1);
    expect(added.concept.relations[0]).toMatchObject({ target_label: "资产项目", inverse: false });

    const badTarget = await store.addConcept({
      label: "悬空概念",
      parent: "采购申请",
      relations: [{ target: "不存在的概念", type: "关联", label: "悬空关系" }],
    });
    expect(badTarget.created).toBe(false);
    if (badTarget.created) return;
    expect(badTarget.reason).toContain("关系目标概念不存在");
  });

  it("reset 恢复种子本体并清掉会话中建设的概念", async () => {
    const graph = await store.reset();
    expect(graph.concepts.some((concept) => concept.label === "工程类采购")).toBe(false);
    expect(graph.concepts).toHaveLength(seed.concepts.length);
  });
});
