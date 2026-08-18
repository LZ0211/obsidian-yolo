# Memory Context Compression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将当前记忆请求路径改造成稳定 Markdown 记忆进入 system snapshot、动态召回随最新问题刷新，并用真实 tokenizer 控制最终召回预算，同时以原子间隔门控和可观测的保守质量门降低无效成本。

**Architecture:** 保留 Markdown source-of-truth、SQLite 索引、lexical/vector/graph 三路检索和 RRF 融合。`getMemoryPromptContext` 产生的稳定 global/assistant 记忆继续留在 system snapshot；`MemoryRecallOrchestrator` 产生的 `<recalled_memory>` 在 snapshot 建立后注入最近真实 user message。检索层只提供有界候选池，最终 render 使用项目现有异步 tokenizer 进行 token packing。召回强化使用独立的 `last_reinforced_at` 原子 SQL 条件，提取质量门按 off/shadow/enabled 三态逐步上线。

**Tech Stack:** TypeScript, React/Obsidian request context builder, SQLite native runtime, Jest, project runtime tokenizer via `src/utils/llm/contextTokenEstimate.ts`, existing flight log.

---

## 文件职责与边界

| 文件 | 职责 |
|---|---|
| `src/utils/chat/requestContextBuilder.ts` | 分离 stable/dynamic memory；注入动态 block；让 sections 从同一份 request 归因 memory token。 |
| `src/utils/chat/requestContextBuilder.test.ts` | 覆盖 snapshot reuse、动态刷新、消息顺序、sections 归因和失败降级。 |
| `src/core/memory/memoryWiring.integration.test.ts` | 用真实 memory runtime 验证每轮 query、embedding cache 和分层。 |
| `src/core/memory/memoryTypes.ts` | 明确候选查询与 indexed entry 的类型语义。 |
| `src/core/memory/memoryRetrieval.ts` | 继续负责三路检索和 RRF，并返回候选统计。 |
| `src/core/memory/memoryRecallOrchestrator.ts` | 区分候选池/最终限制；实现异步 token packer 和指标。 |
| `src/core/memory/memoryRecallOrchestrator.test.ts` | 新增 token packer 单元测试。 |
| `src/core/memory/memoryIndex.ts` | 有界候选查询、融合顺序、`last_reinforced_at` 行映射和原子强化 SQL。 |
| `src/core/memory/memoryIndexSchema.ts` | memory index schema v3→v4，增加可空 `last_reinforced_at`。 |
| `src/core/memory/memoryIndexSchema.test.ts` | 验证 v4 新库、旧库迁移和幂等初始化。 |
| `src/core/memory/memoryIndexRuntime.test.ts` | 验证候选池、S1 强化和冷归档；同步手写 SQLite fixture。 |
| `src/core/memory/memoryAgent.ts` | 确定性 L1 分类、shadow/enabled 行为和 flight events。 |
| `src/core/memory/memoryAgent.test.ts` | gate 分类、重要短事实反例、shadow 和 enabled 跳过。 |
| `src/core/memory/memoryManager.ts` | 扩展 `MemorySettingsLike`。 |
| `src/settings/schema/setting.types.ts` | 增加三态 `memoryExtractionQualityGate`，默认 shadow。 |
| `src/settings/schema/settings.test.ts` | 验证旧配置默认值和三态解析。 |

本计划只实施规范中的 A–D。C3 扩召回、来源一致的 LLM merge、衰减曲线回放不进入本次提交，也不作为 A–D 的隐式依赖。

## 实施顺序

先完成 C4 分层注入，再完成候选池/token packer、S1、C5。C4 的调用点统一使用 `await`，所以后续把 render 改成异步不会产生第二条请求编排路径。每个阶段都先写失败测试，再做最小实现，阶段结束后独立提交。

### Task 1: C4 分层的失败测试

**Files:**

- Modify: `src/utils/chat/requestContextBuilder.test.ts`
- Modify: `src/core/memory/memoryWiring.integration.test.ts`

- [ ] **Step 1: 添加 snapshot reuse 与动态刷新测试**

