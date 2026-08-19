# 工具审批防过期守卫（盲审修订版 v2）

日期：2026-08-19
状态：设计稿（v2，按盲审修订）
盲审结论：方向正确、现状分析基本可靠；v1 缺结果契约扩展路径、epoch 递增语义、校验顺序、超时状态表示。
参考来源：[Claudian](https://github.com/YishenTu/claudian)（交互思路：echo interactionId 防过期；不搬实现）

## 1. 背景与动机

会话内旧审批卡片残留时，点击"允许"仍会执行工具（尾随消息时还会在旧会话后台续跑）。目标：给审批流加**会话 run 代际标识**，使"旧代审批响应"被静默丢弃，且不改变现有 state-mismatch 的 recover() 语义。

## 2. 现状分析（YOLO，盲审校准后）

- 审批状态机：`src/core/agent/tool-gateway.ts` `resolveInitialResponse()`——`shouldAutoExecuteTool()` → `Running`，否则 `PendingApproval`（:859-951）；agent 循环靠 `hasPendingToolCalls()` 停轮。
- 响应入口 `src/core/agent/service.ts`：
  - `approveToolCall`（:1589）：patch `PendingApproval→Running` → `mcpManager.callTool` → patch 结果 → 尾随消息（`isTrailingResolvedToolMessage` :744）时 `run()` **在旧会话后台续跑**（:1771-1777）。
  - `rejectToolCall`（:2124-2146）：仅 patch `Rejected` 后返回布尔，**不续跑**（子代理路径 resume 除外）。
  - 找不到调用/状态非 PendingApproval → false → `'stale'`（`cli-runtime/actions.ts:19` `ChatRuntimeActionResult = 'handled' | 'stale'`）→ `runtime-action-handlers.ts:44` `onStale`；**reject 的 stale 不触发 recover**（仅 approve 路径 `handleRecoverPendingToolCall` 会重执行工具+重播种会话，`useChatDomainActions.ts:330`）。
- 无通用审批超时（仅 `delegate_subagent` 有 deadline，`pending-timeout-registry.ts`）。
- UI：内联工具卡片（`src/components/chat-view/ToolMessage.tsx:1124-1145` 审批页脚）。
- 子代理审批经 `subagentRuntimeRegistry` 路由（`approveSubagentToolCall`）。

**差距**：审批响应无"发起时 run 代际"维度；同会话旧卡片（上一轮 run 遗留）仍有效。

## 3. 参考设计（Claudian）

| 机制 | 参考实现 |
|---|---|
| echo interactionId 防过期：响应携带发起 id，端口校验匹配才受理 | `reference/claudian-main/src/features/chat/execution/ChatExecutionCoordinator.ts` `forwardInteraction :1211-1249`、`isInteractionCurrent :1251` |
| 生命周期租约 + generation 失效 | `reference/claudian-main/src/core/execution/ProviderExecutionLifecycleRegistry.ts` |

## 4. 目标设计（盲审修订）

### 4.1 代际标识：会话 run 序号（不是全局 epoch）

盲审指出：AgentService 是单例管所有会话，全局计数会让 B 会话作废 A 会话审批；且无"会话切换"钩子。

**v2 决策：`runEpoch` = 每次 `AgentService.run()` 启动时递增的会话级序号**（同一会话内每轮 agent 循环 +1，跨会话互不影响；重启后从 1 重新计数——旧消息带的是旧会话的 runEpoch，与新会话的计数**天然不匹配**，这正好是期望行为：跨会话审批视为过期）。

- 存储：`AgentRuntimeRunInput` 携带 `runEpoch`（`native-runtime.ts:249` 构造处传入），gateway 创建 `PendingApproval` 时记录（tool-gateway.ts:859）。
- 挂起消息结构：`PendingApproval` 状态附加 `runEpoch: number` + `toolMessageId: string`（tool-call.types 或 gateway 内部类型）。
- UI 卡片（`ToolMessage.tsx` 审批页脚）持有 `{ runEpoch, toolMessageId }`，响应时随 approve/reject 参数传回。
- 子代理：`runEpoch` 经 `SubagentParentContext` 传入子 runtime（`runner.ts:370` 构造 runInput 处），子代理审批（`approveSubagentToolCall`）用同一 runEpoch 比对。

### 4.2 响应校验（盲审修订顺序）

**顺序**（盲审点 2：找不到时无 epoch 可比）：

```ts
1. find 目标 tool message → 不存在 → state-mismatch（现状）
2. 状态非 PendingApproval → state-mismatch（现状，含 recover 语义，逐字不变）
3. PendingApproval 且 runEpoch 匹配 → valid（执行/拒绝，现状）
4. PendingApproval 但 runEpoch 不匹配 → epoch-mismatch（新增）
```

### 4.3 epoch-mismatch 行为（新增静默丢弃路径）

- 不执行工具、不续跑、不 recover。
- **结果契约扩展**：`ChatRuntimeActionResult` 增加 `'stale-epoch'`（`cli-runtime/actions.ts:19`），穿透 service → `runtime-action-handlers.ts`（`onStaleEpoch`，不调 recover）→ `yolo-actions.ts` → bridge 的 `toActionResult`（现有 `'stale'` 映射处并排）。
- UI：卡片标记为"已过期"（`yolo-approval-stale` 样式 + 按钮禁用 + 提示），无模态、无重载。

### 4.4 审批超时（盲审修订：独立状态，不走 state-mismatch）

- `PendingApproval` 挂起超 `APPROVAL_TIMEOUT_MS`（默认 10 分钟，注册/清理复用 `pending-timeout-registry.ts` 模式）→ 标记为**超时**。
- **状态表示**：`PendingApproval` 增加字段 `expiredAt?: number`（或新增 `Expired` 子状态，实现时选一，禁止复用 state-mismatch 路径——那是 recover 语义）。
- 超时后响应：同 epoch-mismatch 的静默丢弃 + 卡片"已超时"态（不执行、不 recover）。

### 4.5 重启语义（盲审点 5）

- runEpoch 不持久化（内存态）；重启后当前 runEpoch 从 1 开始。
- 持久化的 PendingApproval 消息（重启前挂起）带旧 runEpoch → 与新 run 的 1 不匹配 → 视为 epoch-mismatch（过期）——**行为变化可接受**：重启后旧审批卡片应失效，而不是在不知道的新会话里执行工具。此语义在 spec 中显式声明并测试锁定。

## 5. 边界与非目标

- **不改动现有 state-mismatch → recover() 路径**（逐字不变，reject 的 stale 现状同样不变）。
- 不做 plan mode / canUseTool 双向端口（YOLO 进程内 agent，无 CLI 侧）。
- 不持久化 runEpoch；不做"重启后恢复有效审批"。
- 不改审批 UI 布局，只加过期/超时视觉态。

## 6. 测试计划（盲审补齐后）

- `service.test.ts`：同会话同 runEpoch 正常批准/拒绝回归；新 run 后旧卡片 approve → 不执行工具、不续跑、返回 stale-epoch；reject 同理；重启计数（新 runEpoch=1 vs 旧消息 epoch）→ epoch-mismatch。
- `tool-gateway.test.ts`：PendingApproval 记录 runEpoch；状态迁移校验。
- 结果契约：`runtime-action-handlers` / `yolo-actions` 的 stale-epoch 映射（不调 recover，UI 过期态）。
- UI：`ToolMessage.test.tsx` 过期态（按钮禁用 + 提示）+ 超时态。
- 子代理：`approveSubagentToolCall` epoch 不匹配 → 静默丢弃（且子 runtime 最终由 deadline 中止，不永久挂起——断言不新增挂起）。
- 超时：注册/清理/超时标记，不触发 recover。

## 7. 验证方式

- 单测全绿；type:check / lint。
- 人工 QA：审批挂起 → 新 run（同一会话继续对话）→ 点旧卡片允许 → 卡片过期、无工具执行、无重载；重启 Obsidian → 旧审批卡片过期；10 分钟挂起 → 超时态。

## 8. 实施顺序（TDD）

1. RED：`runEpoch` 传递（runInput → gateway PendingApproval）测试 → GREEN
2. RED：epoch-mismatch 校验 + 不执行/不续跑测试 → GREEN
3. RED：结果契约 `stale-epoch` 四层穿透测试 → GREEN
4. RED：子代理 epoch 路径测试 → GREEN
5. RED：超时独立状态测试 → GREEN
6. RED：UI 过期/超时态测试 → GREEN
7. 人工 QA
