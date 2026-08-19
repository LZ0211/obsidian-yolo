# Workflow 运行控制与工作流管理 Spec（Pause / Rename）

> 日期：2026-08-19（2026-08-19 二轮盲审修订版）
>
> 状态：设计草案，已过两轮盲审（每轮 3 人）并修订，尚未实施
>
> 范围：`modules/workflow` 的运行暂停/恢复与工作流重命名
>
> 前置：`docs/superpowers/specs/2026-08-18-workflow-execution-phase2-spec.md`（已实施并合并）

## 1. 结论

在 Phase 2 的 `WorkflowRunCoordinator` 上增加两个能力：

1. **Pause**：用户可暂停一个正在运行的 Workflow——当前节点跑完后不再启动下游节点，run 保持持久化的 `running` 状态并携带 `paused` 标志；恢复复用现有 Continue 路径。
2. **Rename**：重命名已保存的 Workflow——用 Host 现有原语 `host.vault.renamePath` 原子移动文件，并迁移该 Workflow 的最新 run 记录，保证恢复能力不因改名丢失。

两者都不修改 Host Core、不引入第二个状态机、不新增持久化结构（run 快照只加一个布尔字段）。**Host API 调整许可**（用户确认）：允许增加/调整最小简单接口，凡模块内可完成的优先模块内完成，仅当模块内绕行明显更复杂时增加接口——见 §4 各接口决策点。

## 2. 目标与非目标

### 2.1 目标

- Pause 门控"未来节点启动"：正在执行的 Agent 调用不中断（区别于 cancel），当前节点进入终态后 run 停在 `running + paused`。
- Pause 状态跨插件重载存活：`initialize()` 不把 paused 的 run 转为 `interrupted`；UI 重开后显示 Resume 且可恢复。
- Paused run 在 background 活动上可见（映射为 `waiting`，与 approval waiting 同一显示通道）。
- Rename 使用 `host.vault.renamePath` 完成移动；任一步失败都有补偿，不产生半迁移状态。
- Rename 后旧路径的 run 记录迁移到新路径键，`continueRun` / 恢复能力不受影响。
- 运行中的 Workflow（含 paused）拒绝重命名。

### 2.2 明确不做

- Pause 不中止进行中的 Agent 调用；不提供节点级 pause 检查点（pause 只在节点边界生效）。
- 不新增 background 状态枚举——paused 复用 `waiting` 显示，run 快照内是 `status: 'running'` + `paused: true`。
- **usage 记录本期纳入（原排除项，随 API 许可恢复）**：`YoloModuleAgentEventV1` 目前无 usage 字段（只有 text/tool/completed/aborted/error），成本聚合此前被排除。用户已确认 Host API 可增加简单接口，故本期在 `completed` 事件上增加**可选** `usage?: Readonly<{ inputTokens?: number; outputTokens?: number; totalTokens?: number }>` 字段（provider 有数据则填，无则缺省；Host 侧聚合来自现有 LLM 调用的计费/计数通道，不做新采集）。run 快照增加可选 `usage` 聚合字段（每节点 usage 并入节点记录；汇总在 `succeeded`/`failed`/`cancelled` 终态时写入 run 级 `usage`）。旧快照缺省，读取端无需迁移；没有 usage 数据的 provider 运行时该字段为空对象。若 Host 侧实现发现 usage 无可靠来源，则本期**降级为墙钟时间 + 节点计数**（现有 startedAt/finishedAt 已足够），不阻塞其他能力。
- 不做 workflow 版本历史、archive-on-replace、个人/项目双发现层、历史运行浏览器（Phase 2 非目标维持）。
- 不实现 KodaX 的 token 预算硬限制与保留。
- Rename 不做跨目录移动（slug 变化只影响 `managed/workflows/<slug>/` 目录本身），不提供从聊天工具发起的 rename。

## 3. 当前基线

