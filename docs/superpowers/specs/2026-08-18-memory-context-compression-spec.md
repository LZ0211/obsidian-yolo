# Memory 模块与上下文压缩改进 Spec

> 日期：2026-08-18
> 状态：设计已确认，待拆分实施计划
> 范围：`src/core/memory/` 记忆子系统、请求上下文装配和召回渲染
> 前置文档：`docs/memory-design.md`

## 1. 结论摘要

本 spec 只保留能够对应当前代码路径、并且有明确性能、功能或质量收益的设计。

### 本期实施

1. **TencentDB 风格的稳定/动态记忆分层**：稳定画像进入 system prompt 快照，动态召回按最新用户问题进入当前请求。
2. **端到端 token 预算**：检索层提供候选池，最终装配层使用项目现有 tokenizer 按 token 预算截断和渲染。
3. **间隔门控强化**：保留间隔学习的方向，但以生产实际的 `+0.05` 为增量，并新增独立的 `last_reinforced_at` 语义。
4. **TencentDB 风格的提取前质量门**：先以 shadow 模式测量可跳过的噪声，再启用保守的确定性跳过规则；LLM 仍负责最终 no-op 判断。

### 保留为正式架构基线，但不重复实现

- 三路检索和 RRF 融合；
- `add/update/delete/no-op` 记忆操作模型；
- 提取 prompt 的负面清单；
- Markdown 是事实源，SQLite 是索引和排序加速层。

### 后续实验

- 置信度驱动的一次性扩召回；
- 有来源、有冲突检测、有撤销记录的 LLM 记忆整合；
- 基于生产回放的衰减曲线实验。

### 明确不实施

- 用 SimHash 在索引层自动判定语义重复并合并；
- 当前的 reflective 降权和反思聚类；
- 未经本项目回放验证的固定相似度、衰减、条数和字符阈值。

## 2. 设计依据与证据等级

外部项目验证的是架构模式或任务方向，不自动证明其中的参数和实现可以直接移植。因此本 spec 将借鉴分为三类。

| 等级 | 设计 | 依据 | 当前决策 |
|---|---|---|---|
| 已验证的架构模式 | 稳定记忆与动态召回分层 | TencentDB-Agent-Memory、MemGPT/Letta、Mem0 | 本期实施 |
| 已验证的检索模式 | 多路召回 + RRF | TencentDB-Agent-Memory；当前项目已经实现 | 保留现状，后续只补元数据 |
| 已验证的上下文控制原则 | 以 token 预算控制最终请求 | Semantic Kernel history reducers、LongLLMLingua | 本期实施，使用本项目 tokenizer |
| 有价值但需本地验证 | 间隔强化、提取前质量门、自适应扩召回 | 间隔学习相关研究、TencentDB、Adaptive-RAG/CRAG | 分阶段实验 |
| 不可直接移植 | SimHash 语义去重、反思降权 | 只能证明近文本或特定 agent 任务有效 | 不实施当前版本 |

这里的“保留 TencentDB 借鉴”包括 RRF、分层注入、提取负面清单以及
`add/update/delete/no-op` 操作模型；不包括把 TencentDB 的具体阈值、供应商缓存协议或完整 LLM merge 流程原样复制到本项目。

## 3. 当前项目基线

以下事实决定了本 spec 的实现边界。

| 能力 | 当前行为 | 影响 |
|---|---|---|
| 稳定 Markdown 记忆 | `getMemoryPromptContext` 每个 scope 最多注入 2000 字符 | 已有基础预算；本期不扩大稳定记忆 |
| 动态召回注入 | 召回结果当前参与 `memory.context`，位于 system prompt 构建路径 | 会被 system prompt snapshot 冻结，后续问题不能刷新召回 |
| 召回查询 | SQLite 查询先按最多 8 条和 3000 字符筛选，之后才进入 renderer | 只改 renderer 无法恢复被查询层丢弃的候选 |
| 真实强化 | `memoryIndex.ts` 的生产路径为 `salience + 0.05` | 不能按旧 spec 的 `+0.18` 调参；`decay.ts` helper 的旧值不代表线上路径 |
| 召回时间 | `last_recalled_at` 参与 recency 和冷归档判断 | 不能把它改成“上次强化时间” |
| 检索融合 | lexical/vector/graph 三路 RRF；fusion 只返回 key 顺序 | 不依赖不存在的融合分阈值 |
| lexical path 标记 | `memoryRetrieval.ts` 当前即使无 lexical hit 也会把 `lexical` 放进 paths | C3 不能用 `!paths.includes('lexical')` 作为当前触发条件 |
| 记忆源 | Markdown 文件是可读写事实源，SQLite 是索引 | 任何 update/delete/merge 都必须先保证源文件一致 |
| 提取 | 每个非空用户回合都可能触发隐藏 LLM 提取；现有 prompt 已要求无长期记忆时 no-op | C5 需要先做观测再跳过，不能用短文本规则替代 LLM 判断 |
| 反思 | 反思写入 `memory_reflections`；普通 recall 查询 `memory_index` | 反思当前不占用普通召回上下文，S4/S5 没有直接收益 |

