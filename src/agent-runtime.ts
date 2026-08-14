import path from "node:path";

import { isAIMessage, isToolMessage, type BaseMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { ChatOpenAI } from "@langchain/openai";
import { createDeepAgent, FilesystemBackend } from "deepagents";

import { projectRoot, settings } from "./config.js";
import {
  projectProtocolEvent,
  type AgentStreamEvent,
} from "./stream-events.js";

const systemPrompt = `
你是一个谨慎、简洁的企业业务助手。

工作原则：
1. 涉及订单、资产表单或草稿时，优先使用匹配的 Skill 和 MCP Tool，不要编造业务数据。
2. Tool 没返回的字段明确说不知道。
3. 所有正式写入、提交、删除和审批都必须由确定性业务系统校验并由用户确认。
4. 当前只能准备可见草稿，不能声称已经提交业务数据。
5. 回答使用中文，先给结论，再给必要细节。
6. 需要调用工具时直接调用，不要在工具调用前输出计划、解释或过渡语。
7. 工具执行完成后必须给出简洁的自然语言结论，不能只返回工具调用。
8. 涉及资产类别、术语含义（"X 是什么/属于哪类"）时优先用 search_ontology 查本体，不要凭记忆编分类；"按类别查订单"时用 query_orders_by_concept 做语义扩展，而不是 query_orders 的关键字匹配。
9. 用户要求新增分类概念时使用 add_ontology_concept；工具返回拒绝原因时如实转述，不要自行编造概念。
`.trim();

type DeepAgent = Awaited<ReturnType<typeof createDeepAgent>>;

export class AgentRuntime {
  private agent: DeepAgent | undefined;
  private client: MultiServerMCPClient | undefined;
  private readonly checkpointer = new MemorySaver();
  private activeModelName: string;
  toolNames: string[] = [];

  constructor(modelName = settings.modelName) {
    this.activeModelName = modelName;
  }

  get modelName() {
    return this.activeModelName;
  }

  async start() {
    this.client = new MultiServerMCPClient({
      business: {
        transport: "stdio",
        command: "tsx",
        args: [path.join(projectRoot, "src/mcp/server.ts")],
      },
    });

    const tools = await this.client.getTools();
    this.toolNames = tools.map((tool) => tool.name).sort();
    this.agent = await this.createAgent(this.activeModelName, tools);
  }

  async switchModel(modelName: string) {
    if (modelName === this.activeModelName) return;
    if (!this.client) throw new Error("Agent runtime 尚未初始化");
    const tools = await this.client.getTools();
    this.agent = await this.createAgent(modelName, tools);
    this.activeModelName = modelName;
  }

  private async createAgent(
    modelName: string,
    tools: Awaited<ReturnType<MultiServerMCPClient["getTools"]>>,
  ) {
    const model = new ChatOpenAI({
      apiKey: settings.modelApiKey,
      model: modelName,
      temperature: settings.modelTemperature,
      maxTokens: settings.modelMaxTokens,
      modelKwargs: { thinking: { type: settings.modelThinking } },
      timeout: 120_000,
      maxRetries: 2,
      configuration: { baseURL: settings.modelBaseUrl },
    });

    return createDeepAgent({
      model,
      tools,
      systemPrompt,
      backend: new FilesystemBackend({ rootDir: projectRoot, virtualMode: true }),
      skills: ["/skills/"],
      permissions: [
        { operations: ["read"], paths: ["/skills/**"], mode: "allow" },
        { operations: ["read"], paths: ["/**"], mode: "deny" },
        { operations: ["write"], paths: ["/**"], mode: "deny" },
      ],
      checkpointer: this.checkpointer,
    });
  }

  async chat(message: string, threadId: string) {
    if (!this.agent) throw new Error("Agent runtime 尚未初始化");

    const result = await this.agent.invoke(
      { messages: [{ role: "user", content: message }] },
      { configurable: { thread_id: threadId } },
    );
    const messages = result.messages as BaseMessage[];
    const answer = this.lastAnswer(messages);
    const toolsUsed = [
      ...new Set(
        messages
          .filter(isToolMessage)
          .map((item) => item.name ?? "unknown_tool"),
      ),
    ];

    return { answer, toolsUsed };
  }

  async *streamChat(
    message: string,
    threadId: string,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentStreamEvent> {
    if (!this.agent) throw new Error("Agent runtime 尚未初始化");

    const run = await this.agent.streamEvents(
      { messages: [{ role: "user", content: message }] },
      {
        version: "v3",
        configurable: { thread_id: threadId },
        ...(signal ? { signal } : {}),
      },
    );
    const toolsUsed = new Set<string>();
    const toolNamesById = new Map<string, string>();
    let answer = "";

    for await (const protocolEvent of run) {
      const event = projectProtocolEvent(protocolEvent);
      if (!event) continue;

      if (event.type === "token") answer += event.delta;
      if (event.type === "tool") {
        if (event.name) toolNamesById.set(event.id, event.name);
        const name = event.name ?? toolNamesById.get(event.id) ?? "unknown_tool";
        toolsUsed.add(name);
        yield { ...event, name };
        continue;
      }
      yield event;
    }

    yield { type: "done", answer, toolsUsed: [...toolsUsed] };
  }

  private lastAnswer(messages: BaseMessage[]) {
    for (const message of [...messages].reverse()) {
      if (!isAIMessage(message)) continue;
      if (typeof message.content === "string" && message.content.trim()) {
        return message.content.trim();
      }
      if (Array.isArray(message.content)) {
        const answer = message.content
          .filter(
            (part): part is { type: "text"; text: string } =>
              typeof part === "object" &&
              part !== null &&
              "type" in part &&
              part.type === "text" &&
              "text" in part &&
              typeof part.text === "string",
          )
          .map((part) => part.text)
          .join("\n")
          .trim();
        if (answer) return answer;
      }
    }
    throw new Error("模型没有返回最终回答");
  }
}
