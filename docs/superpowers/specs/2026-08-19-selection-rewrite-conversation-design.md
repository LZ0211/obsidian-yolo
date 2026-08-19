# Selection Rewrite 多轮追问（借鉴 Claudian Inline Edit clarification）

日期：2026-08-19
状态：设计稿
参考来源：[Claudian](https://github.com/YishenTu/claudian) `reference/claudian-main/`

## 1. 背景与动机

改写选中文本（selection-rewrite）一次生成即终：结果不达预期（"再精简一点""别动代码块""漏了第二段"）只能**重新选中重新改写**，对话上下文全丢。Claudian 的 Inline Edit 支持多轮澄清：结果不满意 → 输入框变"Reply to continue..." → `continueConversation` 追加轮次。目标：给 selection-rewrite 加"review 阶段继续追问"。

## 2. 现状分析（YOLO）

- `src/features/editor/selection-rewrite/selectionRewriteController.ts`：`run()`（~1800 起）用 `executeSingleTurn`（`src/core/ai/single-turn.ts`）一次生成，`onStreamDelta` → `candidateText`（streaming）→ `commitCandidate`（真实替换选区 + `reviewDiff` 计算）→ `enterReview`。
- review 交互：`SelectionRewriteControlsMarker`（×/✓ 按钮）+ reviewDiff 行级 diff 预览（本轮新增）。
- accept：`runtime.view.dispatch({changes: {from, to, insert: finalText}})`；reject：`dispatch({changes:{insert: originalText}})` 恢复原文。
- `executeSingleTurn` 支持 `conversationMessages` 上下文吗？——`SingleTurnExecutionInput` 只有 `request`（messages 直接构造），无会话状态；多轮需自行维护 messages 数组。
- 输入：`StartSelectionRewriteOptions.instruction` 是初始指令字符串，无追问入口。

## 3. 参考设计（Claudian）

| 机制 | 参考实现 |
|---|---|
| 结果不满意 → 输入框 placeholder 变 "Reply to continue..."，`isConversing → continueConversation` 追加轮次，agent 回复 markdown 渲染在输入框上方 | `reference/claudian-main/src/features/inline-edit/ui/InlineEditModal.ts`（clarification 流程） |
| 多轮期间输入框保留 / 与 @ 能力 | 同文件 |
| 响应解析三态：edited / inserted / **clarification**（需要追问时） | `reference/claudian-main/src/core/prompt/inlineEdit.ts` `parseInlineEditResponse` |

## 4. 目标设计

### 4.1 多轮会话状态（selectionRewriteController）

- `SelectionRewriteRuntime` 增加：
  ```ts
  conversation: { role: 'user' | 'assistant'; content: string }[]  // 多轮消息历史
  continuing: boolean   // 是否处于追问输入态
  ```
- `run()` 改造：`executeSingleTurn` 的 `request.messages` 从 `conversation` 历史 + 当前轮 user 消息构建（首轮 = 初始 instruction；后续轮 = 追加的追问）。
- **提交语义不变**：只有用户 accept 才替换文档；追问轮次的生成结果**不 commit**，只更新 reviewDiff 预览（`reviewDiff = buildReviewDiff(originalText, latestRewrite)` 重新计算——始终对比原文）。

### 4.2 追问输入 UI

- review 状态下，控制条增加"继续修改"入口（✎ 按钮，或 reuse reviewDiff 浮层内的输入行）：
  - 展开行内输入框（placeholder："继续输入修改要求…"），Enter 提交（IME 守卫），Esc 收起。
  - 提交 → `run()` 追加轮次（streaming 复用现有 candidate 流程）。
- 多轮期间按钮语义：✓ 接受（提交当前最新改写）、× 拒绝（恢复原文并结束）、✎ 继续追问。
- 追问次数上限（默认 3 轮，防无限循环）——达到上限后 ✎ 禁用。

### 4.3 prompt 与响应

- 首轮 prompt 保持现状（instruction）；追问轮 prompt：`"用户要求继续修改：{追问}\n\n原选中文本：{originalText}\n当前改写结果：{currentRewrite}"`，要求模型输出完整改写结果（不是增量 patch——保持与现有 commit 语义一致）。
- 不做 clarification 响应三态解析（Claudian 的 agent 主动请求追问）——本次只做**用户主动追问**（更简单且覆盖主场景）；agent 主动追问列为非目标。

## 5. 边界与非目标

- 不做 agent 主动 clarification（三态解析）。
- 不做追问输入框的 / 和 @ 集成（Lexical 集成成本高，纯文本输入框先行）。
- 不改 accept/reject 的文档语义。
- 追问历史不持久化（会话内内存态，与现有 rewrite 行为一致）。

## 6. 测试计划

- controller 单测（mock `executeSingleTurn` + view）：
  - 首轮消息构造含 instruction；追问轮消息 = 历史 + 追问。
  - 追问轮结果更新 reviewDiff（对比 originalText）；不 commit。
  - accept 提交最新改写；reject 恢复原文。
  - 追问次数上限：第 4 次追问被拒（✎ 禁用）。
- UI 测试：输入框展开/收起、Enter/IME/Esc。
- 沿用 jest 并行 + type:check。

## 7. 验证方式

- 单测全绿；type:check / lint。
- 人工 QA：改写 → 不满意 → "再精简一半" → 新结果 diff 预览 → 满意接受；3 轮上限；拒绝恢复原文。

## 8. 实施顺序（TDD）

1. RED：多轮消息构造测试 → GREEN（run 改造）
2. RED：追问轮不 commit、reviewDiff 更新测试 → GREEN
3. RED：追问输入 UI 测试 → GREEN
4. RED：次数上限测试 → GREEN
5. 人工 QA