## 4. 目标架构

```text
Markdown memory
  ├─ stable profile/preferences ──> system prompt snapshot
  └─ indexed memory
       └─ latest user query
            └─ lexical/vector/graph + RRF
                 └─ candidate pool
                      └─ token packer
                           └─ latest user request
```

### 4.1 稳定记忆路径

- global 和 assistant scope 中的 `profile`、`preferences` 条目属于稳定记忆。
- 稳定记忆继续来自 Markdown，并保留当前每 scope 2000 字符上限。
- 稳定记忆作为独立 system section 注入，例如 `memory.stable`，参与 system prompt fingerprint 和 snapshot。
- 本期不把 `other` 类别默认放进 system。它只能通过动态召回进入请求，避免普通事件或临时事实长期占据 system cache。
- 当 SQLite 不可用时，必须提供 Markdown fallback，不能因为索引故障让已有记忆完全消失。fallback 仍受现有 bounded memory 限制，并作为当前请求的动态 memory block 注入。

### 4.2 动态召回路径

- 动态召回以最新用户问题为主，最多结合现有 recent-user-message 和 compaction summary。
- 动态召回不得参与 system prompt snapshot 的创建或复用。
- 动态 block 只修改即将发送的 `RequestMessage[]` 副本，不修改 `ChatMessage`、会话快照或已发布状态。
- 将 block 合并到最近一条真实 user message；如果请求尾部是 assistant/tool 消息，也不能在 tool 消息之后凭空追加一个破坏顺序的 user message。
- 召回失败、embedding 超时或 SQLite 不可用时，仅省略动态 block；前台回答继续使用稳定记忆和原请求路径。
- context breakdown 必须把动态 block 计入 `memory` bucket，而不是错误地计入普通 conversation token。

### 4.3 保留 TencentDB 的记忆操作模型

现有 memory agent 继续使用四种结果语义：

- `add`：新增 durable memory；
- `update`：修正或替换冲突事实；
- `delete`：删除过期或错误事实；
- `no-op`：本轮没有值得跨会话保存的内容。

`no-op` 不写 Markdown、不触发 reconcile、不改变 SQLite 索引。任何 update/delete 都必须通过现有 Markdown API，再由 reconcile 更新索引。禁止只在 SQLite 中合并或删除事实。

## 5. 本期设计一：分层注入（C4）

### 5.1 实施内容

调整 request context builder 的职责：

1. system snapshot builder 只装配稳定 memory section；
2. request assembly 在 snapshot 取得后，使用最新消息调用动态 recall；
3. 动态结果通过请求副本注入最近真实 user message；
4. `generateRequestMessages` 和 `generateRequestSections` 必须共享同一份动态结果，避免估算路径和真实请求路径召回不同内容。

建议使用明确的内部结果类型表达两部分，而不是让调用方通过字符串猜测：

```ts
type MemoryRequestContext = {
  stableSystem: string | null
  dynamicUser: string | null
}
```

具体 API 名称可按现有 builder 结构调整，但不能让动态召回重新回到 frozen system snapshot。

### 5.2 预期收益

- 多轮对话中，后续问题可以获得新的相关记忆；
- 稳定 system prompt 更适合 provider prompt cache；
- 动态 recall 不再因为首次 snapshot 而过期；
- Markdown fallback 保持索引故障时的功能连续性。

### 5.3 验收条件

