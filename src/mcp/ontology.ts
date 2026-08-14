import { readFile, rename, rm, writeFile } from "node:fs/promises";

import { z } from "zod";

/**
 * 本体（Ontology）学习模块的核心存储。
 *
 * - TBox（概念层）：concepts 里的分类树，描述"世界由哪些概念构成、概念之间如何关联"。
 * - ABox（实例层）：instances 里的具体资产，把概念锚定到业务订单上。
 *
 * 每次操作都是 读文件 → 计算 → 原子写回，不做长驻内存状态，
 * 这样 MCP 子进程的写入和 Web API 的读取天然共享同一份最新数据。
 */

const conceptSchema = z.object({
  id: z.string().min(1),
  label: z.string().trim().min(1).max(50),
  aliases: z.array(z.string().trim().min(1).max(50)).optional(),
  parent_id: z.string().min(1).nullable(),
  description: z.string().trim().max(500),
});

const instanceSchema = z.object({
  id: z.string().min(1),
  label: z.string().trim().min(1).max(100),
  concept_id: z.string().min(1),
  order_id: z.string().trim().min(1).max(64),
});

const ontologySchema = z.object({
  version: z.number().int().positive(),
  concepts: z.array(conceptSchema).min(1),
  instances: z.array(instanceSchema),
});

export type OntologyConcept = z.infer<typeof conceptSchema>;
export type OntologyInstance = z.infer<typeof instanceSchema>;
export type OntologyData = z.infer<typeof ontologySchema>;

export interface ConceptPathNode {
  id: string;
  label: string;
}

export interface ConceptSummary {
  id: string;
  label: string;
  aliases: string[];
  description: string;
  path: ConceptPathNode[];
  children: { id: string; label: string }[];
  instances: { id: string; label: string; order_id: string }[];
}

