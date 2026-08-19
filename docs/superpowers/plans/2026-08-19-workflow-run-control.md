# Workflow Run Control Implementation Plan（Pause / Rename / Usage）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add user-controlled pause/resume and workflow rename to the existing `modules/workflow` execution domain, plus optional token-usage aggregation on run snapshots.

**Architecture:** The Coordinator stays the only owner of run state. Pause parks the serial chain at a node boundary via a run-level gate promise kept in `activeRuns`; recovered paused runs get a record-level control path (start rejects, cancel writes terminal, continue rebuilds with the flag cleared and requires the at-least-once confirmation). Rename moves files with `host.vault.renamePath` under `runExclusive`, guarded by a Coordinator-visible rename lease, then migrates the run record and republishes through a new Coordinator entry. Usage rides on a new optional `usage` field on the agent `completed` event.

**Tech Stack:** TypeScript, React 18, Jest/jsdom, existing versioned module Host API `1.8.0`, Web Crypto SHA-256, `host.vault.renamePath`, `host.paths.runExclusive`, `host.config`.

**Spec:** `docs/superpowers/specs/2026-08-19-workflow-run-control-spec.md`（两轮盲审修订版）— the plan argues from the spec; executors read both.

## Global Constraints

- 不修改 Host Core；Host API 只允许 §5 许可的最小调整：agent `completed` 事件加可选 `usage?: Readonly<{ inputTokens?: number; outputTokens?: number; totalTokens?: number }>`；`renamePath` 目录级接口仅在实现确认逐文件移动不可行时启用（优先逐文件 + 补偿）。
- run 快照 `schemaVersion` 保持 `1`；`paused` 是可选布尔，**仅 `status === 'running'` 合法**；`usage` 是可选聚合字段，无数据时为空对象；旧快照缺省，读取端不迁移。
- 状态机仍是 Phase 2 的五状态（running/succeeded/failed/cancelled/interrupted）+ 节点五状态；`paused` 是快照字段，不是新枚举。
- 所有终态转移一律清除 `paused`，通过共享终态转移辅助函数强制；store validator 拒绝非 running 携带 paused（`storage-failed`，不静默修复）。
- 不引入重试、attempt ledger、历史浏览器、token 预算硬限制、新 background 状态枚举（paused 复用 `waiting`）。
- 测试命令（worktree 根）：`npx jest modules/workflow/src/execution/workflow-run-coordinator.test.ts <file>`（模块测试可用 `npm --prefix modules/workflow test` 或 `npx jest --config ../../jest.config.js`，裸 `npx jest` 从模块目录会 mis-resolve config）；typecheck `npm --prefix modules/workflow run typecheck`；boundary `npm --prefix modules/workflow run test:boundary`。
- 模块版本保持 `0.1.1-dev.1`；源码变更后产物经 `npm run module:build` 再生成并单独提交。
- 提交按任务分批，消息格式 `feat(workflow): ...` / `fix(workflow): ...` / `build(workflow): ...`。

---

### Task 1: Snapshot Contract Extension（paused + usage）

**Files:**
- Modify: `modules/workflow/src/execution/workflow-run-types.ts`
- Modify: `modules/workflow/src/execution/workflow-run-store.ts`
- Test: `modules/workflow/src/execution/workflow-run-store.test.ts`

**Interfaces:**
- Consumes: existing `WorkflowRunSnapshot`（workflow-run-types.ts:64-77）、`WorkflowNodeRun`（:54-62）、`isWorkflowRunSnapshot`（workflow-run-store.ts:113-170）。
- Produces: `WorkflowRunSnapshot.paused?: boolean`；`WorkflowRunSnapshot.usage?: Readonly<{ inputTokens?: number; outputTokens?: number; totalTokens?: number }>`；`WorkflowNodeRun.usage?: Readonly<{ inputTokens?: number; outputTokens?: number; totalTokens?: number }>`。store validator 接受两者并按规则拒绝非法组合。

- [ ] **Step 1: Write the failing validator tests**

Add to `workflow-run-store.test.ts`:

```ts
it('accepts a running snapshot with paused: true', async () => {
  const storage = createStorage()
  const store = createWorkflowRunStore(storage)
  const run = runningSnapshot('a/WORKFLOW.md', { paused: true })
  await store.write(run)
  expect((await store.read('a/WORKFLOW.md'))?.paused).toBe(true)
})

it('rejects paused on a terminal snapshot as malformed', async () => {
  const storage = createStorage()
  const store = createWorkflowRunStore(storage)
  const run = { ...succeededSnapshot('a/WORKFLOW.md'), paused: true }
  await expect(store.write(run)).rejects.toThrow(WorkflowRunStoreError)
})

it('rejects paused: true on a running snapshot is fine but paused: false is dropped', async () => {
  const storage = createStorage()
  const store = createWorkflowRunStore(storage)
  const run = { ...runningSnapshot('a/WORKFLOW.md'), paused: false }
  await store.write(run)
  expect((await store.read('a/WORKFLOW.md'))?.paused).toBe(undefined)
})

it('round-trips usage aggregates on run and node records', async () => {
  const storage = createStorage()
  const store = createWorkflowRunStore(storage)
  const run = {
    ...succeededSnapshot('a/WORKFLOW.md'),
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    nodes: {
      ...succeededSnapshot('a/WORKFLOW.md').nodes,
      agent: {
        ...succeededSnapshot('a/WORKFLOW.md').nodes.agent,
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      },
    },
  }
  await store.write(run)
  const read = await store.read('a/WORKFLOW.md')
  expect(read?.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 })
  expect(read?.nodes.agent.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 })
})

it('rejects a usage object with non-numeric fields', async () => {
  const storage = createStorage()
  const store = createWorkflowRunStore(storage)
  const run = { ...runningSnapshot('a/WORKFLOW.md'), usage: { inputTokens: 'x' } }
  await expect(store.write(run)).rejects.toThrow(WorkflowRunStoreError)
})
```

