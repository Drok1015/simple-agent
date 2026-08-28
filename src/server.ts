import path from "node:path";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { z } from "zod";

import { AgentRuntime } from "./agent-runtime.js";
import { projectRoot, settings } from "./config.js";
import { toPublicAgentError } from "./errors.js";
import { ModelRegistry, modelNameSchema } from "./model-registry.js";
import { McpDebugClient } from "./mcp/debug-client.js";
import { OntologyStore } from "./mcp/ontology.js";

const chatSchema = z.object({
  message: z.string().trim().min(1).max(8000),
  thread_id: z.string().min(1).max(128).optional(),
});
const switchModelSchema = z.object({ model: modelNameSchema });

/** HAM token：JWT 三段式（header.payload.signature）。 */
const hamTokenSchema = z.object({
  token: z
    .string()
    .trim()
    .regex(/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, "token 不是合法的 JWT 格式"),
});

/** 解析 JWT payload 里的 exp/nbf（仅展示用，不验签）。 */
function jwtTimes(token: string): { expires_at: string | null; not_before: string | null } {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"),
    ) as { exp?: unknown; nbf?: unknown };
    return {
      expires_at: typeof payload.exp === "number" ? new Date(payload.exp * 1000).toISOString() : null,
      not_before: typeof payload.nbf === "number" ? new Date(payload.nbf * 1000).toISOString() : null,
    };
  } catch {
    return { expires_at: null, not_before: null };
  }
}

function hamTokenStatus() {
  const configured = settings.hamToken.trim().length > 0;
  const times = configured ? jwtTimes(settings.hamToken) : { expires_at: null, not_before: null };
  return { configured, ...times };
}
const callMcpToolSchema = z.object({
  tool: z.string().trim().min(1).max(128),
  arguments: z.record(z.string(), z.unknown()).default({}),
});

const app = Fastify({ logger: true });
const modelRegistry = new ModelRegistry(path.join(projectRoot, "models.json"), settings.modelName);
const ontologyStore = new OntologyStore(
  path.join(projectRoot, "ontology.json"),
  path.join(projectRoot, "ontology.seed.json"),
);
const mcpDebugClient = new McpDebugClient(settings.mcpDebugUrl, settings.hamToken);
const initialModels = await modelRegistry.load();
const runtime = new AgentRuntime(initialModels.activeModel);
await runtime.start();
const markdownItBrowser = await readFile(
  path.join(projectRoot, "node_modules/markdown-it/dist/browser/markdown-it.umd.min.js"),
  "utf8",
);

await app.register(fastifyStatic, {
  root: path.join(projectRoot, "app/static"),
  wildcard: false,
});

app.get("/vendor/markdown-it.min.js", async (_request, reply) => {
  return reply
    .type("application/javascript; charset=utf-8")
    .header("Cache-Control", "public, max-age=3600")
    .send(markdownItBrowser);
});

app.get("/api/health", async () => ({
  status: "ok",
  model: runtime.modelName,
  mcp_tools: runtime.toolNames,
  remote_mcp_url: mcpDebugClient.targetUrl,
  ham_api_base: settings.hamApiBase,
  ham_token_configured: settings.hamToken.trim().length > 0,
}));

app.get("/api/mcp-debug", async (request, reply) => {
  try {
    return await mcpDebugClient.inspect();
  } catch (error) {
    request.log.error(error);
    return reply.code(502).send({ detail: `连接远程 MCP 失败：${toPublicAgentError(error)}` });
  }
});

app.post("/api/mcp-debug/call", async (request, reply) => {
  const parsed = callMcpToolSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ detail: parsed.error.issues[0]?.message ?? "工具调用参数错误" });
  }

  try {
    const startedAt = performance.now();
    const result = await mcpDebugClient.callTool(parsed.data.tool, parsed.data.arguments);
    return {
      tool: parsed.data.tool,
      arguments: parsed.data.arguments,
      duration_ms: Math.round(performance.now() - startedAt),
      result,
    };
  } catch (error) {
    request.log.error(error);
    return reply.code(502).send({ detail: `MCP 工具调用失败：${toPublicAgentError(error)}` });
  }
});

// 本体可视化数据：每次请求都读盘，能看到 MCP 子进程在会话中写入的最新本体。
app.get("/api/ontology", async (request, reply) => {
  try {
    const [graph, seedIds] = await Promise.all([
      ontologyStore.getGraph(),
      ontologyStore.seedConceptIds(),
    ]);
    return { ...graph, seed_concept_ids: seedIds };
  } catch (error) {
    request.log.error(error);
    return reply.code(500).send({ detail: `读取本体失败：${toPublicAgentError(error)}` });
  }
});