用现有 snapshot store、SQLite reconcile 和 memory wiring harness，分别以“我喜欢极简设计”和“请推荐数据库迁移方案”作为最新 user query。断言第一轮和第二轮的 system message 完全相同，system content 包含稳定 `<global>` 或 `<assistant>`，且两轮 system 都不包含 `<recalled_memory>`；两轮最近 user message 都包含 dynamic block，内容不同。单独关闭/模拟 SQLite 后，断言 Markdown bounded fallback 出现在当前 user message 的 dynamic block 中，而不是只存在于 frozen system snapshot。

- [ ] **Step 2: 添加消息顺序和不可变性测试**

构造 `[user, assistant tool-call, tool result]`，保存输入数组的深拷贝。生成 request 后断言角色顺序仍为 `system, user, assistant, tool`，dynamic block 合并到最后一个真实 user message，而不是在 tool 后新建 user；输入数组和原始 ChatMessage 保持不变。SQLite 不可用时 dynamic block 使用 Markdown fallback；embedding provider 抛错但 SQLite 可用时只省略 dynamic index recall，不影响 stable memory 和原始 conversation。

- [ ] **Step 3: 添加 sections 共享结果测试**

调用 `generateRequestSections`，断言 dynamic block 只产生一个 `bucket: 'memory'`、id 以 `memory.dynamic.` 开头的 section，且 `conversation` section 不再包含同一 block；stable `id: 'memory.context'` 仍存在。相同 query 连续请求只创建一次 embedding client，不同 query 创建第二次；词法召回仍基于新 query 执行。

- [ ] **Step 4: 运行失败测试**

运行：

```bash
npx jest src/utils/chat/requestContextBuilder.test.ts src/core/memory/memoryWiring.integration.test.ts --runInBand
```

预期：当前 snapshot 仍冻结 dynamic block，dynamic block 不在 user，或 sections 没有独立 memory section，新增断言失败。

### Task 2: C4 移动 dynamic recall，保留 stable snapshot

**Files:**

- Modify: `src/utils/chat/requestContextBuilder.ts`
- Test: `src/utils/chat/requestContextBuilder.test.ts`
- Test: `src/core/memory/memoryWiring.integration.test.ts`

- [ ] **Step 1: 定义分层类型与 block 提取 helper**

在 request builder 类型区域增加：

```ts
type MemoryRequestContext = Readonly<{
  stableSystem: string | null
  dynamicUser: string | null
}>

const RECALLED_MEMORY_BLOCK_RE =
  /<recalled_memory(?:\s[^>]*)?>[\s\S]*?<\/recalled_memory>/gu
```

`stableSystem` 只代表 `getMemoryPromptContext` 包装的稳定 `<memory>` section；`dynamicUser` 只代表 `MemoryRecallOrchestrator.render` 的 `<recalled_memory>`，禁止用任意字符串推断来源。

- [ ] **Step 2: 从 snapshot builder 移除 dynamic recall 调用**

保留 SQLite 可用时的 `loadMemorySalience`、`getMemoryPromptContext`、global/assistant wrapper、`id: 'memory.context'` 和每 scope 2000 字符限制；删除 `buildCustomInstructionsSubsections` 中对 `buildIndexedMemoryRecallBlock` 的调用及追加。SQLite 可用时 stable profile/preferences 仍进入 snapshot，`other` 仍不默认进入 system。SQLite 不可用时，stable memory resolver 返回 `unavailable`，不把 Markdown fallback 放进 frozen system；fallback 由当前 request 的 dynamic path 注入，仍使用 `getMemoryPromptContext` 的 bounded 2000 字符限制。

- [ ] **Step 3: 在 assembleRequest 的 snapshot 之后执行 dynamic recall**

在 `getChatHistoryMessages` 后、contextual injections 前构造并使用。先让 `loadMemorySalience` 返回带状态的结果（`{ kind: 'sqlite', salienceByMemoryKey }` 或 `{ kind: 'unavailable' }`），stable section 只在 sqlite kind 进入 snapshot；dynamic resolver 在 store capability 非 sqlite、runtime 缺失或 query index 失败时调用 `buildMarkdownMemoryFallbackBlock`：

