import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import { z } from "zod";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(currentDir, "..");

dotenv.config({ path: path.join(projectRoot, ".env") });

const envSchema = z.object({
  MODEL_API_KEY: z.string().min(1, "MODEL_API_KEY 不能为空"),
  MODEL_BASE_URL: z.url("MODEL_BASE_URL 必须是合法的 URL"),
  MODEL_NAME: z.string().default("glm-4-5v"),
  MODEL_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
  MODEL_MAX_TOKENS: z.coerce.number().int().positive().default(1024),
  MODEL_THINKING: z.enum(["enabled", "disabled"]).default("disabled"),
  APP_HOST: z.string().default("127.0.0.1"),
  APP_PORT: z.coerce.number().int().positive().default(8000),
  HAM_API_BASE: z.url("HAM_API_BASE 必须是合法的 URL").default("https://ham-test.haier.net"),
  HAM_TOKEN: z.string().default(""),
  HAM_TENANT_ID: z.string().default(""),
  MCP_DEBUG_URL: z.url("MCP_DEBUG_URL 必须是合法的 URL").default("http://101.200.220.45:8050"),
});

const parsed = envSchema.parse(process.env);

export const settings = {
  modelApiKey: parsed.MODEL_API_KEY,
  modelBaseUrl: parsed.MODEL_BASE_URL,
  modelName: parsed.MODEL_NAME,
  modelTemperature: parsed.MODEL_TEMPERATURE,
  modelMaxTokens: parsed.MODEL_MAX_TOKENS,
  modelThinking: parsed.MODEL_THINKING,
  appHost: parsed.APP_HOST,
  appPort: parsed.APP_PORT,
  hamApiBase: parsed.HAM_API_BASE,
  hamToken: parsed.HAM_TOKEN,
  hamTenantId: parsed.HAM_TENANT_ID,
  mcpDebugUrl: parsed.MCP_DEBUG_URL,
} as const;
