import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { OntologyStore } from "../src/mcp/ontology.js";

let workspace: string;
let store: OntologyStore;

const seed = {
  version: 1,
  concepts: [
    { id: "equipment", label: "设备", parent_id: null, description: "根概念" },
    { id: "power", label: "动力设备", parent_id: "equipment", description: "动力源设备" },
    {
      id: "air-compressor",
      label: "空压机",
      aliases: ["空气压缩机"],
      parent_id: "power",
      description: "气源设备",
    },
    { id: "post", label: "后处理设备", parent_id: "equipment", description: "二次处理" },
  ],
  instances: [
    { id: "a1", label: "螺杆空压机 A", concept_id: "air-compressor", order_id: "SO-1001" },
    { id: "a2", label: "储气罐 C", concept_id: "post", order_id: "SO-1001" },
  ],
};

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "ontology-test-"));
  const seedPath = path.join(workspace, "ontology.seed.json");
  await writeFile(seedPath, JSON.stringify(seed), "utf8");
  store = new OntologyStore(path.join(workspace, "ontology.json"), seedPath);
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("OntologyStore", () => {
  it("首次访问时从种子初始化运行时本体", async () => {
    const graph = await store.getGraph();
    expect(graph.concepts.map((concept) => concept.label)).toContain("空压机");
    const persisted = JSON.parse(
      await readFile(path.join(workspace, "ontology.json"), "utf8"),
    );
    expect(persisted.concepts).toHaveLength(seed.concepts.length);
  });

  it("search 支持按别名精确解析并返回完整分类链", async () => {
    const result = await store.search("空气压缩机");
    expect(result.found).toBe(true);
    if (!result.found) return;
    expect(result.concept.label).toBe("空压机");
    expect(result.concept.path.map((node) => node.label)).toEqual(["设备", "动力设备", "空压机"]);
    expect(result.concept.instances).toHaveLength(1);
  });

  it("语义扩展把父概念闭包内的实例全部聚合", async () => {
    const result = await store.queryByConcept("动力设备");
    expect(result.found).toBe(true);
    expect(result.expansion).toEqual(["动力设备", "空压机"]);
    expect(result.assets.map((asset) => asset.label)).toEqual(["螺杆空压机 A"]);
    expect(result.order_ids).toEqual(["SO-1001"]);
  });

  it("会话中建设：新增概念持久化并立即可查", async () => {
    const added = await store.addConcept({
      label: "冷干机",
      parent: "后处理设备",
      description: "干燥压缩空气",
      order_id: "SO-1001",
    });
    expect(added.created).toBe(true);
    if (!added.created) return;
    expect(added.concept.path.map((node) => node.label)).toEqual(["设备", "后处理设备", "冷干机"]);

    const query = await store.queryByConcept("后处理设备");
    expect(query.assets.map((asset) => asset.label)).toContain("冷干机");
  });

  it("本体治理：拒绝重复概念与不存在的父概念", async () => {
    const duplicate = await store.addConcept({ label: "空压机", parent: "设备" });
    expect(duplicate.created).toBe(false);

    const orphan = await store.addConcept({ label: "制氮机", parent: "不存在的概念" });
    expect(orphan.created).toBe(false);
    if (orphan.created) return;
    expect(orphan.reason).toContain("父概念不存在");
  });

  it("reset 恢复种子本体并清掉会话中建设的概念", async () => {
    const graph = await store.reset();
    expect(graph.concepts.some((concept) => concept.label === "冷干机")).toBe(false);
    const query = await store.queryByConcept("后处理设备");
    // 种子状态：只剩储气罐 C，会话中新增的冷干机实例被清除。
    expect(query.assets.map((asset) => asset.label)).toEqual(["储气罐 C"]);
  });
});
