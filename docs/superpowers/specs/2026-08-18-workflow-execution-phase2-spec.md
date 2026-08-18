# Workflow 模块执行增强 Spec（Phase 2，修订版）

> 日期：2026-08-18
>
> 状态：核心设计已确认，等待书面复核，尚未实施
>
> 范围：`modules/workflow` 的 Studio 执行、运行恢复与单节点测试
>
> 前置：`docs/superpowers/plans/2026-08-17-workflow-module.md`、`docs/superpowers/specs/2026-08-18-workflow-studio-polish-design.md`

## 1. 结论

Phase 2 在 Workflow 模块内部增加一个最小 `WorkflowRunCoordinator`，只负责：

1. 固化一次运行所使用的 Workflow 定义；
2. 按现有无环拓扑确定节点顺序和分支；
3. 对需要模型的节点调用现有 `host.agent.stream`；
4. 保存节点状态和完整输出，使中断后的同一次运行可以继续；
5. 向 Workflow Studio 和 `host.background` 发布同一份运行快照。

它不是第二个 Agent runtime。模型调用、内置工具、权限审批、取消信号和工具生命周期全部复用 Host Agent。Workflow chat mode 继续只提供 `workflow_read`、`workflow_create` 和工作流讨论能力，不增加运行工具。

本设计不修改 Host Core、不扩 Host API、不新增 SQLite、不建立兼容层，也不保留 prompt 驱动执行与 Coordinator 执行两条并行路径。Workflow Studio 是本期唯一运行入口。

## 2. 目标与非目标

### 2.1 目标

- 从 Studio 可靠执行已保存且验证通过的六类节点。
- 模型节点仍是一轮现有 `host.agent.stream`，不复制 Agent loop。
- 模型输出通过 run-scoped 工具提交结构化结果，不解析最终文本中的 JSON。
- 运行定义在开始时冻结；运行期间编辑文件不会改变正在执行的内容。
- 关闭 Studio 或切换 Obsidian 窗口后，运行继续并可从任意 Studio 实例观察。
- 插件重载或 Obsidian 异常退出后，恢复已完成节点，显式重跑未确认完成的节点。
- 运行状态、图上节点状态、底部面板和后台活动来自一个状态源。
- 提供复用相同节点执行器的单节点测试，不再实现另一套测试逻辑。

### 2.2 明确不做

- 自动重试、指数退避、节点级 retry 配置。
- 跨运行 memoization、全局结果缓存、数据钉住和 time-travel。
- 循环、动态改图、manager agent 或任意表达式引擎。
- 跨重启 HITL、等待事件节点、定时器和 deadline 调度。
- 并行执行普通 DAG 分支；只有 `mapAgent` 的 item 可以有限并发。
- LLM 驱动的 merge、隐藏的 summarize 调用或自动补写输出。
- 发布版本、draft/published 双态、跨设备运行同步和历史运行浏览器。
- 从聊天工具、命令面板或外部协议启动 Workflow。

这些能力只有在真实使用证明有必要后再单独设计，不能预埋状态或兼容字段。

## 3. 当前基线与需要修正的旧方案

当前模块已经具备：六类节点、八类 gate、无环拓扑验证、Markdown/STEP 文件、Studio 编辑状态、`host.agent.stream`、Host API `1.8.0` 的 `privateStorage` 与 `background`。当前没有 run 记录和执行协调器。

原 Phase 2 草案不再采用，原因如下：

- 让模型调用 `workflow_run_update` 自报进度，模型输出不能成为确定性运行状态。
- 仅保存 preview/hash 无法恢复下游执行；恢复必须保留完整 JSON-compatible 输出。
- SQLite 与 Vault run-log 都重复了已有 `privateStorage.deviceLocal`。
- 自动 retry、HITL、循环、变量语法和执行 UI 同时进入一期，状态数量和竞态远大于收益。
- chat mode 的持久工具不适合作为 Studio 长任务的控制面，也会把执行入口扩散到会话。
- 旧 `inputHash` 未覆盖 STEP 内容、模型和执行策略，跨运行复用可能执行错误定义。

