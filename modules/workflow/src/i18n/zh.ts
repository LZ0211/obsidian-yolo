import type { WorkflowCopy } from './index'

export const zh = {
  module: {
    name: '\u6d41\u7a0b\u5de5\u4f5c\u5ba4',
    open: '\u6253\u5f00\u6d41\u7a0b\u5de5\u4f5c\u5ba4',
  },
  mode: {
    description:
      '\u8bbe\u8ba1\u5e76\u7ef4\u62a4\u7531\u6587\u6863\u9a71\u52a8\u7684 Agent \u5de5\u4f5c\u6d41\u3002',
    persona:
      '\u8bf7\u5148\u4f7f\u7528 workflow_read \u8bfb\u53d6\u7528\u6237\u8bf7\u6c42\u7684\u5de5\u4f5c\u6d41\uff0c\u518d\u8fdb\u884c\u8ba8\u8bba\u6216\u4fee\u6539\u3002\u53ea\u6709\u5728\u7528\u6237\u660e\u786e\u8981\u6c42\u65f6\u624d\u4f7f\u7528 workflow_create \u521b\u5efa\u5de5\u4f5c\u6d41\u3002\u5de5\u4f5c\u6d41\u4ecd\u7531 Workflow Studio \u4ee5\u6587\u4ef6\u65b9\u5f0f\u7f16\u8f91\uff0c\u5e76\u5728\u5f53\u524d Session \u4e2d\u6267\u884c\u3002',
  },
  chatTool: {
    readDescription:
      '\u8bfb\u53d6\u6587\u6863\u9a71\u52a8\u7684\u5de5\u4f5c\u6d41\u53ca\u5176\u58f0\u660e\u7684\u6b65\u9aa4\u6587\u4ef6\u3002',
    createDescription:
      '\u5728\u7528\u6237\u660e\u786e\u8981\u6c42\u540e\u521b\u5efa\u65b0\u7684\u6587\u6863\u9a71\u52a8\u5de5\u4f5c\u6d41\u3002',
  },
  studio: {
    title: '\u6d41\u7a0b\u5de5\u4f5c\u5ba4',
    editorOnly: '\u4ec5\u7f16\u8f91',
    sessionBoundary:
      '\u8bf7\u5728\u5f53\u524d Session \u4e2d\u8fd0\u884c\u5de5\u4f5c\u6d41\u3002',
    synced: '\u5df2\u540c\u6b65 Markdown',
  },
  state: {
    loading: '\u6b63\u5728\u52a0\u8f7d\u5de5\u4f5c\u6d41\u2026',
    empty: '\u6682\u65e0\u5de5\u4f5c\u6d41',
    error: '\u5de5\u4f5c\u6d41\u9519\u8bef',
    conflict:
      '\u6b64\u5de5\u4f5c\u6d41\u5df2\u88ab\u5176\u4ed6\u4f4d\u7f6e\u4fee\u6539\u3002',
  },
  toolbar: {
    create: '\u65b0\u5efa\u5de5\u4f5c\u6d41',
    read: '\u6253\u5f00\u5de5\u4f5c\u6d41',
    update: '\u7f16\u8f91\u5de5\u4f5c\u6d41',
    delete: '\u5220\u9664\u5de5\u4f5c\u6d41',
    import: '\u5bfc\u5165 JSON',
    export: '\u5bfc\u51fa JSON',
    save: '\u4fdd\u5b58',
    apply: '\u5e94\u7528\u4fee\u6539',
    undo: '\u64a4\u9500',
    redo: '\u91cd\u505a',
    layout: '\u81ea\u52a8\u5e03\u5c40',
    fit: '\u663e\u793a\u5168\u56fe',
    zoomIn: '\u653e\u5927',
    zoomOut: '\u7f29\u5c0f',
    flow: '\u6d41\u7a0b',
  },
  rail: {
    workflows: '\u5de5\u4f5c\u6d41',
    documents: '\u6587\u6863',
    steps: '\u6b65\u9aa4',
    addNode: '\u6dfb\u52a0\u8282\u70b9',
    master: '\u4e3b\u6587\u6863',
    stepWorkspaces: '\u6b65\u9aa4\u5de5\u4f5c\u533a',
    docsFirst:
      '\u5148\u8bfb\u53d6 WORKFLOW.md\uff0c\u518d\u8bfb\u53d6\u5404\u4e2a STEP.md',
    dragHint:
      '\u62d6\u52a8\u4e24\u4fa7\u8fde\u63a5\u70b9\u521b\u5efa\u7bad\u5934',
  },
  inspector: {
    title: '\u8282\u70b9\u5c5e\u6027',
    id: 'ID',
    label: '\u540d\u79f0',
    kind: '\u7c7b\u578b',
    stepPath: '\u6b65\u9aa4\u6587\u4ef6',
    stage: '\u9636\u6bb5',
    model: '\u6a21\u578b',
    gate: '\u903b\u8f91\u95e8',
    predicate: '\u8c13\u8bcd',
    inputPredicates: '\u8f93\u5165\u8c13\u8bcd',
    outputSchema: '\u8f93\u51fa Schema',
    source: '\u8d77\u70b9',
    target: '\u7ec8\u70b9',
    markdownContent: 'Markdown \u5185\u5bb9',
    deleteNode: '\u5220\u9664\u8282\u70b9',
  },
  nodeKind: {
    input: '\u8f93\u5165',
    agent: 'Agent',
    mapAgent: '\u6620\u5c04 Agent',
    condition: '\u6761\u4ef6',
    merge: '\u5408\u5e76',
    output: '\u8f93\u51fa',
  },
  gateType: {
    ifElse: '\u5982\u679c / \u5426\u5219',
    and: '\u4e0e',
    or: '\u6216',
    not: '\u975e',
    nand: '\u4e0e\u975e',
    nor: '\u6216\u975e',
    xor: '\u5f02\u6216',
    xnor: '\u540c\u6216',
  },
  branchLabel: {
    true: '\u771f',
    false: '\u5047',
    and: '\u4e0e',
    or: '\u6216',
    not: '\u975e',
    nand: '\u4e0e\u975e',
    nor: '\u6216\u975e',
    xor: '\u5f02\u6216',
    xnor: '\u540c\u6216',
  },
  connection: {
    invalid: '\u6b64\u8fde\u63a5\u65e0\u6548\u3002',
    duplicate: '\u8fd9\u4e9b\u8282\u70b9\u5df2\u8fde\u63a5\u3002',
    branchRequired:
      '\u8fde\u63a5\u524d\u8bf7\u9009\u62e9\u6761\u4ef6\u5206\u652f\u3002',
    branchUsed: '\u6b64\u6761\u4ef6\u5206\u652f\u5df2\u8fde\u63a5\u3002',
    gateMismatch:
      '\u5206\u652f\u4e0e\u8be5\u903b\u8f91\u95e8\u4e0d\u5339\u914d\u3002',
    gateLimit:
      '\u6b64\u903b\u8f91\u95e8\u4e0d\u80fd\u518d\u63a5\u6536\u51fa\u7ebf\u3002',
  },
  finding: {
    title: '\u9a8c\u8bc1\u53d1\u73b0',
    none: '\u672a\u53d1\u73b0\u95ee\u9898',
    severity: {
      error: '\u9519\u8bef',
      warning: '\u8b66\u544a',
      info: '\u4fe1\u606f',
    },
    invalidTopology: '\u5de5\u4f5c\u6d41\u62d3\u6251\u65e0\u6548\u3002',
    invalidStructure:
      '\u53d7\u7ba1\u7406\u7684\u7ed3\u6784\u5217\u8868\u65e0\u6548\u3002',
    cycle: '\u5de5\u4f5c\u6d41\u5305\u542b\u5faa\u73af\u3002',
    unreachable:
      '\u65e0\u6cd5\u4ece\u8f93\u5165\u5230\u8fbe\u67d0\u4e2a\u8282\u70b9\u3002',
  },
  assistant: {
    title: '\u5de5\u4f5c\u6d41\u52a9\u624b',
    model: '\u52a9\u624b\u6a21\u578b',
    instruction: '\u6307\u4ee4',
    validate: '\u9a8c\u8bc1',
    optimize: '\u4f18\u5316',
    cancel: '\u53d6\u6d88',
    proposal: '\u5efa\u8bae\u65b9\u6848',
    accept: '\u63a5\u53d7',
    reject: '\u62d2\u7edd',
    stale: '\u5efa\u8bae\u5df2\u8fc7\u671f\u3002',
    failure: '\u52a9\u624b\u8bf7\u6c42\u5931\u8d25\u3002',
    manual:
      '\u624b\u52a8 \u00b7 \u5355\u6b21 \u00b7 \u4e0d\u4f1a\u6267\u884c\u5de5\u4f5c\u6d41',
    optimizeDocument: '\u4f18\u5316\u6587\u6863',
    optimizeWorkflow: '\u4f18\u5316\u5de5\u4f5c\u6d41',
    proposalEmpty:
      '\u8fd8\u6ca1\u6709\u63d0\u6848\uff0c\u8bf7\u9009\u62e9\u4e00\u4e2a\u52a9\u624b\u64cd\u4f5c\u3002',
    changes: '\u9879\u53d8\u66f4',
  },
  document: {
    workflowTitle: '\u5de5\u4f5c\u6d41',
    structureTitle: '\u5de5\u4f5c\u6d41\u7ed3\u6784',
    topologyTitle: '\u5de5\u4f5c\u6d41\u62d3\u6251',
    step: '\u6b65\u9aa4',
  },
  chatToolError: {
    invalidWorkflow: '\u5de5\u4f5c\u6d41\u65e0\u6548\u3002',
    missingWorkflow: '\u6ca1\u6709\u53ef\u7528\u7684\u5de5\u4f5c\u6d41\u3002',
    invalidDocument: '\u5de5\u4f5c\u6d41\u6587\u6863\u65e0\u6548\u3002',
    importFailed: '\u5de5\u4f5c\u6d41\u5bfc\u5165\u65e0\u6548\u3002',
    applyFailed: '\u65e0\u6cd5\u5e94\u7528\u5de5\u4f5c\u6d41\u3002',
    invalidInput:
      '\u5de5\u4f5c\u6d41\u5de5\u5177\u8f93\u5165\u65e0\u6548\u3002',
    notFound: '\u672a\u627e\u5230\u8bf7\u6c42\u7684\u5de5\u4f5c\u6d41\u3002',
    targetExists: '\u5de5\u4f5c\u6d41\u76ee\u6807\u5df2\u5b58\u5728\u3002',
  },
} as const satisfies WorkflowCopy