function newId() {
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export class OntologyStore {
  constructor(
    private readonly runtimePath: string,
    private readonly seedPath: string,
  ) {}

  private async ensureInitialized(): Promise<OntologyData> {
    try {
      const raw = await readFile(this.runtimePath, "utf8");
      return ontologySchema.parse(JSON.parse(raw));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        if (error instanceof z.ZodError) {
          throw new Error(`本体运行时文件格式不合法：${error.message}`);
        }
        throw error;
      }
      // 首次访问：从种子文件复制一份作为可修改的运行时本体。
      const seedRaw = await readFile(this.seedPath, "utf8");
      const seed = ontologySchema.parse(JSON.parse(seedRaw));
      await this.write(seed);
      return seed;
    }
  }

  private async write(data: OntologyData) {
    const temporaryPath = `${this.runtimePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.runtimePath);
  }

  async getGraph(): Promise<OntologyData> {
    return this.ensureInitialized();
  }

  /** 种子文件里的概念 id 集合，用于区分"随仓库分发"与"会话中建设"的概念。 */
  async seedConceptIds(): Promise<string[]> {
    const seedRaw = await readFile(this.seedPath, "utf8");
    const seed = ontologySchema.parse(JSON.parse(seedRaw));
    return seed.concepts.map((concept) => concept.id);
  }

  async reset(): Promise<OntologyData> {
    await rm(this.runtimePath, { force: true });
    return this.ensureInitialized();
  }

  private conceptById(data: OntologyData) {
    return new Map(data.concepts.map((concept) => [concept.id, concept]));
  }

  /** 从根到该概念的完整分类链，例如 设备 › 动力设备 › 空压机。 */
  ancestors(data: OntologyData, conceptId: string): ConceptPathNode[] {
    const byId = this.conceptById(data);
    const chain: ConceptPathNode[] = [];
    let cursor = byId.get(conceptId);
    const visited = new Set<string>([conceptId]);
    while (cursor) {
      chain.unshift({ id: cursor.id, label: cursor.label });
      if (cursor.parent_id === null) break;
      if (visited.has(cursor.parent_id)) break; // 防御性环保护
      visited.add(cursor.parent_id);
      cursor = byId.get(cursor.parent_id);
    }
    return chain;
  }

  /** 语义扩展的核心：把父概念展开成"自身 + 全部后代概念"的闭包。 */
  descendantsClosure(data: OntologyData, conceptId: string): Set<string> {
    const childrenOf = new Map<string, string[]>();
    for (const concept of data.concepts) {
      if (concept.parent_id === null) continue;
      const bucket = childrenOf.get(concept.parent_id) ?? [];
      bucket.push(concept.id);
      childrenOf.set(concept.parent_id, bucket);
    }

    const closure = new Set<string>([conceptId]);
    const queue = [conceptId];
    while (queue.length > 0) {
      const current = queue.shift();
      for (const childId of childrenOf.get(current ?? "") ?? []) {
        if (closure.has(childId)) continue;
        closure.add(childId);
        queue.push(childId);
      }
    }
    return closure;
  }

  /** 按标签或别名解析概念：先精确匹配，再子串包含，模拟简单的术语归一化。 */
  findConcept(data: OntologyData, term: string): OntologyConcept | undefined {
    const normalized = term.trim().toLowerCase();
    if (!normalized) return undefined;
    const exact = data.concepts.find(
      (concept) =>
        concept.label.toLowerCase() === normalized ||
        (concept.aliases ?? []).some((alias) => alias.toLowerCase() === normalized),
    );
    if (exact) return exact;
    return data.concepts.find(
      (concept) =>
        concept.label.toLowerCase().includes(normalized) ||
        (concept.aliases ?? []).some((alias) => alias.toLowerCase().includes(normalized)),
    );
  }

  summarize(data: OntologyData, concept: OntologyConcept): ConceptSummary {
    const instances = data.instances
      .filter((instance) => instance.concept_id === concept.id)
      .map(({ id, label, order_id }) => ({ id, label, order_id }));
    return {
      id: concept.id,
      label: concept.label,
      aliases: concept.aliases ?? [],
      description: concept.description,
      path: this.ancestors(data, concept.id),
      children: data.concepts
        .filter((item) => item.parent_id === concept.id)
        .map(({ id, label }) => ({ id, label })),
      instances,
    };
  }

  async search(term: string): Promise<
    | { found: true; concept: ConceptSummary; suggestions: string[] }
    | { found: false; term: string; suggestions: string[] }
  > {
    const data = await this.ensureInitialized();
    const allLabels = data.concepts.map((concept) => concept.label);
    const concept = this.findConcept(data, term);
    if (!concept) {
      const normalized = term.trim().toLowerCase();
      const suggestions = data.concepts
        .filter(
          (item) =>
            item.label.toLowerCase().includes(normalized) ||
            (item.aliases ?? []).some((alias) => alias.toLowerCase().includes(normalized)),
        )
        .map((item) => item.label);
      return { found: false, term, suggestions: suggestions.length ? suggestions : allLabels };
    }
    return { found: true, concept: this.summarize(data, concept), suggestions: [] };
  }

  async addConcept(input: {
    label: string;
    parent: string;
    description?: string | undefined;
    aliases?: string[] | undefined;
    order_id?: string | undefined;
  }): Promise<
    | { created: true; concept: ConceptSummary; persisted_to: string }
    | { created: false; reason: string }
  > {
    const data = await this.ensureInitialized();
    const label = input.label.trim();
    if (!label) return { created: false, reason: "概念名称不能为空" };

    const parent = this.findConcept(data, input.parent);
    if (!parent) {
      return {
        created: false,
        reason: `父概念不存在：${input.parent.trim()}。请先用 search_ontology 或 get_ontology 确认可用概念`,
      };
    }

    // 本体治理：同一标签或别名不允许重复注册，避免概念歧义。
    const normalizedLabel = label.toLowerCase();
    const duplicate = data.concepts.find((concept) => {
      const labels = [concept.label, ...(concept.aliases ?? [])].map((item) => item.toLowerCase());
      if (labels.includes(normalizedLabel)) return true;
      return (input.aliases ?? []).some((alias) =>
        labels.includes(alias.trim().toLowerCase()),
      );
    });
    if (duplicate) {
      return {
        created: false,
        reason: `概念已存在：${duplicate.label}（${this.ancestors(data, duplicate.id).map((node) => node.label).join(" › ")}）`,
      };
    }

    const aliases = [...new Set((input.aliases ?? []).map((alias) => alias.trim()).filter(Boolean))];
    const concept: OntologyConcept = {
      id: newId(),
      label,
      ...(aliases.length ? { aliases } : {}),
      parent_id: parent.id,
      description: input.description?.trim() || `${parent.label} 下的概念，由会话中建设产生。`,
    };
    const next: OntologyData = {
      ...data,
      concepts: [...data.concepts, concept],
      // 可选：把新概念直接挂到某个订单，形成"概念建设 → 业务数据可达"的闭环。
      instances: input.order_id?.trim()
        ? [
            ...data.instances,
            {
              id: `asset-${Date.now().toString(36)}`,
              label,
              concept_id: concept.id,
              order_id: input.order_id.trim(),
            },
          ]
        : data.instances,
    };
    await this.write(next);
    return {
      created: true,
      concept: this.summarize(next, concept),
      persisted_to: this.runtimePath.split("/").pop() ?? "ontology.json",
    };
  }

  /** 语义查询：把概念闭包内的全部实例按订单聚合，供与 query_orders 对照。 */
  async queryByConcept(term: string): Promise<{
    found: boolean;
    concept?: ConceptSummary;
    matched_concepts: string[];
    assets: { label: string; concept: string; order_id: string }[];
    order_ids: string[];
    expansion: string[];
  }> {
    const data = await this.ensureInitialized();
    const concept = this.findConcept(data, term);
    if (!concept) {
      return {
        found: false,
        matched_concepts: [],
        assets: [],
        order_ids: [],
        expansion: data.concepts.map((item) => item.label),
      };
    }

    const closure = this.descendantsClosure(data, concept.id);
    const labelOf = this.conceptById(data);
    const assets = data.instances
      .filter((instance) => closure.has(instance.concept_id))
      .map((instance) => ({
        label: instance.label,
        concept: labelOf.get(instance.concept_id)?.label ?? instance.concept_id,
        order_id: instance.order_id,
      }));
    const matchedConcepts = data.concepts
      .filter((item) => closure.has(item.id))
      .filter((item) => data.instances.some((instance) => instance.concept_id === item.id))
      .map((item) => item.label);

    return {
      found: true,
      concept: this.summarize(data, concept),
      matched_concepts: matchedConcepts,
      assets,
      order_ids: [...new Set(assets.map((asset) => asset.order_id))].sort(),
      expansion: data.concepts
        .filter((item) => closure.has(item.id))
        .map((item) => item.label),
    };
  }
}
