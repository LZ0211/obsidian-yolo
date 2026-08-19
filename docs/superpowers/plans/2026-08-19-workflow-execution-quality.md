# Workflow Execution Quality Implementation Plan（Repair / Verification / Tier）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add structured-output repair rounds, node-level verification postconditions, and fast/balanced/deep model-tier routing to the `modules/workflow` execution domain.

**Architecture:** The executor gains a single repair round gated by a mechanically checkable predicate (stream ended normally + at least one schema rejection + no accepted submission); the coordinator gets a shared `finalizeNodeResult` helper applying verification at every node-result chokepoint; tier aliases resolve at definition build time from a module settings contribution read through `host.config`. No retry state machine, no new persisted status, no text-JSON parsing.

**Tech Stack:** TypeScript, React 18, Jest/jsdom, Ajv 8, existing Host API `1.8.0` (optional `settings.getContributionValues` only if `host.config` is blocked), Web Crypto SHA-256.

**Spec:** `docs/superpowers/specs/2026-08-19-workflow-execution-quality-spec.md`（两轮盲审修订版）— the plan argues from the spec; executors read both.

## Global Constraints

- 不修改 Host Core；Host API 只允许 §1 许可的最小读取接口（`host.settings.getContributionValues(moduleId)`，仅当 `host.config.getSnapshot()` 读路径有阻塞时启用——默认用 `host.config`）。
- 修复轮触发谓词（精确）：首轮 `host.agent.stream` 正常结束 + **至少一次 schema 校验被拒** + **没有任何提交被接受**。error/aborted/no-submission/已有有效提交（含先无效后有效）**绝不触发**。修复轮恰好一次，共享 signal，成本护栏 ≤2 次 agent 调用/节点。
- 修复轮不解析文本 JSON：修复轮同样只接受 `submit_workflow_output` 提交；被拒值以 2 KiB 有界 JSON 预览携带进修复 prompt。
- mapAgent 不参与修复轮；testNode 与 full run 共享同一 executor 路径（同样享受修复轮）。
- verification：`WorkflowNode.verification?: { schema: unknown; mode: 'warn' | 'hard' }`，只允许 agent/mapAgent/output；`input`/`condition`/`merge` 拒绝（非丢弃）。新错误码 `verification-failed`（`WorkflowRunError.code` 联合 + store validator 同步）。`detail` 编码 `verification: <msg>`（通过为 `verification: ok`）。
- `WorkflowNodeExecutionResult` 加可选 `warnings?: readonly string[]`；`WorkflowRunStartResult` reason 联合加 `tier-unavailable`（不靠 message 嗅探）。
- 分层：`parseNode`（domain）只做 JSON-compatible/mode 白名单校验，Ajv 编译在 `workflow-definition.ts`（execution）；domain 不 import execution。
- 模块本期补注册 settings contribution：`tier.fast`/`tier.balanced`/`tier.deep` 三个 `model` 类型扁平字段（localizations 三语，en fallback 强制）；tier 解析顺序：空 → 默认模型；精确 id 优先；tier 别名 → tier map；未命中/配置缺失 → `tier-unavailable` preflight 拒绝（不静默兜底）。
- 测试命令（worktree 根）：`npx jest modules/workflow/src/execution/<file>`；模块测试 `npm --prefix modules/workflow test` 或 `npx jest --config ../../jest.config.js`（裸 `npx jest` 从模块目录会 mis-resolve config）；typecheck `npm --prefix modules/workflow run typecheck`；boundary `npm --prefix modules/workflow run test:boundary`。
- 模块版本保持 `0.1.1-dev.1`；源码变更后产物经 `npm run module:build` 再生成并单独提交。
- 提交按任务分批：`feat(workflow): ...` / `build(workflow): ...`。

---

### Task 1: Executor Repair Round（精确谓词 + 被拒值捕获）

**Files:**
- Modify: `modules/workflow/src/execution/workflow-node-executor.ts`
- Modify: `modules/workflow/src/execution/workflow-run-types.ts`（`WorkflowNodeExecutionResult` 可选 `usage` 由 run-control Task 6 加；本任务不加 usage，只加修复相关内部类型——若无需要则不改 types）
- Test: `modules/workflow/src/execution/workflow-node-executor.test.ts`