修订版只保留“确定顺序、保存输出、可取消、可恢复、可观察”这一条最小闭环。

## 4. 架构与所有权

### 4.1 组件

| 组件 | 唯一职责 | 依赖 |
|---|---|---|
| `WorkflowRunCoordinator` | 启动、取消、恢复、订阅和每个 Workflow 的活动运行排他 | repository、executor、device-local storage、background |
| `WorkflowDefinitionSnapshot` | 一次性冻结拓扑、STEP、有效模型和执行策略 | repository、model snapshot |
| `WorkflowNodeExecutor` | 执行一个节点并返回 JSON-compatible 结果 | `host.agent.stream`、schema validator |
| `WorkflowRunStore` | 每个 Workflow 保存一份最新运行快照 | `host.privateStorage.deviceLocal` |
| Studio Run 面板 | 收集输入、发送命令、展示 Coordinator 快照 | Coordinator，不直接调 Agent/Storage |

`activate(host)` 只创建一套 repository、Coordinator、executor 和 store。Coordinator 在注册可操作的 Studio 入口前完成一次 `initialize()`：读取最新 run、把遗留 `running` 转为 `interrupted`、恢复 background activity，避免启动恢复和用户 start 并发。所有 Studio 窗口共享这些服务；编辑器模型仍按 view 实例隔离。模块停用时通过 `host.lifecycle.onQuiesce` 中断活动调用并持久化为 `interrupted`。

### 4.2 单轨数据流

```text
Studio Run
  -> WorkflowRunCoordinator
     -> repository 读取一次 WORKFLOW.md + 全部 STEP.md
     -> 构造不可变 WorkflowDefinitionSnapshot
     -> WorkflowNodeExecutor
        -> host.agent.stream（仅 agent/mapAgent/condition）
     -> privateStorage.deviceLocal 持久化
     -> subscribe / host.background 发布
```

Studio 不保存平行的 run reducer，不直接拼 prompt，不直接写运行文件。Agent 不写运行状态；run-scoped 提交工具只把当前调用的结果交回 `WorkflowNodeExecutor`。

单节点测试也通过 Coordinator 的 `testNode(viewId, ...)` 进入 executor。Coordinator 只按 view id 保存一个临时 test controller；view lifecycle 负责取消它，不把测试状态混入持久 run。

### 4.3 并发边界

- 同一个 Workflow 同时最多一个完整运行；来自另一个窗口的重复启动返回 `already-running`。
- Coordinator 在任何异步预检前同步保留 Workflow path；预检失败再释放。这个仅是内存中的 start reservation，不增加持久状态。
- 不同 Workflow 可以并行，且写不同的私有存储文件。
- 一个完整运行按稳定拓扑顺序串行执行节点，避免分支并发带来的工具副作用顺序和取消竞态。
- `mapAgent` 使用固定并发上限 `3`，不提供用户配置，也不保存 item 级状态。
- 每个 run 只有一个控制任务和一个 `AbortController`；不增加全局锁、轮询器或任务队列。

## 5. 运行定义冻结与预检

### 5.1 启动条件

Studio 只有同时满足以下条件才能启动：

- 当前 Workflow 已保存，`dirty === false`；
- repository 可以读到 `WORKFLOW.md` 和每个声明的 `STEP.md`；
- document 与 topology 没有 validation issue；
- 所有 `outputSchema` 都是合法 JSON Schema；
- 每个 `agent`、`mapAgent`、`condition` 都能解析到可用模型；
- 当前 Workflow 没有活动运行。

预检失败不创建 run，也不调用模型。用户在运行开始后可以切换 Workflow；正在运行的 Workflow 保持后台执行。为避免“画布内容与运行状态不是同一版本”，当前 Workflow 有活动运行时，其拓扑和 STEP 编辑控件只读，运行终止后恢复编辑。

### 5.2 模型解析

