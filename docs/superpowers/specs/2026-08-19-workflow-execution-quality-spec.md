# Workflow 执行质量与模型路由 Spec（Output Repair / Verification / Model Tier）

> 日期：2026-08-19
>
> 状态：设计草案，尚未实施
>
> 范围：`modules/workflow` 的结构化输出修复、节点级验证后置条件与模型分层路由
>
> 前置：`docs/superpowers/specs/2026-08-18-workflow-execution-phase2-spec.md`（已实施并合并）

## 1. 结论

在 Phase 2 的 `WorkflowNodeExecutor` 与定义预检上增加三项执行质量能力：

1. **Output Repair**：schema 节点的第一轮提交缺失或校验失败时，执行**恰好一次**同路由修复轮（同 modelId、同 capability、仍走 `submit_workflow_output` 提交工具），修复结果再校验一次；仍失败按 Phase 2 语义 `agent-failed`。修复轮不是重试状态机——它是 executor 内部的一次性捕获修复，不改变节点状态枚举、不持久化中间态、不计 attempt。
2. **Verification 后置条件**：`WorkflowNode` 增加可选 `verification`（JSON Schema + `warn`/`hard` 档位）。executor 返回后、持久化前断言；`hard` 失败使节点 `failed`（`invalid-output`），`warn` 失败节点成功但 detail 记录警告。
3. **Model Tier 路由**：节点 `modelId` 支持 `fast` / `balanced` / `deep` 三层别名，在定义构建时解析到具体模型 id（解析顺序：精确 id 匹配优先 → tier map → 默认模型）。无法解析的 tier 在 preflight 拒绝，不静默降级。

三者都在模块内实现，不修改 Host Core、不扩 Host API、不动 Markdown-first 编辑架构。

## 2. 目标与非目标

### 2.1 目标

- 结构化输出从"一次机会"变为"两次机会"：修复轮显著降低 schema 节点的 `agent-failed` 率，且修复路径与首轮完全同构（同一 submit 工具、同一校验器）。
- Verification 让 workflow 作者能对关键节点声明硬性/软性质量断言，断言失败有确定的、可观察的结果。
- Tier 别名让 workflow 定义与具体模型解耦：换模型只需改模块设置里的 tier map，不改 WORKFLOW.md。
- 全部能力有明确的 preflight 语义：能接受则接受，不能接受则拒绝（KodaX 规则 2：没有"接受但忽略"的字段）。

### 2.2 明确不做

- **不做自动重试/指数退避/节点级 retry 配置**（Phase 2 非目标维持）：修复轮是恰好一次、仅针对结构化输出捕获失败的补救，不是对节点执行的 retry。条件（缺失提交 / schema 校验失败）不满足时不发起修复轮。
- 不做 LLM 驱动的自我评估循环、质量评分器、多候选投票。
- 修复轮不解析文本 JSON（Phase 2 原则维持）：修复轮同样只接受 `submit_workflow_output` 提交。
- mapAgent 不参与修复轮（item 级无提交工具，×3 成本且与 item 隔离语义冲突）；mapAgent 的数组结果继续走现有校验。
- 不做 token 预算、成本硬限制、per-node maxTokens 配置。
- 不做 provider 级路由策略（fast/balanced/deep 只解析到 model id，不选择 provider）。
- verification 不做表达式语言（只有 JSON Schema 断言）、不做跨节点后置条件（只断言本节点输出）、不做 bounded repair 循环（warn/hard 失败即失败，无修复循环）。

## 3. 当前基线

- `WorkflowNodeExecutor.execute` 对 schema 节点：首轮 `submit_workflow_output`，第一份有效 `value` 存入；流结束无成功提交 → `agent-failed`；`error`/`aborted` 事件 → 稳定错误码。
- `workflow-schema.ts` 的 Ajv validator：`validateSchema` / `validateValue`，非有限 JSON-compatible 值在持久化前拒绝。
- `WorkflowNode` 已有可选 `outputSchema`、`mergeStrategy`；`parseNode`/runtime 校验只接受白名单值，DSH import/export 保留扩展字段。
- 定义构建：空 `modelId` 解析到 run 默认模型；非空必须精确匹配模型快照；字符串 `default` 无特殊含义。
- 模块已有 settings contribution 机制（`YoloModuleSettingsContributionV1`，fields + localizations）。