```ts
const memoryContext: MemoryRequestContext = {
  stableSystem:
    (systemSections.find((section) => section.id === 'memory.context')
      ?.content as string | undefined) ?? null,
  dynamicUser: await this.buildIndexedMemoryRecallBlock(
    compiledMessages,
    compaction,
    (contextPolicy?.useAssistant ?? true)
      ? this.getCurrentAssistant()?.id
      : undefined,
  ),
}
const withDynamicMemory = this.appendDynamicMemoryToLastUserMessage(
  baseRequestMessages,
  memoryContext.dynamicUser,
)
```

`buildMarkdownMemoryFallbackBlock` 使用 `getMemoryPromptContext` 生成 `<recalled_memory source="markdown-fallback">`，保留 global/assistant bounded wrapper，不进行 SQLite write。`appendDynamicMemoryToLastUserMessage` 从尾部查找最后一个 user，使用新对象合并 string/ContentPart[]；找不到 user 返回原数组。它不能在 assistant/tool 后追加新 user，不能修改传入数组或 ChatMessage。

- [ ] **Step 4: 保留 embedding cache，统一 render 调用**

把 `buildIndexedMemoryRecallBlock` 中的 render 调用写成 `const rendered = await orchestrator.render(...)` 并返回 `rendered.content`。`assembleRequest` 是 `generateRequestMessages` 与 `generateRequestSections` 的唯一共享入口；同一 model/query 复用现有 `QueryEmbeddingMemoryCache`，但词法/vector/graph entry 结果按当前请求重新生成。

- [ ] **Step 5: 在 sections 中剥离 dynamic block**

遍历 request messages 时，对 user 的 string 或 text ContentPart 使用 `RECALLED_MEMORY_BLOCK_RE`；每个匹配块推入 `{ bucket: 'memory', id: `memory.dynamic.${i}.${s}`, content: block }`，再从 user 副本删除。保留 image/file part 和 role metadata；空 text 仍保留合法 user message。system stable section 不改变。

- [ ] **Step 6: 运行 C4 测试与类型检查**

运行：

```bash
npx jest src/utils/chat/requestContextBuilder.test.ts src/core/memory/memoryWiring.integration.test.ts --runInBand
npm run type:check
```

预期：system 只有 SQLite 可用时的 stable memory；不同 query 的 user dynamic block 可变化；SQLite 不可用时 dynamic fallback 可用；embedding 失败只省略 dynamic index block；tool loop 顺序保持。

- [ ] **Step 7: 提交 C4**

```bash
git add src/utils/chat/requestContextBuilder.ts src/utils/chat/requestContextBuilder.test.ts src/core/memory/memoryWiring.integration.test.ts
git commit -m "feat: separate stable and dynamic memory context"
```

### Task 3: C1+C2 token packer 的失败测试

**Files:**

- Create: `src/core/memory/memoryRecallOrchestrator.test.ts`
- Modify: `src/core/memory/memoryRecallFusion.test.ts`
- Modify: `src/core/memory/memoryIndexRuntime.test.ts`

- [ ] **Step 1: 建立确定性 tokenizer test seam**

使用已有 `setTokenizerProviderForTests` 注入确定 token counter，并在 `afterEach` 恢复；生产代码只能调用 `estimateTextTokens`，测试中的字符计数不得进入生产实现。

- [ ] **Step 2: 添加完整条目、跳过和继续遍历测试**

用融合顺序 `[long, short, later]`，令 long 单条超过剩余预算，断言 short 和 later 仍被尝试并进入输出；当前 renderer 的 `break` 行为必须由测试捕获。最终 XML block token 数不得超过预算。

- [ ] **Step 3: 添加 Unicode、截断和 omitted 测试**

覆盖中文、英文、代码、emoji/代理项混合文本。长条目必须按 code point 安全截短；超出预算的条目产生 `[+N more omitted]` 的候选提示，但提示本身计入同一 token budget，放不下时不输出。

- [ ] **Step 4: 添加候选层与最终层独立限制测试**