- Run 面板提供一个“默认执行模型”，初始值来自 Host model snapshot 的默认模型。
- 节点 `modelId` 为空时使用本次运行的默认执行模型；非空时必须精确匹配 Host model id。
- 不把 provider 保存为独立状态，也不把字符串 `default` 解释为特殊模型。
- 开始运行时保存解析后的 node-to-model 映射；运行中模型设置改变不偷偷切换模型。
- 运行开始后模型被删除或不可用，由 `host.agent.stream` 正常报错并终止当前节点。

现有示例中的 `modelId: "default"` 应移除，避免一个不存在的伪模型身份。

### 5.3 定义快照与 hash

`WorkflowDefinitionSnapshot` 保存：

- Workflow path；
- 从 `WORKFLOW.md` 提取的共享 Workflow 正文上下文；
- 去除纯布局坐标后的执行拓扑；
- 每个节点对应的完整 STEP 内容；
- 每个模型节点解析后的 Host model id；
- 固定执行策略：`capability: 'vault-write'`、map 并发 `3`、merge 策略；
- `definitionHash`。

`definitionHash` 对上述内容的 canonical JSON 计算 SHA-256。节点位置等纯 UI 字段不参与 hash；Workflow 正文、STEP 正文、边、分支、schema、模型和策略必须参与。hash 只用于标识本次运行定义和排查问题，不用于跨运行缓存。

运行期间不再读取实时 Workflow 文件。用户后续保存的修改只影响下一次新运行。

### 5.4 Obsidian Markdown 与 frontmatter 边界

Workflow 继续把 Obsidian Markdown 当作用户可拥有的产品格式，而不是只把 `.md` 当 JSON 容器：

- `WORKFLOW.md` 的普通正文负责目标、说明和人类可读的执行约定；
- 每个 `STEP.md` 负责该节点的完整指令、示例、链接和附件引用；
- managed structure/topology block 是拓扑与执行字段的唯一机器真相；
- 用户已有的 YAML frontmatter、正文、wikilink、embed、callout 和标签在保存时保持原样；
- 用户可以直接使用 Obsidian 原生 `tags`、`aliases`、`cssclasses` 等 frontmatter 做检索和展示，Workflow 模块不复制这些能力。

Phase 2 不新增必填的私有 frontmatter schema，也不把 model、predicate、outputSchema、run status 或 output 同时复制到 frontmatter。否则同一执行字段会在 frontmatter、managed block 和 private storage 出现多份真相。运行记录频繁变化且不应污染用户笔记，因此只进入 `privateStorage.deviceLocal`；本期也不自动生成 run-log Markdown。

开始运行时从 `WORKFLOW.md` 移除 YAML frontmatter 和两段 managed blocks，剩余 Markdown 作为所有模型节点共享的 `workflowContextMarkdown`。这样目标、约束、wikilink、embed 和正文说明真实参与执行，同时不会把拓扑 JSON 重复塞进 prompt。frontmatter 默认仍是 Obsidian 元数据，不暗中改变执行语义。

## 6. 数据契约与节点语义

### 6.1 通用值与输入包

节点输入输出只允许 JSON-compatible value：`null`、boolean、finite number、string、array 和 plain object。不能持久化的值在进入状态前直接失败。

协调器向模型节点提供稳定输入包：

```ts
type WorkflowNodeInput = Readonly<{
  workflowInput: JsonValue
  upstream: readonly Readonly<{
    nodeId: string
    edgeLabel?: string
    value: JsonValue
  }>[]
}>
```

`upstream` 按拓扑稳定顺序排列。数据身份使用不可变 node id，不使用可修改的显示 label。edge label 仅作为提示，不承担字段选择或变量表达式语义。

### 6.2 六类节点

| kind | 执行语义 | 输出 |
|---|---|---|
| `input` | 不调用模型；每个 input 节点接收同一个 run input | run input |
| `agent` | 使用 STEP 作为节点指令，调用一次 `host.agent.stream` | 结构化提交值或最终文本 |
| `mapAgent` | 必须只有一个活动上游且其值是 array；对每个 item 调用同一 agent executor | 按原 index 排列的结果 array |
| `condition` | 调用一次 agent，让模型对活动上游分别提交 boolean 判断；Coordinator 计算 gate | 原活动上游数据透传 |
| `merge` | 不调用模型；按策略合并所有活动上游 | 合并后的 JSON value |
| `output` | 不调用模型；单一活动上游原样返回，多上游按 source node id 组成 object | 最终 run output |

