# Workflow 执行质量与模型路由 Spec（Output Repair / Verification / Model Tier）

> 日期：2026-08-19（2026-08-19 二轮盲审修订版）
>
> 状态：设计草案，已过两轮盲审（每轮 3 人）并修订，尚未实施
>
> 范围：`modules/workflow` 的结构化输出修复、节点级验证后置条件与模型分层路由
>
> 前置：`docs/superpowers/specs/2026-08-18-workflow-execution-phase2-spec.md`（已实施并合并）

## 1. 结论

在 Phase 2 的执行域上增加三项执行质量能力：

1. **Output Repair**：schema 节点首轮"流正常结束但提交被拒"时，执行**恰好一次**同路由修复轮（同 modelId、同 capability、仍走 `submit_workflow_output` 提交工具），修复结果再校验一次；仍失败按 Phase 2 语义 `agent-failed`。修复轮只在**可机械判定**的条件下触发（见 §4.1），不是重试状态机。
2. **Verification 后置条件**：`WorkflowNode` 增加可选 `verification`（JSON Schema + `warn`/`hard` 档位）。统一在 Coordinator 侧、持久化前断言；`hard` 失败使节点 `failed`（新错误码 `verification-failed`），`warn` 失败节点成功且警告在 Run 面板可见（新增警告显示面）。
3. **Model Tier 路由**：节点 `modelId` 支持 `fast` / `balanced` / `deep` 三层别名，在定义构建时解析到具体模型 id。tier 映射放模块设置（经 `host.config` 读取，见 §4.3），无法解析的 tier 在 preflight 拒绝，不静默降级。

三者都在模块内实现，不修改 Host Core。**Host API 调整许可**（用户确认）：允许增加/调整最小简单接口——本 spec 仅有的候选是 `host.settings.getContributionValues(moduleId)`（tier 读取，§4.3；仅当 `host.config` 读路径有阻塞时启用），其余不引入任何 Host API 变更。

## 2. 目标与非目标

### 2.1 目标

- 修复轮只覆盖"模型已尝试提交但被 schema 拒绝"这一种失败：这是模型理解了任务但格式不合规的情形，一次带错误反馈的重试有明确预期价值。
- Verification 让 workflow 作者能对关键节点声明硬性/软性质量断言，断言结果可观察（warn 有显示面、hard 有专属错误码）。
- Tier 别名让 workflow 定义与具体模型解耦：换模型只需改模块设置里的 tier 映射，不改 WORKFLOW.md。
- 全部能力有明确的 preflight 语义：能接受则接受，不能接受则拒绝（KodaX 规则 2：没有"接受但忽略"的字段）。

### 2.2 明确不做

- **不做自动重试/指数退避/节点级 retry 配置**（Phase 2 非目标维持）。修复轮与重试的机械区别（§4.1）：触发条件可机械判定、恰好一次、仅覆盖提交被拒、error/aborted/no-submission 三种情形绝不触发。
- 不做 LLM 驱动的自我评估循环、质量评分器、多候选投票。
- 修复轮不解析文本 JSON：修复轮同样只接受 `submit_workflow_output` 提交。
- mapAgent 不参与修复轮（item 级无提交工具）。
- 不做 token 预算、成本硬限制、per-node maxTokens 配置（Host API 无 usage 数据）。修复轮的成本上限是天然的结构性上限：每个 schema agent 节点最多 2 次 `host.agent.stream` 调用，在 spec 中明示为成本护栏。
- 不做 provider 级路由策略（fast/balanced/deep 只解析到 model id，不选择 provider）。
- verification 不做表达式语言（只有 JSON Schema 断言）、不做跨节点后置条件（只断言本节点输出）、不做修复循环（warn/hard 失败即失败）。

## 3. 当前基线（盲审校验后的准确描述）