Use the test file's existing snapshot factory helpers (`runningSnapshot`/`succeededSnapshot` may be named differently — check the file and reuse or extend them to accept extra fields).

- [ ] **Step 2: Run to verify red**

Run: `npx jest modules/workflow/src/execution/workflow-run-store.test.ts`
Expected: FAIL — validator currently rejects or drops `paused`/`usage` (unknown fields dropped by `isWorkflowRunSnapshot`'s structural checks or `usage` fails `isJsonValue` on node run).

- [ ] **Step 3: Extend the types**

In `workflow-run-types.ts`:

```ts
export type WorkflowTokenUsage = Readonly<{
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}>
```

Add `usage?: WorkflowTokenUsage` to `WorkflowNodeRun` and `WorkflowRunSnapshot`; add `paused?: boolean` to `WorkflowRunSnapshot`.

- [ ] **Step 4: Extend the validator**

In `workflow-run-store.ts`:

```ts
function isTokenUsage(value: unknown): value is WorkflowTokenUsage {
  if (!isRecord(value)) return false
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'number') return false
  }
  return true
}
```

- In `isNodeRun`: accept `value.usage === undefined || isTokenUsage(value.usage)`.
- In `isWorkflowRunSnapshot`: accept `value.usage === undefined || isTokenUsage(value.usage)`；accept `value.paused === undefined || typeof value.paused === 'boolean'`；**after the status check**, reject `value.paused === true && value.status !== 'running'`（return false）。
- Import `WorkflowTokenUsage` type from `workflow-run-types`.

- [ ] **Step 5: Run to verify green**

Run: `npx jest modules/workflow/src/execution/workflow-run-store.test.ts`
Expected: PASS, all 5 new tests plus existing suite.

- [ ] **Step 6: Commit**

```bash
git add modules/workflow/src/execution/workflow-run-types.ts modules/workflow/src/execution/workflow-run-store.ts modules/workflow/src/execution/workflow-run-store.test.ts
git commit -m "feat(workflow): add paused and usage fields to run snapshots"
```

---

### Task 2: Coordinator Pause and Parking Gate

**Files:**
- Modify: `modules/workflow/src/execution/workflow-run-coordinator.ts`
- Modify: `modules/workflow/src/execution/workflow-run-types.ts`（Coordinator 接口加 `pause`）
- Test: `modules/workflow/src/execution/workflow-run-coordinator.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `WorkflowRunSnapshot.paused`；现有 `ActiveRun`（coordinator:74-87）、`enqueueRun`（:434-459）、`processRun`（:408-432）、`transition`、`persistOrFail`/`enqueuePersist`。
- Produces: `WorkflowRunCoordinator.pause(workflowPath: string): Promise<boolean>`（false = no-op 或已 paused）；run 级 paused gate：`ActiveRun.pauseGate: Promise<void>` + `resumePause(): void`；共享终态辅助 `clearPaused(snapshot)` 由所有终态转移使用。

- [ ] **Step 1: Write the failing coordinator tests**

Add to `workflow-run-coordinator.test.ts` (follow the file's existing fake-executor/storage helpers — check how tests hold a run mid-execution via a deferred executor promise):

```ts
it('parks the serial chain at the next node boundary after pause', async () => {
  // 1. start a run with a held executor for the first node
  // 2. while node 1 is held, call pause(path) -> true
  // 3. release node 1; the run stays running+paused, node 2 stays pending
  // 4. assert the run record has paused: true and status running
})

it('resume continues the same ActiveRun chain without re-running succeeded nodes', async () => {
  // pause mid-run -> continueRun(path, { confirmSideEffects: true }) -> ok
  // assert remaining nodes execute and the run succeeds; succeeded nodes not re-run
})

it('pause-then-cancel wins and clears paused on the terminal record', async () => {
  // pause, then cancel; assert status cancelled and paused undefined
})

it('quiesce converts a parked run to interrupted and clears paused', async () => {
  // pause, then quiesce; assert interrupted and paused undefined
})

it('pause on a non-running run is a no-op returning false', async () => {
  // no active run -> pause returns false; no store write
})

it('a parked run still rejects a second start with already-running', async () => {
  // pause; start again -> { ok: false, reason: 'already-running' }
})

it('pause arriving after terminal does not produce succeeded+paused', async () => {
  // run to completion (no pause), then pause -> false; record has no paused
})
```

The held-executor pattern: the test file already holds executors with deferred promises and release helpers — reuse them. `pause` must be awaited after the run snapshot is materialized.

- [ ] **Step 2: Run to verify red**

Run: `npx jest modules/workflow/src/execution/workflow-run-coordinator.test.ts`
Expected: FAIL — `pause` is not on the coordinator type/impl.

- [ ] **Step 3: Add pause and the parking gate to the coordinator**

In `workflow-run-types.ts` add `pause(workflowPath: string): Promise<boolean>` to `WorkflowRunCoordinator`.

In `workflow-run-coordinator.ts`:

```ts
type ActiveRun = {
  // ...existing
  /** Resolves when a parked run may continue scheduling. */
  pauseGate: Promise<void>
  resumePause: () => void
}
```

- In `createWorkflowRunCoordinator`, add a shared terminal helper used by every terminal transition:

```ts
const terminal = (snapshot: WorkflowRunSnapshot, patch: Partial<WorkflowRunSnapshot>): WorkflowRunSnapshot =>
  freezeRun({ ...snapshot, paused: undefined, ...patch })
```

Replace the spread sites in `failNode`、`enqueueRun` catch、`processRun` succeeded、`cancel`、`quiesce`、`initialize` 转换、`storage-failed` 路径 to use `terminal(snapshot, {...})` so `paused` is always cleared.

- Pause gate wiring: give `processRun` the boundary check:

```ts
const processRun = async (run: ActiveRun): Promise<void> => {
  const topology = run.snapshot!.definition.topology
  const order = topologicalWorkflowOrder(topology)
  for (const node of order) {
    if (run.terminal || run.controller.signal.aborted) return
    if (run.snapshot!.nodes[node.id]?.status !== 'pending') continue
    if (run.snapshot!.paused) await run.pauseGate
    if (run.terminal || run.controller.signal.aborted) return
    if (run.snapshot!.nodes[node.id]?.status !== 'pending') continue
    await processNode(run, node)
  }
  // ...existing post-loop (also re-check paused before succeeded)
  if (run.snapshot!.paused) await run.pauseGate
  if (run.terminal || run.cancelRequested || run.controller.signal.aborted) return
  // ...succeeded transition
}
```

- `pause` implementation:

```ts
const pause = async (workflowPath: string): Promise<boolean> => {
  const run = activeRuns.get(workflowPath)
  if (!run) return false
  if (run.snapshot === null) await run.materialized
  if (activeRuns.get(workflowPath) !== run || run.snapshot === null) return false
  if (run.snapshot.status !== 'running' || run.snapshot.paused) return false
  const next = transition(run, {}, (snapshot) =>
    freezeRun({ ...snapshot, paused: true }),
  )
  if (!next) return false
  await enqueuePersist(run, next).catch(() => undefined)
  return true
}
```

- `cancel` / `quiesce` / `initialize` / `continueRun`:解析 gate（`run.resumePause()`）在相应转移前调用；`continueRun` 对 in-memory paused 的路径改为：**先检查 `activeRuns`，若有且快照 paused → 复用现有 ActiveRun**（清 paused、`resumePause()`、返回 ok:true），不再走 record 重建。副作用确认对 in-memory paused 免查（`confirmSideEffects` 直接接受），对 failed/interrupted/recovered 保持现有要求。每次创建 ActiveRun 时初始化 `pauseGate: Promise.resolve(), resumePause: () => undefined`（Task 3 才让 recovered 路径真正挂起）。

- [ ] **Step 4: Run to verify green**

Run: `npx jest modules/workflow/src/execution/workflow-run-coordinator.test.ts`
Expected: PASS（7 个新测试 + 既有全套）。

- [ ] **Step 5: Commit**

```bash
git add modules/workflow/src/execution/workflow-run-types.ts modules/workflow/src/execution/workflow-run-coordinator.ts modules/workflow/src/execution/workflow-run-coordinator.test.ts
git commit -m "feat(workflow): pause parks the run at node boundaries"
```

---

### Task 3: Recovery and Record-Level Control Paths

**Files:**
- Modify: `modules/workflow/src/execution/workflow-run-coordinator.ts`
- Modify: `modules/workflow/src/execution/workflow-run-types.ts`（`start` 输入/结果不变；内部用）
- Test: `modules/workflow/src/execution/workflow-run-coordinator.test.ts`

**Interfaces:**
- Consumes: Task 2 的 pause/gate；现有 `initialize`（:637-655）、`start`（:461-544）、`continueRun`（:563-635）、`cancel`（:546-561）。
- Produces: `initialize()` 发布保留的 `running+paused` 记录（listener + 直接通知）；`start` 的 store 检查（reserve → read → release-on-found）；`cancel` 的 record-level check-then-write；`continueRun` 对 recovered paused 走记录级重建（清 paused、要求确认、**重建的 ActiveRun 挂真实 gate**）。

- [ ] **Step 1: Write the failing tests**

Add to `workflow-run-coordinator.test.ts`:

```ts
it('initialize keeps running+paused records and publishes them', async () => {
  // seed store with a running+paused snapshot; call initialize
  // assert record unchanged (still running+paused) and listener got it
})

it('initialize still converts plain running records to interrupted', async () => {
  // existing behavior preserved
})

it('start rejects when the store holds a running+paused record', async () => {
  // seed store; start -> { ok: false, reason: 'already-running' }; activeRuns empty
})

it('record-level cancel writes cancelled with paused cleared and publishes', async () => {
  // seed store with running+paused; no active run; cancel(path)
  // assert store record is cancelled without paused; listener notified
})

it('record-level cancel does not resurrect a run after a stale continue read', async () => {
  // simulate: continueRun reads the record (hold the store read), cancel writes
  // cancelled, then continueRun proceeds -> must not start a run
  // (implement via a store that returns a fresh read or a version check)
})

it('continueRun on a recovered paused run rebuilds, clears paused, requires confirmation, and resumes', async () => {
  // seed running+paused with a mid-flight running node; continueRun without
  // confirmation -> side-effect-confirmation-required; with confirmation -> ok,
  // record status running, paused undefined, resume node pending, run succeeds
})
```

- [ ] **Step 2: Run to verify red**

Run: `npx jest modules/workflow/src/execution/workflow-run-coordinator.test.ts`
Expected: FAIL — initialize/start/cancel/continueRun don't handle paused records yet.

- [ ] **Step 3: Implement record-level paths**

In `workflow-run-coordinator.ts`:

- `initialize`：读取记录时区分——`running + paused` → 保持原样并**通知 listener**（listener 直呼循环，与转换记录相同的通知模式）；`running` 无 paused → 现有转 `interrupted` 并通知。两种都写 store（paused 保持的写是幂等写入，可选；若写，保持原记录不变）。
- `start`：在 `activeRuns.set(workflowPath, run)` 之后、`createWorkflowDefinition` 之前插入：

```ts
try {
  const record = await store.read(workflowPath)
  if (record?.status === 'running' && record.paused) {
    if (activeRuns.get(workflowPath) === run) activeRuns.delete(workflowPath)
    return { ok: false, reason: 'already-running' }
  }
} catch {
  // storage read failure: continue as today (definition build will surface storage issues)
}
```

- `cancel`：先查 `activeRuns`；无活动 run 时读 store 找 `running + paused` 记录，做 check-then-write：

```ts
const run = activeRuns.get(workflowPath)
if (run) {
  // existing in-memory path (resolves the gate, terminal clears paused)
} else {
  let record: WorkflowRunSnapshot | null
  try { record = await store.read(workflowPath) } catch { return }
  if (!record || record.status !== 'running' || !record.paused) return
  const cancelled = freezeRun({
    ...record,
    paused: undefined,
    cancelRequested: true,
    status: 'cancelled',
    finishedAt: now(),
  })
  try {
    // re-read to guard against a concurrent continueRun having rebuilt the run
    const latest = await store.read(workflowPath)
    if (latest?.status !== 'running' || !latest.paused) return
    await store.write(cancelled)
  } catch { return }
  publish(cancelled)
}
```

- `continueRun`：`activeRuns.has` 守卫改为——若活动 run 存在且 `run.snapshot?.paused` → 走 Task 2 的 in-memory 复用分支（清 paused、`resumePause()`、直接 ok，**免确认**）；若活动 run 存在且未 paused → 现有 `already-running`。record 路径：读记录后，`running + paused` → 与 failed/interrupted 相同的重建流程，但**重建快照清 paused**（`paused: undefined`），**要求确认**（`confirmSideEffects` 检查保持在前），且**重建的 ActiveRun 挂真实 gate**（`pauseGate: 新 Promise` + `resumePause` 解析器），使后续 pause 语义完整。

- [ ] **Step 4: Run to verify green**

Run: `npx jest modules/workflow/src/execution/workflow-run-coordinator.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add modules/workflow/src/execution/workflow-run-types.ts modules/workflow/src/execution/workflow-run-coordinator.ts modules/workflow/src/execution/workflow-run-coordinator.test.ts
git commit -m "feat(workflow): recover paused runs through record-level control"
```

---

### Task 4: Workflow Rename（repository + coordinator lease + editor）

**Files:**
- Modify: `modules/workflow/src/domain/workflow-repository.ts`
- Modify: `modules/workflow/src/execution/workflow-run-coordinator.ts`（`notifyRenamedWorkflow` + rename lease 检查）
- Modify: `modules/workflow/src/execution/workflow-run-types.ts`（Coordinator 接口）
- Modify: `modules/workflow/src/ui/workflow-editor-model.ts`（`rename` + saving 守卫）
- Test: `modules/workflow/src/domain/workflow-repository.test.ts`
- Test: `modules/workflow/src/ui/workflow-editor-model.test.ts`

**Interfaces:**
- Consumes: 现有 `WorkflowRepository`（list/read/create/trash/replaceFile）、`host.vault.renamePath`/`ensureFolder`/`removeEmptyFolderExact`、`host.paths.runExclusive`、`writeBundle` 的 cleanup 模式（repository:199-261）、editor 的 `load`/`dirty`（editor-model:182-298）。
- Produces: `repository.renameWorkflow(path, nextSlug): Promise<{ ok: true; nextPath: string } | { ok: false; reason: 'not-found' | 'target-exists' | 'invalid-slug' | 'failed' }>`；`coordinator.notifyRenamedWorkflow(oldPath, newPath): Promise<void>`（迁移 run 记录 + 发布）；`coordinator` 暴露 `isRenaming(path): boolean`（start/continueRun 检查）；`editor.rename(nextSlug): Promise<{ ok: boolean }>`。

- [ ] **Step 1: Write failing repository tests**

Add to `workflow-repository.test.ts` (reuse its fake host fixture — check what `host.vault` fakes exist; extend with `renamePath`/`ensureFolder`/`removeEmptyFolderExact` if missing):

```ts
it('renames a workflow directory with step files first and WORKFLOW.md last', async () => {
  // create demo workflow via repository.create; renameWorkflow('demo/WORKFLOW.md', 'alpha')
  // assert list() has alpha/WORKFLOW.md, demo gone, all files moved
})

it('rejects rename when the target slug exists', async () => {
  // two workflows; rename onto the second -> { ok: false, reason: 'target-exists' }
})

it('rejects invalid slugs and unknown paths', async () => {
  // 'a/b' -> invalid-slug; 'missing/WORKFLOW.md' -> not-found
})

it('compensates by moving files back when a later move fails', async () => {
  // make the 3rd renamePath call fail; assert original paths intact, new dir removed
})
```

- [ ] **Step 2: Run to verify red**

Run: `npx jest modules/workflow/src/domain/workflow-repository.test.ts`
Expected: FAIL — `renameWorkflow` missing.

- [ ] **Step 3: Implement `renameWorkflow`**

In `workflow-repository.ts`:

```ts
renameWorkflow: (path, nextSlug) => renameWorkflowFile(host, root, path, nextSlug),
```

```ts
async function renameWorkflowFile(
  host: Host,
  root: () => string,
  path: string,
  nextSlug: string,
): Promise<RenameWorkflowResult> {
  if (!isManifestPath(path)) return { ok: false, reason: 'not-found' }
  if (!isSlug(nextSlug)) return { ok: false, reason: 'invalid-slug' }
  const currentRoot = root()
  const oldFolder = at(currentRoot, path.slice(0, -'/WORKFLOW.md'.length))
  const newFolder = at(currentRoot, nextSlug)
  return host.paths.runExclusive('workflows', async () => {
    const operationRoot = root()
    if (root() !== operationRoot) return { ok: false, reason: 'failed' }
    if (await host.vault.exists(newFolder))
      return { ok: false, reason: 'target-exists' }
    const entries = host.vault.listChildren(oldFolder)
    const files = entries
      .filter((entry) => entry.kind === 'file')
      .map((entry) => entry.path)
    if (files.length === 0) return { ok: false, reason: 'not-found' }
    const moved: string[] = []
    const undo = async (): Promise<void> => {
      for (const movedPath of moved.reverse()) {
        const relative = movedPath.slice(newFolder.length)
        await host.vault.renamePath(movedPath, at(oldFolder, relative)).catch(() => false)
      }
      await host.vault.removeEmptyFolderExact(newFolder).catch(() => false)
    }
    try {
      await host.vault.ensureFolder(newFolder)
      // STEP files first, WORKFLOW.md last so list() never sees a half-state
      const ordered = [
        ...files.filter((file) => !file.endsWith('/WORKFLOW.md')),
        ...files.filter((file) => file.endsWith('/WORKFLOW.md')),
      ]
      for (const file of ordered) {
        const relative = file.slice(oldFolder.length)
        await host.vault.renamePath(file, at(newFolder, relative))
        moved.push(at(newFolder, relative))
      }
      if (root() !== operationRoot) {
        await undo()
        return { ok: false, reason: 'failed' }
      }
      return { ok: true, nextPath: `${nextSlug}/WORKFLOW.md` }
    } catch {
      await undo()
      return { ok: false, reason: 'failed' }
    }
  })
}
```

Add `RenameWorkflowResult` to the repository types and `renameWorkflow` to `WorkflowRepository`.

- [ ] **Step 4: Run to verify green**

Run: `npx jest modules/workflow/src/domain/workflow-repository.test.ts`
Expected: PASS.

- [ ] **Step 5: Add coordinator notify + lease, and editor rename**

Coordinator (`workflow-run-types.ts` + coordinator):

```ts
// types
notifyRenamedWorkflow(oldPath: string, newPath: string): Promise<void>
isRenaming(path: string): boolean
```

Coordinator impl:
- `renamingPaths = new Set<string>()`；`isRenaming: (path) => renamingPaths.has(path)`；`start` 与 `continueRun` 的同步保留阶段前检查 `isRenaming(workflowPath)` → `{ ok: false, reason: 'already-running' }`（用现有 reason，UI 文案可复用；spec 允许 `rename-in-progress` 语义映射到已存在 reason 或新 reason——实现时若要保持语义清晰，可在 `WorkflowRunStartFailureReason` 增加 `'rename-in-progress'` 并在 index.tsx 的 `runStartFailureMessage` 加一行映射）。
- `notifyRenamedWorkflow(oldPath, newPath)`：读旧 run 记录（store.read(oldPath)）；存在则构造迁移记录（`workflowPath`/`definition.workflowPath` 换新路径，`definitionHash` 保持原值）→ `store.write` 迁移记录 → `store.remove(oldPath)`；随后 `publish(migrated)` 与 `background` 移除旧活动（通过现有 publish 路径：模块订阅者按 `workflowPath` 键控，发布迁移记录后 index.tsx 需要把旧键移除——见 Task 6 的 index.tsx 改造；coordinator 只负责发布，键控在模块层）。
- 模块接线层（index.tsx，Task 6）在 rename 前设置 `renamingPaths.add`，结束后 delete——或由 repository 回调；实现选择：editor.rename 调用前由模块接线层设置 lease（coordinator 暴露 `beginRename(path)`/`endRename(path)`，或直接由 index.tsx 组合调用）。**裁决：lease 由 index.tsx 的 rename 处理器设置**（coordinator 只提供 `isRenaming` 检查与 `notifyRenamedWorkflow` 发布）。

Editor model（`workflow-editor-model.ts`）：

```ts
rename: async (nextSlug: string): Promise<boolean> => {
  if (disposed || snapshot.dirty || !snapshot.path) return false
  const result = await repository.renameWorkflow(snapshot.path, nextSlug)
  if (!result.ok) return false
  await load(result.nextPath, { discardDirty: true })
  refreshWorkflows()
  return true
}
```

Add `rename(nextSlug: string): Promise<boolean>` to `WorkflowEditorModel`.

- [ ] **Step 6: Add editor test**

In `workflow-editor-model.test.ts`:

```ts
it('renames the current workflow and loads the new path', async () => {
  // repository.renameWorkflow mocked to ok; model.rename('alpha') -> true
  // assert snapshot.path === 'alpha/WORKFLOW.md' and list refreshed
})

it('refuses rename while dirty', async () => {
  // make an edit; rename -> false; path unchanged
})
```

- [ ] **Step 7: Run all touched suites**

Run: `npx jest modules/workflow/src/domain/workflow-repository.test.ts modules/workflow/src/ui/workflow-editor-model.test.ts modules/workflow/src/execution/workflow-run-coordinator.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add modules/workflow/src/domain/workflow-repository.ts modules/workflow/src/execution/workflow-run-types.ts modules/workflow/src/execution/workflow-run-coordinator.ts modules/workflow/src/ui/workflow-editor-model.ts modules/workflow/src/domain/workflow-repository.test.ts modules/workflow/src/ui/workflow-editor-model.test.ts modules/workflow/src/execution/workflow-run-coordinator.test.ts
git commit -m "feat(workflow): rename workflows with run record migration"
```

---

### Task 5: Studio and Run Panel UI（Pause / Resume / Rename）

**Files:**
- Modify: `modules/workflow/src/ui/workflow-run-panel.tsx`
- Modify: `modules/workflow/src/ui/workflow-studio.tsx`
- Modify: `modules/workflow/src/i18n/en.ts`、`zh.ts`、`it.ts`、`index.ts`
- Modify: `modules/workflow/src/ui/workflow-run-panel.test.tsx`
- Modify: `modules/workflow/src/ui/workflow-ui.test.tsx`

**Interfaces:**
- Consumes: Task 2-4 的 `coordinator.pause`、`coordinator.isRenaming`、`editor.rename`；现有 `WorkflowRunPanelProps`（run-panel:15-44）、`WorkflowStudio` 的 props 结构。
- Produces: Run 面板 Pause/Resume/Stop 三态按钮、paused 徽章文案；Studio 工具栏 Rename 入口（禁用在 dirty/运行中）；i18n 新键。

- [ ] **Step 1: Add i18n keys first**

In `en.ts` `run` block add（zh/it 同步翻译）：

```ts
pause: 'Pause',
resume: 'Resume',
status: {
  // ...existing
  paused: 'Paused',
},
rename: 'Rename workflow',
renamePlaceholder: 'New workflow name',
renameFailed: 'Failed to rename the workflow.',
cannotRenameWhileRunning: 'Stop or finish the run before renaming.',
cannotRenameWhileDirty: 'Save or discard the current edits before renaming.',
```

- [ ] **Step 2: Write failing UI tests**

In `workflow-run-panel.test.tsx` (follow existing render/harness pattern):

```ts
it('shows Pause while running and Resume plus Stop while paused', async () => {
  // render with a running snapshot -> Pause visible, Resume absent
  // re-render with running+paused snapshot -> Resume visible, Pause absent, Stop still visible
})

it('Pause calls onPause', async () => {
  // click Pause; assert onPause called
})

it('Resume calls onContinue without a confirmation dialog for an in-memory paused run', async () => {
  // running+paused snapshot; click Resume; assert confirm not called and onContinue called
})

it('Stop remains enabled while paused', async () => {
  // running+paused; Stop visible and clickable; onCancel called
})
```

Panel prop changes: add `onPause(): void`（index.tsx 的 WorkflowModuleView 增加 `pauseRun` callback 调 `coordinator.pause(path)`）。`continuable` 扩展为 `failed || interrupted || run?.paused === true`；`runningPaused = run?.status === 'running' && run?.paused === true`。按钮渲染：

```tsx
{running ? (
  <button className="...__pause" onClick={onPause}>{copy.run.pause}</button>
) : null}
{runningPaused ? (
  <button className="...__resume" onClick={handleResume}>{copy.run.resume}</button>
) : null}
{running ? (
  <button className="...__stop" onClick={onCancel}>{copy.run.stop}</button>
) : null}
```

`handleResume` = 直接 `onContinue()`（无确认——Coordinator 按 activeRuns 成员决定是否要求确认；recovered paused 场景面板不区分，Coordinator 返回 `side-effect-confirmation-required` 时由 index.tsx 的 continue 处理器弹确认后重试——**裁决：为简化 UI，面板对 paused 的 Resume 直接调用 onContinue；若 Coordinator 返回确认要求，index.tsx 的 continueRun 回调先弹 confirm 再调 coordinator**。因此 index.tsx 的 `continueRun` 回调改为：读当前 run 快照，若 `paused` 且失败原因是 `side-effect-confirmation-required`，则先 `confirm({...})` 再带 `confirmSideEffects: true` 重试）。

Badge：`run.status` 显示 `run.status.paused` 当 `run?.paused === true`。

In `workflow-ui.test.tsx`:

```ts
it('exposes Rename and refuses while dirty or running', async () => {
  // toolbar Rename visible; with dirty snapshot click -> disabled/notice
  // with running snapshot -> disabled
})
```

Studio: toolbar 加 Rename 按钮（复用 New/Export/Delete 的既有 pattern，`aria-label={copy.run.rename}`），disabled 条件 `dirty || runActive`；点击后显示 inline 输入（复用 New workflow 的 prompt pattern——检查 studio 现有的新建输入交互并仿照），提交调用 `model.rename(slug)`，失败用 `notice(copy.run.renameFailed)`。

- [ ] **Step 3: Implement panel + studio + index wiring**

- `WorkflowRunPanelProps` 加 `onPause(): void`。
- `WorkflowStudio` props 加 `onPause`，透传给 panel。
- index.tsx：`pauseRun` callback（`coordinator.pause(path)`，失败用 notice）；`continueRun` 改造（paused + 确认要求 → 先 confirm 再重试）；`runStartFailureMessage` 增加 `rename-in-progress` 映射（若加了该 reason）。

- [ ] **Step 4: Run to verify green**

Run: `npx jest modules/workflow/src/ui/workflow-run-panel.test.tsx modules/workflow/src/ui/workflow-ui.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add modules/workflow/src/ui/workflow-run-panel.tsx modules/workflow/src/ui/workflow-studio.tsx modules/workflow/src/index.tsx modules/workflow/src/i18n modules/workflow/src/ui/workflow-run-panel.test.tsx modules/workflow/src/ui/workflow-ui.test.tsx
git commit -m "feat(workflow): add Pause/Resume and Rename to Studio"
```

---

### Task 6: Usage Aggregation and Module Wiring

**Files:**
- Modify: `src/core/modules/moduleAgent.ts`（Host `completed` 事件加可选 usage）
- Modify: `src/core/modules/types.ts`（`YoloModuleAgentEventV1` completed 变体）
- Modify: `modules/workflow/src/execution/workflow-node-executor.ts`（透传 completed usage → 结果）
- Modify: `modules/workflow/src/execution/workflow-run-types.ts`（`WorkflowNodeExecutionResult.usage?`）
- Modify: `modules/workflow/src/execution/workflow-run-coordinator.ts`（节点/run usage 聚合）
- Modify: `modules/workflow/src/index.tsx`（rename lease + notifyRenamedWorkflow + paused background 映射 + runStartFailureMessage）
- Test: `src/core/modules/moduleAgent.test.ts`（usage 透传）
- Test: `modules/workflow/src/execution/workflow-node-executor.test.ts`、`workflow-run-coordinator.test.ts`
- Test: `modules/workflow/src/workflow.execution.integration.test.ts`（end-to-end usage + rename + pause/recover）

**Interfaces:**
- Consumes: Host agent 事件（types.ts:154-169）、`host.config.getSnapshot`（若 tier 相关不需要——本任务不含 tier，那是 quality plan 的范围）、`WorkflowRunSnapshot.usage`（Task 1）。
- Produces: `WorkflowNodeExecutionResult.usage?: WorkflowTokenUsage`；Coordinator 节点终态并入 `nodes[id].usage`、run 终态汇总 `usage`；index.tsx 的 paused→waiting 背景映射与 rename 发布接线。

- [ ] **Step 1: Add usage to the Host agent completed event**

In `src/core/modules/types.ts`:

```ts
export type YoloModuleAgentEventV1 =
  // ...existing
  | Readonly<{ type: 'completed'; text: string; usage?: Readonly<{ inputTokens?: number; outputTokens?: number; totalTokens?: number }> }>
```

In `src/core/modules/moduleAgent.ts`（completed 映射处，约 :528-529）：透传 host agent 事件里的 usage——先确认该文件里 completed 事件从底层 agent 事件构造的位置，若底层事件有 usage（`message.metadata.usage`）则映射 `usage: { inputTokens, outputTokens, totalTokens }`；若底层无可靠数据，则省略该字段（保持可选）。**裁决**：先看底层 `completed` 是否携带 token 数据（`src/core/agent/` 的 completion 事件或 metadata），有则透传，无则本期省略字段（spec 的降级条款）。

- [ ] **Step 2: Write failing executor/coordinator tests**

In `workflow-node-executor.test.ts`:

```ts
it('passes completed usage through to the node result', async () => {
  // fake agent yields { type: 'completed', text: 'x', usage: { inputTokens: 7 } }
  // assert result.usage equals the usage
})
```

In `workflow-run-coordinator.test.ts`:

```ts
it('aggregates node usage into the run snapshot at terminal', async () => {
  // fake executor returns usage on the agent node; run to succeeded
  // assert nodes.agent.usage present and run.usage sums input/output/total
})
```

- [ ] **Step 3: Implement**

- `workflow-node-executor.ts`：`WorkflowAgentEvent` 的 `completed` 加可选 `usage`；`executeAgentStream` 返回 `{ text, usage }` 或 executor 内捕获 completed 事件的 usage；schema 节点结果 `return { value, ...(usage ? { usage } : {}) }`；`WorkflowNodeExecutionResult` 加 `usage?: WorkflowTokenUsage`。
- `workflow-run-coordinator.ts`：`executeAgent` 成功路径把 `result.usage` 并入 `nodes[node.id].usage`；`processRun` 的 succeeded 转移前对全部节点 usage 求和（input/output/total 各加，`totalTokens` 优先取节点显式值否则 input+output）写入 run `usage`；failed/cancelled 终态同样汇总已成功节点。
- `moduleAgent.ts` 完成 usage 透传（Step 1 裁决）。

- [ ] **Step 4: Wire index.tsx（rename lease + paused background + notify）**

In `modules/workflow/src/index.tsx`:

- `renaming` 状态：`let renamingPath: string | null = null`；`beginRename`/`endRename`（或直接调 `coordinator.isRenaming` 配合一个局部 set——**裁决**：coordinator 不持有 lease，index.tsx 持有 `renamingPath` 并在 `startRun`/`continueRun` 前检查，命中则 notice `run.cannotRenameWhileRunning` 语义文案——实际上语义相反，用新文案 `run.renameInProgress`，i18n 加键）。简化：在 Studio 的 rename 处理器里设置 `renamingPath`，start/continue 回调开头检查。
- `continueRun` 回调改造（paused 确认重试，Task 5 已述）。
- background 映射：`running + paused` → `waiting`（在 `case 'running'` 分支内：`snapshot.paused ? 'waiting' : isWaitingForApproval(...) ? 'waiting' : 'running'`）。
- rename 成功后调用 `coordinator.notifyRenamedWorkflow(oldPath, nextPath)`：模块订阅者把旧键从 index 移除——`RunSnapshotIndex` 需要支持删除键或由 coordinator 发布迁移记录后 index 层以新键添加、旧键仍留（陈旧）——**裁决**：给 `RunSnapshotIndex` 加 `remove(path)` 方法，rename 处理器调用 `runs.remove(oldPath)` 与 `host.background.remove(workflowRunActivityId(oldPath))`；`notifyRenamedWorkflow` 只负责 store 迁移与发布迁移记录（新键添加）。

- [ ] **Step 5: Integration tests**

In `workflow.execution.integration.test.ts`（复用既有 fake host 与 fake agent）：

```ts
it('pause, reload, resume, and rename keep the run recoverable', async () => {
  // 1. run with held agent; pause mid-run; assert persisted running+paused
  // 2. re-activate (initialize) with the same store; assert recovered paused visible
  // 3. continueRun with confirmation; assert resumes and succeeds; usage aggregated
  // 4. renameWorkflow after success; assert new path listed, run record migrated,
  //    background activity keyed to new path, continueRun works on new path
})

it('usage aggregates across nodes into the run record', async () => {
  // fake agent yields usage on completed; run input->agent->output; assert run.usage
})
```

- [ ] **Step 6: Run full verification batch**

Run:
```text
npx jest modules/workflow/src/execution/workflow-run-coordinator.test.ts modules/workflow/src/execution/workflow-node-executor.test.ts modules/workflow/src/workflow.execution.integration.test.ts src/core/modules/moduleAgent.test.ts
npm --prefix modules/workflow run typecheck
npm --prefix modules/workflow run test:boundary
```

Expected: all pass；typecheck 0；boundary 4/4。

- [ ] **Step 7: Commit**

```bash
git add src/core/modules/types.ts src/core/modules/moduleAgent.ts src/core/modules/moduleAgent.test.ts modules/workflow/src/execution modules/workflow/src/index.tsx modules/workflow/src/workflow.execution.integration.test.ts
git commit -m "feat(workflow): aggregate run usage and wire pause-rename lifecycle"
```

---

### Task 7: Verify and Regenerate Artifacts

**Files:**
- Modify: generated files under `modules/workflow/0.1.1-dev.1/`（entry.js、module.json、style.css）
- Modify only if changed: `modules/bundled.json`

- [ ] **Step 1: Run focused checks**

```text
npm --prefix modules/workflow test
npm --prefix modules/workflow run test:boundary
npm run module:typecheck
npx jest modules/workflow/src/ui/workflow-ui.test.tsx --silent
```

Expected: all Workflow tests、boundary、typecheck 通过；lint 只检查本次变更文件干净（仓库有既有 prettier 债务，不在本期范围）。

- [ ] **Step 2: Rebuild artifacts and commit them alone**

```bash
npm run module:build
git status --short
git add modules/workflow/0.1.1-dev.1 modules/bundled.json
git commit -m "build(workflow): regenerate phase 3 run control artifacts"
```

Expected: 版本仍 `0.1.1-dev.1`，无新版本目录；manifest hash/size 与 entry/style/data 匹配。

- [ ] **Step 3: Verify production bundle and e2e**

```bash
npm run build
npm run test:workflow:e2e
```

Expected: 全链路通过；现有 19 个 e2e 不回归（本次改动不涉及 harness fixture 需要的 surface——若 fixture 缺 `usage` 字段的 fake，则 e2e 断言不依赖 usage，保持现状）。