## 4. 设计

### 4.1 Output Repair

**触发条件（两选一）：**

- 首轮流正常结束但无任何成功提交（`agent-failed` 前捕获）；
- 首轮有提交但 `validateValue(outputSchema, value)` 失败。

**修复轮构造：**

- 同一 `modelId`、同一 `capability: 'vault-write'`、同一 `activity` 与 `signal`；
- `systemPrompt` 与首轮相同（协议前缀 + workflow 上下文 + STEP 内容 + 输出指令）；
- `prompt` 在首轮动态输入上附一条结构化修复说明：缺失提交时说明"必须调用 submit_workflow_output 提交结果"，校验失败时附 Ajv 错误消息（`errors` 的 message 字段）；
- 仍携带 `submit_workflow_output` 工具，仍只接受工具提交。

**结果判定：**

- 修复轮提交通过 `validateValue` → 作为节点输出返回（与首轮成功路径完全相同）；
- 修复轮流结束仍无有效提交 / 校验再失败 / `error` / `aborted` → 维持 Phase 2 语义：`agent-failed`（缺失）或 `invalid-output`（校验失败），错误消息注明"after repair attempt"。
- 无 schema 节点（completed.text 路径）不参与修复轮。

**实现边界：**

- 修复轮是 executor 内部的一到两个顺序调用，不进入 Coordinator 状态机、不发布中间快照、不写 store；Coordinator 对节点只看到一次执行与一个结果。
- 不引入 attempt 计数、不持久化修复轮证据（首轮失败原因进入最终错误的 message 即可）。
- 与 cancel 的关系：修复轮与首轮共享同一 `signal`，abort 后走 `cancelled`。

### 4.2 Verification 后置条件

**节点字段（DSH import/export 保留）：**

```ts
verification?: Readonly<{
  schema: unknown          // JSON Schema，定义构建时用 Ajv validateSchema 预检
  mode: 'warn' | 'hard'
}>
```

- `parseNode`/runtime 校验：`mode` 只接受 `warn`/`hard`；`schema` 必须是可编译的 JSON Schema（复用 `validateSchema`）；非法即 `invalidDefinition` 类 issue。
- 适用节点：`agent`、`mapAgent`、`output`。`input`/`condition`/`merge` 不接受该字段（白名单外即校验失败，维持"只接受白名单值"原则）。

**执行位置与语义：**

- executor 返回 `value` 后、Coordinator 持久化节点结果前，调用 `validateValue(verification.schema, value)`。
- 通过：节点正常进入终态，detail 可记录 `verified`。
- `hard` 失败：节点 `failed`，错误码 `invalid-output`，message 附验证错误（与 outputSchema 失败同通道，不新增错误码）。
- `warn` 失败：节点成功，`detail` 记录验证警告（展示在 Run 面板节点详情），输出照常持久化。

**边界：**

- verification 断言的是"节点输出"，不访问 workflow 输入或其他节点输出（无跨节点表达式）。
- `warn` 不进入 background 状态（仍是 succeeded）；detail 是 Phase 2 已有的展示通道。
- 与 outputSchema 的关系：outputSchema 先于 verification（outputSchema 失败 → 修复轮 → 仍失败则终止；verification 只作用于最终通过 outputSchema 的值）。

### 4.3 Model Tier 路由

**别名集合：** `fast` / `balanced` / `deep`，仅这三个字符串；其余一律按具体 model id 处理（维持精确匹配语义）。

**模块设置新增（settings contribution，i18n 三语）：**