- Coordinator 已具备：`start` / `cancel` / `continueRun` / `quiesce` / `initialize`；每 run 一个 `AbortController` 与串行控制 promise（`enqueueRun`）；`activeRuns` Map 为闭包私有，`WorkflowRunCoordinator` 类型未暴露 has/isActive 方法（workflow-run-types.ts:195-205）。
- run 快照：`status`（running/succeeded/failed/cancelled/interrupted）+ `cancelRequested` 布尔；每节点 `pending/running/succeeded/failed/skipped`。
- `initialize()` 把遗留 `running` 一律转 `interrupted`，且只对**发生转换**的记录通知 listener（workflow-run-coordinator.ts:637-655）。
- background 映射（index.tsx:173-204）：running→running、approval→waiting、failed→failed、interrupted→reminder、succeeded/cancelled→remove。
- repository 已有 `create` / `trash` / `list` / `read`；无 rename。Host API 有 `vault.renamePath(oldPath, newPath): Promise<void>`（src/core/modules/types.ts:374）与 `paths.runExclusive`。
- Run 面板已有 Run/Stop/Continue 按钮与状态徽章；Studio 编辑锁在 `run.status === 'running'` 时生效（workflow-studio.tsx:163）。
- `RunSnapshotIndex`（index.tsx）按 `workflowPath` 键控，仅由 Coordinator publish 更新。
- 托管块的 `step:` 引用是**目录相对**路径（workflow-repository.ts:108 读取时补前缀）——整目录移动时内容**零改写**。

## 4. 设计

### 4.1 Pause 语义

**状态形状（持久化）：**

```ts
type WorkflowRunSnapshot = Readonly<{
  // ...phase 2 字段
  paused?: boolean
}>
```

`paused` 只在 `status === 'running'` 时有意义。它是持久化状态，不是显示细节。

**转移规则（含两轮盲审修订）：**

1. `pause(workflowPath)`：仅当该路径有活动 run 且未 paused 时生效；持久化 `paused: true`（走现有转移函数，仍是唯一快照写入者）。
2. **Parking 机制（盲审 Critical 修订）**：串行调度器在启动下一个节点前检查 `paused`；为 true 则 `processRun` **await 一个 run 级 paused gate**（未解析的 Promise），而不是返回。gate 有三个解析点：`continueRun`（清 paused、继续调度）、`cancel`（走取消转移）、`quiesce`（走中断转移）。`enqueueRun` 的完成清理只在 gate 解析后的终态路径触发——parked run 因此真实地保留在 `activeRuns`，`start` 的 `already-running` 拒绝自然覆盖它。gate 解析后由单调转移检查裁决竞态（见边界）。
3. `cancel` 对 paused run 生效（run 在 `activeRuns` 中，gate 被取消路径解析）；cancel 转移**清除 `paused`**（终态快照不携带 paused）。
4. `continueRun(workflowPath, confirmSideEffects)` 扩展：接受 `failed` / `interrupted` / `running + paused`。
   - `running + paused` **且 run 在 `activeRuns` 中**（in-memory pause）：解析 gate、清 paused、复用**现有** ActiveRun 的串行链继续调度——不得新建第二个 ActiveRun（现有 `activeRuns.has` 守卫改为对 paused 放行并复用）。**不需要副作用确认**：in-memory pause 边界保证没有节点被重执行，Phase 2 的 at-least-once 确认只属于 failed/interrupted 分支。
   - `running + paused` **且 run 不在 `activeRuns` 中**（recovered after reload）：走现有**记录级重建**路径（`continueRun` 从 store 构造新 ActiveRun，coordinator.ts:595-634）——**重建时必须清 `paused`**（否则边界检查立即再次挂起）。**需要副作用确认**（与 failed/interrupted 相同）：恢复记录的 resume 节点可能是 `running`（reload 时节点正在执行、pause 已持久化），重置该节点会重跑其副作用，Phase 2 §7.4 的 at-least-once 语义必须保留。区分依据是 `activeRuns` 成员身份，不是快照内容。
   - `failed` / `interrupted`：现有语义不变（含确认）。
