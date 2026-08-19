# Workflow Phase 2 Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one reliable, resumable Workflow Studio execution path inside `modules/workflow` without changing Host Core, Host API, or the existing Markdown-first editor architecture.

**Architecture:** `WorkflowRunCoordinator` is the only owner of run state, scheduling, cancellation, recovery, subscriptions, and background activity. It freezes a definition from `WORKFLOW.md` and all `STEP.md` files, delegates model calls to the existing `host.agent.stream`, and persists the latest immutable run snapshot in `host.privateStorage.deviceLocal`. Studio, the graph, the Run panel, and background activity all consume the same Coordinator snapshot; no chat execution path, prompt-driven runner, SQLite store, retry state machine, or compatibility layer is added.

**Tech Stack:** TypeScript, React 18, Jest/jsdom, existing versioned module Host API `1.8.0`, Web Crypto SHA-256, Ajv 8 for JSON Schema validation, Obsidian Markdown/frontmatter, and the existing first-party module build.

---

## File Map

Create the execution code under `modules/workflow/src/execution/` so the editor and execution boundaries stay visible:

- `workflow-run-types.ts`: JSON-compatible values, immutable definition/run/node records, error codes, executor and Coordinator contracts.
- `workflow-definition.ts`: read-time validation, frontmatter/managed-block context extraction, model resolution, canonical definition hashing, and frozen definition construction.
- `workflow-schema.ts`: the one JSON Schema validator used for preflight and runtime output validation.
- `workflow-run-store.ts`: one latest-run file per Workflow in `privateStorage.deviceLocal`.
- `workflow-run-graph.ts`: deterministic active-edge routing, gate truth tables, merge, and output aggregation.
- `workflow-run-coordinator.ts`: the single-run controller, serial scheduler, cancellation, initialization recovery, subscriptions, and background publication.
- `workflow-node-executor.ts`: input/agent/mapAgent/condition/merge/output execution using the Host Agent API.
- `workflow-run-input.ts`: Studio input parsing and JSON-compatible validation.

Modify only the existing module surfaces that need wiring:

- `modules/workflow/src/domain/workflow-model.ts`: add the single `mergeStrategy` execution field and validate it.
- `modules/workflow/src/domain/workflow-document.ts`: expose execution-context extraction while preserving user Markdown and frontmatter on disk.
- `modules/workflow/src/index.tsx`: create one repository/definition loader/store/executor/Coordinator per module activation and wire lifecycle/background/view dependencies.
- `modules/workflow/src/ui/workflow-studio.tsx`: add Assistant/Run tabs, toolbar Run/Stop entry, shared selection, and editor locking while a run is active.
- `modules/workflow/src/ui/workflow-run-panel.tsx`: render Run controls and one Coordinator snapshot.
- `modules/workflow/src/style.css`: add only Run panel and status styles using the existing `yolo-` prefix.
- `modules/workflow/src/i18n/en.ts`, `zh.ts`, `it.ts`, `index.ts`: add all Run, recovery, error, and node-status strings.
- `modules/workflow/package.json`, `scripts/check-workflow-module-boundary.test.mjs`: declare and verify Ajv as a bundled production dependency.

Tests are kept next to the owning code, with `modules/workflow/src/workflow.execution.integration.test.ts` covering the fake Host end-to-end path. Existing editor, chat-tool, and assistant-review tests remain unchanged except where the removed “current Session execution” wording is asserted.

Generated files are touched only in the final artifact batch: `modules/workflow/0.1.1-dev.1/entry.js`, `style.css`, `module.json`, and any changed `modules/bundled.json`/`modules/catalog-v1.json` metadata. The module version remains `0.1.1-dev.1`; no release/version bump is part of this work.

## Task 1: Define Immutable Runs, Frozen Definitions, Store, and Serial Coordinator

**Files:**
- Create: `modules/workflow/src/execution/workflow-run-types.ts`
- Create: `modules/workflow/src/execution/workflow-definition.ts`
- Create: `modules/workflow/src/execution/workflow-schema.ts`
- Create: `modules/workflow/src/execution/workflow-run-store.ts`
- Create: `modules/workflow/src/execution/workflow-run-graph.ts`
- Create: `modules/workflow/src/execution/workflow-run-coordinator.ts`
- Create: `modules/workflow/src/execution/workflow-definition.test.ts`
- Create: `modules/workflow/src/execution/workflow-schema.test.ts`
- Create: `modules/workflow/src/execution/workflow-run-store.test.ts`
- Create: `modules/workflow/src/execution/workflow-run-graph.test.ts`
- Create: `modules/workflow/src/execution/workflow-run-coordinator.test.ts`
- Modify: `modules/workflow/src/domain/workflow-model.ts`
- Modify: `modules/workflow/src/domain/workflow-document.ts`