让 fake store 记录 retrieval 与 fused-key resolve 两次 query，断言两次使用 candidate pool 上限而不是最终 8/3000；最终 render 使用独立 max entries/token budget，且顺序没有被 category 排序覆盖。

- [ ] **Step 5: 运行失败测试**

运行：

```bash
npx jest src/core/memory/memoryRecallOrchestrator.test.ts src/core/memory/memoryRecallFusion.test.ts src/core/memory/memoryIndexRuntime.test.ts --runInBand
```

预期：当前同步字符预算在长条目处提前停止，render 没有 token stats，query 仍受 8/3000 限制；新增断言失败。

### Task 4: C1+C2 候选池与 token packer 实现

**Files:**

- Modify: `src/core/memory/memoryTypes.ts`
- Modify: `src/core/memory/memoryIndex.ts`
- Modify: `src/core/memory/memoryRetrieval.ts`
- Modify: `src/core/memory/memoryRecallOrchestrator.ts`
- Modify: `src/utils/chat/requestContextBuilder.ts`
- Test: `src/core/memory/memoryRecallOrchestrator.test.ts`
- Test: `src/core/memory/memoryIndexRuntime.test.ts`

- [ ] **Step 1: 拆开三种限制并保留可观测初值**

使用明确常量：

```ts
export const MAX_RECALL_CANDIDATE_ENTRIES = 32
export const MAX_RECALL_CANDIDATE_CHARS = 12_000
export const MAX_RECALL_RENDER_ENTRIES = 8
export const MAX_RECALL_RENDER_TOKENS = 768
```

`memoryIndex.ts` 的 query safety cap 使用同语义命名并至少覆盖上述候选值。32、12000、768 是本项目第一版安全起点，不是外部项目最优参数；只能通过本项目指标调整。删除 `MAX_RECALL_CHARS` 的多重含义。

- [ ] **Step 2: 返回 retrieval 候选统计**

将 `MemoryRetrievalResult` 扩为：

```ts
export type MemoryRetrievalResult = {
  memoryKeys: readonly string[]
  paths: readonly MemoryRetrievalPath[]
  candidateCounts: Readonly<Record<MemoryRetrievalPath, number>>
  candidateLimitHit: boolean
}
```

记录 lexical/vector/graph 各自数量；达到 `maxEntries` 时设置 `candidateLimitHit`。RRF 仍只按 ranked key list 融合。

- [ ] **Step 3: 用 candidate 限制执行两次 SQLite query**

retrieval 和 fused-key resolve 都使用 `MAX_RECALL_CANDIDATE_ENTRIES` 与 `MAX_RECALL_CANDIDATE_CHARS`；只在 render 阶段 `.slice(0, MAX_RECALL_RENDER_ENTRIES)`。保存 candidate count、path counts、candidateLimitHit；query 层用 flight event 记录实际返回行数、字符过滤数和 safety cap 命中，renderer 另记 omitted/truncated。

- [ ] **Step 4: 将 render 改为异步 token packer**

返回结构：

```ts
export type MemoryRecallRenderResult = Readonly<{
  content: string | null
  tokenCount: number
  selectedCount: number
  truncatedCount: number
  omittedCount: number
}>
```

将 packing core 提取为 `packMemoryRecallLines(lines, source, limits)`，indexed entries 和 Markdown fallback 都调用它，避免 fallback 再造字符预算。按融合/来源顺序生成 `[category] content`，把 XML wrapper、换行和 omission notice 一并交给 `estimateTextTokens`。完整条目放不下时用 `Array.from(content)` 做 code-point 安全二分截断；单条仍放不下就计入 omitted 并继续后面的候选，不能 `break`。有 omitted 时尝试 `[+N more omitted]`，提示计入预算；必要时从后往前移除已选条目再试，提示仍放不下则省略。wrapper 超预算返回 null。`buildMarkdownMemoryFallbackBlock` 把 bounded global/assistant 文本转换为 lines 后调用同一 packer，因此 SQLite 故障时的 dynamic fallback 也不突破最终 token budget。

每次 render 记录 candidateCount、selectedCount、tokenCount、truncatedCount、omittedCount、candidateLimitHit。复用 `contextTokenEstimate.ts` 文本缓存，不新增 CJK 字符比例公式。

