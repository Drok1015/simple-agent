import path from "node:path";

import { isAIMessage, isToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { StructuredTool } from "@langchain/core/tools";
import { MemorySaver } from "@langchain/langgraph";
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { ChatOpenAI } from "@langchain/openai";
import { createDeepAgent, FilesystemBackend } from "deepagents";

import { projectRoot, settings } from "./config.js";
import { hamTools } from "./ham-tools.js";
import {
  projectProtocolEvent,
  type AgentStreamEvent,
} from "./stream-events.js";

const systemPrompt = `
你是一个谨慎、简洁的企业业务助手，接入资产中台（ham_ui）真实数据。

工作原则：
1. 查询父项目、子项目、采购申请、采购合同、资产等业务数据时，优先使用匹配的 Skill 和 MCP Tool，数据来自真实接口，不要编造。
2. Tool 没返回的字段明确说不知道；接口报错（凭证过期、网络失败）时如实转述，不要假装查询成功。
3. 所有正式写入、提交、删除和审批都必须由确定性业务系统校验并由用户确认；当前只有只读查询能力。
4. 回答使用中文，先给结论，再给必要细节。
5. 需要调用工具时直接调用，不要在工具调用前输出计划、解释或过渡语。
6. 工具执行完成后必须给出简洁的自然语言结论，不能只返回工具调用。
7. 涉及业务术语、分类或"该用哪个工具"时先用 search_ontology 查本体，按 suggested_call 选择工具与参数，不要凭记忆猜。
8. 用户要求新增分类概念时使用 add_ontology_concept；工具返回拒绝原因时如实转述，不要自行编造概念。
9. 查询结果带分页信息（total/has_more）时主动告知用户还有多少条，可翻页。
`.trim();

type DeepAgent = Awaited<ReturnType<typeof createDeepAgent>>;

/** 清洗模型偶发泄漏的思维标记（如 <|begin_of_box|>、</think>），避免进入聊天正文。 */
const THINK_MARKERS = /<\|begin_of_box\|>|<\|end_of_box\|>|<\/?think>/g;

function stripThinkMarkers(text: string) {
  return text.replace(THINK_MARKERS, "");
}

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
      mcpServers: {
        business: {
          transport: "stdio",
          // 不能依赖 PATH 中的 tsx（systemd/生产环境下不可用），改用 node + cli.mjs 绝对路径启动
          command: process.execPath,
          args: [
            path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs"),
            path.join(projectRoot, "src/mcp/server.ts"),
          ],
        },
      },
      onConnectionError: "ignore",
    });

    const ontologyTools = await this.client.getTools();
    // 本体工具（MCP 子进程）+ 业务查询工具（主进程，token 按请求注入）
    const tools = [...ontologyTools, ...hamTools] as unknown as StructuredTool[];
    this.toolNames = tools.map((tool) => tool.name).sort();
    this.agent = await this.createAgent(this.activeModelName, tools);
  }

  async switchModel(modelName: string) {
    if (modelName === this.activeModelName) return;
    if (!this.client) throw new Error("Agent runtime 尚未初始化");
    const ontologyTools = await this.client.getTools();
    const tools = [...ontologyTools, ...hamTools] as unknown as StructuredTool[];
    this.agent = await this.createAgent(modelName, tools);
    this.activeModelName = modelName;
  }

  private async createAgent(
    modelName: string,
    tools: StructuredTool[],
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

  async chat(message: string, threadId: string, hamToken?: string) {
    if (!this.agent) throw new Error("Agent runtime 尚未初始化");

    const result = await this.agent.invoke(
      { messages: [{ role: "user", content: message }] },
      { configurable: { thread_id: threadId, ...(hamToken ? { ham_token: hamToken } : {}) } },
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
    hamToken?: string,
  ): AsyncGenerator<AgentStreamEvent> {
    if (!this.agent) throw new Error("Agent runtime 尚未初始化");

    const run = await this.agent.streamEvents(
      { messages: [{ role: "user", content: message }] },
      {
        version: "v3",
        configurable: { thread_id: threadId, ...(hamToken ? { ham_token: hamToken } : {}) },
        ...(signal ? { signal } : {}),
      },
    );
    const toolsUsed = new Set<string>();
    const toolNamesById = new Map<string, string>();
    let answer = "";

    for await (const protocolEvent of run) {
      const event = projectProtocolEvent(protocolEvent);
      if (!event) continue;

      if (event.type === "token") {
        const delta = stripThinkMarkers(event.delta);
        if (!delta) continue;
        answer += delta;
        yield { ...event, delta };
        continue;
      }
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
        const cleaned = stripThinkMarkers(message.content).trim();
        if (cleaned) return cleaned;
      }
      if (Array.isArray(message.content)) {
        const answer = stripThinkMarkers(
          message.content
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
            .join("\n"),
        ).trim();
        if (answer) return answer;
      }
    }
    throw new Error("模型没有返回最终回答");
  }
}