非 input 节点如果没有活动入边则标记为 `skipped`。普通边仅在 source `succeeded` 时激活；condition 边按 gate 结果激活。所有 output 节点都被跳过仍是一个成功运行，最终 `outputs` 为空对象，不额外调用模型猜测结果。

Condition 在分支裁剪后仍必须满足 gate 的运行时输入数量：`ifElse`/`not` 恰好一个，其他 gate 至少两个；不满足时该 condition 与下游一起 `skipped`，不让模型对残缺输入猜测。`mapAgent` 的活动入边数量不等于一个则是定义与实际路由不匹配，明确失败。

### 6.3 Agent 输出协议

每个 `agent`/`mapAgent` 调用仍是一次 `host.agent.stream`：

- `systemPrompt` 由稳定的执行协议、共享 Workflow 正文、节点 STEP 和输出要求组成；
- 动态 `WorkflowNodeInput` 或 map item 放入 `prompt`，不混入 system prompt；
- 不写入 run id、当前时间或其他破坏 prompt cache 前缀的内容；
- `capability` 固定为 `vault-write`，Host 原有工具权限和审批逻辑保持不变；
- `signal` 使用 Coordinator 的 run AbortSignal。

节点存在 `outputSchema` 时，request 注入 run-scoped `submit_workflow_output`：

```ts
{
  type: 'object',
  properties: { value: node.outputSchema },
  required: ['value'],
  additionalProperties: false
}
```

Host tool gateway 先校验工具参数，handler 再保存第一个合法 `value`。流结束时没有成功提交则节点失败；后续重复提交返回 tool error，不覆盖第一次成功值。没有 `outputSchema` 时使用 `completed.text` 字符串，不尝试从文本提取 JSON。

模块使用一个标准 JSON Schema validator 在预检和非模型节点输出处执行同一契约，不实现自定义 schema 语言。

### 6.4 `mapAgent`

- 输入不是 array、存在零个或多个活动上游时直接失败。
- 固定最多三个 item 同时调用，结果按输入 index 排序，不按完成顺序排序。
- 任一 item 失败时 abort 尚未完成的 sibling，整个节点失败。
- 不保存 item 级 ledger，不支持部分成功继续；手动恢复会重跑整个 map 节点。
- 空数组直接成功并输出空数组，不调用模型。

这个边界保留 fan-out 的主要性能收益，同时避免 item checkpoint、部分失败 UI 和嵌套重试状态机。

### 6.5 `condition`

不执行 `predicate` 字符串，也不引入 JavaScript、JSONPath 或另一套表达式引擎。`predicate` 与 `inputPredicates[sourceNodeId]` 是给条件 Agent 的自然语言判断标准；STEP 提供补充上下文。

Condition request 注入 run-scoped `submit_workflow_condition`。其 schema 要求模型为每个活动 source node id 提交且只提交一个 boolean。Coordinator 对这些 boolean 执行既有 gate：

- `ifElse`：唯一输入值决定 `true` / `false`；
- `and` / `nand`：全部为真 / 其反值；
- `or` / `nor`：至少一个为真 / 其反值；
- `not`：唯一输入值取反；
- `xor` / `xnor`：奇数个为真 / 偶数个为真。

`ifElse` 激活对应 `true` 或 `false` 边。其他 gate 在结果为真时激活标有该 gate 名称的全部出边，结果为假时不激活出边。模型只负责语义判断，分支和真值表由确定性代码控制。

Condition 节点的数据输出不替换成 boolean：单一活动上游原样透传，多上游按 source node id 组成 object。gate 判断另存为节点的 `conditionResult`，供恢复时重建相同的活动分支。这样 condition 只控制路由，不吞掉下游仍需使用的数据。