**Interfaces:**
- Consumes: `createOutputSubmissionTool`（executor:282-321，handler 内联校验、first-valid-wins、`{isError:true}`）、`executeAgentStream`（:214-245）、`WORKFLOW_AGENT_SYSTEM_PROTOCOL`/`SCHEMA_OUTPUT_INSTRUCTION`（:80-84）、`WorkflowNodeExecutionError`。
- Produces: `createOutputSubmissionTool` 返回扩展 `{ tool, getSubmitted, getRejections }`——`getRejections(): readonly Readonly<{ message: string; value: JsonValue }>[]`（记录被拒提交的 Ajv 消息 + 被拒值，**不记录重复提交**）；executor 对 schema agent 节点实现"首轮 → 谓词判定 → 修复轮"；修复轮与首轮共享 signal；最终错误 message 组合两轮信息。

- [ ] **Step 1: Write failing tests**

In `workflow-node-executor.test.ts` (reuse the fake async-generator agent; check how tests drive tool calls):

```ts
it('repairs exactly once after a rejected submission, then succeeds', async () => {
  // fake agent: round 1 handler call returns isError once (schema reject) then
  // the model calls again with a valid value; stream completes
  // assert: executor returns the valid value; agent called twice
})

it('does not repair when the stream ends without any submission', async () => {
  // fake agent completes without calling the tool
  // assert: agent-failed; agent called exactly once
})

it('does not repair when the first round ended with error or aborted', async () => {
  // fake agent yields { type: 'error' } -> agent-failed, single call
  // fake agent yields { type: 'aborted' } -> cancelled (signal aborted) or agent-failed, single call
})

it('does not repair when an earlier invalid submission was followed by a valid one', async () => {
  // invalid then valid in the SAME round; assert: node succeeds with the first
  // accepted value; agent called exactly once (no second round)
})

it('does not count duplicate submissions as schema rejections', async () => {
  // valid submission, then a second submission (duplicate isError); assert no repair
})

it('includes the rejected value and Ajv message in the final error after a failed repair', async () => {
  // round 1 rejected; repair round rejected again; assert agent-failed with a
  // message containing both rounds' info and a bounded value preview
})

it('shares the abort signal with the repair round', async () => {
  // abort during repair; assert cancelled
})
```

- [ ] **Step 2: Run to verify red**

Run: `npx jest modules/workflow/src/execution/workflow-node-executor.test.ts`
Expected: FAIL — no repair behavior yet.

- [ ] **Step 3: Implement capture + repair**

In `workflow-node-executor.ts`:

- `createOutputSubmissionTool` handler: schema-reject branch 记录 `rejections.push({ message: check.message, value: input.value })`（仅 schema 分支，不含 accepted 分支）；返回 `{ tool, getSubmitted, getRejections }`。
- 新增 `REPAIR_PROMPT_PREFIX`（内部常量）：`'Your previous submission was rejected because it does not satisfy the node output schema. Submit exactly one corrected value with the submit_workflow_output tool.'`
- `execute` 的 schema agent 分支改为：

```ts
const submission = createOutputSubmissionTool(validator, request.node.outputSchema)
await executeAgentStream(context, { prompt, signal: request.signal, tool: submission.tool, outputInstruction: SCHEMA_OUTPUT_INSTRUCTION })
const value = submission.getSubmitted()
if (value !== undefined) return { value }
const rejections = submission.getRejections()
if (rejections.length > 0) {
  // exactly one repair round: same route, same tool, rejection feedback
  onAgentEvent?.(request.node.id, { type: 'tool', name: 'submit_workflow_output', status: 'running' }) // detail hint: repairing
  const last = rejections[rejections.length - 1]
  const repairPrompt = `${prompt}\n\n${REPAIR_PROMPT_PREFIX}\nRejected value: ${previewJson(last.value)}\nSchema errors: ${last.message}`
  const repairSubmission = createOutputSubmissionTool(validator, request.node.outputSchema)
  await executeAgentStream(context, { prompt: repairPrompt, signal: request.signal, tool: repairSubmission.tool, outputInstruction: SCHEMA_OUTPUT_INSTRUCTION })
  const repaired = repairSubmission.getSubmitted()
  if (repaired !== undefined) return { value: repaired }
  const repairRejections = repairSubmission.getRejections()
  const round2 = repairRejections.length > 0
    ? `rejected (${repairRejections[repairRejections.length - 1].message})`
    : 'no submission'
  throw new WorkflowNodeExecutionError('agent-failed',
    `Agent output rejected twice. Round 1: ${last.message} (value: ${previewJson(last.value)}); after repair attempt: ${round2}`)
}
throw new WorkflowNodeExecutionError('agent-failed',
  `Agent finished without a valid submit_workflow_output submission`)
```