- 同一 conversation 中，第一轮和第二轮使用不同查询时，动态召回内容可以不同；
- system snapshot fingerprint 不因单次动态召回结果变化；
- stable system section 在 snapshot reuse 下保持一致；
- tool loop、compaction、无 assistant、无 SQLite 四种场景均不破坏请求消息顺序；
- `generateRequestMessages` 与 `generateRequestSections` 的 memory token 归因一致。

## 6. 本期设计二：端到端 token 预算（C1 + C2）

### 6.1 预算原则

最终上下文预算只能由真正接近模型请求的装配层决定。SQLite 和各检索路径可以有防止失控的候选上限，但不能把 8 条/3000 字符继续当作最终召回预算。

- 复用 `src/utils/llm/contextTokenEstimate.ts` 的真实 tokenizer，不能新增基于 CJK 字符比例的经验公式。
- 保留候选池上限和单次请求 token budget 两个不同概念。
- 候选池负责防止 SQLite、vector、graph 在异常数据下无限增长；最终 packer 负责决定哪些条目真正进入 prompt。
- 标签、类别前缀、XML 标签、换行、省略提示和条目内容都计入最终 token budget。

### 6.2 候选层

召回链需要从“查询即最终截断”改为“查询产生有界候选”：

- `memoryIndex.query` 的条数上限提升为候选池上限，而不是固定为最终 8 条；
- 查询层的字符上限只作为故障保护，必须高于最终 render budget 对应的数据量；
- lexical、vector、graph 各自返回候选 key，RRF 继续只按 rank 融合；
- resolve fused keys 时保留融合顺序，不能重新按 category 覆盖融合顺序；
- 最终输出仍保留一个独立的 max-entry safety cap，初始值沿用 8，是否扩大由 C3 的实验决定。

候选上限、字符故障保护上限和最终 token budget 都必须命名区分，不能继续复用 `MAX_RECALL_CHARS` 表示三种语义。

### 6.3 Token packer

将 `MemoryRecallOrchestrator.render` 改为最终预算装配器：

1. 按融合顺序遍历候选；
2. 计算完整条目渲染后的 token 数；
3. 完整条目放不下时，在安全文本边界截短；
4. 单条仍无法放入时跳过该条并继续尝试后续条目；
5. 记录被截短或跳过的条目数；
6. 在剩余预算允许时追加 `[+N more omitted]`，并将提示本身计入预算。

渲染器可以由同步改为异步，因为现有 tokenizer API 是异步的。不得用字符数估算替代最终 token 计数。截断 helper 只负责 Unicode/CJK 边界安全，不负责决定预算。

### 6.4 验收条件

- 最终 `<recalled_memory>` token 数不超过配置预算；
- 长条目不会阻止后续短条目进入结果；
- 中文、英文、代码和混合文本均按同一 tokenizer 计数；
- SQLite 候选层被截断的条目数与最终 renderer 被截断的条目数可以分别观测；
- 在相同 token 预算下，短条目覆盖数不低于现状；
- 实际请求和 context breakdown 使用同一渲染结果。

## 7. 本期设计三：间隔门控强化（S1）

### 7.1 语义修正

外部设计支持“密集重复不应无限增加长期记忆强度”的方向，但当前生产实际强化量是 `+0.05`，不是旧 spec 中的 `+0.18`。因此本期不复制外部增量，只在真实生产增量上增加间隔门控。

`last_recalled_at` 继续表示最近一次召回，用于 recency 和冷归档。间隔门控需要独立的 `last_reinforced_at` 列，避免用户连续查询不断刷新召回时间后导致永远没有 spaced reinforcement。

### 7.2 设计

- `memoryIndexSchema.ts` 增加可空 `last_reinforced_at`，按该模块自己的 schema version 和显式迁移流程处理；
- 首次命中或 `last_reinforced_at` 距现在超过初始间隔时，执行生产现有的 `+0.05` 强化；
- 间隔内再次命中不增加 salience，但仍更新 `last_recalled_at`；
- 强化和时间戳必须在同一个 SQL update 中完成，避免两个请求并发时重复强化；
- 提取写入和 reconcile 不触发本规则，避免把“写入新事实”和“召回确认旧事实”混为一谈；
- 初始间隔只作为可观测实验参数，不宣称一个小时是通用最优值。

