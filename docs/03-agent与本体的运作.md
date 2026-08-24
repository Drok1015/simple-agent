# Agent 与本体(Ontology)如何运作 —— 以"项目立项的步骤"为例

> 基于本项目真实代码:`src/mcp/ontology.ts`(OntologyStore)、`src/agent-runtime.ts`(Agent 循环)、`ontology.json`(运行时本体,62 个概念)。

## 1. 本体是什么:两层、一座桥

```text
TBox 概念层(ontology.json 的 concepts,62 个)
  每个概念:id / label / 别名 aliases / 父概念 parent_id / 描述 /
           工具映射 tool+params / 后端接口提示 api / 关系 relations
        │
        │  ←—"语义 → 接口"的桥:search_ontology 返回 suggested_call
        v
真实业务接口(HamClient,只读)
  query_parent_projects / query_child_projects / query_purchase_requisitions /
  query_purchase_contracts / query_assets_by_contract

ABox 实例层(instances):预留,当前为空 —— 业务数据不静态维护,
全部由真实接口按需返回,避免本体变成需要人工同步的第二份事实源。
```

**一句话定位:本体不是知识库,是路由表。**
它不存放"XX 项目预算多少"这种事实(事实永远来自接口),它存放的是:
**"你说的这个词 → 是哪个概念 → 在分类树什么位置 → 该调哪个工具 → 参数怎么填 → 和哪些概念有关系"。**

## 2. 本体在 Agent 架构里的位置

```text
用户提问
  v
DeepAgents 单 Agent 循环(大脑:LLM;规则:系统提示词 + 2 个 SKILL.md)
  |   系统提示词第 7 条:涉及业务术语先 search_ontology,
  |   按 suggested_call 选工具,不要凭记忆猜
  v
MCP 工具(手脚,白名单只读)
  ├─ search_ontology / add_ontology_concept / get_ontology   ← 本体三工具
  └─ query_parent_projects 等 5 个业务查询                    ← 事实来源
```

分工是关键:

| 角色 | 负责 | 特点 |
|------|------|------|
| LLM | 模糊的部分:理解意图、改写关键词、判断信息够不够 | 聪明但会编造 |
| 本体 | 精确的部分:术语归一、概念定位、工具路由、治理 | 死板但可信 |
| 真实接口 | 事实本身 | 唯一数据源 |

另有一层**持久化学习**:会话记忆(MemorySaver)随进程消失,而本体写入 `ontology.json`(临时文件 + rename 原子写),MCP 子进程与 Web API 共享同一份文件——**会话中建设的概念立刻对所有后续会话生效**,这才是项目里真正的"长期记忆"。

## 3. 四个核心机制(对应 OntologyStore 源码)

### 3.1 术语归一 `findConcept`(第 192-206 行)

```text
先精确:label 或任一 alias 与搜索词全等(大小写不敏感)
再子串:label 或 alias "包含"搜索词
```

没有向量、没有 embedding——朴素但确定的字符串匹配。
"PR"能命中"采购申请单"靠的是 aliases 里登记了 "PR";
模糊理解这一步的缺口,由 LLM 自己补(见第 5 节思考链第 2 轮)。

### 3.2 分类链 `ancestors`(第 153-166 行)

返回根到概念的完整路径:资产业务对象 › 资产项目域 › 父项目。
带环保护(parent_id 成环时截断),回答"X 属于哪类"直接用。

### 3.3 工具映射继承 `resolveToolHint`(第 209-224 行)★ 最精髓

```text
沿"自身 → 父 → 祖父 → …"向上找,遇到第一个带 tool 的概念就返回
```

全库只有 5 个概念带直接映射:

```text
parent-project        -> query_parent_projects
child-project         -> query_child_projects
purchase-requisition  -> query_purchase_requisitions
purchase-contract     -> query_purchase_contracts
receiving-order       -> query_assets_by_contract
```

所以"采购明细行"自己没配工具,却能沿链继承到 `query_purchase_requisitions`。
好处:**挂新概念不用配工具,挂对父概念就自动获得路由能力。**

### 3.4 双向关系 `collectRelations`(第 227-258 行)

汇总"自身出边 + 全图入边"(inverse: true 标记反向)。
"父项目"上登记的 `包含 → 子项目`,查询"子项目"时也会以反向边出现——
agent 问任何一个概念,都能看到它在业务链路中的上下游。

## 4. 本体建设(会话中)与治理 `addConcept`(第 301-392 行)