- [ ] **Step 1: Write the run contracts and failing domain tests.**

Define the smallest contracts required by the following tasks. The public records must be deeply immutable before publication:

```ts
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | Readonly<{ [key: string]: JsonValue }>

export type WorkflowRunStatus =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export type WorkflowNodeRunStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'

export type WorkflowExecutionPolicy = Readonly<{
  capability: 'vault-write'
  mapConcurrency: 3
  mergeStrategy: 'concat' | 'dedupe'
}>

export type WorkflowDefinitionSnapshot = Readonly<{
  workflowPath: string
  workflowContextMarkdown: string
  topology: WorkflowTopology
  stepContents: Readonly<Record<string, string>>
  modelByNodeId: Readonly<Record<string, string>>
  policy: WorkflowExecutionPolicy
  definitionHash: string
}>

export type WorkflowRunError = Readonly<{
  code:
    | 'invalid-definition'
    | 'model-unavailable'
    | 'agent-failed'
    | 'invalid-output'
    | 'storage-failed'
    | 'cancelled'
  nodeId?: string
  message: string
}>

export type WorkflowNodeRun = Readonly<{
  status: WorkflowNodeRunStatus
  output?: JsonValue
  conditionResult?: boolean
  detail?: string
  error?: WorkflowRunError
  startedAt?: number
  finishedAt?: number
}>

export type WorkflowRunSnapshot = Readonly<{
  schemaVersion: 1
  runId: string
  workflowPath: string
  definition: WorkflowDefinitionSnapshot
  input: JsonValue
  status: WorkflowRunStatus
  nodes: Readonly<Record<string, WorkflowNodeRun>>
  outputs: Readonly<Record<string, JsonValue>>
  error?: WorkflowRunError
  cancelRequested?: boolean
  startedAt: number
  finishedAt?: number
}>

export type WorkflowNodeExecutionRequest = Readonly<{
  definition: WorkflowDefinitionSnapshot
  node: WorkflowNode
  workflowInput: JsonValue
  upstream: readonly Readonly<{
    nodeId: string
    edgeLabel?: string
    value: JsonValue
  }>[]
  signal: AbortSignal
}>

export type WorkflowNodeExecutionResult = Readonly<{
  value: JsonValue
  conditionResult?: boolean
}>

export type WorkflowNodeExecutor = Readonly<{
  execute(
    request: WorkflowNodeExecutionRequest,
  ): Promise<WorkflowNodeExecutionResult>
  testNode(
    request: WorkflowNodeExecutionRequest,
  ): Promise<WorkflowNodeExecutionResult>
}>
```

Add `mergeStrategy?: 'concat' | 'dedupe'` to `WorkflowNode`, accept only those two values in `parseNode`/runtime-node validation, and keep it in DSH import/export. Add tests proving that an invalid strategy is rejected and that layout changes do not affect execution semantics.

- [ ] **Step 2: Run the new domain tests and verify the contracts fail before implementation.**

Run:

```text
npx jest modules/workflow/src/execution/workflow-definition.test.ts modules/workflow/src/execution/workflow-run-store.test.ts modules/workflow/src/execution/workflow-run-graph.test.ts modules/workflow/src/execution/workflow-run-coordinator.test.ts --runInBand
```

Expected: the test files fail to compile or fail with missing execution exports. No existing Workflow test should be changed to hide this failure.

- [ ] **Step 3: Implement context extraction, JSON compatibility, schema compilation, and canonical hashing.**

Add `extractWorkflowExecutionContext(content)` to `workflow-document.ts`. It must remove YAML frontmatter and both YOLO/DSH structure and topology managed blocks from the prompt-only copy, while leaving the original `WorkflowDocument.content` unchanged. The result preserves normal Markdown, wikilinks, embeds, callouts, and tags.

In `workflow-definition.ts`, build a definition only from a repository `WorkflowBundle` and a model snapshot. Reject dirty/invalid/missing-step bundles, invalid JSON Schemas, empty or unknown model ids, and non-JSON-compatible schema values. Resolve an empty node `modelId` to the run default model, require non-empty node ids to match exactly, and never interpret the string `default` specially.

