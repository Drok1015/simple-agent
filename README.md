# Simple Agent

一个尽量小、但边界完整的 TypeScript 业务 Agent 示例，接入资产中台（ham_ui）真实接口：

- DeepAgents TypeScript：单 Agent 运行时和原生 `SKILL.md`
- 真实业务数据：父项目 / 子项目 / 采购申请单 / 采购合同 / 合同资产，全部走 ham_ui 网关只读接口
- 本体（Ontology）学习模块：资产项目与采购的概念树，概念到工具的语义映射，支持会话中建设
- 流式输出：SSE 逐 Token 返回；默认关闭 Thinking，避免思维链进入聊天正文
- Agent 工作台：会话导航、工具执行轨迹、业务记录卡片、停止生成和新建会话
- 模型列表和运行时切换：已使用过的模型会自动保留
- MCP：把业务后端包装成受控 Tool（stdio 子进程）
- Fastify：聊天 API 和本地 Web 页面
- MCP 调试台：连接远程 SSE MCP、查看 Tool Schema、填写参数并执行调用
- 远程 MCP Agent 接入：调试台目标同时注册到 Agent，模型可直接调用远程工具

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
       +-- OntologyStore（本体：概念树 + 工具映射，ontology.json）
       |
       +-- HamClient（真实接口：ham-test.haier.net/ham-api）
              - ham-project/parent-project/page          父项目
              - ham-project/project-info/getProjectList  子项目
              - ham-purchasing/purchase-requisition/page 采购申请单
              - ham-purchasing/purchase-contract/page    采购合同
              - ham-assets/receiving-info/selectByContract 合同资产
```

## 启动

复制 `.env.example` 为 `.env`，填入模型 API 地址和密钥；调用真实业务接口还需要资产中台凭证：

```bash
MODEL_API_KEY=...          # 模型密钥
MODEL_BASE_URL=...         # 模型网关
HAM_API_BASE=https://ham-test.haier.net   # 资产中台网关（默认测试环境）
HAM_TOKEN=...              # 登录 ham_ui 后从浏览器 cookie `token` 复制
HAM_TENANT_ID=...          # 租户ID（可选）
```

```bash
npm install
npm run dev
```

打开 <http://127.0.0.1:8000>；本体可视化在 <http://127.0.0.1:8000/ontology>。
MCP 调试台在 <http://127.0.0.1:8000/mcp-debug>，默认连接 `http://101.200.220.45:8050/sse`；可通过 `MCP_DEBUG_URL` 修改目标地址。
同一远程 MCP 也会作为 `remote` 服务接入 Agent；当前可用工具会合并显示在 `GET /api/health` 的 `mcp_tools` 中。

## MCP 工具

真实数据（只读，需 HAM_TOKEN）：

- `query_parent_projects`：父项目分页；status 传中文状态词（生效/审批中/退回/取消/可审批）自动转码
- `query_child_projects`：子项目分页；传 parent_project_code 时走"父查子"接口
- `query_purchase_requisitions`：采购申请单分页；status 传中文状态词自动转字母码（草稿=D、审批中=P、招标中=B、已批准=A 等）
- `query_purchase_contracts`：采购合同分页
- `query_assets_by_contract`：按合同查收货资产

本体：

- `search_ontology`：概念查询，返回分类链与 `suggested_call`（概念 → 工具映射）
- `add_ontology_concept`：会话中建设本体（治理校验：重名/父概念/工具白名单）
- `get_ontology`：本体全图

## 本体（Ontology）学习模块

本体 = 概念层（TBox，`ontology.seed.json` 里的资产项目/采购分类树）+ 实例层（ABox，业务数据由真实接口按需返回，不再静态维护）。运行时本体在 `ontology.json`（gitignore），会话中的建设写入这里；`/ontology` 页面每 4 秒自动同步，可一键重置回种子。

### 学习实验

1. **语义 → 接口**：问「PR 是什么意思？查采购申请该用哪个工具？」——`search_ontology` 别名命中"采购申请"，返回 `suggested_call: query_purchase_requisitions`，Agent 按它调用真实接口。
2. **状态词归一**：问「查一下生效状态的父项目」——"生效"自动转成 `parentProjectStatus=9` 调真实接口，不需要用户知道码值。
3. **会话中建设影响工具选择**：说「帮我在本体里新增概念：设备类采购，父类是采购申请，映射到 query_purchase_requisitions 工具」——写入持久化，之后相关问题的 suggested_call 立即包含新概念；打开 `/ontology` 看树的变化。
4. **本体治理**：重复添加概念、指定不存在的父类或未知工具名，工具会拒绝并返回原因，Agent 如实转述。
5. **恢复现场**：`npm run ontology:reset` 或在 `/ontology` 页面点"重置本体"。

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

- 模型密钥与资产中台凭证只从 `.env` 或环境变量读取。
- Agent 不获得通用 HTTP 请求能力，只能调用白名单 MCP Tool；业务接口仅只读查询。
- DeepAgents 文件权限只允许读取 `skills/`，拒绝读取其他项目文件和所有写入。
- 查询权限、租户和用户身份由资产中台根据 token 校验；凭证过期时工具返回可操作的错误提示。
- 未开放任何写入、提交、审批类接口。

## API

- `GET /api/health`：Agent 服务状态（含 ham_api_base 与凭证配置状态）
- `GET /api/config`：非敏感运行配置
- `POST /api/config/model`：切换模型并将其加入历史模型列表
- `POST /api/chat`：发送消息，使用 `thread_id` 续接会话
- `POST /api/chat/stream`：通过 SSE 流式返回 `meta`、`token`、`tool`、`done` 或 `error` 事件
- `GET /api/ontology`：读取当前本体（含会话中建设的内容）
- `POST /api/ontology/reset`：重置运行时本体回种子状态
- `GET /api/mcp-debug`：连接远程 MCP 并读取服务信息和工具列表
- `POST /api/mcp-debug/call`：调用选定的远程 MCP 工具并返回原始结果与耗时