5. `initialize()`：
   - `running + paused`（活动遗留）→ 保持原样（不转 interrupted），**且必须发布到 listener 与 background**（现实现只发布发生转换的记录，需扩展为"转换的记录 + 保留的 paused 记录"）。用户重开 UI 后能看到 paused 状态与 Resume。
   - `running` 无 paused → 照旧转 `interrupted`。
   - **recovered paused run 不在 `activeRuns` 中**（插件重载后无活跃调用），走**记录级控制路径**：
     - `start`：在**同步保留之后、首个异步操作之前**读 store 检查 `running + paused` 记录——存在则释放保留并返回 `already-running`（store 读是异步的，插入顺序为 reserve → read → release-on-found，与现有 preflight release 模式一致）。**注意：`start` 原本不读 store，这是新增读；reserve 必须先行以维持 Phase 2 的同步保留不变式，避免并发 start 都通过检查**。
     - `cancel`：读 store 找到 `running + paused` 记录 → check-then-write（重新读最新记录、确认仍为 running+paused 后写终态 `cancelled`、清 paused、发布）——**不得与 in-memory cancel 路径共享同一函数但共享发布语义**（两条路径都必须到达 listener 与 background 移除）。
6. `quiesce()`：paused run（含 parked gate）被中断并持久化为 `interrupted`（清 paused），与现有 quiesce 语义一致。
7. 所有终态转移（succeeded/failed/cancelled/interrupted）一律清除 `paused`——**通过一个共享的终态转移辅助函数**强制（coordinator 有六个 spread 终态点：failNode、enqueueRun catch、succeeded、cancel、quiesce、initialize 转换、storage-failed 错误路径），不允许各点独立写 spread；快照校验器拒绝任何非 running 状态携带 `paused`（畸形记录 → `storage-failed`，不静默修复）。校验器是后置安全网，不是清除机制——清除必须发生在转移函数内。

**UI（Run 面板）：**

- running 且未 paused → 显示 Pause + Stop 两按钮；running + paused → 显示 Resume + Stop 两按钮（**Stop 常驻**：paused run 可取消；Resume 无副作用确认只对 in-memory pause 成立——UI 无法区分两种 paused，确认流程统一走 continueRun 的入参，由 Coordinator 按 `activeRuns` 成员身份决定是否要求确认；面板在确认弹窗文案上不做区分）。
- 状态徽章：paused 显示 `run.status.paused` 文案（i18n 三语），节点列表保持当前进度。
- 编辑锁：paused 期间仍锁编辑（run 未终态，`status === 'running'` 的现有判断天然覆盖）。
- background：paused → `waiting`（detail 标注 paused 文案），Resume 后回 `running`。

**边界与竞态：**

- pause 请求到达时若节点正在执行，只置标志；节点完成后的边界检查天然落在节点终态持久化之后，不存在"paused 但快照还写着 running 节点"的中间态。
- **pause 与终态竞态（盲审 Critical）**：pause 在最后一个节点终态持久化**之后**到达时，`pause(workflowPath)` 返回 false（run 已非 running），不产生 `succeeded + paused` 畸形记录；pause 在终态转移**之前**到达时，转移函数按规则 7 清除 paused——两个方向都不产生畸形快照。规则 7 是这一竞态的裁决依据。
- pause 与 cancel 并发：cancel 胜利（单调转移检查保证 terminal/cancel 优先，且 cancel 清 paused）。
- 对不存在的 run 或非 running 状态调用 pause → no-op 返回 false。
- 不同 Workflow 的 pause 互不影响（各路径独立 run）。
- mapAgent 中途 pause：等待整个节点完成（单一 executor 调用），pause 在节点边界生效。

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

**前置拒绝（在调用方与 repository 两层落实）：**

- 目标 slug 不合法或目标路径已存在 → 拒绝。
- 当前 Workflow 有活动 run（含 paused）或 store 中有 `running`（含 paused）最新记录 → 拒绝（`already-running` 语义）。
- 编辑器 `dirty` 为 true → 拒绝（避免 `load(nextPath)` 静默丢弃未保存编辑）。
- 调用方是 `WorkflowEditorModel`：新增 `rename(nextSlug)`，成功后 `load(nextPath)` 并刷新列表。多视图场景：其他视图的 editor 通过现有 vault 事件自动 reload；rename 期间 repository 侧用 `runExclusive` 包住整个序列，且对仓库自身触发的事件设置 saving 式守卫（复用现有模式），避免 auto-reload 在迁移中途读半状态。