Canonicalize only this object before Web Crypto SHA-256:

```ts
{
  workflowPath,
  workflowContextMarkdown,
  topology: topologyWithoutNodePositions,
  stepContents,
  modelByNodeId,
  policy,
}
```

Sort object keys recursively, preserve array order, and omit only `position.x`/`position.y`. Do not include run id, timestamps, input, locale, or provider settings in the hash. Freeze the topology, maps, policy, and returned definition.

- [ ] **Step 4: Implement the device-local latest-run store.**

Use only `host.privateStorage.deviceLocal` with keys `runs/<sha256(workflowPath)>.json`. Expose exactly:

```ts
export type WorkflowRunStore = Readonly<{
  read(workflowPath: string): Promise<WorkflowRunSnapshot | null>
  list(): Promise<readonly WorkflowRunSnapshot[]>
  write(run: WorkflowRunSnapshot): Promise<void>
  remove(workflowPath: string): Promise<boolean>
}>
```

`write` serializes one complete snapshot, `list` recursively reads `runs/`, and malformed or unsupported records surface as `storage-failed` rather than being silently repaired. There is no run index, Vault run log, SQLite table, transcript copy, preview copy, or history browser. Use the existing 16 MiB storage limit and let the Host API error be converted to the stable store error by the Coordinator.

- [ ] **Step 5: Implement deterministic graph helpers.**

`workflow-run-graph.ts` must contain pure functions for stable incoming-source ordering, active-edge selection, gate evaluation, one-level `concat`, canonical-JSON `dedupe`, and output aggregation. The helpers must implement the existing eight gates exactly:

```ts
ifElse: values.length === 1 ? values[0] : invalid
and: values.every(Boolean)
nand: !values.every(Boolean)
or: values.some(Boolean)
nor: !values.some(Boolean)
not: values.length === 1 ? !values[0] : invalid
xor: values.filter(Boolean).length % 2 === 1
xnor: values.filter(Boolean).length % 2 === 0
```

Condition data is kept separate from `conditionResult`: a single active source is passed through unchanged, and multiple active sources become an object keyed by source node id. A branch with no active incoming source is skipped deterministically; no expression interpreter is added.

- [ ] **Step 6: Implement the Coordinator with a fake executor boundary.**

The Coordinator owns one in-memory active run per Workflow path, one `AbortController` per run, and one serial control promise per run. Its injected executor contract is:

```ts
export type WorkflowNodeExecutor = Readonly<{
  execute(request: WorkflowNodeExecutionRequest): Promise<WorkflowNodeExecutionResult>
  testNode(request: WorkflowNodeExecutionRequest): Promise<WorkflowNodeExecutionResult>
}>
```

Implement these transitions:

1. Preflight and freeze the definition before creating a run.
2. Reserve the Workflow path synchronously before the first awaited preflight operation.
3. Persist all nodes as `pending` before any external Agent call.
4. Process `topologicalWorkflowOrder` serially; persist `running` before execution and terminal output before advancing.
5. Mark inactive branch nodes `skipped`.
6. Stop on the first failed node and persist `failed`.
7. Aggregate output nodes and persist `succeeded`.
8. Reject a second start for the same path with `already-running`, while allowing another path to run independently.
9. On `cancel`, persist `cancelRequested`, abort the Agent, ignore late events, and finish as `cancelled` unless a terminal node success was persisted before the cancel boundary.
10. On `initialize`, convert persisted `running` snapshots to `interrupted` without invoking the executor. `continue` resets only the last `running`/`failed` or not-yet-started node to `pending`, keeps successful outputs and the original definition hash, and requires an explicit side-effect confirmation supplied by the UI.
11. Publish every immutable snapshot to subscribers and map it to one background activity. Do not add polling, locks, retry counters, attempt ledgers, or a second reducer.

Use a monotonic per-run transition check (`runId`, `nodeId`, and terminal/cancel flags) before applying any awaited result. The transition function is the only writer to a run snapshot.

- [ ] **Step 7: Add Coordinator and domain tests for all race-sensitive behavior.**

Cover these named cases in the new tests:

