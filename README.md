# Simple Agent

一个尽量小、但边界完整的 TypeScript 业务 Agent 示例：

- DeepAgents TypeScript：单 Agent 运行时和原生 `SKILL.md`
- 支持模型列表和运行时切换：已使用过的模型会自动保留，当前默认 `glm-4-5v`
- 流式输出：SSE 逐 Token 返回；默认关闭 Thinking，避免思维链进入聊天正文
- Agent 工作台：会话导航、工具执行轨迹、结构化订单/草稿卡片、停止生成和新建会话
- Markdown 回复：流式渲染标题、列表、表格、引用、链接和代码块；禁用原始 HTML
- MCP：把已有业务后端包装成受控 Tool
- Fastify：聊天 API 和本地 Web 页面
- 人工确认边界：示例只生成草稿预览，不自动提交业务数据

## 架构

```text
浏览器 / 调用方
       |
       v
Fastify Agent API :8000
       |
       +-- DeepAgents TS + skills/
       |
       v
MCP Server（stdio 子进程）
       |
       v
现有业务后端（当前使用内存演示数据）
```

第一版使用 stdio MCP，启动简单且不开放额外端口。以后独立部署 MCP Server 时，可切换为
Streamable HTTP，Agent 与 Skill 不需要改变业务语义。

## 启动

复制 `.env.example` 为 `.env`,填入你的模型 API 地址和密钥;`.env` 已被 `.gitignore` 排除。

```bash
npm install
npm run dev
```

打开 <http://127.0.0.1:8000>。

也可以直接请求 API：

```bash
curl http://127.0.0.1:8000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"查询订单 SO-1001，并告诉我客户名称"}'
```

## 当前演示能力

- `查询订单 SO-1001`
- `查一下青岛工厂的订单`
- `根据 SO-1001 准备资产申报草稿，资产名称改成空压机 A`

演示数据和业务适配层位于 `src/mcp/backend.ts`。接真实系统时，只替换
`DemoBusinessBackend` 内部实现，MCP Tool 的名称、入参和结构化输出可以保持稳定。

## 本体（Ontology）学习模块

本项目内置一个最小但完整的本体示例，用来直观学习"本体建设"如何影响 Agent 的会话结果。

- **TBox（概念层）**：`ontology.seed.json` 里的资产分类树（设备 → 动力设备 → 空压机…），含别名与描述。
- **ABox（实例层）**：同一文件里的具体资产实例，锚定到演示订单。
- **运行时本体**：首次访问自动从种子复制为 `ontology.json`（被 gitignore），会话中的建设写入这里。
- **可视化**：打开 <http://127.0.0.1:8000/ontology> 浏览概念树，页面每 4 秒自动同步，可一键重置回种子。

相关工具：`search_ontology`（概念查询）、`query_orders_by_concept`（语义订单查询）、
`add_ontology_concept`（会话中建设）、`get_ontology`（全图）。实现见 `src/mcp/ontology.ts`。

### 学习实验

1. **关键字 vs 语义**：先问 `查询动力设备的订单`（`query_orders` 按字符串匹配，订单字段里没有这四个字，查不到），
   再问 `按动力设备这个类别查一下相关订单`（`query_orders_by_concept` 把概念展开为子类，命中空压机实例和 SO-1001）。
   差异来源：本体知道"空压机 ⊑ 动力设备"，而关键字匹配不知道。
2. **术语归一**：问 `空气压缩机属于哪类资产` —— 别名命中"空压机"，返回完整分类链与实例。
3. **会话中建设影响结果**：问 `帮我在本体里新增概念：冷干机，父类是后处理设备，关联订单 SO-1001`，
   然后再问 `查后处理设备相关的订单` —— 结果比建设前多出冷干机。同时打开 `/ontology` 页面看树的变化。
4. **本体治理**：重复添加"冷干机"、或指定不存在的父类，工具会拒绝并返回原因，Agent 如实转述。
5. **恢复现场**：`npm run ontology:reset` 或在 `/ontology` 页面点"重置本体"，回到种子状态。

## 常用命令

```bash
npm run dev             # 开发模式
npm run build           # 编译 TypeScript
npm run typecheck       # 类型检查
npm test                # 单元测试
npm run check           # 类型检查 + 单元测试
npm run ontology:reset  # 重置运行时本体回种子状态
```

## 安全边界

- 模型密钥只从 `.env` 或环境变量读取。
- Agent 不获得通用 HTTP 请求能力，只能调用白名单 MCP Tool。
- DeepAgents 文件权限只允许读取 `skills/`，拒绝读取其他项目文件和所有写入。
- 查询权限、租户和用户身份应由 MCP 服务端根据可信请求上下文校验。
- `prepare_asset_draft` 只生成预览，不进行正式保存或提交。
- 接入写操作时，应在 Agent 外增加确认令牌、幂等键和审计记录。

## API

- `GET /api/health`：Agent 服务状态
- `GET /api/config`：非敏感运行配置
- `POST /api/config/model`：切换模型并将其加入历史模型列表
- `POST /api/chat`：发送消息，使用 `thread_id` 续接会话
- `POST /api/chat/stream`：通过 SSE 流式返回 `meta`、`token`、`tool`、`done` 或 `error` 事件
- `GET /api/ontology`：读取当前本体（含会话中建设的内容）
- `POST /api/ontology/reset`：重置运行时本体回种子状态
