# 改写预览：给 Selection Rewrite 补 diff 预览与源快照守卫（盲审修订版）

日期：2026-08-19
状态：设计稿（v2，按盲审修订）
盲审结论：v1 方向错误——YOLO 已有 selection-rewrite 管线与 diff 引擎，v1 重复造轮子且挂错管线。v2 转向"复用 + 补齐"。
参考来源：[Claudian](https://github.com/YishenTu/claudian) `reference/claudian-main/`（仅借鉴交互形态，不搬实现）

## 1. 背景与动机

用户改写选中文本时，当前 `SelectionRewriteController` 提供 streaming→review 的接受/拒绝闭环（reject 恢复原文），但 **review 阶段没有 diff 可视化**——用户看不到模型改了什么就点接受。借鉴 Claudian Inline Edit 的 diff 预览交互，给 YOLO 已有改写管线补上预览，不新建第二条改写路径。

## 2. 现状分析（YOLO，盲审校准后）

- **改写管线已存在**：`src/features/editor/selection-rewrite/selectionRewriteController.ts`（2286 行）——`SelectionRewritePhase = 'resizing' | 'waiting' | 'streaming' | 'review'`（:31），accept 提交 / reject 用 `dispatch({changes:{insert: originalText}})` 恢复原文（:1776），带按钮与 keymap（:1003-1039）、streaming 占位 mark（:226, :954）。入口：QuickAskPanel `submitRewrite` → main.ts:770。
- **diff 引擎已存在**：`src/utils/chat/diff.ts`（873 行）——`createDiffBlocks`（Markdown 块级）、`createLineDiffBlocks`（行级，含 `InlineDiffToken` word 级 token、`mergeAdjacentUnchangedBlocks`、`createModifiedDiffBlock`），被 diff-review / apply-view 使用。
- **源快照**：`originalText`（:59）在启动时存入（:1535），但**无生成期间源变更检测**——生成中用户编辑文档后 accept 仍按旧坐标/旧内容提交。
- Write Assist（续写）是**另一条路径**：`writeAssistController.ts:85`，有选区时语义是"在选区后追加续写"（prompt 禁止重述改写），无 diff 需求——**v1 的错误在于把改写预览挂到这条续写管线**。

**差距**（v2 范围）：
1. review 阶段无 diff 预览（对比原文 vs 改写结果）。
2. 无源快照校验：生成期间源文档被改时 accept 会误覆盖。
3. selection-rewrite 2286 行**零测试**。

## 3. 参考设计（Claudian，仅交互形态）

| 交互 | 参考实现 |
|---|---|
| review 预览：原文本与改写结果的可视化对比（Claudian 为逐行 LCS + 块内新旧两段 markdown） | `reference/claudian-main/src/features/inline-edit/ui/InlineEditModal.ts` `showDiffInPlace :142-170` |
| 接受前源校验：`isSourceUnchanged()` 比对快照，源被改则拒绝应用 | 同文件 `:931-946` |

**不搬**：Claudian 的 CM6 StateField/Effect 状态机（YOLO selection-rewrite 已有等价状态机）、LCS diff（YOLO diff.ts 更强）。

## 4. 目标设计

### 4.1 review 阶段 diff 预览（主改动）

在 `SelectionRewriteController` 的 review 渲染处接入 `diff.ts`：

- 用 `createLineDiffBlocks(originalText, rewrittenText)`（或 `createDiffBlocks` 块级，按现有 diff-review 的用法选型）生成 diff。
- 渲染：复用现有 review 浮层，diff 块内显示删除段（原文，删除线样式）与插入段（改写结果，高亮），对齐 diff-review 已有的视觉语言（`src/features/editor/diff-review/` 的样式）。
- 样式类 `yolo-selection-rewrite-diff-*`（`src/styles/`，仅 opacity/transform 动画）。
- **accept/reject 行为不变**（仍是整个替换/恢复），diff 只是"看得见"，不改变提交语义。

### 4.2 源快照守卫

- 启动时已有 `originalText` 快照；**新增文档版本比对**：accept 时比较 `originalText` 与当前文档对应区间内容（用启动时的 from/to 位置，若区间长度/内容与快照不符 → 源被改）。
- 不匹配 → 拒绝应用 + notice（"源文档已修改，请重新改写"），reject 路径同守卫（恢复原文本身安全，但位置漂移时同样拒绝）。
- 不做字符级偏移映射（v1 的过度设计；位置校验足够）。

### 4.3 测试补齐（selection-rewrite 零测试现状）

- 状态机测试：resizing→waiting→streaming→review→commit/reject 全迁移。
- accept/reject 的 dispatch 内容断言（commit 用改写文本、reject 恢复 originalText）。
- diff 预览：`createLineDiffBlocks` 输入输出断言（纯函数，放 diff.ts 现有测试或新测试）。
- 源快照守卫：生成期间模拟源变更 → accept/reject 均拒绝。

## 5. 边界与非目标

- **不新建改写管线**；不碰 Write Assist 续写路径（ghost/Tab 接受保持现状）。
- 不做多轮追问（clarification）；不做 Claudian 的 block widget 覆盖式预览（沿用 YOLO 浮层形态）。
- 不引入新依赖（diff.ts 已有）。

## 6. 测试计划

- `selectionRewriteController.test.ts`（新增）：状态机迁移、accept/reject dispatch、快照守卫（源被改拒绝）。
- `diff.ts` 补齐测试（若缺失）：`createLineDiffBlocks` 行级 diff 正确性。
- 沿用 jest 并行 + `npm run type:check`。

## 7. 验证方式

- 单测全绿；type:check / lint。
- 人工 QA：选中段落改写 → review 浮层显示 diff（删除/插入可视化）→ accept/reject；生成期间编辑源文档 → accept 被拒并提示；改写+续写两路径回归。

## 8. 实施顺序（TDD）

1. RED：状态机 + accept/reject dispatch 测试（先锁现有行为）→ 确认全绿（基线）
2. RED：diff 预览渲染测试 → GREEN 接入 `createLineDiffBlocks`
3. RED：源快照守卫测试 → GREEN
4. 样式 + 人工 QA