`previewJson(value: JsonValue): string` — `JSON.stringify(value)` 截断到 2 KiB（`slice(0, 2048)`）。

- [ ] **Step 4: Run to verify green**

Run: `npx jest modules/workflow/src/execution/workflow-node-executor.test.ts`
Expected: PASS（7 个新测试 + 既有 suite；既有测试中"duplicate or invalid output submissions"断言不回归）。

- [ ] **Step 5: Commit**

```bash
git add modules/workflow/src/execution/workflow-node-executor.ts modules/workflow/src/execution/workflow-node-executor.test.ts
git commit -m "feat(workflow): repair schema output once with rejection feedback"
```

---

### Task 2: Verification Field（model + DSH + definition build）

**Files:**
- Modify: `modules/workflow/src/domain/workflow-model.ts`（`WorkflowNode.verification?`、parseNode 白名单、runtime 校验）
- Modify: `modules/workflow/src/domain/workflow-document.ts`（DSH import/export 双向）
- Modify: `modules/workflow/src/execution/workflow-definition.ts`（Ajv 编译校验）
- Test: `modules/workflow/src/domain/workflow-model.test.ts`
- Test: `modules/workflow/src/domain/workflow-document.test.ts`
- Test: `modules/workflow/src/execution/workflow-definition.test.ts`

**Interfaces:**
- Consumes: `WorkflowNode`（model.ts:24-37）、`parseNode`（:361-412，白名单构造、未知字段丢弃）、`exportDshFlowJson`/`dshNode`（document.ts:169-242）、`isJsonSchema`/`workflowSchemaValidator`（definition.ts:12, 定义构建期）。
- Produces: `WorkflowNode.verification?: Readonly<{ schema: unknown; mode: 'warn' | 'hard' }>`；parseNode 对 `verification` 的 kind 白名单（agent/mapAgent/output 接受，其余**拒绝**——不是丢弃）；DSH 双向往返；定义构建期 `validateSchema(verification.schema)` 失败 → `invalidDefinition`。

- [ ] **Step 1: Write failing domain tests**

In `workflow-model.test.ts`:

```ts
it('parses verification on agent nodes with mode warn', async () => {
  // parse a node with verification { schema: { type: 'object' }, mode: 'warn' }
  // assert the parsed node carries it
})

it('rejects verification on input/condition/merge nodes', async () => {
  // parseNode returns null for those kinds when verification present
})

it('rejects verification with an unknown mode', async () => {
  // mode: 'strict' -> parseNode null
})

it('rejects non-JSON-compatible verification schema', async () => {
  // schema containing a function/undefined -> parseNode null
})
```

In `workflow-document.test.ts`:

```ts
it('round-trips verification through DSH import and export', async () => {
  // export a topology with verification; import it; assert verification survives
})
```

In `workflow-definition.test.ts`:

```ts
it('rejects an uncompilable verification schema at definition build', async () => {
  // schema { type: 'nonsense' } -> { ok: false, error.code: 'invalid-definition' }
})

it('accepts a compilable verification schema at definition build', async () => {
  // schema { type: 'object' } -> ok
})
```

- [ ] **Step 2: Run to verify red**