Inspector 必须为 condition 的每条入边提供对应的自然语言 input predicate 编辑入口。示例 `findings.length > 0` 改成“findings 列表非空”，避免暗示它会执行代码。

### 6.6 `merge`

节点只增加一个必要字段：

```ts
mergeStrategy?: 'concat' | 'dedupe'
```

缺省为 `concat`：按活动上游的稳定顺序将 array 展开一层，scalar 作为单个 item。`dedupe` 在 concat 后按 canonical JSON 去重并保留首次出现顺序。两种策略都不调用模型。

不提供 `summarize`。需要总结时，用户显式连接一个 `agent` 节点，使成本、权限、失败和输出契约都可见。

## 7. 顺序调度、状态与恢复

### 7.1 状态模型

```ts
type WorkflowRunStatus =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

type WorkflowNodeRunStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
```

审批等待、模型生成和工具调用是 `running` 下的展示 detail，不增加持久状态枚举。工具事件 `awaiting_approval` 只把 detail 显示为“等待审批”；权限请求仍由 Host 管理。

每个 run 记录：schema version、run id、Workflow path、definition snapshot/hash、默认模型、输入、状态、按 node id 保存的 node status/完整 output/conditionResult/error/timestamps，以及最终 outputs。UI preview 从完整值派生，不另存 preview 状态。

### 7.2 调度规则

1. 预检完成后创建所有节点为 `pending` 的记录并持久化；
2. 按 `topologicalWorkflowOrder` 的稳定顺序处理节点；
3. 调用外部 Agent 前先持久化节点 `running`；
4. 得到合法输出后先持久化节点 `succeeded` 和完整输出，再进入下一个节点；
5. 分支未激活的节点持久化为 `skipped`；
6. 第一个失败节点终止 run，不继续执行后续节点；
7. 全部可达节点结束后汇总 output 节点并标记 `succeeded`。

一次 run 内已经 `succeeded`/`skipped` 的节点不会在恢复时重跑。这是本期唯一 memoization；新 run 永远从头执行。

### 7.3 存储

- 使用 `host.privateStorage.deviceLocal`，不写 Vault、SQLite 或同步目录。
- 每个 Workflow path 的 SHA-256 对应 `runs/<pathHash>.json`，文件中只保留该 Workflow 最新的一次 run。
- 不建立 run index；启动时递归列出 `runs/` 并读取记录。
- 每次状态转换写完整 run snapshot，避免 ledger 行与主记录不一致。
- 超过 Host private storage 16 MiB 限制时明确失败，不截断恢复所需输出。
- 新 run 覆盖该 Workflow 的旧终态记录；本期没有历史列表和清理状态机。

### 7.4 异常退出与手动恢复

模块启动时发现持久化 run 为 `running`，先转换并保存为 `interrupted`，绝不自动调用模型。Studio 与 background 提供“继续”入口：

- 已 `succeeded`/`skipped` 的节点和输出保持不变；
- 最后一个 `running`、`failed` 或未开始的节点重置为 `pending`；
- 从该节点继续顺序执行；
- definition snapshot 保持原样，Workflow 文件已修改也不会混入旧 run。

Agent 工具可能在状态落盘前已经产生外部副作用，因此恢复是 **at-least-once**，不是 exactly-once。对 `interrupted` 或 storage failure 的重跑，UI 必须明确提示当前节点可能已经产生部分副作用，由用户确认后继续。不得用复杂事务或幂等推断掩盖这个事实。

普通 `failed` run 也使用相同的手动继续入口；本期不自动 retry、不计 attempt、不做 backoff。

### 7.5 取消与竞态

- `cancel(runId)` 先标记 cancel requested，再 abort 当前 Agent 调用。
- 每个异步完成回调提交前检查 run id、node id 和 terminal/cancel 标记。
- cancel 先被接受时，迟到的 text/tool/completed 事件全部忽略，run 最终为 `cancelled`。
- 节点成功已经持久化后才收到 cancel，则成功结果有效，取消从下一节点边界生效。
- transition 只由该 run 的单一控制任务串行提交；不增加互相等待的 mutex。
- view unmount 只取消订阅，不取消 run。module quiesce 才把活动 run 变为 `interrupted` 并 abort。