- [ ] **Step 5: 接通 request builder 的异步 render**

在 `buildIndexedMemoryRecallBlock` 返回 `const rendered = await orchestrator.render(...)` 的 `.content`；删除同步字符预算和第二套 token counter。

- [ ] **Step 6: 运行 C1+C2 测试与类型检查**

运行：

```bash
npx jest src/core/memory/memoryRecallOrchestrator.test.ts src/core/memory/memoryRecallFusion.test.ts src/core/memory/memoryIndexRuntime.test.ts src/utils/chat/requestContextBuilder.test.ts --runInBand
npm run type:check
```

预期：最终 `<recalled_memory>` 不超过初始 token budget；长条目不会阻断短条目；request 与 sections 复用同一 dynamic block；candidate 与 renderer 丢弃统计分开。

- [ ] **Step 7: 提交 C1+C2**

```bash
git add src/core/memory/memoryTypes.ts src/core/memory/memoryIndex.ts src/core/memory/memoryRetrieval.ts src/core/memory/memoryRecallOrchestrator.ts src/core/memory/memoryRecallOrchestrator.test.ts src/core/memory/memoryIndexRuntime.test.ts src/utils/chat/requestContextBuilder.ts
git commit -m "feat: pack recalled memory by token budget"
```

### Task 5: S1 间隔门控的失败测试与 schema 迁移

**Files:**

- Modify: `src/core/memory/memoryIndexSchema.ts`
- Modify: `src/core/memory/memoryIndexSchema.test.ts`
- Modify: `src/core/memory/memoryIndex.ts`
- Modify: `src/core/memory/memoryIndexRuntime.test.ts`

- [ ] **Step 1: 添加 v4 schema 和旧库迁移测试**

将 `MEMORY_INDEX_SCHEMA_VERSION` 从 3 改为 4，在 `memory_index` DDL 增加 `last_reinforced_at integer`。先初始化 v3 fixture，再运行 v4 initializer，断言 `pragma table_info(memory_index)` 有该列、schema meta 为 4、原有 salience/last_recalled_at 数据不变。重复初始化保持幂等；高于 4 的版本仍抛 `MemoryIndexUnavailableError`。

- [ ] **Step 2: 添加间隔内/间隔外/上限/并发失败测试**

用注入 clock 或传入 `nowMs` 验证首次 hit 增加 0.05；间隔内第二次只刷新 `last_recalled_at`；间隔外第三次再增加 0.05；salience=1 不溢出。并发调用两个 `reinforce` promise，查询最终行，断言一个间隔窗口至多一次强化。读取：

```sql
select salience, last_recalled_at, last_reinforced_at
from memory_index
where partition_key = ? and local_id = ?
```

- [ ] **Step 3: 运行失败测试**

运行：

```bash
npx jest src/core/memory/memoryIndexSchema.test.ts src/core/memory/memoryIndexRuntime.test.ts --runInBand
```

预期：v3 没有新列，现有 reinforce 每次都增加 salience，新增迁移/间隔断言失败。

### Task 6: S1 原子 SQL 强化实现

**Files:**

- Modify: `src/core/memory/memoryIndexSchema.ts`
- Modify: `src/core/memory/memoryIndex.ts`
- Modify: `src/core/memory/memoryTypes.ts`
- Modify: `src/core/memory/memoryIndexSchema.test.ts`
- Modify: `src/core/memory/memoryIndexRuntime.test.ts`

- [ ] **Step 1: 实现显式 v3→v4 列迁移**

增加 `addLastReinforcedAtColumn(runtime)`：读取 `pragma table_info(memory_index)`，列不存在时执行 `alter table memory_index add column last_reinforced_at integer`，存在时不执行；在 schema transaction 中于写入版本 4 前调用。新库由 DDL 创建，旧库由该函数补列。

- [ ] **Step 2: 扩展 row/type/reconcile 保留语义**