Run: `npx jest modules/workflow/src/domain/workflow-model.test.ts modules/workflow/src/domain/workflow-document.test.ts modules/workflow/src/execution/workflow-definition.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `workflow-model.ts`:

```ts
export type WorkflowVerification = Readonly<{
  schema: unknown
  mode: 'warn' | 'hard'
}>
```

- `WorkflowNode` 加 `verification?: WorkflowVerification`。
- `parseNode` 内加（在 outputSchema 处理之后、返回对象之前）：

```ts
const hasVerification = Object.prototype.hasOwnProperty.call(value, 'verification')
const verification = hasVerification ? parseVerification(value.verification, value.kind as WorkflowNodeKind) : undefined
if (hasVerification && !verification) return null
```

```ts
const VERIFICATION_NODE_KINDS: ReadonlySet<WorkflowNodeKind> = new Set(['agent', 'mapAgent', 'output'])
function parseVerification(value: unknown, kind: WorkflowNodeKind): WorkflowVerification | null {
  if (!VERIFICATION_NODE_KINDS.has(kind)) return null
  if (!isRecord(value)) return null
  if (value.mode !== 'warn' && value.mode !== 'hard') return null
  if (!isJsonCompatible(value.schema)) return null
  return { schema: cloneJsonValue(value.schema), mode: value.mode }
}
```

（`isJsonCompatible`/`cloneJsonValue` 用文件里已有的 JSON 工具；若没有，用 `isJsonSerializable` + 深拷贝——检查 model.ts 现有 helper 并复用。）

返回对象加 `...(verification ? { verification } : {})`。

In `workflow-document.ts`：`dshNode`（导入）与 `exportDshFlowJson`（导出）在 outputSchema/mergeStrategy 同位置加 verification 字段透传（导入走 parseNode 已在 model 层验证；导出 `...(node.verification ? { verification: node.verification } : {})`）。先读这两函数确认字段枚举方式，仿照 mergeStrategy 的写法。

In `workflow-definition.ts`：在 outputSchema 循环（:76-80）同一处加：

```ts
for (const node of topology.nodes) {
  if (node.verification === undefined) continue
  if (!isJsonSchema(node.verification.schema))
    return invalid(`Node "${node.id}" has an invalid verification schema`, node.id)
}
```

- [ ] **Step 4: Run to verify green**

Run: `npx jest modules/workflow/src/domain/workflow-model.test.ts modules/workflow/src/domain/workflow-document.test.ts modules/workflow/src/execution/workflow-definition.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add modules/workflow/src/domain/workflow-model.ts modules/workflow/src/domain/workflow-document.ts modules/workflow/src/execution/workflow-definition.ts modules/workflow/src/domain/workflow-model.test.ts modules/workflow/src/domain/workflow-document.test.ts modules/workflow/src/execution/workflow-definition.test.ts
git commit -m "feat(workflow): add verification field to workflow nodes"
```

---

### Task 3: Coordinator Verification（finalize 辅助 + 错误码 + warnings 通道）

**Files:**
- Modify: `modules/workflow/src/execution/workflow-run-types.ts`（`WorkflowNodeExecutionResult.warnings?`、`WorkflowRunError.code` 加 `'verification-failed'`）
- Modify: `modules/workflow/src/execution/workflow-run-store.ts`（ERROR_CODES 同步）
- Modify: `modules/workflow/src/execution/workflow-run-coordinator.ts`（`finalizeNodeResult` 辅助 + 三个调用点）
- Test: `modules/workflow/src/execution/workflow-run-coordinator.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `WorkflowNode.verification`；`executeAgent`（coordinator:283-297 附近）、`processNode` output 直算（:385-403）、`testNode`（:701-779）；`validateJsonSchemaOutput`（workflow-schema.ts）。
- Produces: `finalizeNodeResult(node, value): Readonly<{ ok: true } | { ok: false; error: WorkflowRunError }> & { warnings?: readonly string[] }`——coordinator 内部函数；executor 路径在 schema 校验后调用、output 直算路径在值形成后调用、testNode 在返回值前调用；warn → warnings 并入 `WorkflowNodeExecutionResult.warnings` 与节点 `detail`（`verification: <msg>`）；hard → 抛 `WorkflowNodeExecutionError('verification-failed', ...)`。

- [ ] **Step 1: Write failing coordinator tests**

In `workflow-run-coordinator.test.ts`:

```ts
it('fails an agent node with verification-failed on hard mismatch', async () => {
  // node with verification { schema: { type: 'number' }, mode: 'hard' }
  // fake executor returns { value: 'string' }; assert node failed,
  // error.code 'verification-failed'
})

it('keeps an agent node succeeded with a warn detail on soft mismatch', async () => {
  // verification warn; executor returns wrong-typed value
  // assert node succeeded, detail starts with 'verification: '
})

it('records verification: ok in detail when the value passes', async () => {
  // matching value; assert detail === 'verification: ok'
})

it('applies verification to output nodes computed by the coordinator', async () => {
  // output node with hard verification; single-source pass-through value fails
  // assert output node failed with verification-failed
})

it('skips verification for skipped output nodes', async () => {
  // output with no active sources -> skipped; no verification error
})

it('returns warnings through testNode for warn mismatches', async () => {
  // testNode on a node with warn verification; assert result.warnings non-empty
})
```