- `WorkflowNodeExecutor.execute`：schema 节点首轮 `submit_workflow_output`；**工具 handler 内联校验提交值，只存第一份有效值，无效提交返回 `{isError:true}`**（workflow-node-executor.ts:302-318）——因此首轮结束后只有两种可观察结果：有有效提交 / 无有效提交。流结束无成功提交 → `agent-failed`；`error`/`aborted` 事件 → 稳定错误码。**修复轮触发条件二（"提交但校验失败"）在现有结构下不可达，需 executor 重构让 handler 把被拒提交的校验错误捕获为可观察信息（见 §4.1）**。
- `workflow-schema.ts` 的 Ajv validator：`validateSchema` / `validateValue`。
- `WorkflowNode` 已有可选 `outputSchema`、`mergeStrategy`；`parseNode` 白名单构造、未知字段**丢弃**（workflow-model.ts:394-411）——`verification` 需要显式加入 parseNode/runtime 校验与 DSH 双向转换（`exportDshFlowJson` / `dshNode`，workflow-document.ts:169-242），不是"先例同款免费加法"。
- 定义构建：空 `modelId` 解析到 run 默认模型；非空必须精确匹配；`definitionHash` 覆盖解析后的 `modelByNodeId`（workflow-definition.ts:91-96, 114-122）。
- **模块目前未注册任何 settings contribution**（index.tsx 只用 `host.settings.getModelSnapshot/subscribeModels`）；模块贡献值的读路径是 `host.config`（`ModuleConfigV1`），settings 字段经 contribution 持久化为 **flat `Record<key, string>`**（moduleSettingsContributions.ts:366-370）。
- `WorkflowNodeRun.detail` 是持久化字段但 **Run 面板不渲染它**（面板只有 input/output/error 三个 tab，workflow-run-panel.tsx:46, 314-348）——warn 警告需要新显示面。
- 节点执行路径分两类：agent/mapAgent 走 executor；**input/condition/merge/output 由 Coordinator 直接计算**（workflow-run-coordinator.ts:317-404）——verification 的统一位置必须是 Coordinator 侧。
- 节点检查器的模型字段已存在（自由文本输入，workflow-studio.tsx:1530-1540），tier 别名可直接输入；解析后的具体 id 以只读提示展示。

## 4. 设计

### 4.1 Output Repair

**触发条件（唯一，精确谓词，可机械判定）：**

> 首轮 `host.agent.stream` **正常结束**（非 error、非 aborted），且**至少一次** schema 校验被拒（`handler` 拒绝了提交值）、**且没有任何一次提交被接受**。

精确谓词的两侧都必要（盲审修订）："先无效后有效"的混合情形下，首轮已有有效提交 → 节点正常成功，**绝不发起修复轮**（否则修复轮的第二份输出会覆盖首轮已接受的输出）。为此 executor 的提交 handler 需要区分三种 isError 来源（当前实现直接丢弃，需重构捕获）：

- **schema 拒绝**（`validateValue` 失败）→ 计入修复触发计数器，捕获 Ajv 错误与**被拒值**；
- **重复提交**（已有有效值后再次提交，executor.ts:309-314 也返回 isError）→ 不计入（该分支只在首轮已成功时可达，谓词第二侧已排除）；
- 其他工具错误 → 不计入。

其余情形**绝不触发**修复轮：

- 流以 `error` 或 `aborted` 结束 → 维持现有稳定错误码（error→`agent-failed`、aborted→`cancelled`）；
- 流正常结束但模型从未调用提交工具（no-submission）→ 直接 `agent-failed`——模型没有理解提交要求，重复同样指令是纯重试，不做；
- 首轮已有有效提交（含先无效后有效）→ 正常成功。

这一不变量是代码审查可执行的边界：reviewer 无需读 spec 即可验证"修复轮只在 handler 记录了 schema 拒绝且无有效提交时发起"。

**修复轮构造：**

- 同一 `modelId`、同一 `capability: 'vault-write'`、同一 `activity` 与 `signal`；
- `systemPrompt` 与首轮相同；`prompt` 在首轮动态输入上附一条修复说明：**最后一条被拒的 Ajv 错误消息 + 被拒值（有界截断，如 2 KiB JSON 预览）** + "提交必须通过 schema 校验"。携带被拒值让模型能看到自己提交了什么（盲审修订：仅错误消息时模型看不到实际值，如 pattern 不匹配却不知值为何）。
- 仍携带 `submit_workflow_output` 工具；修复轮内的 schema 拒绝同样被捕获（若修复轮再失败，两轮的错误与被拒值都进入最终消息）。

**结果判定：**

- 修复轮提交通过 `validateValue` → 作为节点输出返回（与首轮成功路径完全相同）。
- 修复轮流结束仍无有效提交 → `agent-failed`；`error`/`aborted` → 现有稳定错误码。
- **错误保真**：最终错误的 `message` 必须包含首轮被拒原因（Ajv 错误 + 被拒值预览）与修复轮结果（"schema rejection (round 1): <ajv>; value: <preview>; after repair attempt: <round-2 outcome>"），第一轮失败原因不得丢失。