```text
definition hash includes STEP content, model mapping, and policy but ignores position
frontmatter and managed blocks are excluded only from workflowContextMarkdown
store writes and reads one latest record per Workflow path
stable topological order and inactive branch skipping
all eight gate truth tables
concat and dedupe preserve stable source/first-seen order
same-path start is rejected before an async preflight race can create two runs
different paths execute independently
successful nodes are not rerun after continue
running startup records become interrupted without executor calls
cancel wins over late completed/tool results
module quiesce aborts active work and persists interrupted
published snapshots are not mutable through caller-owned input/output objects
```

- [ ] **Step 8: Run the first batch checks and commit only the execution domain.**

Run:

```text
npx jest modules/workflow/src/execution --runInBand
npm --prefix modules/workflow run typecheck
```

Expected: all execution domain tests pass and module typecheck exits `0`. Then commit only the new execution domain files and the two domain-model/document changes:

```text
git add modules/workflow/src/execution modules/workflow/src/domain/workflow-model.ts modules/workflow/src/domain/workflow-document.ts
git commit -m "feat(workflow): add resumable run coordinator domain"
```

## Task 2: Implement the Real Node Executor and Structured Agent Protocol

**Files:**
- Create: `modules/workflow/src/execution/workflow-node-executor.ts`
- Create: `modules/workflow/src/execution/workflow-node-executor.test.ts`
- Modify: `modules/workflow/src/execution/workflow-run-types.ts`
- Modify: `modules/workflow/src/execution/workflow-run-coordinator.ts`
- Modify: `modules/workflow/package.json`
- Modify: `scripts/check-workflow-module-boundary.test.mjs`

- [ ] **Step 1: Write failing executor tests with a fake `host.agent.stream`.**

Use a fake async generator that records each request and exposes the request-scoped tool handler. Assert that agent requests contain `modelId`, `capability: 'vault-write'`, stable system prefix, dynamic input only in `prompt`, the Workflow context before the STEP text, and the Coordinator signal. Assert no request contains run id, timestamp, or provider metadata.

Add failing tests for:

```text
input returns the run input without an Agent call
agent with outputSchema requires exactly one valid submit_workflow_output call
agent without outputSchema returns completed.text as a string and never parses JSON text
duplicate or invalid output submissions return tool errors and do not overwrite the first value
condition requires one boolean per active source through submit_workflow_condition
condition computes the gate in deterministic code and preserves source data as output
mapAgent rejects non-arrays and multiple active upstreams
mapAgent runs at most three calls concurrently, preserves input order, and aborts siblings after the first error
mapAgent with an empty array makes zero Agent calls
merge never calls the Agent and supports concat/dedupe
output never calls the Agent and preserves single-source values
invalid output and schema errors use stable error codes
```

- [ ] **Step 2: Add Ajv as the declared module production dependency.**

Add the existing root-resolved Ajv 8 dependency to `modules/workflow/package.json` and change the boundary test’s exact dependency list to `['ajv', 'lucide-react', 'react']`. Do not import `src/core`, `obsidian`, Node built-ins, or a second schema implementation. The first-party bundler must include Ajv in the module artifact.

- [ ] **Step 3: Implement the shared JSON Schema validator.**

Create one Ajv instance in `workflow-schema.ts`. Compile every node `outputSchema` during definition preflight and expose:

```ts
export type WorkflowSchemaValidator = Readonly<{
  validateSchema(schema: unknown): Readonly<{ ok: true } | { ok: false; message: string }>
  validateValue(schema: unknown, value: unknown): Readonly<{ ok: true } | { ok: false; message: string }>
}>
```

Reject schemas that Ajv cannot compile and reject values that are not finite JSON-compatible values before persistence. Keep the validator independent of Provider or model settings.

- [ ] **Step 4: Implement one-shot Agent execution and run-scoped tools.**

Construct the request with this stable shape:

```ts
{
  modelId,
  systemPrompt: `${stableProtocol}\n\n${workflowContextMarkdown}\n\n${stepContent}\n\n${outputInstruction}`,
  prompt: JSON.stringify({ workflowInput, upstream }),
  capability: 'vault-write',
  activity: { title: workflowLabel, detail: node.label },
  tools: [submitTool],
  signal,
}
```

For schema nodes, `submit_workflow_output` has input schema `{ type: 'object', properties: { value: <node schema> }, required: ['value'], additionalProperties: false }`. Its handler validates the complete input and stores only the first valid `value`; subsequent submissions return `{ isError: true }`. For conditions, `submit_workflow_condition` has exactly one boolean property per active source node id and rejects missing, extra, or non-boolean values. When the stream ends, a schema node without a successful submission is `agent-failed`; a no-schema node uses only `completed.text`.

