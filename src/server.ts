import path from "node:path";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { z } from "zod";

import { AgentRuntime } from "./agent-runtime.js";
import { projectRoot, settings } from "./config.js";
import { toPublicAgentError } from "./errors.js";
import { ModelRegistry, modelNameSchema } from "./model-registry.js";
import { OntologyStore } from "./mcp/ontology.js";

const chatSchema = z.object({
  message: z.string().trim().min(1).max(8000),
  thread_id: z.string().min(1).max(128).optional(),
});
const switchModelSchema = z.object({ model: modelNameSchema });

const app = Fastify({ logger: true });
const modelRegistry = new ModelRegistry(path.join(projectRoot, "models.json"), settings.modelName);
const ontologyStore = new OntologyStore(
  path.join(projectRoot, "ontology.json"),
  path.join(projectRoot, "ontology.seed.json"),
);
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
  ham_api_base: settings.hamApiBase,
  ham_token_configured: settings.hamToken.trim().length > 0,
}));

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

app.get("/api/config", async () => {
  const registry = modelRegistry.snapshot();
  return {
    model: runtime.modelName,
    models: registry.models,
    model_base_url: settings.modelBaseUrl,
    mcp_transport: "stdio",
  };
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

app.post("/api/chat", async (request, reply) => {
  const parsed = chatSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ detail: parsed.error.issues[0]?.message ?? "请求参数错误" });
  }

  const threadId = parsed.data.thread_id ?? randomUUID();
  try {
    const result = await runtime.chat(parsed.data.message, threadId);
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