- [ ] **Step 2: Run to verify red**

Run: `npx jest modules/workflow/src/execution/workflow-run-coordinator.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `workflow-run-types.ts`:

```ts
export type WorkflowNodeExecutionResult = Readonly<{
  value: JsonValue
  conditionResult?: boolean
  warnings?: readonly string[]
}>
```

`WorkflowRunError['code']` 联合加 `'verification-failed'`。

In `workflow-run-store.ts`：`ERROR_CODES` 加 `'verification-failed'`。

In `workflow-run-coordinator.ts`:

```ts
const finalizeNodeResult = (
  node: WorkflowNode,
  value: JsonValue,
): Readonly<{ warnings?: readonly string[] }> => {
  const verification = node.verification
  if (verification === undefined) return {}
  const check = validateJsonSchemaOutput(verification.schema, value)
  if (check.ok) return { warnings: ['verification: ok'] }
  const message = `verification: ${check.message}`
  if (verification.mode === 'hard')
    throw new WorkflowNodeExecutionError('verification-failed', message)
  return { warnings: [message] }
}
```

（先读 `validateJsonSchemaOutput` 的实际签名——若它返回 `{ ok } | { ok: false; message }` 就用；否则用 `workflowSchemaValidator.validateValue`。）

- **executor 路径**（`executeAgent`）：拿到 `result` 后：

```ts
let warnings: readonly string[] | undefined
try {
  warnings = finalizeNodeResult(node, result.value).warnings
} catch (error) {
  // verification-failed -> node failed with that code
  throw error  // 或包装为 WorkflowRunError
}
// detail 并入：transition 的 withNodeRun detail 参数加 warnings?.[0]（full run 只存一条；多警告合并 '; ' join）
```

- **output 直算路径**（`processNode` output 分支）：`value` 形成后同 finalize；hard 失败 → 该节点 `failed` + `verification-failed`（transition 内 error 字段）；warn → detail。
- **testNode**：executor 返回后调用 finalize，warnings 并入返回的 result（`{ ...result, warnings }`），hard 失败 → reject `WorkflowNodeExecutionError('verification-failed', ...)`。
- **skipped**：`markSkipped` 路径（coordinator:332-334 附近）不调用 finalize。

- [ ] **Step 4: Run to verify green**

Run: `npx jest modules/workflow/src/execution/workflow-run-coordinator.test.ts`
Expected: PASS（6 个新测试 + 既有全套）。

- [ ] **Step 5: Commit**

```bash
git add modules/workflow/src/execution/workflow-run-types.ts modules/workflow/src/execution/workflow-run-store.ts modules/workflow/src/execution/workflow-run-coordinator.ts modules/workflow/src/execution/workflow-run-coordinator.test.ts
git commit -m "feat(workflow): enforce node verification postconditions"
```

---

### Task 4: Verification Warn Display（面板警告条 + testNode 通道 UI）

**Files:**
- Modify: `modules/workflow/src/ui/workflow-run-panel.tsx`
- Modify: `modules/workflow/src/ui/workflow-run-panel.test.tsx`
- Modify: `modules/workflow/src/i18n/en.ts`、`zh.ts`、`it.ts`、`index.ts`

**Interfaces:**
- Consumes: Task 3 的 `WorkflowNodeRun.detail`（`verification: ` 前缀编码）、`WorkflowNodeExecutionResult.warnings`、`NodeTestState`（panel:48-54）。
- Produces: output 区顶部警告条（`verification:` 前缀且非 ok 时显示）、testNode 结果 warnings 渲染、i18n `run.verificationWarn`。

- [ ] **Step 1: Add i18n keys**

In `en.ts` `run` block（zh/it 同步）：

```ts
verificationWarn: 'Verification warning:',
```

- [ ] **Step 2: Write failing UI tests**

In `workflow-run-panel.test.tsx`:

```ts
it('shows a warning bar when the selected node detail starts with verification:', async () => {
  // run snapshot with nodes.agent.detail = 'verification: expected number'
  // select agent; assert warning bar visible with the message
})