Handle `error` and `aborted` events as stable executor failures. Do not parse text JSON, infer progress from model text, or let the model write run state.

- [ ] **Step 5: Implement mapAgent with a fixed three-worker window.**

Use a local index cursor and three workers. Each worker calls the same single-agent executor with an item-specific dynamic prompt, stores its result at the original index, and stops after the shared abort signal. On the first failure, abort the local sibling controller and reject the whole node; do not expose partial outputs or persist item records. An empty input returns `[]` immediately.

- [ ] **Step 6: Connect the executor result contract back to the Coordinator.**

Return a single `WorkflowNodeExecutionResult` containing `value`, optional `conditionResult`, and no UI-specific fields. The Coordinator alone decides node status, persists output, publishes detail such as `awaiting_approval`, and routes downstream nodes. Agent tool events may update the current `running` detail in memory, but they must not add a new persisted status enum.

- [ ] **Step 7: Run executor tests, boundary tests, and commit the second batch.**

Run:

```text
npx jest modules/workflow/src/execution/workflow-node-executor.test.ts modules/workflow/src/execution/workflow-schema.test.ts --runInBand
npm --prefix modules/workflow run test:boundary
npm --prefix modules/workflow run typecheck
```

Expected: executor and schema tests pass, the boundary test accepts exactly the three declared production packages, and typecheck exits `0`. Commit only this batch:

```text
git add modules/workflow/src/execution modules/workflow/package.json scripts/check-workflow-module-boundary.test.mjs
git commit -m "feat(workflow): execute nodes through host agent"
```

## Task 3: Wire One Module-Level Coordinator, Recovery, and Background Activity

**Files:**
- Modify: `modules/workflow/src/index.tsx`
- Create: `modules/workflow/src/workflow.execution.integration.test.ts`
- Modify: `modules/workflow/src/index.test.tsx`
- Modify: `modules/workflow/src/workflow.integration.test.ts`

- [ ] **Step 1: Extend the integration fixtures with device-local storage and background recording.**

Add a fake private-storage scope implementing `list`, `readJson`, `writeJson`, `removeFile`, `mkdir`, and `stat`, plus a fake background registry recording `upsert/remove`. Add a fake model snapshot with one default and one explicit model. Keep the existing Vault fixture and editor tests intact.

- [ ] **Step 2: Construct the services exactly once in `activate(host)`.**

Make module activation await Coordinator initialization before registering the operational view. The construction order is:

```ts
const repository = createWorkflowRepository(host)
const store = createWorkflowRunStore(host.privateStorage.deviceLocal)
const executor = createWorkflowNodeExecutor({ agent: host.agent, ... })
const coordinator = createWorkflowRunCoordinator({
  repository,
  store,
  executor,
  getModelSnapshot: host.settings.getModelSnapshot,
  background: host.background,
  openWorkflow: (path) => host.workspace.openView({ state: { path } }),
})
await coordinator.initialize()
host.lifecycle.onQuiesce(() => coordinator.quiesce())
```

Register the same Coordinator in every Studio view. Keep editors per view as they are today. A view lifecycle cleanup disposes only the view editor and node-test controller; it must never cancel a full run. Keep the existing chat mode with only `workflow_read` and `workflow_create`.

- [ ] **Step 3: Implement background mapping without a second state source.**

Map `running` to a background activity with status `running`, `running` plus approval detail to `waiting`, `failed` to `failed`, and `interrupted` to `reminder`. Remove the activity immediately for `succeeded` and `cancelled`. Use a deterministic activity id derived from the Workflow path and make `onOpen` open the same path in Workflow Studio. Do not use timers or a background polling loop.

- [ ] **Step 4: Pass view id, Coordinator, and run subscriptions into `WorkflowModuleView`.**

The view component must obtain the current path from the editor snapshot and subscribe to Coordinator snapshots through `useSyncExternalStore`. The current Workflow’s run snapshot is selected by path; changing Workflow changes the selected snapshot without copying run state into React local state.

- [ ] **Step 5: Add integration tests for the complete non-UI lifecycle.**

The integration test must execute `input -> agent -> output` using a fake Agent tool submission and assert the persisted output, background activity, and final run status. Add cases for activation recovery of a persisted `running` snapshot, view disposal while a full run continues, and quiesce converting an active run to `interrupted`.

