# Plan 反馈修订循环（借鉴 Claudian ExitPlanMode 交互）

日期：2026-08-19
状态：设计稿
参考来源：[Claudian](https://github.com/YishenTu/claudian) `reference/claudian-main/`

## 1. 背景与动机

用户审核 plan（Claude Code CLI 的 ExitPlanMode）时，只有 Approve / Stay in plan 两个动作——**计划不满意没有反馈通道**：拒绝后只能重新发起，让 agent 从头规划（丢上下文）或手动打字说明。Claudian 的 plan 交互有行内 Feedback 输入：反馈送还 agent（`deny, interrupt:false`），**不中断、继续规划**。目标：给 YOLO 的 plan 审核补上"反馈 → 修订"闭环。

## 2. 现状分析（YOLO）

- plan 由 Claude Code CLI 生成：`CliChatMode = 'agent' | 'plan'`（`src/core/cli-runtime/permission-profile.ts:1`），plan 内容在 ExitPlanMode 工具调用的 arguments（`src/core/cli-runtime/claude/exitPlanMode.ts` `CLAUDE_EXIT_PLAN_MODE_TOOL`）。
- 审核 UI：`src/components/chat-view/ToolMessage.tsx`——`isExitPlanMode`（:1070）、按钮 `approvePlan`/`stayInPlan`（:1092-1097）、footer（:1402-1444）；**plan 内容以 JSON 代码块展示**（:1314-1318 generic 卡片），非 markdown。
- 批准链：`handleToolCall` → `runtime-action-handlers.ts:14` → `approveTool` → `chat-runtime-contract-actions-bridge.ts:42` `respondApproval({decision:'approve_once'})`。
- **拒绝链无文本字段**：`handleReject`（ToolMessage.tsx:1605）→ `rejectTool` → bridge:53 `respondApproval({decision:'reject'})`。`ToolCallResponseStatus.Rejected.reason` 仅用于展示（:1369-1375），不可回传 agent。
- Shift+Tab 已有：`useCliRuntimeOrchestration.ts:902-929` `handleClaudePlanShortcut`。

## 3. 参考设计（Claudian）

| 机制 | 参考实现 |
|---|---|
| 计划内联渲染（markdown）+ 权限列表 + 编号动作 | `reference/claudian-main/src/features/chat/execution/InlineExitPlanMode.ts`、`Tab.ts:792` |
| 四动作：Approve (new session) / Approve (current) / **Feedback（行内输入继续规划）** / Abandon | `ClaudeInteractionHandler.ts:104`（`requestPlanDecision`：feedback → `deny, interrupt:false`） |
| 键盘导航：↑/↓ 选择、Enter 确认、Esc 取消；Feedback 行先聚焦输入框再 Enter 提交 | `InlineExitPlanMode.ts` |
| "Approve (new session)"：把计划提取为 `"Implement this plan:\n\n{plan}"` 开新会话 | `InputController.ts:683-691` |

## 4. 目标设计

### 4.1 reject 带文本通道（核心改动）

- **契约扩展**：`ChatRuntimeActions.rejectTool` 增加可选 `reason?: string`（`src/core/cli-runtime/actions.ts`）；bridge 的 `respondApproval` 增加 reject 带 reason 的映射（`chat-runtime-contract-actions-bridge.ts:53`）。
- SDK 侧：`ClaudeCliRuntime` 的拒绝路径把 reason 转为 feedback 语义——对齐 Claudian：`{ type: 'feedback', text }` → `deny` 且 **interrupt: false**（agent 继续规划）。需确认当前 SDK 版本 respondApproval 对 reject + feedback 的支持形态（实现时验证，若 SDK 不支持则退化为"拒绝 + 文本作为后续用户消息注入"）。
- **普通工具拒绝**（非 plan）保持现状（无 reason），不扩大范围。

### 4.2 plan 内容 markdown 渲染

- `tool-renderers/index.ts` 增加 ExitPlanMode 条目：arguments 里的 plan 文本以 **markdown 渲染**（复用现有 markdown 渲染器，对齐 assistant 消息）展示，替代 JSON 代码块。
- 保留原始 JSON 的可折叠视图（debug 用）。

### 4.3 审核 UI：反馈输入

- ToolMessage 的 plan footer 增加第三个动作 **Feedback**：点击展开行内输入框（"输入反馈以继续规划…"），Enter 提交（IME 守卫 `!e.isComposing`），Esc 取消。
- 提交后走 4.1 的 reject+reason 通道 → 工具卡片标记"反馈已发送"，agent 继续规划产生修订计划。
- 键盘：footer 三个动作 ↑/↓ 导航 + Enter 选择（实现成本低，若与现有卡片交互冲突则仅做按钮 + 输入框，键盘导航列为可选）。

## 5. 边界与非目标

- 不做 "Approve (new session)"（新会话重播种是 harness 专属行为，YOLO 单会话形态不适用）。
- 不做权限列表展示（SDK 返回的权限明细不可靠，跳过）。
- 普通工具 reject 不带文本（范围收敛到 plan）。
- 若 SDK 的 respondApproval 不支持 interrupt:false 的 feedback 形态，退化为"拒绝 + reason 注入为后续用户消息"（在实施时验证并锁定）。

## 6. 测试计划

- `chat-runtime-contract-actions-bridge.test.ts`：reject 带 reason 的映射断言。
- `ClaudeCliRuntime.test.ts`：plan 拒绝 + reason → respondApproval feedback 调用形态（mock SDK）。
- `runtime-action-handlers.test.ts`：rejectTool 透传 reason。
- UI：`ToolMessage.test.tsx`——Feedback 按钮展开/收起、Enter 提交触发 reject+reason、IME 守卫、Esc 取消。
- `tool-renderers` 测试：ExitPlanMode 渲染 markdown（新条目）。

## 7. 验证方式

- 单测全绿；type:check / lint。
- 人工 QA（claude-code 运行时）：plan 模式 → 计划出现 → 点 Feedback 输入"太长了，缩短" → agent 继续规划 → 修订计划出现；批准/拒绝回归。

## 8. 实施顺序（TDD）

1. RED：bridge reject+reason 映射测试 → GREEN
2. RED：CLI 侧 feedback 调用形态测试 → GREEN
3. RED：ToolMessage Feedback 输入交互测试 → GREEN
4. RED：ExitPlanMode markdown 渲染测试 → GREEN
5. 人工 QA