app.post("/api/ontology/reset", async (request, reply) => {
  try {
    return await ontologyStore.reset();
  } catch (error) {
    request.log.error(error);
    return reply.code(500).send({ detail: `重置本体失败：${toPublicAgentError(error)}` });
  }
});

app.get("/ontology", async (_request, reply) => reply.redirect("/ontology.html"));
app.get("/mcp-debug", async (_request, reply) => reply.redirect("/mcp-debug.html"));

app.get("/api/config", async () => {
  const registry = modelRegistry.snapshot();
  return {
    model: runtime.modelName,
    models: registry.models,
    model_base_url: settings.modelBaseUrl,
    mcp_transport: "stdio",
    ham_token: hamTokenStatus(),
  };
});

/** 更新 HAM token：写回 .env 并立即生效运行时（免重启）。 */
app.post("/api/config/ham-token", async (request, reply) => {
  const parsed = hamTokenSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ detail: parsed.error.issues[0]?.message ?? "token 无效" });
  }
  try {
    const envPath = path.join(projectRoot, ".env");
    let content = await readFile(envPath, "utf8");
    if (/^HAM_TOKEN=/m.test(content)) {
      content = content.replace(/^HAM_TOKEN=.*$/m, `HAM_TOKEN=${parsed.data.token}`);
    } else {
      content += `\nHAM_TOKEN=${parsed.data.token}\n`;
    }
    await writeFile(envPath, content, "utf8");
    settings.hamToken = parsed.data.token;
    request.log.info("HAM token 已更新（.env 写回 + 运行时生效）");
    return hamTokenStatus();
  } catch (error) {
    request.log.error(error);
    return reply.code(500).send({ detail: `token 更新失败：${toPublicAgentError(error)}` });
  }
});

app.post("/api/config/model", async (request, reply) => {
  const parsed = switchModelSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ detail: parsed.error.issues[0]?.message ?? "模型名称无效" });
  }

  try {
    await runtime.switchModel(parsed.data.model);
    const registry = await modelRegistry.activate(parsed.data.model);
    return { model: runtime.modelName, models: registry.models };
  } catch (error) {
    request.log.error(error);
    return reply.code(500).send({ detail: `模型切换失败：${toPublicAgentError(error)}` });
  }
});

/** 从请求头读取用户 token，未携带时回退 .env 配置（直接打开页面场景）。 */
function requestHamToken(headerValue: unknown): string | undefined {
  const token = typeof headerValue === "string" ? headerValue.trim() : "";
  return token ? token : undefined;
}

app.post("/api/chat", async (request, reply) => {
  const parsed = chatSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ detail: parsed.error.issues[0]?.message ?? "请求参数错误" });
  }

  const threadId = parsed.data.thread_id ?? randomUUID();
  const hamToken = requestHamToken(request.headers["x-ham-token"]);
  try {
    const result = await runtime.chat(parsed.data.message, threadId, hamToken);
    return {
      thread_id: threadId,
      answer: result.answer,
      tools_used: result.toolsUsed,
      model: runtime.modelName,
    };
  } catch (error) {
    request.log.error(error);
    return reply.code(502).send({ detail: `Agent 调用失败：${toPublicAgentError(error)}` });
  }
});

app.post("/api/chat/stream", async (request, reply) => {
  const parsed = chatSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ detail: parsed.error.issues[0]?.message ?? "请求参数错误" });
  }

  const threadId = parsed.data.thread_id ?? randomUUID();
  const hamToken = requestHamToken(request.headers["x-ham-token"]);
  const abortController = new AbortController();

  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  reply.raw.flushHeaders();
  reply.raw.on("close", () => abortController.abort());

  const sendEvent = (event: string, data: unknown) => {
    if (reply.raw.destroyed) return;
    reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  sendEvent("meta", { thread_id: threadId, model: runtime.modelName });

  try {
    for await (const event of runtime.streamChat(
      parsed.data.message,
      threadId,
      abortController.signal,
      hamToken,
    )) {
      sendEvent(event.type, event);
    }
  } catch (error) {
    request.log.error(error);
    sendEvent("error", { message: `Agent 调用失败：${toPublicAgentError(error)}` });
  } finally {
    if (!reply.raw.destroyed) reply.raw.end();
  }

  return reply;
});

await app.listen({ host: settings.appHost, port: settings.appPort });
