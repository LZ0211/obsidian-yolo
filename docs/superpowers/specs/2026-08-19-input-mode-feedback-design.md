# 聊天输入模式视觉反馈（借鉴 Claudian 输入模式）

日期：2026-08-19
状态：设计稿
参考来源：[Claudian] `reference/claudian-main/`

## 1. 背景与动机

Claudian 的输入框对每种输入模式都有**视觉状态反馈**：`#` 指令模式（蓝边框 + placeholder 切换）、`!` bang-bash（粉边框 + 等宽字体）、Shift+Tab plan 模式（青绿边框）。YOLO 的输入框是静态外观——用户切到 plan 模式、或想输入特殊前缀时没有任何视觉提示。目标：给输入框加模式反馈（# 指令模式 / ! 命令模式 + plan 模式边框反馈），让模式状态一眼可见。

## 2. 现状分析（YOLO）

- 输入框结构：`ChatUserInput.tsx` wrapper `div.yolo-chat-user-input-wrapper`（:767）、承载边框的 `div.yolo-chat-user-input-container`（:812）；编辑区 `div.yolo-chat-user-input-editor`（:843）；contentEditable 类名 `yolo-obsidian-textarea yolo-content-editable`（LexicalContentEditable :299）。
- 样式：容器边框/focus ring 在 `styles.css`（`border: var(--input-border-width) solid ...`、focus-within box-shadow）。
- placeholder：静态文本（ChatUserInput :852-885，"输入消息..." + 可点击 @ / 触发器），**无按模式切换**。
- 前缀机制：`/` 由 `SkillSlashPlugin.tsx`（`useBasicTypeaheadTriggerMatch('/')` :172）触发；`@` 由 `MentionPlugin.tsx` 触发。**无 `#` / `!` 前缀**。
- **Shift+Tab 已占用**：`useCliRuntimeOrchestration.ts:902-929` `handleClaudePlanShortcut` 已切 plan 模式（claude-code 运行时）——**模式切换已有，只是无视觉反馈**。
- ChatModeSelect（`chat-input/ChatModeSelect.tsx`）：下拉选 ask/agent/plan，`CLAUDE_CODE_CHAT_MODES = ['agent','plan']`（:68）。
- 测试：`ChatUserInput.cli.test.tsx`（placeholder/引用）、`SkillSlashPlugin.test.tsx`。

## 3. 参考设计（Claudian）

| 机制 | 参考实现 |
|---|---|
| `#` 指令模式：空输入按 `#` 触发，wrapper 蓝边框 + placeholder 变 "# Save in custom system prompt"，Escape 取消、清空自动退出 | `reference/claudian-main/src/features/chat/ui/InstructionModeManager.ts` |
| `!` bang-bash：空输入按 `!` 触发，粉边框 + 等宽字体，Enter 直接执行（绕过 provider） | `reference/claudian-main/src/features/chat/ui/BangBashModeManager.ts` |
| Shift+Tab plan：wrapper 青绿边框 + 工具栏权限指示更新 | `reference/claudian-main/src/views/ClaudianView.ts:1821` |
| 模式互斥：激活模式吞掉后续键、禁用其他下拉 | `reference/claudian-main/src/views/Tab.ts`（keydown 优先级链） |

## 4. 目标设计

### 4.1 模式状态与视觉反馈（核心）

`ChatUserInput` 增加 `inputMode: 'normal' | 'instruction' | 'command'` 状态（+ 已有 plan 模式的视觉化）：

- wrapper/container 根据模式切换类名：`yolo-chat-user-input-mode-instruction` / `-command` / `-plan`。
- 样式（`src/styles/chat/` 新增）：三种模式的边框颜色（复用现有 border token，仅色值差异）：
  - instruction：`var(--color-blue)` 边框
  - command：`var(--color-pink)` 边框 + 编辑区 `font-family: var(--font-monospace)`
  - plan：青绿边框（claude-code 运行时生效）
- placeholder 按模式切换：instruction → "输入要保存为系统指令的内容…"；command → "输入要执行的命令…"（Escape 取消）。

### 4.2 `#` 指令模式（功能：保存自定义指令）

- 空输入时按 `#` 进入 instruction 模式；输入内容后 Enter：**不发送给 agent**，而是保存为会话自定义指令（复用现有自定义指令存储，探索时确认位置；若不存在则仅做模式反馈，保存指令列为可选）。
- 进入后插入的 `#` 不显示在内容里（模式标记，非输入字符）。
- Esc 或清空退出。

### 4.3 `!` 命令模式（功能：直接执行本地命令）

- 空输入时按 `!` 进入 command 模式；Enter 直接走 bash/terminal 执行通道（复用 `src/core/agent/bash` 或 terminal_command 的现有执行与审批），结果以工具结果形式进入对话。
- **审批不变**：走现有 bash 审批策略（dangerous gate 等），不是绕过审批。

### 4.4 plan 模式反馈（最小）

- 仅视觉：claude-code 运行时处于 plan 模式时 wrapper 加 `-plan` 类名（数据源：`useCliRuntimeOrchestration` 现有 chatMode/cliChatMode 状态），无行为改动。

### 4.5 模式互斥

- instruction/command 激活时禁用 `SkillSlashPlugin` 与 `MentionPlugin` 的触发（与模式状态联动，参照 Claudian 的 keydown 优先级）。

## 5. 边界与非目标

- bang-bash 的"绕过 provider 直跑 shell"是 Claudian 行为；YOLO 的 `!` 模式**不绕过审批**（走现有 bash 审批链）。
- 不做 instruction 保存的完整设置 UI（只做输入模式 + 保存到现有存储；设置页展示列为后续）。
- Shift+Tab 行为不变（已有），只加视觉。
- 移动端：边框/placeholder 纯视觉可用；`!` 命令在桌面才可用（复用 bash 平台门控）。

## 6. 测试计划

- `ChatUserInput` 测试：空输入按 `#` / `!` 进入对应模式（类名 + placeholder 断言）；Esc 退出；清空自动退出；模式激活时 slash/mention 不触发；Enter 提交路径。
- plan 模式：cli 运行时 plan 状态 → wrapper 类名断言（`ChatUserInput.cli.test.tsx` 扩展）。
- 样式：styles:build 回归（无测试，构建验证）。

## 7. 验证方式

- 单测全绿；type:check / lint；styles:build。
- 人工 QA：输入框 `#`/`!` 模式视觉 + 行为；plan 模式边框；slash/mention 互斥；桌面执行命令走审批。

## 8. 实施顺序（TDD）

1. RED：模式状态 + 类名/placeholder 测试 → GREEN
2. RED：`#` 指令模式（保存路径）测试 → GREEN
3. RED：`!` 命令模式（执行通道 + 审批）测试 → GREEN
4. RED：互斥与 plan 视觉测试 → GREEN
5. 样式 + 人工 QA