用户说"帮我在本体里新增概念:设备类采购,父类是采购申请,映射到 query_purchase_requisitions":

```text
5 道治理校验(任一失败 → 返回 reason,Agent 如实转述,不静默修正):
  ① 概念名非空
  ② 父概念必须已存在(支持 label/别名/id)
  ③ 重名治理:新 label/别名 与全库 label+别名 不得重复(大小写不敏感)
  ④ 工具白名单:tool 必须是已注册的 MCP 工具,防止概念指向不存在的接口
  ⑤ 关系目标概念必须已存在
        |
        v 全部通过
生成 id(c-<时间戳>-<随机>) → 挂到父概念下 → 原子写入 ontology.json
        |
        v
/ontology 页面 ≤4 秒同步可见;之后任何会话 search_ontology 立即命中新概念
```

治理的意义:本体会随使用不断长大,没有这几道闸门,树很快就会被重名概念、悬空关系、假工具名腐蚀成垃圾——**可学习的系统必须同时是可治理的**。

## 5. 完整思考链:"项目立项的步骤"

每一轮 = 一次独立 LLM 调用;`Thought` 是内部推理(系统提示词要求不得在正文输出),`Action` 是真实的工具调用。**注意第 2 轮:本体搜索是朴素字符串匹配,首次未命中,靠 Agent 自己改写关键词重试——这是 LLM 与本体互补的最典型瞬间。**

```text
[用户] 项目立项的步骤是什么?

━━ 第 1 轮 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Thought: 这是资产业务流程问题。规则:业务术语先查本体,不凭记忆猜。
         直接拿用户原词"项目立项"去查。
Action:  search_ontology(term="项目立项")
Observation:
         found: false
         suggestions: [全部 62 个概念标签](没有任何 label/别名包含"项目立项")

━━ 第 2 轮 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Thought: 未命中——本体是字符串匹配,用户原词太长。
         建议列表里有"立项项目""资产项目域",改用更短的关键词"立项"重试。
Action:  search_ontology(term="立项")
Observation: ✅ 命中 parent-project(别名"立项项目"包含"立项")
  path: 资产业务对象 › 资产项目域 › 父项目
  description: 项目立项主体。状态 2可审批/3审批中/4退回/8取消/9生效;
               hbcParentProjectCode(HBC 关联);蓝图内控:立项审批通过后
               通知 HBC 锁定预算,项目取消时释放。
  suggested_call: { tool: "query_parent_projects", params: {} }
  relations: ─包含→ 子项目(via parentProjectCode)
             ─同步→ HBC系统(via hbcParentProjectCode)
             ─审批→ 流程实例(via processInstanceId)

━━ 第 3 轮 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Thought: 流程骨架齐了:HBC 申报 → 中台建档 → 审批流 → 生效锁预算 → 拆子项目。
         skill 要求按 suggested_call 取真实数据佐证;
         状态词"生效"直接传中文,工具自动转码 9。
Action:  query_parent_projects(status="生效", page_size=2)
Observation: 真实父项目 2 条(编码/名称/orgCode/预算/项目经理/hbcParentProjectCode)

━━ 第 4 轮 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Thought: 概念给结构、接口给事实,互相印证,信息足够 → 组织回答,标注来源。
Action:  最终回答(不含工具调用,循环结束)
```

**最终回答**:① HBC 申报(取得 hbcParentProjectCode)→ ② 立项主体在资产中台建档 → ③ 提交统一审批流(状态 2→3)→ ④ 批复生效(状态 9,通知 HBC 锁定预算)→ ⑤ 拆分子项目(执行单元,canStart=Y 才能发起采购),附真实父项目实例。

## 6. 设计洞察(为什么这样架构)

1. **模糊与精确分治**:LLM 管模糊(理解/改写/判断),本体管精确(归一/路由/治理),接口管事实。三者各自只做自己擅长的事。
2. **本体是最便宜的"教 Agent 学业务"方式**:不用微调模型、不用重训向量库,一句话 `add_ontology_concept` 就让所有后续会话立刻学会新术语——因为学习成果落在文件里,不在模型权重里。
3. **继承式工具映射**让本体可扩展:新概念只要挂对父节点,自动获得整条 suggested_call 能力。
4. **朴素匹配是刻意取舍**:62 个概念的规模下,别名 + 子串匹配足够;真正难的部分(同义改写、口语化表达)交给 LLM 在循环里自行完成——如果概念规模到万级,才需要升级为向量检索。