**可见性（盲审修订）：** 修复轮期间节点状态仍是 `running`（设计上无中间状态），但用户应能看出修复在进行：executor 通过现有 `onAgentEvent` 钩子把活动 detail 更新为 `repairing`（i18n `run.repairing`），背景活动 detail 同步。这是显示细节，不新增持久状态。

**实现边界：**

- 修复轮是 executor 内部顺序第二次调用；Coordinator 对节点只看到一次执行与一个结果；无中间快照、无 store 写、无 attempt 计数字段。
- 与 cancel 的关系：修复轮与首轮共享同一 `signal`，abort 后走 `cancelled`。
- 修复轮可能触发第二次工具审批（`vault-write` 审批策略）——接受，因为首轮已审批过同一次运行的同节点工具；若 Host 审批策略导致每次调用都询问，用户看到的是同一次运行的第二次询问，语义一致。
- 与 testNode 的关系：testNode 复用同一 executor，**同样享受修复轮**（与 full run 行为一致，符合 Phase 2 复用原则）。
- 成本护栏：每 schema agent 节点最多 2 次 `host.agent.stream` 调用（结构性上限，非配置）。
- 若实施评审判定该机制与"禁重试"不可调和，按 §5 降级：退化为"首轮错误消息直接进入最终 error"，不引入任何第二轮调用。

### 4.2 Verification 后置条件

**节点字段（parseNode 白名单 + DSH 双向显式加入）：**

```ts
verification?: Readonly<{
  schema: unknown          // JSON Schema；parseNode 只做 JSON-compatible 校验，Ajv 编译在定义构建期
  mode: 'warn' | 'hard'
}>
```

- 适用节点：`agent`、`mapAgent`、`output`。`input`/`condition`/`merge` 不接受该字段——**显式例外**：现有 `parseNode` 对未知字段是"静默丢弃"（workflow-model.ts:394-411），`verification` 需要在白名单构造中显式声明"适用节点白名单 + 其余节点拒绝"，即该字段不是被丢弃而是被拒绝（`invalidDefinition` 类 issue）。实现上是白名单构造里对 `verification` 加 kind 条件分支。
- `mode` 只接受 `warn`/`hard`；schema 必须在定义构建期通过 `validateSchema`，否则 `invalidDefinition` 类 issue。
- 分层：`parseNode`（domain 层）只校验 JSON-compatible 与 mode 白名单；Ajv 编译留在 `workflow-definition.ts`（execution 层）——domain 不 import execution，维持现有分层。

**执行位置（统一 Coordinator 侧，共享 finalize 辅助）：**

- **新增一个共享的 `finalizeNodeResult(node, value)` 辅助**（coordinator 内部函数）：执行 verification 校验并返回结果/警告。它在三个调用点生效，保证行为一致：
  1. executor 路径（agent/mapAgent，executeAgent 内输出 schema 校验之后）；
  2. Coordinator 直算路径（output 节点，processNode 内）；
  3. testNode 路径（Coordinator 内部，见下方 warn 通道）。
- 通过：节点正常进入终态，`detail` 记录 `verified`（编码见下）。
- `hard` 失败：节点 `failed`，**新错误码 `verification-failed`**（不复用 `invalid-output`——后置条件失败与输出 schema 失败是两件事，UI 文案区分；Phase 2 的"少量稳定错误分类"允许新增一个），message 附验证错误。
- `warn` 失败：节点成功，`detail` 记录验证警告。
- `skipped` 节点（output 无活跃来源被跳过）：不执行 verification（无输出可断言，`markSkipped` 路径不变）。

**warn 的编码约定与显示面（盲审修订：detail 是自由字符串，必须约定格式）：**

- `detail` 命名空间格式：`verification: <message>`（通过时为 `verification: ok`）。面板渲染器按前缀识别，不解析 prose。
- Run 面板节点详情增加警告渲染：选中节点时，若 `node.detail` 以 `verification:` 开头且非 ok，在 output 区顶部显示警告条（`yolo-` 前缀样式，i18n 三语 `run.verificationWarn`）。detail 区已按 `selectedNodeId` 键控，节点切换自然清态；多警告合并为一条（`detail` 是单字符串字段，spec 不新增快照字段）。
- background 不受 warn 影响（节点仍 succeeded）。

**testNode 的 warn 通道（盲审修订：testNode 无快照无 detail，三处一致性对 warn 不成立）：**

