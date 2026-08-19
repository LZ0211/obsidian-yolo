import { AlertTriangle, CircleStop, Pause, Play } from 'lucide-react'
import { useEffect, useState } from 'react'

import type { WorkflowIssue } from '../domain/workflow-model'
import type {
  JsonValue,
  WorkflowModelSnapshot,
  WorkflowNodeExecutionResult,
  WorkflowRunSnapshot,
} from '../execution/workflow-run-types'
import type { WorkflowCopy } from '../i18n'

import { parseWorkflowRunInput } from './workflow-run-input'

export type WorkflowRunPanelProps = Readonly<{
  copy: WorkflowCopy
  run: WorkflowRunSnapshot | null
  selectedNodeId: string | null
  modelSnapshot: WorkflowModelSnapshot
  dirty: boolean
  issues: readonly WorkflowIssue[]
  confirm(
    options: Readonly<{
      title: string
      message: string
      ctaText?: string
      cancelText?: string
    }>,
  ): Promise<boolean>
  onStart(input: JsonValue, modelId: string): void
  onPause(): void
  onCancel(): void
  onContinue(): void
  onSelectNode(nodeId: string): void
  /**
   * Runs the selected node through the Coordinator's ephemeral test path. A
   * handler that resolves to nothing is treated as a completed test without a
   * result; the undefined branch keeps the older pass-through wiring (the
   * Studio surface) assignable.
   */
  onTestNode?(
    nodeId: string,
    input: JsonValue,
  ): Promise<WorkflowNodeExecutionResult> | undefined
}>

type DetailTab = 'input' | 'output' | 'error'

/** Ephemeral node-test state owned by the panel, keyed to one selected node. */
type NodeTestState = Readonly<{
  nodeId: string
  status: 'running' | 'done'
  result?: WorkflowNodeExecutionResult
  error?: string
}>

/**
 * Pure Coordinator client for the Run tab. Every piece of run state (status,
 * node statuses, outputs, errors) comes from the `run` snapshot prop; the
 * panel owns only the input textarea, the model pick, and which detail tab is
 * shown. Run/Stop/Continue invoke the Coordinator through the callbacks.
 */