```ts
modelTiers: {
  fast?: string      // 具体 model id
  balanced?: string
  deep?: string
}
```

**定义构建时的解析顺序（`workflow-definition.ts`）：**

1. `modelId` 为空 → run 默认模型（现状不变）。
2. `modelId` 精确命中模型快照中某个模型 id → 直接用（包括某模型真实 id 恰好叫 `fast` 的情形——精确匹配永远优先，向后兼容）。
3. `modelId` 是 tier 别名且 tier map 中配置了具体 id、且该 id 在模型快照中可用 → 解析为该 id。
4. tier 别名但 tier map 未配置 / 配置的 id 不在快照中 → preflight 失败（`model-unavailable`），与"非空 id 必须精确匹配"的现有拒绝语义一致。
5. 其他未命中 → preflight 失败（现状）。

`definitionHash` 不变：`modelByNodeId` 记录的是解析后的具体 id（tier 是解析期的输入，不是快照的一部分），保证同一定义哈希对应同一组真实模型。

**UI：** Run 面板模型下拉不变（仍选具体模型作为 run 默认模型）；节点检查器（inspector）的模型字段接受 tier 别名输入，显示解析后的具体 id（readonly 提示）；preflight 失败在 Run 面板显示 `run.noModel` 语义的消息。

### 4.4 数据与契约

- `WorkflowNode` 新增 `verification?`（DSH 导入导出往返保持）；`mergeStrategy` 先例同款加法。
- run 快照不新增字段（verification 警告走节点 `detail`；修复轮无持久化痕迹，仅最终错误 message 注明）。
- i18n 新增：`run.modelTier.fast/balanced/deep`、`node.verification.hard/warn`、`node.verified`、`run.repairAttempted`（错误消息用）、inspector 相关文案，en/zh/it 三语。

## 5. 与 Phase 2 非目标的边界

- 修复轮 vs "自动重试"：Phase 2 禁止的是节点级 retry 状态机与退避；修复轮是结构化输出捕获的单一补救路径，executor 内顺序两次调用、零状态机改动、零持久化字段。若评审认为二者不可区分，则修复轮退化为"首轮错误消息直接进入最终 error"，不引入任何循环。
- verification 不引入新错误码、新节点状态、新 background 状态。
- tier 路由不引入 provider 选择、不改 Host API 的模型快照结构（模块设置是既有机制）。
- 不做跨运行 memoization、结果缓存（Phase 2 非目标维持）：tier 解析在定义构建时一次性完成。

## 6. 测试要点

```text
schema 节点首轮无提交 → 修复轮提交有效值 → 节点成功且只持久化最终值
schema 节点首轮校验失败 → 修复轮再失败 → invalid-output，message 注明 repair attempt
无 schema 节点不发起修复轮（completed.text 路径零变化）
修复轮期间 abort → cancelled（与首轮共享 signal）
verification hard 失败 → 节点 failed + invalid-output；warn 失败 → succeeded + detail 警告
verification schema 不可编译 → 定义构建期拒绝（invalidDefinition issue）
input/condition/merge 不接受 verification 字段
tier 别名解析到 tier map 配置的具体 id；精确 id 优先于 tier 别名
tier 未配置或配置 id 不可用 → preflight model-unavailable
definitionHash 记录解析后的具体 id，同哈希对应同组模型
DSH 导入导出往返保持 verification 字段
```

## 7. 验证矩阵

| 要求 | 覆盖 |
| --- | --- |
| 恰好一次同路由修复，不建重试状态机 | 4.1 + 5 |
| 修复轮不解析文本 JSON、只走提交工具 | 4.1 修复轮构造 + 测试 |
| verification 确定性可观察（warn/hard） | 4.2 + 测试 |
| tier 不能接受则拒绝，无静默降级 | 4.3 解析顺序 3-4 + 测试 |
| 不改 Host Core/Host API/快照结构/新枚举 | 2.2 + 4.4 + 5 |
