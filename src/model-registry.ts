import { readFile, rename, writeFile } from "node:fs/promises";

import { z } from "zod";

export const modelNameSchema = z
  .string()
  .trim()
  .min(1, "模型名称不能为空")
  .max(128, "模型名称不能超过 128 个字符")
  .regex(/^[A-Za-z0-9._:/-]+$/, "模型名称包含不支持的字符");

const registrySchema = z.object({
  active_model: modelNameSchema,
  models: z.array(modelNameSchema).min(1),
});

type RegistryState = z.infer<typeof registrySchema>;

export class ModelRegistry {
  private state: RegistryState;

  constructor(
    private readonly filePath: string,
    fallbackModel: string,
  ) {
    const model = modelNameSchema.parse(fallbackModel);
    this.state = { active_model: model, models: [model] };
  }

  async load() {
    try {
      const saved = registrySchema.parse(JSON.parse(await readFile(this.filePath, "utf8")));
      this.state = {
        active_model: saved.active_model,
        models: [...new Set([saved.active_model, ...saved.models])],
      };
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      await this.save(this.state);
    }
    return this.snapshot();
  }

  snapshot() {
    return {
      activeModel: this.state.active_model,
      models: [...this.state.models],
    };
  }

  async activate(modelName: string) {
    const model = modelNameSchema.parse(modelName);
    const next = {
      active_model: model,
      models: [...new Set([...this.state.models, model])],
    };
    await this.save(next);
    this.state = next;
    return this.snapshot();
  }

  private async save(state: RegistryState) {
    const temporaryPath = `${this.filePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.filePath);
  }
}