export function WorkflowRunPanel({
  copy,
  run,
  selectedNodeId,
  modelSnapshot,
  dirty,
  issues,
  confirm,
  onStart,
  onPause,
  onCancel,
  onContinue,
  onSelectNode,
  onTestNode,
}: WorkflowRunPanelProps) {
  const [inputText, setInputText] = useState('')
  const [inputError, setInputError] = useState<string | null>(null)
  const [runModelId, setRunModelId] = useState(() =>
    defaultRunModelId(modelSnapshot),
  )
  const [detailTab, setDetailTab] = useState<DetailTab>('input')
  const [nodeTest, setNodeTest] = useState<NodeTestState | null>(null)

  useEffect(() => {
    setRunModelId((current) =>
      modelSnapshot.models.some((model) => model.id === current)
        ? current
        : defaultRunModelId(modelSnapshot),
    )
  }, [modelSnapshot])

  // A test result belongs to the node it ran for; changing the selection
  // discards it instead of showing it under another node.
  useEffect(() => {
    setNodeTest(null)
  }, [selectedNodeId])

  const running = run?.status === 'running'
  const runningPaused = running && run?.paused === true
  // Paused runs are resumable like failed and interrupted ones; the Resume
  // button owns the paused path while Continue stays for terminal states.
  const continuable =
    run?.status === 'failed' || run?.status === 'interrupted' || runningPaused
  const runDisabled =
    dirty || issues.length > 0 || modelSnapshot.models.length === 0 || running
  const runDisabledReason = dirty
    ? copy.run.dirty
    : issues.length > 0
      ? copy.run.invalidDefinition
      : modelSnapshot.models.length === 0
        ? copy.run.noModel
        : running
          ? copy.run.alreadyRunning
          : null

  const selectedNodeRun =
    selectedNodeId !== null ? (run?.nodes[selectedNodeId] ?? null) : null
  const selectedError =
    selectedNodeRun?.error?.message ?? run?.error?.message ?? null
  const succeededCount =
    run === null
      ? 0
      : Object.values(run.nodes).filter((node) => node.status === 'succeeded')
          .length
  // The run snapshot's topology is the same frozen definition the node test
  // runs against; input nodes have nothing to test, every other kind does.
  const selectedNodeExecutable =
    run !== null &&
    selectedNodeId !== null &&
    run.definition.topology.nodes.some(
      (node) => node.id === selectedNodeId && node.kind !== 'input',
    )
  const testing = nodeTest?.status === 'running'
  const testResult =
    nodeTest !== null && nodeTest.nodeId === selectedNodeId ? nodeTest : null

  const handleRun = (): void => {
    if (runDisabled) return
    const result = parseWorkflowRunInput(inputText)
    if (!result.ok) {
      setInputError(copy.run.invalidInput)
      return
    }
    onStart(result.value, runModelId)
  }

  const handleContinue = (): void => {
    if (!continuable || running) return
    void confirm({
      title: copy.run.continue,
      message: copy.run.confirmSideEffects,
      ctaText: copy.run.continue,
      cancelText: copy.assistant.cancel,
    }).then((accepted) => {
      if (accepted) onContinue()
    })
  }

  // Resume never asks here: the Coordinator decides whether a paused run
  // needs the side-effect confirmation (in-memory pauses resume cleanly, a
  // recovered one returns `side-effect-confirmation-required` and the
  // view-level continue handler confirms before retrying).
  const handleResume = (): void => {
    if (!runningPaused) return
    onContinue()
  }

  const handleTestNode = (): void => {
    if (selectedNodeId === null || running || testing || !onTestNode) return
    const parsed = parseWorkflowRunInput(inputText)
    if (!parsed.ok) {
      setInputError(copy.run.invalidInput)
      return
    }
    setInputError(null)
    setNodeTest({ nodeId: selectedNodeId, status: 'running' })
    void Promise.resolve(onTestNode(selectedNodeId, parsed.value))
      .then((result) => {
        setNodeTest(
          result === undefined
            ? { nodeId: selectedNodeId, status: 'done' }
            : { nodeId: selectedNodeId, status: 'done', result },
        )
      })
      .catch((error: unknown) => {
        setNodeTest({
          nodeId: selectedNodeId,
          status: 'done',
          error: error instanceof Error ? error.message : String(error),
        })
      })
  }

  return (
    <section className="yolo-workflow-run-panel" aria-label={copy.run.tabs.run}>
      <div className="yolo-workflow-run-controls">
        <label className="yolo-workflow-run-controls__field yolo-workflow-run-controls__model">
          <span className="yolo-workflow-eyebrow">{copy.run.model}</span>
          <select
            aria-label={copy.run.model}
            value={runModelId}
            disabled={modelSnapshot.models.length === 0}
            onChange={(event) => setRunModelId(event.currentTarget.value)}
          >
            {modelSnapshot.models.length === 0 ? (
              <option value="">{copy.run.noModel}</option>
            ) : (
              modelSnapshot.models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                </option>
              ))
            )}
          </select>
        </label>
        <label className="yolo-workflow-run-controls__field yolo-workflow-run-controls__input">
          <span className="yolo-workflow-eyebrow">{copy.run.input}</span>
          <textarea
            aria-label={copy.run.input}
            value={inputText}
            placeholder={copy.run.input}
            onInput={(event) => {
              setInputText(event.currentTarget.value)
              setInputError(null)
            }}
          />
        </label>
        <div className="yolo-workflow-run-controls__actions">
          {running && !runningPaused ? (
            <button
              type="button"
              className="yolo-workflow-run-controls__pause"
              onClick={onPause}
            >
              <Pause size={13} />
              {copy.run.pause}
            </button>
          ) : null}
          {runningPaused ? (
            <button
              type="button"
              className="yolo-workflow-run-controls__resume"
              onClick={handleResume}
            >
              <Play size={13} />
              {copy.run.resume}
            </button>
          ) : null}
          {running ? (
            <button
              type="button"
              className="yolo-workflow-run-controls__stop"
              onClick={onCancel}
            >
              <CircleStop size={13} />
              {copy.run.stop}
            </button>
          ) : null}
          {continuable && !running ? (
            <button
              type="button"
              className="yolo-workflow-run-controls__continue"
              onClick={handleContinue}
            >
              <Play size={13} />
              {copy.run.continue}
            </button>
          ) : null}
          <button
            type="button"
            className="yolo-workflow-run-controls__run"
            disabled={runDisabled}
            title={runDisabled ? (runDisabledReason ?? undefined) : undefined}
            onClick={handleRun}
          >
            <Play size={13} />
            {copy.run.run}
          </button>
          {onTestNode !== undefined && selectedNodeExecutable && !running ? (
            <button
              type="button"
              className="yolo-workflow-run-controls__test"
              disabled={testing}
              onClick={handleTestNode}
            >
              {testing ? copy.run.testing : copy.run.testNode}
            </button>
          ) : null}
        </div>
      </div>
      {inputError ? (
        <span className="yolo-workflow-run-input-error" role="alert">
          {inputError}
        </span>
      ) : null}
      {run === null ? (
        <div className="yolo-workflow-run-panel__empty">
          <span className="yolo-workflow-muted">{copy.run.noOutput}</span>
        </div>
      ) : (
        <>
          {continuable ? (
            <div className="yolo-workflow-run-confirmation" role="note">
              <AlertTriangle size={13} />
              <span>{copy.run.confirmSideEffects}</span>
            </div>
          ) : null}
          <div className="yolo-workflow-run-body">
            <div className="yolo-workflow-run-status">
              <span
                className={`yolo-workflow-run-status__badge yolo-workflow-run-status__badge--${run.status}`}
              >
                {run.paused === true
                  ? copy.run.status.paused
                  : copy.run.status[run.status]}
              </span>
              <span className="yolo-workflow-run-status__progress">
                {succeededCount}/{run.definition.topology.nodes.length}
              </span>
              {run.error ? (
                <span className="yolo-workflow-run-status__error">
                  {run.error.message}
                </span>
              ) : null}
            </div>
            <div className="yolo-workflow-run-nodes">
              {run.definition.topology.nodes.map((node) => {
                const status = run.nodes[node.id]?.status ?? 'pending'
                return (
                  <button
                    key={node.id}
                    type="button"
                    className={`yolo-workflow-run-node${
                      node.id === selectedNodeId ? ' is-active' : ''
                    }`}
                    onClick={() => onSelectNode(node.id)}
                  >
                    <span
                      className={`yolo-workflow-run-node__badge yolo-workflow-run-node__badge--${status}`}
                    />
                    <span className="yolo-workflow-run-node__label">
                      {node.label}
                    </span>
                    <small>{copy.run.nodeStatus[status]}</small>
                  </button>
                )
              })}
            </div>
            <div className="yolo-workflow-run-detail">
              <div
                className="yolo-workflow-run-detail__tabs"
                role="tablist"
                aria-label={copy.run.output}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={detailTab === 'input'}
                  className={detailTab === 'input' ? 'is-active' : undefined}
                  onClick={() => setDetailTab('input')}
                >
                  {copy.run.input}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={detailTab === 'output'}
                  className={detailTab === 'output' ? 'is-active' : undefined}
                  onClick={() => setDetailTab('output')}
                >
                  {copy.run.output}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={detailTab === 'error'}
                  className={detailTab === 'error' ? 'is-active' : undefined}
                  onClick={() => setDetailTab('error')}
                >
                  {copy.run.error}
                </button>
              </div>
              <div className="yolo-workflow-run-detail__content">
                {detailTab === 'input' ? (
                  <pre className="yolo-workflow-run-preview">
                    {formatRunValue(run.input)}
                  </pre>
                ) : null}
                {detailTab === 'output' ? (
                  testResult?.result !== undefined ? (
                    <pre className="yolo-workflow-run-preview">
                      {formatRunValue(testResult.result.value)}
                    </pre>
                  ) : selectedNodeRun?.output !== undefined ? (
                    <pre className="yolo-workflow-run-preview">
                      {formatRunValue(selectedNodeRun.output)}
                    </pre>
                  ) : (
                    <span className="yolo-workflow-muted">
                      {copy.run.noOutput}
                    </span>
                  )
                ) : null}
                {detailTab === 'error' ? (
                  testResult?.error !== undefined ? (
                    <div className="yolo-workflow-run-error">
                      {testResult.error}
                    </div>
                  ) : selectedError !== null ? (
                    <div className="yolo-workflow-run-error">
                      {selectedError}
                    </div>
                  ) : (
                    <span className="yolo-workflow-muted">
                      {copy.run.noOutput}
                    </span>
                  )
                ) : null}
              </div>
            </div>
          </div>
          <div className="yolo-workflow-run-output">
            <span className="yolo-workflow-eyebrow">{copy.run.output}</span>
            {Object.keys(run.outputs).length === 0 ? (
              <span className="yolo-workflow-muted">{copy.run.noOutput}</span>
            ) : (
              <pre className="yolo-workflow-run-output__value">
                {formatRunValue(run.outputs)}
              </pre>
            )}
          </div>
        </>
      )}
    </section>
  )
}

function defaultRunModelId(modelSnapshot: WorkflowModelSnapshot): string {
  return (
    modelSnapshot.models.find(
      (model) => model.id === modelSnapshot.defaultModelId,
    )?.id ??
    modelSnapshot.models[0]?.id ??
    ''
  )
}

function formatRunValue(value: JsonValue): string {
  return JSON.stringify(value, null, 2)
}