建议的 SQL 语义是“基于旧 `last_reinforced_at` 条件更新 salience，同时无条件刷新 `last_recalled_at`”，而不是先读后写的应用层判断。

### 7.3 验收条件

- 同一条记忆在间隔内多次召回，salience 至多增加一次；
- 间隔外再次召回，增加一次且执行现有的 `min(1, salience + 0.05)`；
- `last_recalled_at` 每次命中都更新，`last_reinforced_at` 仅在实际强化时更新；
- 并发召回测试不会产生双重强化；
- 冷归档仍以 `last_recalled_at` 为准。

## 8. 本期设计四：提取前质量门（C5）

### 8.1 保留 TencentDB 思路，但采用两层门

当前项目已经在 `memory_extraction_contract` 中有负面清单。C5 不替代它，而是在隐藏 LLM 调用之前增加廉价的 L1 gate：

```text
确定性 L1 gate
  ├─ 明确为空/纯空白/纯标点/控制字符 -> 直接 no-op
  └─ 其他 -> 继续现有 memory agent
                         └─ LLM contract 决定 add/update/delete/no-op
```

L1 gate 不使用“少于 3 个字符”、固定 30 秒、语言黑名单或简单的“寒暄词列表”作为唯一依据。中文短句可能包含重要偏好、身份或纠正，错误跳过的质量损失高于一次轻量提取调用。

### 8.2 上线方式

1. 先在不改变行为的 shadow 模式记录：候选跳过原因、字符长度、语言特征、后续 LLM 是否返回 no-op；
2. 用真实样本测量 precision、潜在漏检率和可节省的模型调用；
3. 只启用在人工抽样中没有发现 durable memory 漏检的确定性规则；
4. gate 命中统一记录 `extraction-skipped` flight event，并保留关闭开关；
5. provider fallback 不改变 gate 语义，gate 只减少明确无意义的调用，不负责处理 provider 错误。

### 8.3 验收条件

- 被 gate 跳过的回合不产生文件写入、reconcile 或 retry；
- 重要短事实、偏好、纠正不会被规则跳过；
- 可统计跳过率、LLM no-op 率和抽样漏检率；
- gate 关闭后行为回到现有“非空回合交给 LLM”路径。

## 9. 后续路线

### 9.1 C3：置信度驱动的有界扩召回

保留 TencentDB/Adaptive-RAG/CRAG 的“检索质量不足时才增加检索成本”原则，但不使用当前错误的 `paths` 判断。

前置工作：

- retrieval result 返回 lexical 命中数、vector top score、graph 扩展数、候选是否耗尽等真实元数据；
- 每一路候选数和最终 packer 的 token 消耗可观测；
- 明确定义一次扩召回的最大候选量和最大延迟。

第一版只允许一次、有界、可关闭的扩展。以离线 query set 和线上 shadow 结果比较 Recall@K、MRR、P95 检索延迟、embedding 调用量和最终 token 数。没有收益或延迟超标时不晋级。

### 9.2 来源一致的 LLM 记忆整合

保留 TencentDB `store/update/merge/skip` 的决策方向，但必须适配本项目的 Markdown source-of-truth：

- LLM 只能产出候选操作，不能直接写 SQLite；
- merge 必须变成 Markdown update/delete 的事务性组合；
- 保存被合并条目的来源、原文、时间和操作原因；
- 支持撤销或从历史恢复；
- reconcile 完成后才允许索引层反映新状态；
- 冲突事实必须优先保留最新明确用户陈述，不能用相似度替代事实判断。

在具备上述审计和恢复能力前，只做候选提示或人工确认，不做自动语义合并。

### 9.3 衰减曲线实验

S2 不与 S1 同批上线。先建立生产数据回放，比较现有曲线和候选曲线在以下指标上的差异：

- 之后再次被用户问题命中的记忆保留率；
- 陈旧记忆进入最终 prompt 的比例；
- 冷归档数量与库增长；
- 召回质量和 token 消耗。

没有回放结果前，保留现有衰减曲线。

## 10. 不采纳设计

