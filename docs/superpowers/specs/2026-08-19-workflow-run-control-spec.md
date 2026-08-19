# Workflow 运行控制与工作流管理 Spec（Pause / Rename）

> 日期：2026-08-19
>
> 状态：设计草案，尚未实施
>
> 范围：`modules/workflow` 的运行暂停/恢复与工作流重命名
>
> 前置：`docs/superpowers/specs/2026-08-18-workflow-execution-phase2-spec.md`（已实施并合并）

## 1. 结论

在 Phase 2 的 `WorkflowRunCoordinator` 上增加两个能力：

1. **Pause**：用户可暂停一个正在运行的 Workflow——当前节点跑完后不再启动下游节点，run 保持持久化的 `running` 状态并携带 `paused` 标志；恢复复用现有 continue 路径。
2. **Rename**：重命名已保存的 Workflow——原子移动 `WORKFLOW.md` 与全部 `STEP.md` 引用，并迁移该 Workflow 的最新 run 记录，保证恢复能力不因改名丢失。

两者都不修改 Host Core、不扩 Host API、不新增持久化结构（run 快照只加一个布尔字段）、不引入第二个状态机。

## 2. 目标与非目标

### 2.1 目标

- Pause 门控"未来节点启动"：正在执行的 Agent 调用不中断（区别于 cancel），当前节点进入终态后 run 停在 `running + paused`。
- Pause 状态跨插件重载存活：`initialize()` 不把 paused 的 run 转为 `interrupted`；UI 重开后显示 Resume。
- Paused run 在 background 活动上可见（映射为 `waiting`，与 approval waiting 同一显示通道）。
- Rename 是一次原子操作：目标 slug 不存在才执行；`WORKFLOW.md` 内 frontmatter/托管块引用、目录内 `STEP.md` 相对路径全部保持一致性。
- Rename 后旧路径的 run 记录迁移到新路径键，`continueRun` / 恢复能力不受影响。
- 运行中的 Workflow 拒绝重命名（与 `already-running` 同一排他语义）。

### 2.2 明确不做

- Pause 不中止进行中的 Agent 调用；不提供节点级 pause 检查点（pause 只在节点边界生效）。
- 不新增 background 状态枚举——paused 复用 `waiting` 显示，run 快照内是 `status: 'running'` + `paused: true`。
- 不记录成本/usage：Host API `1.8.0` 的 `YoloModuleAgentEventV1` 只有 text/tool/completed/aborted/error，无 usage 字段。run 快照已有时戳（startedAt/finishedAt），墙钟时间与节点计数就是本期唯一的成本代理。若未来 Host API 扩展 usage 事件，再单独设计聚合，不预埋字段。
- 不做 workflow 版本历史、archive-on-replace、个人/项目双发现层、历史运行浏览器（Phase 2 非目标维持）。
- 不实现 KodaX 的 token 预算硬限制与保留。
- Rename 不做跨目录移动（slug 变化只影响 `managed/workflows/<slug>/` 目录本身），不提供从聊天工具发起的 rename。

## 3. 当前基线

- Coordinator 已具备：`start` / `cancel` / `continueRun` / `quiesce` / `initialize`；每 run 一个 `AbortController` 与串行控制 promise；单调转移检查；`activeRuns` 路径保留。
- run 快照：`status`（running/succeeded/failed/cancelled/interrupted）+ `cancelRequested` 布尔；每节点 `pending/running/succeeded/failed/skipped`。
- `initialize()` 把遗留 `running` 一律转 `interrupted`。
- background 映射：running→running、approval→waiting、failed→failed、interrupted→reminder、终态→remove。
- repository 已有 `create` / `trash` / `list` / `read`；无 rename。
- Run 面板已有 Run/Stop/Continue 按钮与状态徽章；Studio 编辑锁在 `running` 时生效。

## 4. 设计

### 4.1 Pause 语义

**状态形状（持久化）：**

```ts
type WorkflowRunSnapshot = Readonly<{
  // ...phase 2 字段
  paused?: boolean
}>
```

`paused` 只在 `status === 'running'` 时有意义。它是持久化状态，不是显示细节——因为插件重载后 `initialize()` 必须区分"用户主动暂停"与"异常遗留 running"。

**转移规则：**

1. `pause(workflowPath)`：仅当该路径有活动 run 且未 paused 时生效；持久化 `paused: true`（走现有转移函数，仍是唯一快照写入者）。
2. 节点边界检查：串行调度器在启动下一个节点前检查 `paused`；为 true 则不再启动，run 保持在 `running + paused`。
3. `cancel` 对 paused run 同样生效（cancel 优先于 pause/continue 的竞态裁决）。
4. `continueRun(workflowPath, confirmSideEffects)` 扩展为同时接受 `failed` / `interrupted` / `running + paused`。对 paused run：确认副作用后清 `paused` 标志并继续调度。对 failed/interrupted 的现有语义不变。
5. `initialize()`：`running + paused` 保持原样（不转 interrupted）；`running` 无 paused 照旧转 `interrupted`。
6. `quiesce()`：paused run 同样被中断并持久化为 `interrupted`（清 paused），与现有 quiesce 语义一致。

