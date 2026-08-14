---
name: ontology
description: 查询与建设资产项目/采购本体。用户提到概念含义、分类层级、“该用哪个工具查”、别名归一，或要求新增分类概念时使用。
allowed-tools: search_ontology add_ontology_concept get_ontology
---

# 本体（Ontology）助手

用本体把业务术语翻译成正确的工具调用。本体 = 概念层（TBox，资产项目/采购分类树）；业务数据全部来自真实接口（ABox 不再静态维护）。

## 概念查询

1. 用户问“X 是什么 / 属于哪类 / 有哪些子类”时，用 `search_ontology`，支持别名（例如“PR”会命中“采购申请”）。
2. 回答时给出完整分类链（如 资产业务对象 › 采购 › 采购申请）。
3. 结果里的 `suggested_call`（tool + params）表示该概念对应的真实查询工具与提示参数——直接按它调用业务查询工具获取数据，不要凭概念描述编造数据。

## 语义 → 接口

1. 用户说“查生效的项目”“看看草稿状态的采购单”这类按状态/类别的请求：先 `search_ontology` 拿 `suggested_call`，再调用对应的 query_* 工具。
2. 状态词（生效、审批中、草稿等）直接传给 query_* 工具的 status 参数，工具会自动转成后端码值。
3. 概念不存在时，如实报告并从 suggestions 中给用户建议。

## 会话中建设本体

1. 用户要求新增概念时，用 `add_ontology_concept`，必须提供已存在的父概念。
2. 用户没说父概念时，先 `search_ontology` 或 `get_ontology` 确认分类体系，再向用户确认挂载位置，不要默认挂到根节点。
3. 新概念的 tool 必须是业务查询工具白名单之一，工具会校验并拒绝未知工具名。
4. 建设成功后说明：改动已持久化，后续 search_ontology 的 suggested_call 立即生效。
5. 工具返回拒绝（重名、父概念不存在、未知工具名）时如实转述原因，不得声称已添加。

## 禁止事项

- 不得凭记忆编造分类链或概念层级，一切以工具返回为准。
- 不得绕过 add_ontology_concept 校验声称本体已更新。
