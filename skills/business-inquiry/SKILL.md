---
name: business-inquiry
description: 查询资产中台（ham_ui）的真实业务数据：父项目、子项目、采购申请单、采购合同、合同资产。用户问项目进度/状态、采购单、合同或资产明细时使用。
allowed-tools: query_parent_projects query_child_projects query_purchase_requisitions query_purchase_contracts query_assets_by_contract search_ontology
---

# 资产中台业务查询

通过 MCP Tool 查询真实业务数据（只读）。所有数据来自 ham_ui 真实接口，不要编造。

## 项目查询

1. “查项目”默认用 `query_parent_projects`（父项目）；提到子项目/明细项目用 `query_child_projects`。
2. 按状态查：status 参数直接传中文状态词（生效、审批中、退回、取消、可审批），工具自动转码。
3. “某个父项目下有哪些子项目”：`query_child_projects` 传 parent_project_code。
4. 项目字段：编码、名称、状态、公司编码 orgCode、预算 projectTotalAmount、项目经理、计划起止日期。

## 采购查询

1. “采购单/采购申请/PR”用 `query_purchase_requisitions`；按采购编码查时把 requisitionCode 放进 filters。
2. 状态词（草稿、审批中、已审批、已退回、已取消）传 status 参数，自动转字母码。
3. “合同”用 `query_purchase_contracts`（filters 传 contractCode/projectCode）。
4. “合同下有哪些资产”用 `query_assets_by_contract`，filters 必须同时传 `purchaseContractNumber`（合同号）和 `orgCode`（公司编码）；如果用户只给了合同号，先 `query_purchase_contracts` 查出 orgCode 再查资产。
5. 采购链路：子项目（canStart=Y）→ 采购申请 → 采购合同 → 支付节点/收货资产。

## 不确定用哪个工具时

1. 先 `search_ontology` 查业务术语，按返回的 `suggested_call` 选择工具和参数。

## 禁止事项

- 不得编造业务数据；接口报错（如 token 过期）时如实转述错误信息。
- 只做只读查询，不调用任何写入/提交/审批操作。
- 分页默认 10 条；结果多时告诉用户总数，可翻页继续查。