**UI（Run 面板）：**

- running 且未 paused → 显示 Pause 按钮；running + paused → 显示 Resume（复用 Continue 确认流程与 i18n 键）。
- 状态徽章：paused 显示 `run.status.paused` 文案（i18n 三语），节点列表保持当前进度。
- 编辑锁：paused 期间仍锁编辑（run 未终态）。
- background：paused → `waiting`（detail 标注 paused 文案），Resume 后回 `running`。

**边界与竞态：**

- pause 请求到达时若节点正在执行，只置标志；节点完成后的转移检查天然落在节点边界。
- pause 与 cancel 并发：cancel 胜利（单调转移检查已保证 terminal/cancel 优先）。
- 对不存在的 run 或非 running 状态调用 pause → no-op 返回 false，不产生快照变化。
- 不同 Workflow 的 pause 互不影响（各路径独立 run）。

### 4.2 Rename 语义

**repository 新增：**

```ts
renameWorkflow(
  path: string,
  nextSlug: string,
): Promise<
  | { ok: true; nextPath: string }
  | { ok: false; reason: 'not-found' | 'target-exists' | 'invalid-slug' | 'failed' }
>
```

执行顺序（失败任一步即整体失败，不产生半迁移状态）：

1. 校验 `path` 存在、`nextSlug` 合法（与 `create` 的 slug 规则一致）、目标路径不存在。
2. 读取原 `WORKFLOW.md` 与全部声明 `STEP.md`。
3. 在 `managed/workflows/<nextSlug>/` 下写入 WORKFLOW.md（frontmatter/托管块中的步骤路径引用同步改为新目录前缀）与全部 STEP.md。
4. 迁移 run 记录：读 `runs/<sha256(oldPath)>.json`，存在则改写其 `workflowPath`（以及 definition 快照中的 `workflowPath`）后写入 `runs/<sha256(newPath)>.json`，删除旧键。run 中的相对 step 路径不在快照内（快照只有 stepContents 映射），无需改写。
5. 删除原目录。
6. 返回 `nextPath`，调用方（editor model）`load(nextPath)`。

**Coordinator 排他：** rename 前检查 `activeRuns.has(path)`，活动 run 拒绝重命名（返回 `already-running` 语义并入 UI 提示）。

**UI：** Studio 工具栏新增 Rename 入口（输入新 slug 的既有 pattern，i18n 三语）；`WorkflowEditorModel` 增加 `rename(nextSlug)`，成功后 `load` 新路径并刷新列表。

### 4.3 数据与契约

- run 快照 `schemaVersion` 保持 `1`；`paused` 是可选布尔，旧快照缺省 false，读取端无需迁移。
- store 的 validator 接受可选 `paused` 字段（仅 `running` 状态合法，其余状态出现 paused 按 malformed 处理，遵循"畸形记录报 storage-failed 不静默修复"的既有原则）。
- i18n 新增键：`run.pause` / `run.resume` / `run.status.paused` / `run.rename` / `run.renamePlaceholder` / `run.alreadyRunning` 复用现有 / `run.renameFailed`，en/zh/it 三语。

## 5. 与 Phase 2 非目标的边界

- Pause 不是 HITL、不是等待事件节点、不是定时器：它是用户主动发起的运行控制，实现为节点边界的一个标志检查。
- 不引入重试、attempt ledger 或新的持久状态枚举：`paused` 是快照字段，状态机仍是 Phase 2 的五状态。
- Rename 不引入历史浏览器：run 记录是每 Workflow 一份 latest，随路径迁移。
- 不扩 Host API：`pause`/`rename` 全部在模块内实现，依赖面与 Phase 2 相同（repository、store、Coordinator、UI）。

## 6. 测试要点

```text
pause 在当前节点终态后生效，下游节点保持 pending
pause 后 continue 清标志并继续调度剩余节点
paused run 在 initialize 后保持 running+paused 不转 interrupted
cancel 对 paused run 生效且优先于 continue
quiesce 将 paused run 转为 interrupted
paused 映射 background waiting，Resume 后回 running
对非 running run 调用 pause 是 no-op
rename 成功后 list/read 走新路径，旧路径不存在
rename 迁移 run 记录，continueRun 在新路径可用
rename 拒绝 target-exists 与运行中的 workflow
rename 失败不产生半迁移状态（任一步失败后旧目录完整）
```

## 7. 验证矩阵

| 要求 | 覆盖 |
| --- | --- |
| Pause 门控未来 launches、不中断当前调用 | 4.1 转移规则 1-2 + 测试 |
| Pause 跨重载存活 | 4.1 转移规则 5 + 测试 |
| 复用 continue 恢复 | 4.1 转移规则 4 + 测试 |
| background 单一状态源 | 4.1 UI/background + 测试 |
| Rename 原子性 | 4.2 执行顺序 + 失败测试 |
| run 记录随 rename 迁移 | 4.2 步骤 4 + 测试 |
| 不改 Host Core/Host API/新枚举/新状态机 | 2.2 + 5 |