- [ ] **Step 6: Run the wiring tests and commit the third batch.**

Run:

```text
npx jest modules/workflow/src/index.test.tsx modules/workflow/src/workflow.integration.test.ts modules/workflow/src/workflow.execution.integration.test.ts --runInBand
npm --prefix modules/workflow run typecheck
```

Expected: module registration, existing assistant/editor integration, lifecycle recovery, background mapping, and the fake end-to-end run all pass. Commit:

```text
git add modules/workflow/src/index.tsx modules/workflow/src/index.test.tsx modules/workflow/src/workflow.integration.test.ts modules/workflow/src/workflow.execution.integration.test.ts
git commit -m "feat(workflow): wire module run lifecycle"
```

## Task 4: Add the Studio Run Surface Without a Parallel UI State Machine

**Files:**
- Create: `modules/workflow/src/ui/workflow-run-input.ts`
- Create: `modules/workflow/src/ui/workflow-run-input.test.ts`
- Create: `modules/workflow/src/ui/workflow-run-panel.tsx`
- Create: `modules/workflow/src/ui/workflow-run-panel.test.tsx`
- Modify: `modules/workflow/src/ui/workflow-studio.tsx`
- Modify: `modules/workflow/src/ui/workflow-ui.test.tsx`
- Modify: `modules/workflow/src/i18n/en.ts`
- Modify: `modules/workflow/src/i18n/zh.ts`
- Modify: `modules/workflow/src/i18n/it.ts`
- Modify: `modules/workflow/src/i18n/index.ts`
- Modify: `modules/workflow/src/style.css`

- [ ] **Step 1: Add input parsing tests and implementation.**

`parseWorkflowRunInput(text)` returns `null` for blank input, the parsed JSON value when JSON is valid and JSON-compatible, and the original trimmed text as a string for non-JSON text. Invalid JSON must not silently become a different object, and non-finite or unsupported values are rejected before `start`.

```ts
export function parseWorkflowRunInput(
  text: string,
): Readonly<{ ok: true; value: JsonValue } | { ok: false; message: string }>
```

Add tests for blank, string, number, array, object, malformed JSON, and unsupported/non-finite values.

- [ ] **Step 2: Add i18n keys before rendering new controls.**

Extend `WorkflowCopy` with structured keys for `run.tabs.assistant/run`, `run.model`, `run.input`, `run.run`, `run.stop`, `run.continue`, `run.confirmSideEffects`, `run.invalidInput`, `run.noModel`, `run.dirty`, `run.invalidDefinition`, `run.alreadyRunning`, `run.status.*`, `run.nodeStatus.*`, `run.output`, `run.error`, `run.noOutput`, `run.testNode`, and `run.testing`. Add equivalent English, Simplified Chinese, and Italian strings. Keep all user-visible text in these copies; do not add literal labels to JSX.

- [ ] **Step 3: Implement `WorkflowRunPanel` as a pure Coordinator client.**

The panel receives `run: WorkflowRunSnapshot | null`, `selectedNodeId`, `modelSnapshot`, `dirty`, `issues`, and callbacks `start`, `cancel`, `continue`, `selectNode`, and `testNode`. It owns only the input textarea and selected tab presentation; it does not own `running`, node statuses, outputs, errors, or a second reducer.

Render:

```text
model select -> input textarea -> Run/Stop/Continue
overall status/progress -> stable node list -> selected input/output/error
final output
```

Disable Run when the editor is dirty, validation issues exist, no model resolves, or the current path already has a run. Stop is enabled only for the current run. Continue is enabled only for failed/interrupted runs and must call `confirm` with the explicit at-least-once side-effect warning before invoking Coordinator `continue`. Node list clicks call the existing `model.selectNode` callback.

- [ ] **Step 4: Add Assistant/Run tabs and the toolbar entry to `WorkflowStudio`.**

Keep the existing Assistant component and its behavior. Wrap the existing bottom workspace in two tabs; Assistant remains the current review surface, and Run renders `WorkflowRunPanel` in the same region. Add a Run/Stop button to the existing canvas toolbar that selects the Run tab and invokes Coordinator callbacks. Remove the old “Run workflows from the current session” wording from the toolbar copy.

When the current Workflow has a `running` snapshot, disable topology edits, node creation/deletion, edge changes, file edits, and assistant proposal acceptance. Do not change `WorkflowEditorModel` or create an editor lock state there. Once the run reaches a terminal state, controls become editable again. Selecting a run node calls the same `selectedNodeId`/graph focus path already used by the editor.