- `WorkflowNodeExecutionResult` 增加可选 `warnings?: readonly string[]`（契约扩展；full run 路径 coordinator 把它并入 `detail` 编码，testNode 路径 UI 直接渲染）。这样"同一 finalize 辅助"在三条路径都成立：full run 侧 warnings → detail；testNode 侧 warnings → 结果字段 → 面板测试输出区。
- full run 的 `detail` 仍是单字符串（`verification: <msg1>; <msg2>`），不新增快照字段。

**与 outputSchema 的关系：** outputSchema 先于 verification（outputSchema 失败 → 修复轮 → 仍失败则终止；verification 只作用于最终通过 outputSchema 的值）。两者职责不同：outputSchema 约束"提交的形状"，verification 断言"业务后置条件"（可在 outputSchema 之外断言值域、互斥关系等）。

### 4.3 Model Tier 路由

**别名集合：** `fast` / `balanced` / `deep`，仅这三个字符串；其余一律按具体 model id 处理（维持精确匹配语义）。

**tier 映射的存放与读取（二轮盲审修订 + Host API 调整许可）：**

- 模块新增 settings contribution（本期范围内，模块目前未注册任何设置）：
  - `tier.fast` / `tier.balanced` / `tier.deep` 三个**扁平**字段。字段类型用 **`model` 类型（picker，下拉模型快照）** 而非自由文本——Host settings 机制已支持该类型（moduleSettingsContributions.ts），避免手输 id 出错。localizations 三语；en 为 fallback 强制。
- 读取：优先走**现有 `host.config.getSnapshot()`**（settings contribution 与 config 共享同一后端，flat key 往返一致，零 Host API 变更）。若实现发现 config 读路径有阻塞（如激活时序问题），**允许增加一个最小 Host API 简单接口**（例如 `host.settings.getContributionValues(moduleId)` 返回扁平贡献值）——用户已确认 Host API 可以增加简单接口，本 spec 只约定"不引入 provider 选择/模型快照结构变更"，不禁止读取类小接口。
- 取值时机：**定义构建时**，随 `createWorkflowDefinition` 的参数传入（签名从 `(bundle, modelSnapshot)` 扩展为 `(bundle, modelSnapshot, tierMap)`）；模块接线层（index.tsx）组装参数。`WorkflowRunStartInput` 与 testNode 的路径同步携带该参数。
- **冷启动语义**：tier 别名存在但对应配置为空/缺失 → preflight 失败（`model-unavailable`），消息指明是 tier 未配置并给出 settings 入口路径。不使用 run 默认模型静默兜底（KodaX 规则 2）。

**定义构建时的解析顺序（workflow-definition.ts）：**

1. `modelId` 为空 → run 默认模型（现状不变）。
2. `modelId` 精确命中模型快照中某个模型 id → 直接用（精确匹配永远优先，向后兼容；某真实模型 id 恰好叫 `fast` 时按精确匹配）。
3. `modelId` 是 tier 别名 → 读 tier 配置得到具体 id；该 id 在模型快照中可用 → 解析为该 id。
4. tier 别名但配置缺失 / 配置的 id 不在快照中 → preflight 失败（`model-unavailable`）。
5. 其他未命中 → preflight 失败（现状）。

**冻结与哈希：** tier 解析发生在定义构建期；`modelByNodeId` 记录解析后的具体 id，`definitionHash` 不变（同哈希 ↔ 同组真实模型）。运行中途修改 tier 配置不影响已冻结的运行（executor/Coordinator 只读 `definition.modelByNodeId`）——该保证在测试要点中覆盖。

**UI：**

- 节点检查器模型字段（已存在）接受 tier 别名输入；解析后的具体 id 以只读提示展示（`run.modelTierResolved` 文案）。提示数据源是**最近一次冻结的 definition.modelByNodeId**（若有）；未运行过或 tier 配置变更后提示可能过期——显示时标注"上次运行解析"，不作为运行时事实（运行时以冻结定义为准）。
- preflight 失败经现有 notice 通道（index.tsx 的 start 失败通知），文案区分"默认模型未配置"（现有 `run.noModel`）与"tier 未解析"（新 `run.modelTierUnavailable`）——**区分机制不得靠 message 字符串嗅探**：`WorkflowRunStartResult` 的 reason 联合新增 `tier-unavailable` 成员（现有 `model-unavailable` 语义是"默认模型不可用"，两者分开），模块接线层按 reason 映射 i18n 文案。

### 4.4 数据与契约

