# 工具审批防过期守卫（借鉴 Claudian ProviderInteractionPort）

日期：2026-08-19
状态：设计稿
参考来源：[Claudian](https://github.com/YishenTu/claudian)（`reference/claudian-main/`），具体见 §3

## 1. 背景与动机

YOLO 的工具审批（PendingApproval → 用户批准/拒绝 → 执行/续跑）没有**审批请求代际标识**：会话切换、工具调用被取消、或同一次会话内旧审批卡片残留时，用户点击"允许"仍会执行工具（只是不续跑），或触发 `recover()` 重载会话。Claudian 的双向交互端口用 interactionId echo + 生命周期租约 + generation 失效来丢弃过期响应。

目标：给审批流加"请求代际 + 响应校验"，把过期响应从"执行工具/重载会话"降级为"静默丢弃 + 提示"，且不破坏现有审批 UI。

## 2. 现状分析（YOLO）

- 审批状态机：`src/core/agent/tool-gateway.ts` —— `resolveInitialResponse()`：`shouldAutoExecuteTool()` → `Running`，否则 `PendingApproval`。agent 循环（`native-runtime.ts`）靠 `hasPendingToolCalls()` 停轮。
- 响应入口：`src/core/agent/service.ts` —— `approveToolCall()`（:1589）：patch `PendingApproval→Running` → `mcpManager.callTool` → patch 结果 → **仅当 tool message 是尾部**（`isTrailingResolvedToolMessage`）才 `run()` 续跑；`rejectToolCall()`（:2124）→ `Rejected` 后同样续跑。找不到调用/状态非 PendingApproval → 返回 false → `toActionResult` → `'stale'` → `handleRuntimeToolApproval` → `recover()`（重载会话）或 `showReloadNotice`。
- **无通用审批超时**：普通工具 PendingApproval 无限等待（仅 `delegate_subagent` 有 deadline，`pending-timeout-registry.ts`）。
- UI：内联工具卡片（`src/components/chat-view/ToolMessage.tsx` 审批页脚），无 modal。
- 测试：`tool-gateway.test.ts`、`service.test.ts` 覆盖 approve/reject 的 stale 返回、子代理路由等。

**差距**：
1. "stale" 的判定是"状态已非 PendingApproval"——**没有会话/代际维度**。会话切换后旧审批依然有效（执行工具但不续跑）。
2. 过期响应触发 `recover()` 重载会话——重，且对"用户点的其实是旧卡片"场景是误导。
3. 无审批超时（挂起的审批永远挂着）。

## 3. 参考设计（Claudian）

| 机制 | 参考实现 |
|---|---|
| 双向交互端口：CLI 内工具请求（approval/question/plan-decision）经 `canUseTool` 回调转发 UI，响应带回 `updatedPermissions` | `reference/claudian-main/src/core/rpc/ProviderInteractionPort.ts` |
| **echo interactionId 防过期**：响应携带 interactionId，端口校验匹配才受理 | `reference/claudian-main/src/core/execution/ClaudeInteractionHandler.ts:103`（`requestPlanDecision` 等） |
| 生命周期租约 + generation 失效：会话/运行代际标识，旧代响应直接丢弃（`ProviderExecutionLifecycleRegistry.ts`） | `reference/claudian-main/src/core/execution/ProviderExecutionLifecycleRegistry.ts` |
| 分级终止配套：`ProviderExecutionRun.cancel()` + 租约释放 | `reference/claudian-main/src/core/execution/ProviderExecutionSession.ts` |

## 4. 目标设计

### 4.1 审批请求代际标识（核心改动）

在工具消息的 `PendingApproval` 状态上附加 **`approvalEpoch`**（会话级单调递增 + toolMessageId）：

```ts
// types/tool-call.types.ts 或 tool-gateway 内部
type PendingApprovalState = {
  status: 'pending_approval'
  approvalEpoch: number   // AgentService/会话维护的单调计数
  toolMessageId: string
}
```

- `approvalEpoch` 在**每次会话启动/恢复/切换**时递增（`AgentService` 持有当前 epoch）。
- 审批挂起时把 `{ epoch, toolMessageId }` 一起存进 UI 卡片（`ToolMessage.tsx` 的审批页脚持有）。

### 4.2 响应校验（`approveToolCall` / `rejectToolCall`）

在现有"找不到/非 PendingApproval → stale"之前增加代际校验：

```ts
function isStaleApproval(ctx, target): 'valid' | 'epoch-mismatch' | 'state-mismatch'
```

- `epoch-mismatch`（会话已切换/重启）：**新增的静默丢弃路径**——不执行工具、不续跑、不 recover。返回 stale 标记，UI 侧把卡片标记为"已过期"（`yolo-approval-stale` 样式 + 提示）。
- `state-mismatch`（已批准/拒绝过/已取消）：**保持现有行为完全不变**（含 recover()），本次不触碰该路径——它的语义是"状态损坏后的会话恢复"，与"代际过期"不同场景。

### 4.3 审批超时（可选，随本次做）

- `PendingApproval` 挂起超过 `APPROVAL_TIMEOUT_MS`（默认 10 分钟，复用 subagent deadline 的 registry 模式）→ 标记过期（`state-mismatch` 路径），卡片显示"已超时"。不自动执行/拒绝，仅失效。
- 复用 `pending-timeout-registry.ts` 的注册/清理模式（不引入新依赖）。

### 4.4 UI（`ToolMessage.tsx`）

- 审批页脚持有 `approvalEpoch + toolMessageId`；点击时随 `approveToolCall/rejectToolCall` 参数带上。
- 响应返回"过期"时：卡片进入 `expired` 视觉态（不执行动作、不重载会话、按钮禁用）。
- 样式类 `yolo-approval-*`（`src/styles/`）。

## 5. 边界与非目标

- **不改动现有 stale → recover() 会话恢复路径**（state-mismatch 行为逐字不变）；只新增 `epoch-mismatch` 一条静默丢弃路径。
- 不做 plan mode / canUseTool 双向端口（那是 CLI harness 架构，YOLO 是进程内 agent，无 CLI 侧审批）。
- 子代理审批（subagentRuntimeRegistry 路由）沿用同一代际校验（epoch 贯穿）。
- 不改审批 UI 布局，只加过期视觉态。

## 6. 测试计划

- `service.test.ts`（扩展）：epoch 不匹配 → 不执行工具、不续跑、返回 stale 标记；同 epoch 正常路径回归。
- `tool-gateway.test.ts`（扩展）：挂起审批带 epoch；批准后状态迁移校验。
- 超时路径：`pending-timeout` 相关测试（复用现有 registry 测试模式）。
- UI：`ToolMessage.test.tsx` 过期态渲染（按钮禁用 + 提示）。
- 沿用 jest 并行 + `npm run type:check`。

## 7. 验证方式

- 单测全绿；type:check / lint。
- 人工 QA：开审批 → 新开会话 → 回旧会话点"允许" → 卡片过期、无工具执行、无会话重载；正常批准路径回归；10 分钟挂起 → 超时过期态。

## 8. 实施顺序（TDD）

1. RED：epoch 校验测试（approve/reject 两路）→ GREEN
2. RED：超时失效测试 → GREEN（registry 复用）
3. RED：UI 过期态测试 → GREEN
4. 人工 QA