- [ ] **Step 5: Add status badges and layout styles using the existing module style boundary.**

Add prefixed selectors for the tabs, run controls, status badges, node list, JSON/text previews, errors, and confirmation notice. Use fixed min/max dimensions and `overflow-wrap:anywhere` for long JSON/errors. Keep the Run panel in the existing bottom workspace; do not add a modal, drawer, floating status panel, or nested card hierarchy. Add narrow-layout rules that stack controls without hiding Run/Stop/Continue.

- [ ] **Step 6: Add UI tests for wiring and interaction.**

Extend the existing jsdom tests to verify:

```text
Run tab is reachable and Assistant remains available
Run is disabled for dirty/invalid/no-model/already-running states
clicking Run passes parsed input to Coordinator and switches tab
Stop calls Coordinator.cancel and does not change local busy state
Continue requires the side-effect confirmation and then calls Coordinator.continue
snapshot updates change badges/output/error without local duplication
clicking a run node reuses selectedNodeId and graph selection
active runs make editing controls read-only and terminal runs restore them
long errors and large output stay inside the panel
```

- [ ] **Step 7: Run the UI batch and commit it separately.**

Run:

```text
npx jest modules/workflow/src/ui/workflow-run-input.test.ts modules/workflow/src/ui/workflow-run-panel.test.tsx modules/workflow/src/ui/workflow-ui.test.tsx --runInBand
npm --prefix modules/workflow run typecheck
```

Expected: all existing editor/assistant UI tests and new Run interaction tests pass. Commit:

```text
git add modules/workflow/src/ui modules/workflow/src/i18n modules/workflow/src/style.css
git commit -m "feat(workflow): add Studio run surface"
```

## Task 5: Add Single-Node Testing Through the Same Executor

**Files:**
- Modify: `modules/workflow/src/execution/workflow-run-coordinator.ts`
- Modify: `modules/workflow/src/execution/workflow-run-coordinator.test.ts`
- Modify: `modules/workflow/src/ui/workflow-run-panel.tsx`
- Modify: `modules/workflow/src/ui/workflow-run-panel.test.tsx`
- Modify: `modules/workflow/src/index.tsx`
- Modify: `modules/workflow/src/workflow.execution.integration.test.ts`

- [ ] **Step 1: Add failing tests for view-scoped node tests.**

Cover one active node test per view, no persistent store write, no background activity, no dependency execution, full-run exclusion for the same Workflow, and abort on view disposal. A synthetic upstream value is passed as one predecessor; condition and merge inputs use predecessor node ids exactly as the full-run executor does.

- [ ] **Step 2: Implement `testNode(viewId, request)` in Coordinator.**

Use the same definition snapshot, model resolution, prompt construction, schema validation, `WorkflowNodeExecutor`, and `vault-write` capability as a full run. Keep a `Map<viewId, AbortController>` only for active ephemeral tests. Return the executor result directly; do not create a `WorkflowRunSnapshot`, write device-local storage, publish background, pin output, mock dependencies, or add history.

```ts
testNode(
  viewId: string,
  request: Readonly<{
    workflowPath: string
    nodeId: string
    input: JsonValue
  }>,
): Promise<WorkflowNodeExecutionResult>
```

- [ ] **Step 3: Add the Run panel entry and view cleanup.**

Show `Test selected node` only for a selected executable node and only when no full run is active. Use the existing input parser and display the result in the selected-node output area. Pass `context.id` into the module view and cancel only that view’s node test from `context.lifecycle.add`.

- [ ] **Step 4: Run the single-node tests and commit the fifth batch.**

Run:

```text
npx jest modules/workflow/src/execution/workflow-run-coordinator.test.ts modules/workflow/src/ui/workflow-run-panel.test.tsx modules/workflow/src/workflow.execution.integration.test.ts --runInBand
npm --prefix modules/workflow run typecheck
```

Expected: node tests use the same executor path and do not alter a full-run snapshot or background registry. Commit:

```text
git add modules/workflow/src/execution/workflow-run-coordinator.ts modules/workflow/src/execution/workflow-run-coordinator.test.ts modules/workflow/src/ui/workflow-run-panel.tsx modules/workflow/src/ui/workflow-run-panel.test.tsx modules/workflow/src/index.tsx modules/workflow/src/workflow.execution.integration.test.ts
git commit -m "feat(workflow): add shared single-node testing"
```