**执行顺序（`host.paths.runExclusive` 内；任一步失败即补偿回滚）：**

0. **rename-lease（盲审 TOCTOU 修订）**：进入 `runExclusive` 前，设置一个 Coordinator 可见的同步内存标志 `renaming: path`；`start` / `continueRun` 在同步保留阶段检查该标志，命中则拒绝（`rename-in-progress` 语义）。标志在 rename 结束（成功或补偿完成）时清除。这闭合了"start 不共享 runExclusive 锁"的窗口——rename 的校验与移动期间不可能有新 run 保留成功。store 写入绕过 vault 锁，因此该标志必须由 Coordinator 暴露给 start/continueRun 检查，不能只放在 repository 内。
1. 校验（见上），并读取旧路径 run 记录内容（`runs/<sha256(oldPath)>.json`，可能不存在）。
2. **创建目标目录并移动内容**：先 `host.vault.ensureFolder(newSlug)`（`renamePath` 要求目标父目录已存在，moduleVault.ts:905-913）；再对旧目录下文件逐文件调用 `host.vault.renamePath(oldFilePath, newFilePath)`（Obsidian 原语完成原子移动与 vault 内链接维护；`step:` 托管块引用是目录相对路径，内容零改写）。**移动顺序：`STEP.md` 文件先行，`WORKFLOW.md` 最后**（`repository.list()` 只把含 WORKFLOW.md 的目录视为 workflow——最后移动 WORKFLOW.md 使其他视图在整个序列期间要么看到旧路径完整、要么看到新路径完整，不读中间态）。若某文件移动失败，把已移动的文件移回原路径（补偿），并删除空的目标目录，整体返回 `failed`。
3. **迁移 run 记录**（若步骤 1 读到）：写 `runs/<sha256(newPath)>.json`，内容仅把 `workflowPath` 与 `definition.workflowPath` 更新为新路径；`definitionHash` **保持原值**（它是定义创建时标识，语义上属于"这次冻结的内容"，路径改写不改内容——在 spec 中明示该决定，不静默）。然后删除旧键。
4. **发布**：rename 完成后调用 Coordinator 新增的发布入口（publish 是闭包私有，需新增一个方法如 `notifyRenamedWorkflow(oldPath, newPath)`，内部走现有 publish 通道并触发 background 移除旧 `workflow:run:<oldPath>` 活动、按迁移后的记录以新路径重建索引项）。不得让 renamed workflow 显示"无 run"直到下次自然发布。

**失败语义：**

- 步骤 2 补偿失败（移不回去）→ 返回 `failed`，旧目录与新目录状态通过 `list()` 对用户可见，editor 保持旧路径（不做静默修复）。
- 步骤 3 写新键成功但删旧键失败 → 返回 `failed` 但新键已存在（无害重复，下次 initialize 以新路径为准）；记录 detail 通知用户。
- 步骤 4 失败不影响 rename 本身成功（发布层重试即可，activity 是易失状态）。

### 4.3 数据与契约

- run 快照 `schemaVersion` 保持 `1`；`paused` 是可选布尔，旧快照缺省 false，读取端无需迁移。
- store validator：接受可选 `paused` 字段，**仅 `running` 状态合法**；其余状态出现 paused 按 malformed 处理（storage-failed，不静默修复）。
- i18n 新增键（en/zh/it 三语）：`run.pause` / `run.resume` / `run.status.paused` / `run.rename` / `run.renamePlaceholder` / `run.renameFailed` / `run.cannotRenameWhileRunning` / `run.cannotRenameWhileDirty`。`alreadyRunning` 复用现有。
- `WorkflowRunCoordinator` 类型需新增暴露（盲审修正）：`isActive(path): boolean`（含 paused）与 rename 所需的记录级检查，或由调用方直接读 store——实现在模块接线层选择，spec 只约定语义不约束手段。