- `WorkflowNode` 新增 `verification?`；run 快照不新增字段（verification 警告走节点 `detail`；修复轮无持久化痕迹，仅最终错误 message 注明）。
- `WorkflowNodeExecutionResult` 新增可选 `warnings?: readonly string[]`（testNode 的 warn 通道；full run 侧由 Coordinator 并入 `detail` 编码）。
- `WorkflowRunStartResult` 的 reason 联合新增 `tier-unavailable`（与 `model-unavailable` 区分，模块接线层按 reason 映射文案，不靠 message 嗅探）。
- 新错误码 `verification-failed`（`WorkflowRunError.code` 联合 + store validator 同步）。
- i18n 新增（en/zh/it 三语 + settings localizations）：`run.repairAttempted` / `run.repairing`（错误消息与 activity detail 用）、`run.verificationWarn` / `run.verificationFailed`、`run.modelTier.fast/balanced/deep`、`run.modelTierResolved`、`run.modelTierUnavailable`、inspector 相关文案。
- settings contribution 三个 `model` 类型字段的 localizations 三语，en fallback 强制。

## 5. 与 Phase 2 非目标的边界

- 修复轮 vs "自动重试"：Phase 2 禁止节点级 retry 状态机与退避。修复轮的机械不变量是"仅在 handler 记录了被拒提交时发起、恰好一次、error/aborted/no-submission 绝不触发"——代码审查可独立验证。若评审判定二者仍不可区分，降级方案：修复轮退化为"首轮错误消息直接进入最终 error"，不引入任何第二轮调用（该降级不损害其他两项能力）。
- verification 新增一个错误码（`verification-failed`）——Phase 2 原则是"少量稳定错误分类"，新增一码比复用 `invalid-output` 语义更诚实；不新增节点状态、不新增 background 状态。
- tier 路由不引入 provider 选择、不改 Host API 的模型快照结构；settings contribution 是模块自己的既有机制（本期补注册）。
- 不做跨运行 memoization、结果缓存（Phase 2 非目标维持）：tier 解析在定义构建时一次性完成。

## 6. 测试要点

```text
修复轮触发（精确谓词）：首轮正常结束 + 至少一次 schema 被拒 + 无任何提交被接受 → 修复轮发起，提交有效值 → 节点成功
先无效后有效（混合情形）：绝不发起修复轮，首轮已接受的值保留且不被覆盖
重复提交（已有有效值后再次提交）不计入 schema 被拒计数
修复轮再失败 → agent-failed，message 含首轮 Ajv 错误 + 被拒值预览 + 修复轮结果
no-submission 绝不发起修复轮（直接 agent-failed，agent 调用次数 == 1）
error / aborted 绝不发起修复轮（现有错误码不变）
修复轮期间 abort → cancelled（共享 signal）；修复轮期间 activity detail 显示 repairing
每 schema 节点最多 2 次 agent 调用（成本护栏断言）
testNode 同样享受修复轮（与 full run 行为一致）
verification hard 失败 → failed + verification-failed；warn 失败 → succeeded + detail（verification: 前缀）+ 面板警告条可见
verification 通过 → detail 记录 verification: ok
verification schema 不可编译 → 定义构建期拒绝
input/condition/merge 的 verification 字段被拒绝（非丢弃）
output 节点 verification 在 Coordinator 直算路径生效（与 executor 路径一致）
skipped 节点不执行 verification
testNode 的 warn 经 WorkflowNodeExecutionResult.warnings 返回并在测试输出区显示
tier 别名解析到配置的具体 id；精确 id 优先于 tier 别名（真实模型名为 fast 时）
tier 未配置或配置 id 不可用 → preflight 返回 tier-unavailable reason（不静默兜底默认模型，不靠 message 嗅探）
definitionHash 记录解析后的具体 id；运行中途改 tier 配置不影响冻结运行
DSH 导入导出往返保持 verification 字段
```

## 7. 验证矩阵

| 要求 | 覆盖 |
| --- | --- |
| 修复轮机械可判定（精确谓词）、恰好一次、非重试状态机 | 4.1 + 5 |
| 修复轮不解析文本 JSON、只走提交工具；被拒值携带进修复 prompt | 4.1 修复轮构造 + 测试 |
| 首轮失败原因与被拒值不丢失 | 4.1 结果判定 + 测试 |
| 修复轮可见性（repairing detail） | 4.1 可见性 + 测试 |
| verification 确定性可观察（warn 有显示面/hard 有专属错误码/testNode 有 warnings 通道） | 4.2 + 测试 |
| tier 不能接受则拒绝（tier-unavailable reason，非 message 嗅探） | 4.3 解析顺序 + 测试 |
| Host Core 不变；Host API 仅 §1 许可的最小读取接口 | 2.2 + 4.3 + 5 |