it('does not show the bar for verification: ok or non-verification details', async () => {
  // detail 'verification: ok' -> no bar; detail 'awaiting_approval' -> no bar
})

it('shows warnings from a node test result', async () => {
  // onTestNode resolves { value, warnings: ['verification: x'] }
  // assert warnings rendered in the output area
})
```

- [ ] **Step 3: Implement**

In `workflow-run-panel.tsx`:

- `selectedNodeRun?.detail` 解析：

```ts
const selectedVerificationWarning =
  selectedNodeRun?.detail !== undefined && selectedNodeRun.detail.startsWith('verification: ') && selectedNodeRun.detail !== 'verification: ok'
    ? selectedNodeRun.detail.slice('verification: '.length)
    : null
```

- output tab 顶部（`detailTab === 'output'` 分支内、pre 之前）渲染：

```tsx
{selectedVerificationWarning ? (
  <div className="yolo-workflow-run-detail__warning" role="note">
    <AlertTriangle size={13} />
    <span>{copy.run.verificationWarn} {selectedVerificationWarning}</span>
  </div>
) : null}
```

- `testResult?.result?.warnings` 渲染：测试输出区（`testResult` 分支）在 value pre 之上显示 warnings 列表。
- `style.css` 加 `.yolo-workflow-run-detail__warning`（`yolo-` 前缀、警告色、overflow-wrap:anywhere——检查现有 run panel 样式文件位置并追加）。

- [ ] **Step 4: Run to verify green**

Run: `npx jest modules/workflow/src/ui/workflow-run-panel.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add modules/workflow/src/ui/workflow-run-panel.tsx modules/workflow/src/ui/workflow-run-panel.test.tsx modules/workflow/src/style.css modules/workflow/src/i18n
git commit -m "feat(workflow): surface verification warnings in the Run panel"
```

---

### Task 5: Model Tier Routing（settings + config + 定义解析 + UI）

**Files:**
- Modify: `modules/workflow/src/execution/workflow-definition.ts`（`createWorkflowDefinition` 加 `tierMap` 参数 + 解析顺序）
- Modify: `modules/workflow/src/execution/workflow-run-types.ts`（`WorkflowRunStartInput` 加 `tierMap`；`WorkflowRunStartFailureReason` 加 `'tier-unavailable'`）
- Modify: `modules/workflow/src/execution/workflow-run-coordinator.ts`（透传 tierMap、错误 reason）
- Modify: `modules/workflow/src/index.tsx`（settings contribution 注册 + tierMap 组装 + runStartFailureMessage）
- Modify: `modules/workflow/src/ui/workflow-studio.tsx`（inspector tier 提示）
- Modify: `modules/workflow/src/i18n/en.ts`、`zh.ts`、`it.ts`、`index.ts`
- Test: `modules/workflow/src/execution/workflow-definition.test.ts`
- Test: `modules/workflow/src/execution/workflow-run-coordinator.test.ts`
- Test: `modules/workflow/src/index.test.tsx`

**Interfaces:**
- Consumes: `createWorkflowDefinition(bundle, modelSnapshot)`（definition.ts:18-21）、`WorkflowRunStartInput`（types.ts:141-146）、`host.settings.contribute`（settings contribution 注册，`YoloModuleSettingsContributionV1`，`moduleSettingsContributions.ts:32-44`）、`host.config.getSnapshot()`（`ModuleConfigV1`）。
- Produces: `TierMap = Readonly<Partial<Record<'fast' | 'balanced' | 'deep', string>>>`；`createWorkflowDefinition(bundle, modelSnapshot, tierMap)`；解析顺序：空→默认；精确 id 优先；tier 别名→tier map（缺失/不可用 → `tier-unavailable`）；其他 → `model-unavailable`。模块 settings contribution 注册 `tier.fast/balanced/deep`（`model` 类型）。

- [ ] **Step 1: Write failing definition tests**

In `workflow-definition.test.ts`:

```ts
it('resolves a tier alias through the tier map', async () => {
  // node modelId 'fast'; tierMap { fast: 'claude-model' }; snapshot has claude-model
  // assert definition.modelByNodeId[node.id] === 'claude-model'
})

