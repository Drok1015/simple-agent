import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ModelRegistry, modelNameSchema } from "../src/model-registry.js";

describe("ModelRegistry", () => {
  it("首次创建后记录并持久化使用过的模型", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "model-registry-"));
    const filePath = path.join(directory, "models.json");
    const registry = new ModelRegistry(filePath, "glm-4-5v");

    await registry.load();
    await registry.activate("DeepSeek-V4-Flash");
    await registry.activate("glm-4-5v");

    expect(registry.snapshot()).toEqual({
      activeModel: "glm-4-5v",
      models: ["glm-4-5v", "DeepSeek-V4-Flash"],
    });
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({
      active_model: "glm-4-5v",
      models: ["glm-4-5v", "DeepSeek-V4-Flash"],
    });
  });

  it("拒绝不安全的模型名称", () => {
    expect(modelNameSchema.safeParse("../bad model").success).toBe(false);
  });
});