## Task 6: Verify and Commit Generated Module Artifacts

**Files:**
- Modify: generated files under `modules/workflow/0.1.1-dev.1/`
- Modify only if generated output changes: `modules/bundled.json`, `modules/catalog-v1.json`

- [ ] **Step 1: Run the focused and required checks before building artifacts.**

Run:

```text
npm --prefix modules/workflow test
npm --prefix modules/workflow run test:boundary
npm run module:typecheck
npm run lint:check
```

Expected: all Workflow tests, boundary checks, module typecheck, Prettier, and ESLint pass. Fix source files in the earlier task commit boundaries if a failure is behavioral; do not edit generated `entry.js` by hand.

- [ ] **Step 2: Build first-party module artifacts without changing the version.**

Run:

```text
npm run module:build
git status --short
```

Expected: the existing `0.1.1-dev.1` Workflow artifact is regenerated, its manifest hashes/sizes match its entry/style/data files, and no new version directory is created.

- [ ] **Step 3: Verify the production bundle and generated metadata.**

Run:

```text
npm run build
npm run test:workflow:e2e
```

Expected: host typecheck, module typecheck/build, styles, production host bundle, package verification, and the existing Workflow browser harness pass. The browser harness uses fake Host Agent/storage where applicable; no manual Obsidian testing is required for this batch.

- [ ] **Step 4: Review generated diffs and commit artifacts alone.**

Inspect:

```text
git diff --stat
git diff -- modules/workflow/0.1.1-dev.1/module.json modules/bundled.json modules/catalog-v1.json
```

Stage only generated outputs changed by `module:build`, then commit:

```text
git add modules/workflow/0.1.1-dev.1 modules/bundled.json modules/catalog-v1.json
git commit -m "build(workflow): regenerate phase 2 module artifacts"
```

## Verification Matrix

| Spec requirement | Plan coverage |
| --- | --- |
| One Coordinator and one execution path | Tasks 1 and 3; no chat run tool or prompt runner |
| Frozen `WORKFLOW.md`/`STEP.md`/models/policy | Task 1 definition snapshot and hash tests |
| `host.agent.stream` and run-scoped submit tools | Task 2 executor tests |
| Serial DAG and fixed map concurrency 3 | Tasks 1 and 2 graph/coordinator tests |
| Deterministic condition and merge | Tasks 1 and 2 graph/executor tests |
| Device-local latest snapshot and startup recovery | Tasks 1 and 3 store/lifecycle integration tests |
| Cancel/quiesce/late-event race handling | Tasks 1 and 3 Coordinator tests |
| Single source for Studio/graph/background/multi-view | Tasks 3 and 4 wiring and UI tests |
| Assistant/Run single bottom workspace | Task 4 UI integration |
| Single-node test reuses executor without persistence | Task 5 |
| No retry, loops, HITL, cache, history, release version, or Host changes | Every task’s explicit non-goals and final diff review |
| Markdown/frontmatter ownership | Task 1 context extraction and Task 4 editor behavior |
| Boundary, module build, production build | Task 6 |

## Self-Review Checklist

- [ ] Search the finished plan for unresolved placeholder instructions or vague implementation advice; replace each with a concrete file, test, command, or explicit non-goal.
- [ ] Check that every type name used by Tasks 2–5 is defined in Task 1 or in the task that introduces it: `JsonValue`, `WorkflowDefinitionSnapshot`, `WorkflowRunSnapshot`, `WorkflowNodeExecutor`, `WorkflowNodeExecutionRequest`, and `WorkflowNodeExecutionResult`.
- [ ] Confirm no task modifies `src/core`, `modules/host-sdk.d.ts`, chat mode execution, Host permissions, module loader, editor model architecture, or the module version.
- [ ] Confirm every persisted status is one of `running`, `succeeded`, `failed`, `cancelled`, `interrupted` and that approval waiting is display detail only.
- [ ] Confirm output values are stored once in the run snapshot, previews are derived in UI, and map items have no persistent ledger.
- [ ] Confirm every task ends with a focused command and an independent commit.

Plan complete and saved to `docs/superpowers/plans/2026-08-18-workflow-execution-phase2.md`. Two execution options:

1. **Subagent-Driven (recommended)** - dispatch a fresh subagent per task and review between tasks.
2. **Inline Execution** - execute tasks in this session using executing-plans with batch checkpoints.
