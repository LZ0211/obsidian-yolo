# Write Assist 行内 Diff 编辑（借鉴 Claudian InlineEditModal）

日期：2026-08-19
状态：设计稿
参考来源：[Claudian](https://github.com/YishenTu/claudian)（`reference/claudian-main/`），具体见 §3

## 1. 背景与动机

YOLO 的 Write Assist（续写）当前体验：选区或光标前文本 → `executeSingleTurn` 流式生成 → CM6 ghost 文本预览 → **Tab 接受（直接插入）**、Shift-Tab/Escape 拒绝。没有改写与原文的 diff 可视化，接受动作是"追加"而非"替换"，用户无法在应用前核对模型改了什么——尤其当选区内容被改写而非续写时，接受后想反悔只能依赖 Obsidian 原生 undo。

借鉴 Claudian 的 Inline Edit：选中文本 → agent 改写 → **word-level diff 预览**（删除线/高亮）→ 接受/拒绝。目标是给 YOLO Write Assist 增加"改写 + diff 预览 + 安全应用"的完整闭环。

## 2. 现状分析（YOLO）

- 入口：命令 `trigger-quick-ask-continue`（`src/main.ts:2904`）→ `QuickAskPanel` → `WriteAssistController.handleContinueWriting`（`src/features/editor/write-assist/writeAssistController.ts:85`）。
- 文本来源：有选区 → `editor.getSelection()`；无选区 → 光标前全文（`maxContinuationChars` 默认 8000 截断）。
- 生成：`executeSingleTurn`（`src/core/ai/single-turn.ts`）流式，ghost 渲染在 `src/features/editor/inline-suggestion/inlineSuggestionController.ts`（`setInlineSuggestionGhost`）。
- 应用：`tryAcceptContinuationFromView`（inlineSuggestionController.ts:226）→ `escapeMarkdownSpecialChars` + `editor.replaceRange(text, startPos, startPos)` **插入**（选区末尾/光标处），非替换。
- 拒绝：Shift-Tab/Escape/Backspace 仅清除 ghost。无撤销包装。
- 编辑器双接口：Obsidian `Editor` + CM6 `EditorView`（`editor.cm instanceof EditorView`）。
- 测试：无 write-assist 专属测试；共享接受/拒绝机制覆盖在 `tabCompletionController.test.ts`。

**差距**：无 diff 计算、无覆盖式预览（widget 是"追加的 ghost"，不是"替换原文的预览"）、无显式 accept/reject 状态机、无源快照校验（源文档在生成期间被用户改动时直接覆盖风险）。

## 3. 参考设计（Claudian）

| 机制 | 参考实现 |
|---|---|
| CM6 状态机：`StateField<DecorationSet>` + 4 个 `StateEffect`（showInlineEdit / showDiff / showInsertion / hideInlineEdit）驱动全部 UI 状态 | `reference/claudian-main/src/features/inline-edit/ui/InlineEditModal.ts:40-59` |
| 无破坏式预览：输入框为 block widget；diff 预览 = block widget + `Decoration.replace` **覆盖**原选区，原文本不真改直到 Accept | 同文件 `:135-143` |
| diff 算法：逐行（保留行尾）LCS DP O(n·m) 回溯出 insert/delete/equal，`mergeAdjacentDiffOps` 合并相邻同类操作 | 同文件 `computeMarkdownDiff :170-201` |
| 源快照校验：`isSourceUnchanged()` 对源文档快照比对，源被改则 reject 应用 | 同文件 `:931-946` |
| 服务层：独立只读会话 + 多轮追问（clarification → continueConversation），prompt 与响应解析三态（edited / inserted / clarification） | `src/core/auxiliary/InlineEditService.ts`、`src/core/prompt/inlineEdit.ts` |
| Chat 侧行级 diff 渲染（hunk 切分 + 统计） | `src/features/chat/rendering/DiffRenderer.ts` |

## 4. 目标设计

### 4.1 状态机（新增 `src/features/editor/write-assist/inlineEditState.ts`）

CM6 `StateField<InlineEditState>`，值域：

```ts
type InlineEditState =
  | { phase: 'idle' }
  | { phase: 'streaming' }          // 生成中，显示 ghost（沿用现有 suggestion ghost）
  | { phase: 'reviewing';           // 生成完成，diff 预览覆盖选区
      diff: MarkdownDiffOp[];       // LCS 结果
      sourceSnapshot: string;       // 源文档快照（防误覆盖）
      baseStart: EditorPosition;
      baseEnd: EditorPosition;
      applied: boolean }
  | { phase: 'applied'; appliedText: string; baseStart; baseEnd }
```

StateEffect：`beginReview` / `hideInlineEdit`（拒绝）/ `markApplied`。

### 4.2 diff 模块（`src/features/editor/write-assist/markdownDiff.ts`）

按 Claudian 算法移植：逐行 LCS DP（保留行尾），`mergeAdjacentDiffOps` 合并。输出 `{ kind: 'insert' | 'delete' | 'equal', text }[]`。纯函数，直接单测。

### 4.3 预览渲染（`inlineEditDecorations.ts`）

- `Decoration.replace` 用 diff 渲染的 widget 覆盖源选区（删除段 = 删除线样式 + 保留原文；插入段 = 高亮）。
- 一个 `accept` / `reject` 的交互 widget（或复用 keymap：Tab=接受，Shift-Tab/Escape=拒绝，与现有 ghost 交互一致）。
- 样式类 `yolo-inline-edit-*`（走 `src/styles/`，仅 opacity/transform 动画）。

### 4.4 应用逻辑（`WriteAssistController` 扩展）

- 生成完成后（`onStreamDelta` 结束）计算 diff：`diff = computeMarkdownDiff(originalSelection, generatedText)`。
- **有选区**：进入 `reviewing`（diff 预览）；接受时 `editor.replaceRange(appliedText, baseStart, baseEnd)` **替换**整个选区；拒绝时恢复原文（无操作，预览消失）。
- **无选区（续写）**：保持现有"插入 + Tab 接受"ghost 行为（insertion 模式，不做 diff），不破坏既有续写体验。
- 源快照校验：接受时比对 `editor.getValue()` 与快照，不一致 → 拒绝应用 + notice（"源文档已修改，请重新生成"）。
- 接受动作包装 undo：`editor.transaction` 保留 Obsidian 原生 undo（现状已依赖，保持）。

### 4.5 触发范围

本次只做 Write Assist 的编辑闭环。Quick Ask 的"改写选中文本"模式若已存在则复用同一管线；不新增命令/入口。

## 5. 边界与非目标

- 不做多轮追问（clarification 循环）——Claudian 有，YOLO 本次只做单轮编辑闭环。
- 不做 Chat 侧行级 diff 渲染（DiffRenderer）——现有 chat 工具结果渲染不动。
- 不引入新的第三方 diff 库（LCS 手写，可控且已证明）。
- 移动端：CM6 可用，行为一致，无平台分支。

## 6. 测试计划

- `markdownDiff.test.ts`：LCS diff 正确性（纯函数，覆盖插入/删除/相等/相邻合并/空输入/行尾保留）。
- `inlineEditState.test.ts`：状态机迁移（idle→streaming→reviewing→applied / idle→reviewing→idle 拒绝）。
- `writeAssistController.test.ts`（新增）：有选区 → diff 预览状态；接受 → `replaceRange` 替换整个选区；拒绝 → 无 DOM 变更；**源快照被改 → 拒绝应用**；无选区 → 保持 ghost 插入路径。
- 沿用 jest 并行验证 + `npm run type:check`。

## 7. 验证方式

- 单测全绿；`npm run type:check`；`npm run lint:check`（改动文件）。
- 人工 QA（Obsidian）：选中段落改写 → diff 预览 → 接受/拒绝/源被改三路径；续写（无选区）路径回归。

## 8. 实施顺序（TDD）

1. RED：`markdownDiff` 纯函数测试 → GREEN 实现
2. RED：状态机测试 → GREEN 实现
3. RED：Controller 集成测试（mock editor）→ GREEN 接线
4. 样式 + 人工 QA