在 `MemoryIndexRow` 和 `IndexedMemoryEntry` 增加 `lastReinforcedAt: number | null`（若 UI 不需要暴露，至少保留内部 row mapping）。reconcile 的固定语义为：content/fingerprint unchanged 时保留旧值；new/changed entry 写 null；reconcile、add/update/delete 不调用 reinforce。upsert 写入 `last_reinforced_at = excluded.last_reinforced_at`，不能因重新索引清零。

- [ ] **Step 3: 用同一 UPDATE 实现间隔门控**

定义可观测初始间隔并允许测试注入：

```ts
export const DEFAULT_MEMORY_REINFORCEMENT_INTERVAL_MS = 60 * 60 * 1000
```

将 reinforce SQL 改成一个原子 UPDATE，核心语义：

```sql
update memory_index
set salience = case
      when last_reinforced_at is null
        or last_reinforced_at <= ?
        then min(1, salience + 0.05)
      else salience
    end,
    last_reinforced_at = case
      when last_reinforced_at is null
        or last_reinforced_at <= ?
        then ?
      else last_reinforced_at
    end,
    last_recalled_at = ?,
    updated_at = ?
where partition_key = ? and local_id = ?
```

两个条件参数使用 `nowMs - reinforcementIntervalMs`；开放窗口将 `last_reinforced_at` 写为 nowMs，间隔内保持旧值；last_recalled_at 每次无条件写 nowMs。salience=1 时仍记录开放窗口时间，避免每次命中被当作首次强化。更新与时间戳在同一 SQL statement 内完成，不依赖应用层先读后写。

- [ ] **Step 4: 保持 decay/archive 使用 last_recalled_at**

确认 `applyDecay`、冷归档查询和 graph/lexical stale filter 仍只读 `last_recalled_at`；不得替换为 `last_reinforced_at`。增加断言证明连续召回不会改变冷归档时间语义。

- [ ] **Step 5: 运行 S1 测试和类型检查**

运行：

```bash
npx jest src/core/memory/memoryIndexSchema.test.ts src/core/memory/memoryIndexRuntime.test.ts src/core/memory/decay.test.ts --runInBand
npm run type:check
```

预期：schema v4 幂等；间隔内 salience 至多增加一次；间隔外按生产实际 `min(1, salience + 0.05)` 增加；每次 hit 更新 last_recalled_at；并发不双重强化。

- [ ] **Step 6: 提交 S1**

```bash
git add src/core/memory/memoryIndexSchema.ts src/core/memory/memoryIndex.ts src/core/memory/memoryTypes.ts src/core/memory/memoryIndexSchema.test.ts src/core/memory/memoryIndexRuntime.test.ts
git commit -m "feat: gate memory reinforcement by interval"
```

### Task 7: C5 提取前质量门的失败测试

**Files:**

- Modify: `src/core/memory/memoryAgent.test.ts`
- Modify: `src/settings/schema/settings.test.ts`

- [ ] **Step 1: 添加 gate 分类和重要短事实反例**

导出分类纯函数并断言：

```ts
expect(classifyMemoryExtractionTurn('以后请始终用中文回答').reason).toBeNull()
expect(classifyMemoryExtractionTurn('请记住我住在上海').reason).toBeNull()
expect(classifyMemoryExtractionTurn('帮我打开这个文件').reason).toBeNull()
expect(classifyMemoryExtractionTurn('   !!!   ').reason).toBe('punctuation')
expect(classifyMemoryExtractionTurn('\u0000\u0007').reason).toBe('control')
```

不添加小于 3 字符、30 秒 cooldown、寒暄词黑名单或语言判断作为 gate 条件。

- [ ] **Step 2: 添加 off/shadow/enabled 行为测试**

使用现有 provider mock：off 对标点仍调用一次 LLM；shadow 仍调用一次并产生 `extraction-quality-outcome`；enabled 不调用 provider，产生 `extraction-skipped`，且没有 memory file write、reconcile callback 或 retry。重要短事实在 enabled 仍调用 LLM。使用 `runMemoryAgentWithFallback` 包装一次 provider mock，确认 gate 返回 `[]` 不进入 fallback。

- [ ] **Step 3: 添加 settings 默认值测试**