it('prefers an exact model id over a tier alias', async () => {
  // node modelId 'fast'; snapshot has a model literally named 'fast'
  // assert resolution is 'fast' (not the tier map)
})

it('fails preflight with tier-unavailable when the tier map lacks the alias', async () => {
  // node modelId 'fast'; tierMap {} -> { ok: false, error.code: 'model-unavailable' }
  // (reason mapping to tier-unavailable happens in start — assert the error message
  // mentions the tier)
})

it('fails preflight when the tier-mapped id is not in the snapshot', async () => {
  // tierMap { fast: 'missing' } -> not ok
})
```

In `workflow-run-coordinator.test.ts`:

```ts
it('returns tier-unavailable reason when definition build reports it', async () => {
  // start with tierMap lacking the alias -> { ok: false, reason: 'tier-unavailable' }
})
```

- [ ] **Step 2: Run to verify red**

Run: `npx jest modules/workflow/src/execution/workflow-definition.test.ts modules/workflow/src/execution/workflow-run-coordinator.test.ts`
Expected: FAIL（签名变化）。

- [ ] **Step 3: Implement**

In `workflow-run-types.ts`:

```ts
export type WorkflowTierMap = Readonly<Partial<Record<'fast' | 'balanced' | 'deep', string>>>
```

`WorkflowRunStartInput` 加 `tierMap?: WorkflowTierMap`；`WorkflowRunStartFailureReason` 加 `'tier-unavailable'`。

In `workflow-definition.ts`：`createWorkflowDefinition(bundle, modelSnapshot, tierMap: WorkflowTierMap = {})`；模型解析循环改为：

```ts
const modelByNodeId: Record<string, string> = {}
for (const node of topology.nodes) {
  const requested = node.modelId ?? ''
  let resolved: string
  if (requested === '') {
    resolved = modelSnapshot.defaultModelId
  } else if (modelIds.has(requested)) {
    resolved = requested
  } else if (requested === 'fast' || requested === 'balanced' || requested === 'deep') {
    const mapped = tierMap[requested]
    if (mapped === undefined)
      return unavailable(`Model tier "${requested}" is not configured; set it in the Workflow module settings`, node.id)
    resolved = mapped
  } else {
    return unavailable(`Model "${resolved}" is unavailable`, node.id)
  }
  if (!modelIds.has(resolved))
    return unavailable(`Model "${resolved}" is unavailable`, node.id)
  modelByNodeId[node.id] = resolved
}
```

In `workflow-run-coordinator.ts`：`createWorkflowDefinition(input.bundle, input.modelSnapshot, input.tierMap)`；definition 构建失败分支里区分：`built.error.code === 'model-unavailable'` 且 error.message 含 "tier" 时 reason `'tier-unavailable'`，否则 `'model-unavailable'`——**不用 message 嗅探**：让 `createWorkflowDefinition` 返回的 error 携带一个可区分标志（`error.code` 不变，加 `error.reason?: 'tier-unavailable'`？——**裁决**：`WorkflowRunError` 不加字段，改为 `createWorkflowDefinition` 的返回值在 tier 失败时返回 `{ ok: false, error: { code: 'model-unavailable', message, nodeId } }`，但 start 层无法区分——因此**给 `WorkflowDefinitionBuildResult` 加 `tierUnavailable?: true` 标志**（只在 tier 分支设置），start 层 `reason: built.tierUnavailable ? 'tier-unavailable' : 'model-unavailable'`）。

In `index.tsx`：

- 激活时注册 settings contribution：

```ts
host.settings.contribute?.({
  id: MODULE_ID,
  title: createWorkflowLocalizedText('settings.title'),
  fields: [
    { key: 'tier.fast', type: 'model', label: createWorkflowLocalizedText('settings.tier.fast') },
    { key: 'tier.balanced', type: 'model', label: createWorkflowLocalizedText('settings.tier.balanced') },
    { key: 'tier.deep', type: 'model', label: createWorkflowLocalizedText('settings.tier.deep') },
  ],
})
```

（先查 `host.settings` 是否有 `contribute`——`YoloModuleSettingsV1` 的成员名，`moduleSettingsContributions.ts:169` 附近有 `getModelSnapshot`，contribute 的准确签名以类型为准；若字段类型是 `'model'` 且要求 value 为 string，检查 `YoloModuleSettingFieldV1` 的字段形状。）

- tierMap 组装：`host.config.getSnapshot()`（先确认 `config.getSnapshot()` 返回的形状——`ModuleConfigSnapshot<T>`，取 `data` 或扁平值；若 config 读路径阻塞，按 spec 用新增的 `host.settings.getContributionValues(MODULE_ID)`——本计划默认用 config，接线层读取 `{ fast, balanced, deep }` 构造 tierMap）。
- `startRun` 回调：`tierMap` 传入 `coordinator.start`。
- `runStartFailureMessage`：`reason === 'tier-unavailable' → copy.run.modelTierUnavailable`。

In `workflow-studio.tsx`（inspector）：模型字段旁加只读提示（`run.modelTierResolved` 文案 + 上次运行解析的 id——数据源：`run?.definition.modelByNodeId[node.id]`，若有且 `node.modelId` 是 tier 别名则显示）。

- [ ] **Step 4: Add i18n keys**

en（zh/it 同步）：

```ts
modelTier: { fast: 'Fast tier model', balanced: 'Balanced tier model', deep: 'Deep tier model' },
modelTierResolved: 'Resolves to',
modelTierUnavailable: 'The requested model tier is not configured.',
settings: { title: 'Workflow', tier: { fast: 'Fast tier', balanced: 'Balanced tier', deep: 'Deep tier' } },
```

- [ ] **Step 5: Run to verify green**

Run: `npx jest modules/workflow/src/execution/workflow-definition.test.ts modules/workflow/src/execution/workflow-run-coordinator.test.ts modules/workflow/src/index.test.tsx modules/workflow/src/ui/workflow-ui.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add modules/workflow/src/execution/workflow-definition.ts modules/workflow/src/execution/workflow-run-types.ts modules/workflow/src/execution/workflow-run-coordinator.ts modules/workflow/src/index.tsx modules/workflow/src/ui/workflow-studio.tsx modules/workflow/src/i18n modules/workflow/src/execution/workflow-definition.test.ts modules/workflow/src/execution/workflow-run-coordinator.test.ts modules/workflow/src/index.test.tsx
git commit -m "feat(workflow): route nodes through fast/balanced/deep model tiers"
```

---

### Task 6: Integration and Artifacts

**Files:**
- Modify: `modules/workflow/src/workflow.execution.integration.test.ts`
- Modify: generated files under `modules/workflow/0.1.1-dev.1/`（entry.js、module.json、style.css）
- Modify only if changed: `modules/bundled.json`

- [ ] **Step 1: Add integration tests**

In `workflow.execution.integration.test.ts`（复用 fake host/fake agent；fixture 的 fake agent 需支持——检查 fake `host.agent.stream` 是否可按 tool 分发 `submit_workflow_output`，run-control 的 e2e 已扩展过 fixture，jest 集成 fixture 若没有则扩展）：

```ts
it('repairs a rejected schema submission end to end', async () => {
  // fake agent round 1 rejects then accepts; run input->agent->output
  // assert succeeded and output is the repaired value
})

it('verification hard failure fails the run with verification-failed', async () => {
  // agent node with hard verification; fake agent submits a wrong-typed value
  // assert run failed, node error code verification-failed
})

it('routes a tier alias to the mapped model', async () => {
  // workflow node modelId 'deep'; tierMap { deep: 'deep-model' }; fake model snapshot
  // assert the agent request modelId === 'deep-model'
})
```

- [ ] **Step 2: Run focused checks**

```text
npm --prefix modules/workflow test
npm --prefix modules/workflow run test:boundary
npm run module:typecheck
```

Expected: 全部通过；typecheck 0。

- [ ] **Step 3: Rebuild artifacts and commit them alone**

```bash
npm run module:build
git status --short
git add modules/workflow/0.1.1-dev.1 modules/bundled.json
git commit -m "build(workflow): regenerate execution quality artifacts"
```

Expected: 版本仍 `0.1.1-dev.1`；manifest hash/size 匹配。

- [ ] **Step 4: Verify production build and e2e**

```bash
npm run build
npm run test:workflow:e2e
```

Expected: 全链路通过；现有 19 个 e2e 不回归。