## 8. Studio 交互

### 8.1 一个底部工作区

现有底部 Assistant 区域改为 `Assistant` / `Run` 两个页签，保持一个底部工作区，不叠加第二个 drawer、modal 或悬浮状态面板。

Run 页签包含：

- 默认执行模型；
- 输入 textarea：空白为 `null`，合法 JSON 按 JSON value 使用，其他文本按 string 使用；
- Run / Stop / Continue 主操作；
- 总进度与节点状态列表；
- 当前选中节点的输入、输出或错误；
- 最终 output；
- interrupted 重跑的副作用提示与确认。

顶部 toolbar 增加一个明确的 Run/Stop 主按钮，并删除“只能在 Session 执行”的旧文案。toolbar 操作只切换到 Run 页签并调用 Coordinator，不维护另一份 busy 状态。

### 8.2 图与面板同步

- 图节点只根据 Coordinator snapshot 显示 pending/running/succeeded/failed/skipped badge。
- Run 列表点击节点复用现有 `selectedNodeId` 和 focus 行为，不创建第二个 selection。
- 多窗口订阅同一 snapshot；一个窗口启动/取消后其他窗口立即反映。
- 切换到其他 Workflow 后，只显示对应 path 的最新 run。
- failed/interrupted 后不自动弹窗，不抢焦点；使用现有 notice、Run 页签和 background activity。
- 所有新文案通过模块 i18n；所有 DOM、focus、clipboard 和尺寸行为使用 view 的 `ownerDocument/defaultView`，并覆盖 popout。

### 8.3 后台活动

- `running`：`host.background.upsert` 显示 Workflow 名和当前节点；点击打开对应 Studio/Run 页签。
- Host 工具等待审批时仍是 `running`，detail 显示等待审批。
- `failed`：保留 failed activity，点击查看错误。
- `interrupted`：使用 reminder activity，点击进入继续入口。
- `succeeded`/`cancelled`：移除 activity，不用 timer 延迟清理。

## 9. 单节点测试

单节点测试在完整 run 闭环稳定后实现，但仍属于 Phase 2：

- 入口位于 Run 页签，使用当前选中节点和手工 JSON-compatible 输入；
- 调用 Coordinator 的 `testNode(viewId, ...)`；普通值作为一个 synthetic upstream，多入边 condition/merge 使用按真实 predecessor node id 组织的 object；
- 复用同一个 `WorkflowNodeExecutor`、模型解析、schema 校验、权限和 prompt 构造；
- 不创建持久 run、不写 background、不执行依赖节点；
- 每个 Studio view 同时最多一个 node test，关闭 view 时 abort；
- 完整 run 活动时禁止对同一 Workflow 做 node test；
- 不提供 pin、mock output、历史样本或“从此节点继续”。

测试 agent 节点仍具有正常 `vault-write` capability，Host 审批照常生效，避免测试环境与真实执行行为不一致。

## 10. 错误处理

内部只保留少量稳定错误分类：

- `invalid-definition`：文件、拓扑、schema 或节点输入契约不合法；
- `model-unavailable`：预检时无法解析模型；
- `agent-failed`：Host stream error、异常结束或缺少结构化提交；
- `invalid-output`：输出不是 JSON-compatible 或不满足 schema；
- `storage-failed`：run snapshot 无法读写；
- `cancelled`：用户主动取消；module quiesce 使用 `interrupted`，不伪装成用户取消。

持久记录保存 code、节点 id 和可诊断 message；UI 根据 code 显示本地化标题，同时保留原始 message 供排查。不得 catch 后静默继续、把 schema 错误转成文本输出，或自动换模型重试。

## 11. 性能与成本