解析缺少新字段的旧 settings 时断言 `memoryExtractionQualityGate === 'shadow'`；显式 off/enabled 通过 schema。该字段不新增设置 UI，默认 shadow 不改变现有行为。

- [ ] **Step 4: 运行失败测试**

运行：

```bash
npx jest src/core/memory/memoryAgent.test.ts src/settings/schema/settings.test.ts --runInBand
```

预期：当前纯标点仍调用 LLM，没有质量门事件，settings 没有三态字段；新增断言失败。

### Task 8: C5 shadow-first 质量门实现

**Files:**

- Modify: `src/core/memory/memoryAgent.ts`
- Modify: `src/core/memory/memoryManager.ts`
- Modify: `src/settings/schema/setting.types.ts`
- Modify: `src/core/memory/memoryAgent.test.ts`
- Modify: `src/settings/schema/settings.test.ts`

- [ ] **Step 1: 增加三态设置类型和默认值**

在 `MemorySettingsLike` 增加：

```ts
memoryExtractionQualityGate?: 'off' | 'shadow' | 'enabled'
```

在 `yoloSettingsSchema` 增加：

```ts
memoryExtractionQualityGate: z
  .enum(['off', 'shadow', 'enabled'])
  .catch('shadow'),
```

旧配置通过 catch 获得 shadow；不增加 migration version 或设置 UI 行，因为这是向后兼容的可选运行策略。

- [ ] **Step 2: 实现确定性分类器**

导出：

```ts
export type MemoryExtractionGateCandidate = Readonly<{
  reason: 'empty' | 'control' | 'punctuation' | null
  charCount: number
}>
```

顺序为：trim 后为空返回 empty；匹配 `^[\\p{Cc}\\p{Cf}\\s]+$` 返回 control；匹配 `^[\\p{P}\\p{S}\\s]+$` 返回 punctuation；其余返回 null。`shouldProcessMemoryTurn` 保持现有非空 contract，分类器只负责减少明确无意义的 LLM 调用。

- [ ] **Step 3: 在 runMemoryAgentAfterTurn 接入 shadow/enabled**

在确认 assistant text 非空且 signal 未 abort 后先分类 user text，再读取 mode 并记录候选事件。空白输入无论 mode 都保持当前 `shouldProcessMemoryTurn` 的 no-op 行为，同时记录 skip；非空的纯 control/punctuation 输入只有 enabled mode 在 provider 调用前记录 `memory:extraction-skipped` 并 return `[]`。shadow/off 继续现有 entries load、LLM extraction、operation filter 和 Markdown write path；LLM response 后记录 `memory:extraction-quality-outcome`，detail 包含 mode、wouldSkip 和 operations。这样 enabled gate 不会写文件、reconcile 或触发 retry。

- [ ] **Step 4: 运行 C5 测试与类型检查**

运行：

```bash
npx jest src/core/memory/memoryAgent.test.ts src/settings/schema/settings.test.ts --runInBand
npm run type:check
```

预期：默认 shadow 不改变非空回合行为；enabled 只跳过确定性空白/控制/标点；重要短事实不跳过；flight events 可统计 candidate、skip 和 no-op outcome；关闭模式恢复原路径。

- [ ] **Step 5: 提交 C5**

```bash
git add src/core/memory/memoryAgent.ts src/core/memory/memoryManager.ts src/settings/schema/setting.types.ts src/core/memory/memoryAgent.test.ts src/settings/schema/settings.test.ts
git commit -m "feat: add observable memory extraction quality gate"
```

### Task 9: 全量验证、指标审计和计划验收

**Files:**

- Modify only when a test fixture or metric field is inconsistent: files listed in Tasks 1–8

- [ ] **Step 1: 运行相关范围回归**

运行：

```bash
npx jest src/core/memory src/utils/chat/requestContextBuilder.test.ts src/settings/schema/settings.test.ts --runInBand
npm run type:check
```

预期：相关 memory、request context、settings 测试全部通过；类型检查退出码为 0。

- [ ] **Step 2: 运行完整 Jest suite**

运行：

```bash
npm test -- --runInBand
```