## 5. 与 Phase 2 非目标的边界

- Pause 不是 HITL、不是等待事件节点、不是定时器：它是用户主动发起的运行控制，实现为节点边界的一个标志检查。
- 不引入重试、attempt ledger 或新的持久状态枚举：`paused` 是快照字段，状态机仍是 Phase 2 的五状态。
- Rename 不引入历史浏览器：run 记录是每 Workflow 一份 latest，随路径迁移。
- Host API 只允许下列最小调整（用户许可）：agent `completed` 事件加可选 `usage` 字段（§2.2）；`vault.renamePath` 若实现发现逐文件移动 + 补偿比目录级操作更脆弱，可增加 `renameFolder(oldPath, newPath)` 目录级原子接口（Obsidian 底层 rename 本身可作用于文件夹）。除此之外 `pause`/`rename` 全部在模块内实现，优先用既有 `runExclusive`。

## 6. 测试要点

```text
pause 在当前节点终态后生效，下游节点保持 pending，run 保留在 activeRuns（gate 未解析期间 start 拒绝 already-running）
parked run 的 gate 由 resume/cancel/quiesce 三路解析，各路径都清 paused 并正确终态化
pause 后 continue（in-memory）清标志并在同一 ActiveRun 继续调度剩余节点，无副作用确认
pause 后 cancel 生效且快照不携带 paused（cancelled 无 paused）
recovered paused run（不在 activeRuns）：continueRun 走记录级重建、清 paused、要求副作用确认（resume 节点为 running 时）
paused run 在 initialize 后保持 running+paused、不转 interrupted、且发布到 listener 与 background
recovered paused run：start 拒绝（等同 already-running）；cancel 经记录级 check-then-write 写终态并发布
record-level cancel 与 continueRun 并发：stale continueRun 读不得复活已取消的 run（check-then-write）
quiesce 将 paused run 转为 interrupted（清 paused）
pause 在终态后到达返回 false，不产生 succeeded+paused 畸形记录
对非 running run 调用 pause 是 no-op
mapAgent 中途 pause 在节点边界生效
rename 成功：ensureFolder 创建新目录，STEP 先移 WORKFLOW.md 后移，list/read 走新路径、旧路径不存在；托管块引用零改写
rename 迁移 run 记录（workflowPath 更新、definitionHash 不变），continueRun 在新路径可用
rename 后 RunSnapshotIndex 与 background 立即以新路径键控（notifyRenamedWorkflow 发布）
rename 拒绝 target-exists、运行中（含 paused）、dirty、rename-lease 命中（start/continueRun 在 rename 期间被拒）
rename 步骤 2 部分失败时补偿回滚并删除空目标目录，旧目录完整
rename 期间自身 vault 事件不触发 editor 中途 reload（saving 式守卫）
usage：completed 事件带 usage → 节点记录并入；终态汇总 run 级 usage；无 usage 数据的 provider 为空对象
```

## 7. 验证矩阵

| 要求 | 覆盖 |
| --- | --- |
| Pause 门控未来 launches、不中断当前调用 | 4.1 规则 1-2 + 测试 |
| Pause 跨重载存活且可见 | 4.1 规则 5 + 测试 |
| paused run 保留 activeRuns，continue 复用同一链 | 4.1 规则 1/4 + 测试 |
| recovered paused run 的 resume 语义（重建、清 paused、确认） | 4.1 规则 4-5 + 测试 |
| 终态永不携带 paused | 4.1 规则 7 + 测试 |
| background 单一状态源 | 4.1 UI/background + 测试 |
| Rename 原子性（含补偿）与 rename-lease 防竞态 | 4.2 步骤 0-2 + 测试 |
| run 记录随 rename 迁移且 index/activity 键控一致 | 4.2 步骤 3-4 + 测试 |
| usage 聚合（可选字段、空对象降级） | 2.2 + 测试 |
| Host Core 不变；Host API 仅 §5 许可的最小调整 | 5 |