| 设计 | 原因 |
|---|---|
| SimHash Hamming 阈值自动语义合并 | SimHash 适合近文本，不可靠地判断短中文语义改写；索引层合并还会绕过 Markdown 事实源 |
| reflective sector 当前直接降权 | 当前普通 recall 查询 `memory_index`，而反思产出写入 `memory_reflections`，没有可见的普通召回消费路径 |
| S5 反思聚类 | 在反思未进入普通上下文前，不会减少当前 prompt token 或改善当前召回 |
| 固定 `0.55`、`0.18`、`0.15`、`8 -> 12`、`160 chars` 等参数 | 外部项目中的局部参数不是当前项目的验证结论；参数必须来自本项目回放或保持为可调实验值 |
| 对话级 compaction | 属于 agent conversation runtime，不是本 spec 的 memory recall 问题；另立设计 |
| 多查询改写 | 会增加每轮模型调用和延迟，当前没有质量基线支持 |
| 写入 TTL 淘汰 | 与现有衰减和冷归档重叠，容易产生两个互相干扰的淘汰机制 |

## 11. 分期与实施边界

| 阶段 | 内容 | 依赖 |
|---|---|---|
| A | C4 分层注入和动态 recall 移出 snapshot | 先盘点 request builder、snapshot、compaction、tool loop 测试 |
| B | C1+C2 候选池与最终 token packer | 复用现有 tokenizer；需要同步 context breakdown |
| C | S1 独立强化时间戳与 SQL 门控 | memory index schema version、并发测试 |
| D | C5 shadow gate，再按数据启用 | flight event、采样和关闭开关 |
| E | C3 真实检索元数据与 shadow 扩召回 | A/B 完成并有 recall/token 基线 |
| F | 来源一致的记忆整合研究 | 需要 Markdown 操作审计和恢复设计 |

A-D 是本 spec 的实施范围，但每项仍独立提交、独立验证。E-F 不得作为 A-D 的隐式依赖，也不得在没有指标结果时顺手上线。

## 12. 测试与验收

### 单元测试

- stable/dynamic memory context 分割；
- system snapshot reuse 不冻结 dynamic recall；
- token packer 的完整条目、截断、跳过、`+N more` 和预算边界；
- 中文、英文、代码和混合文本的真实 tokenizer 预算；
- S1 首次命中、间隔内命中、间隔外命中和 salience=1；
- L1 gate 的空白、标点、控制字符和重要短事实反例。

### 集成测试

- `requestContextBuilder` 的真实请求和 sections 使用同一动态 memory block；
- SQLite 候选池不因最终 render budget 提前丢掉短候选；
- Markdown 写入后 reconcile 和 recall 仍可用；
- embedding 不可用、SQLite 不可用、分区 dirty 时稳定记忆和前台请求仍可工作；
- tool loop、compaction、assistant scope/global scope 和 popout 无额外请求顺序回归。

### 运行验证

按仓库指南执行：

- `npm run type:check`
- 相关 memory/request context Jest 测试
- `npm test`
- 如涉及生产 bundling 或跨平台运行时，再执行 `npm run build`

### 必须记录的指标

- 动态 recall 的候选数、最终条目数、最终 token 数和省略数；
- system stable memory token 数；
- SQLite 候选层丢弃数与 renderer 丢弃数；
- S1 实际强化次数与召回次数的比值；
- C5 gate 跳过率、LLM no-op 率、抽样漏检率；
- 前台请求 P50/P95 延迟和 embedding/提取调用量。

## 13. 风险与回滚

| 风险 | 缓解和回滚 |
|---|---|
| 动态记忆移动到 user 后模型行为变化 | 保留 feature flag；对比召回命中、回答相关性和 token breakdown；可恢复旧注入路径 |
| 候选池扩大导致 SQLite 查询变慢 | 候选上限、字符故障保护和 P95 监控；超阈值自动关闭扩大候选 |
| tokenizer 异步化放大上下文构建延迟 | 保留文本 token cache；测量 tokenizer P95；异常时只使用已有安全上限，不突破请求预算 |
| S1 schema 或并发门控错误 | 新列可空、迁移显式失败；salience 更新和时间戳同一 SQL；旧版本可关闭强化门控 |
| C5 漏掉重要短事实 | 先 shadow；规则小而确定；保留开关和抽样审核 |
| 未来 merge 误删事实 | 在 Markdown source-of-truth、审计、撤销能力完成前禁止自动 merge |