预期：全量 Jest 通过；手写旧 SQLite fixture 若缺列则补 nullable `last_reinforced_at`，不改变外部行为。

- [ ] **Step 3: 运行生产构建和差异检查**

运行（将模式拆成字符串片段，避免扫描命令本身成为命中内容）：

```bash
npm run build
git diff --check
$bad = @((@('T','B','D') -join ''), (@('T','O','D','O') -join ''), ('appropriate ' + 'error handling'), ('Similar to ' + 'Task')) -join '|'
rg -n $bad docs/superpowers/plans/2026-08-19-memory-context-compression.md
```

预期：build 和 `git diff --check` 成功，最后的 `rg` 无输出。memory index schema 是自管理 SQLite schema，不运行 Drizzle migration；本计划不改变 `src/database/schema.ts`。

- [ ] **Step 4: 核对必须可观测字段**

从代码和 flight events 逐项确认：dynamic candidate/selected/token/truncated/omitted；stable memory token；candidate path counts 与 renderer omitted 的分离；S1 强化次数与召回次数；C5 candidate/skip/LLM outcome/no-op；embedding cache 命中；以及 provider、SQLite、embedding failure 对前台请求的降级连续性。

- [ ] **Step 5: 提交验证修正**

```bash
git status --short
git diff --check
git add -f docs/superpowers/specs/2026-08-18-memory-context-compression-spec.md docs/superpowers/plans/2026-08-19-memory-context-compression.md
git commit -m "docs: finalize memory context compression plan"
```

实现阶段产生的代码和测试应在各自 Task commit 中显式加入；最后的文档 commit 只包含本计划列出的 spec 与 plan 文件，不吸收其他工作树改动。

## Spec coverage 自审

| Spec 要求 | 计划覆盖 |
|---|---|
| stable global/assistant Markdown memory 留在 snapshot | Task 1–2，保留 `memory.context`、2000 字符 bounded fallback。 |
| dynamic recalled_memory 移出 snapshot、按最新 query 刷新 | Task 1–2，覆盖 reuse、query 变化、tool loop、失败降级。 |
| embedding cache 复用而不冻结 lexical/dynamic recall | Task 1–2、Task 9，保留现有 query cache。 |
| lexical/vector/graph + RRF 基线 | Task 4，只增加候选统计。 |
| candidate pool 与 final token budget 分离 | Task 3–4，三组限制和双层测试。 |
| 真实 tokenizer、Unicode 截断、跳过后继续、omitted 计预算 | Task 3–4，使用 `estimateTextTokens`。 |
| `last_reinforced_at` 与 `last_recalled_at` 分离 | Task 5–6，v4 migration、原子 SQL、decay/archive 回归。 |
| 生产实际 `min(1, salience + 0.05)` | Task 6，禁止复用旧 decay 增量。 |
| add/update/delete/no-op 与 Markdown source-of-truth 不变 | Task 2、Task 8，gate no-op 不写，operation path 不改。 |
| C5 shadow-first、保守规则、关闭能力 | Task 7–8，三态设置和短事实反例。 |
| E/F 不成为 A–D 隐式依赖 | 文件边界和实施顺序明确排除 C3、LLM merge、S2 回放。 |

## 类型与实现一致性自审

- `MemoryRecallRenderResult.content` 是 `string | null`，request builder 只使用该字段；token stats 来自同一 render。
- `MemoryRetrievalResult.candidateCounts` 的 key 固定为 lexical/vector/graph；`candidateLimitHit` 只由 candidate maxEntries 判断。
- `MemoryIndexRow.last_reinforced_at`、schema 列名和 `IndexedMemoryEntry.lastReinforcedAt` 一致；last_recalled_at 仍映射到 `lastRecalledAt`。
- `MemorySettingsLike.memoryExtractionQualityGate`、Zod enum 和 memory agent mode 使用同一 `'off' | 'shadow' | 'enabled'` 联合类型。
- dynamic block 使用 `memory.dynamic.*` section id；stable block 继续使用 `memory.context`，不会重复计算。
- 生产强化只在 reinforce SQL 路径使用 `+0.05`；`decay.ts` helper 不承担 S1 门控。