- 普通 DAG 节点串行，避免并发工具副作用与复杂调度；map 固定并发 `3` 提供最有价值的吞吐提升。
- merge/input/output 不调用 LLM；condition 每个节点只调用一次 LLM。
- 稳定 protocol 与 STEP 放在 system prompt，动态输入放在 prompt；同一 map 的多个 item 共享相同前缀，提高 provider prompt cache 命中率。
- 共享 Workflow 正文位于节点 STEP 之前，使同一 run 的模型调用复用更长的稳定前缀。
- 不保存 token stream、完整 Agent transcript、UI preview 副本或跨运行 cache。
- 每个节点最多两次正常存储写入（running、terminal）；不按 text delta 写盘。
- Studio 通过 subscription 更新，不轮询 storage 或 Vault。

## 12. 测试与验收

### 12.1 Domain / Coordinator 单测

- 稳定拓扑顺序、分支激活、无活动入边 skip 和多 output 汇总；
- 六类节点的输入输出契约；
- 八类 gate 真值表和动态 condition tool schema；
- `concat`/`dedupe` 稳定顺序；
- map 最大并发为 3、结果保持 index、首错 abort、空数组不调用模型；
- 有 schema 必须调用 submit tool，无 schema 只使用 completed text；
- definition hash 覆盖 STEP/模型/策略且忽略 position；
- 同 Workflow 重复 start 被拒绝，不同 Workflow 可独立运行；
- storage 在每个外部调用边界前后落盘；恢复不重跑已成功节点；
- cancel/completed 竞态、迟到事件、module quiesce 和 storage failure；
- 所有发布 snapshot 不可变。

### 12.2 Studio 集成测试

- dirty/invalid/no-model/already-running 的禁用状态和可理解原因；
- 从输入、点击 Run、Agent 事件、节点 badge 到最终 output 的完整链路；
- Stop、failed、interrupted、Continue 与副作用确认；
- 多 view 同步、view unmount 后继续、background 点击回到正确 Workflow；
- Run/Assistant 页签、节点列表和图共用 selection；
- main window 与 popout 的点击、focus、textarea、滚动和关闭行为；
- narrow/wide、light/dark、长错误、长 JSON、空输出和 map 大列表不重叠或遮挡主操作。

测试使用 fake Host Agent、private storage 与 background 完成可重复的端到端链路，不要求用户进入 Obsidian 手工验证。

### 12.3 必跑命令

```text
npm --prefix modules/workflow test
npm --prefix modules/workflow run test:boundary
npm run module:typecheck
npm run module:build
npm run build
```

## 13. 分批实施与提交边界

1. **Coordinator domain**：run 类型、定义冻结、store、纯调度与单测。
2. **Node executor**：Agent/condition 提交工具、map、merge、schema 与单测。
3. **Module wiring**：`activate` 单例、quiesce、background 和集成测试。
4. **Studio Run UI**：页签、输入、状态、图 badge、恢复交互和 UI 测试。
5. **Single-node test**：复用 executor 的最小测试入口和测试。
6. **Artifacts**：module build、bundled catalog 和最终生产 build。

每批独立提交；生成产物单独提交。不得在 Phase 2 顺便重构 editor model、Host Agent、权限模型、chat mode 或模块加载器。

## 14. 最终验收清单

- [ ] Workflow 只有 Studio Coordinator 一条执行路径，没有 `workflow_run_update` 或聊天运行工具。
- [ ] 每个模型节点只通过 `host.agent.stream` 执行，没有第二个 Agent loop。
- [ ] Agent/condition 结构化结果不依赖解析最终文本 JSON。
- [ ] 运行使用开始时冻结的 WORKFLOW/STEP/模型，不受中途编辑影响。
- [ ] 同一次 run 恢复保留完整输出且不重跑已成功节点；新 run 不复用旧结果。
- [ ] 普通节点串行，map 并发固定为 3，取消和迟到完成不会覆盖终态。
- [ ] 不存在自动 retry、循环、HITL、表达式引擎、LLM merge、历史浏览和跨设备同步的半成品字段。
- [ ] Studio、图、background 和多窗口使用同一 Coordinator snapshot。
- [ ] 权限继续由 Host `vault-write` Agent 工具模型处理，Workflow 不复制审批逻辑。
- [ ] module boundary、typecheck、模块测试、module build 和 production build 全部通过。
