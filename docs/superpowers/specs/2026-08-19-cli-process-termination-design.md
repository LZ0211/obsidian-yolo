# CLI 进程分级终止统一（盲审修订版 v2）

日期：2026-08-19
状态：设计稿（v2，按盲审修订）
盲审结论：v1 四块必改——claude 接口不适配、POSIX 组杀前提缺失、租约键与句柄获取路径错误、win32 兜底与监听器语义。
参考来源：[Claudian](https://github.com/YishenTu/claudian) `reference/claudian-main/src/core/process/ManagedStdioProcess.ts`（分级终止 + 自有监听器清理语义）

## 1. 背景与动机

claude-code / codex CLI 子进程终止强度不足：claude 仅 `child.kill('SIGTERM')` 无升级；codex 非 win32 分支仅 SIGTERM；两者 spawn 均非 detached，孙进程无法组杀。目标：统一分级终止（SIGTERM → 超时 → SIGKILL → destroy 兜底），补齐 claude/codex。

## 2. 现状分析（YOLO，盲审校准后）

- `src/core/cli-runtime/claude/process.ts`：`resolveClaudeProcessSupport`（:305-317）→ `createElectronSpawnFunction`，`windowsHide:true`，**非 detached**（:298-303）；AbortSignal 仅 `child.kill('SIGTERM')`；SDK 的 `SpawnedProcess` 对插件只暴露 kill/stdin/stdout——**无 pid、无 stderr**。
- `src/core/cli-runtime/codex/process.ts`：`CodexAppServerProcess.start`（:143-149 非 detached）；`shutdown()`：**`.cmd` 包裹分支**用 `taskkill /pid /t /f`（:188-197），**直接 `codex.exe` 分支仅 `child.kill('SIGTERM')`**（:199）；exit 前先查 `exitCode` 再注册监听（:186，已有竞态先例）。
- `src/core/agent/bash/session-manager.ts`：`createKillProcess`（POSIX detached 进程组 `kill(-pid,SIGTERM)` → `SIGKILL_DELAY_MS` 3s → SIGKILL；win32 taskkill 用 **node 原生 spawn** 非 cross-spawn，:302-320 有 fallback）。`CappedOutputCollector`（1MB 上限头尾 256KB）**无实时快照 API**（只有 finalize/tail）。
- `src/core/agent/git-diff/gitCommandRunner.ts`：terminating 状态机 + 2s watchdog + 兜底。
- 桌面动态加载：`src/utils/platform/desktopNodeModule.ts`。

**差距**（v2 范围）：claude/codex 无分级终止；非 detached 无组杀；三处终止逻辑未共享。

## 3. 参考设计（Claudian）

| 机制 | 参考实现 |
|---|---|
| 分级终止：graceful → 超时 → SIGKILL → destroy 流 | `reference/claudian-main/src/core/process/ManagedStdioProcess.ts` |
| **监听器清理只清自有处理器**（不 removeAllListeners，避免清掉 transport 的监听） | 同文件 `:274-290` |
| stderr 环形缓冲（固定容量 slice，非"保头尾"） | 同文件（stderr ring buffer） |

## 4. 目标设计（盲审修订）

### 4.1 共享终止工具 `src/core/cli-runtime/termination.ts`

```ts
export type TerminatedProcess = {
  pid?: number
  onExit(listener: () => void): void
  kill(signal?: NodeJS.Signals | number): boolean
  stderr?: NodeJS.ReadableStream | null
  stdout?: NodeJS.ReadableStream | null
}

export async function terminateProcess(
  target: TerminatedProcess,
  options?: {
    sigKillDelayMs?: number   // 默认 3000
    destroyTimeoutMs?: number // 默认 3000
  },
): Promise<{ exited: boolean; via?: 'signal' | 'sigkill' | 'destroy' | 'taskkill' }>
```

行为（盲审修订后）：
1. **只清自有监听器**：内部用 `AbortController`/包装器跟踪自己注册的 exit/error 监听，终止结束时精确移除——**绝不用 removeAllListeners**（SDK transport / CodexAppServerProcess 持有自己的监听器）。
2. 先查 `exitCode`（codex :186 先例）再注册 `once('exit')`——已退出进程立即返回，防挂死。
3. POSIX：`kill('SIGTERM')` → `sigKillDelayMs` 未退出 → `kill('SIGKILL')` → `destroyTimeoutMs` 未退出 → destroy stdio 流（stdout/stderr 可空，claude 场景）→ 返回 `via:'destroy'`。
4. win32：`taskkill /pid <pid> /t /f`（node 原生 spawn，对齐 bash）→ 失败/非零/挂死时 **fallback** 到 `kill('SIGTERM')` → 升级 SIGKILL → destroy（bash :302-320 的兜底语义，不能比现有实现更弱）。
5. **幂等**：重复调用对同一 target 只生效一次（内部 state 标记），并发安全。
6. 信号终止后不补发多余信号（SIGKILL 已生效后不再发默认信号）。

### 4.2 claude 适配（`src/core/cli-runtime/claude/process.ts`）

- SDK `SpawnedProcess` 无 pid/stderr → **不把 terminateProcess 接到 SDK 句柄上**；在 `createElectronSpawnFunction` 内部用**真实 child**（`import('node:child_process').spawn` 的返回值）包一层 `TerminatedProcess`（pid = child.pid，onExit = child.once('exit')），插件侧持有该包装句柄。
- AbortSignal 回调是同步的 → `void terminateProcess(wrapper)`（fire-and-forget，与 v1 相同但签名成立）。
- 不新增 detached（见 §4.3 决策）。

### 4.3 组杀决策（盲审点 2）

盲审指出：claude/codex spawn 均非 detached，`kill(-pid)` 不可用。**v2 决策：不引入 detached**——detached 改变子进程行为（新进程组、信号隔离），对 SDK 托管的 claude 风险不可控。**接受"孙进程残留"为已知限制**（与现状一致，本次不扩大范围；bash/git 已有组杀不受影响）。§1 目标相应收敛为"主进程必杀 + 升级兜底"。

### 4.4 租约与句柄（盲审点 3）

盲审指出：coordinator 同 runtimeId 可多进程并存（`instantiateRuntime` 每会话独立，coordinator.ts:302,534-550），`Map<runtimeId,...>` 冲突；且 coordinator 拿不到 child 句柄。

**v2 决策：不做中央 registry**。改为**运行时实例自持**：
- claude：`createElectronSpawnFunction` 返回的包装句柄由 `ClaudeProcessSupport` 实例持有（每会话独立实例，天然隔离代际）。
- codex：`CodexAppServerProcess` 实例持有 child + generation（实例自增，`shutdown()` 前校验 generation 未变）。
- 每个实例的 `dispose()`/`shutdown()` 内部完成"校验代际 → terminateProcess → 清理"。
- 取消跨 runtime 的共享 registry（v1 的过度设计，且无安全实现路径）。

### 4.5 stderr 缓冲（盲审点 6）

- 新建 `src/core/cli-runtime/stderrBuffer.ts`：固定容量**环形 slice**（对齐 codex 现状 8KB，:117-122），提供 `push(chunk)` / `snapshot()`（实时读取，区别于 bash CappedOutputCollector 的 finalize/tail）。
- claude/codex 接入；bash 保持现状（语义不同，不迁移）。

## 5. 边界与非目标

- 不迁移 bash / gitCommandRunner（已有等价实现且测试充分）。
- 不做 detached 组杀（§4.3 决策，接受孙进程残留限制）。
- 不做中央进程 registry（§4.4 决策，实例自持代际）。
- 不引入新依赖。

## 6. 测试计划（盲审补齐后）

- `termination.test.ts`：mock `TerminatedProcess` —— 已退出早返回（exitCode 先查）、SIGTERM 后退出、超时升级 SIGKILL、全不响应 destroy、**幂等并发**、**自有监听器清理（断言第三方监听器仍在）**、win32 taskkill 成功/失败/非零/挂死四路径 + fallback、destroy 安全网。
- `stderrBuffer.test.ts`：环形截断 + snapshot 实时性。
- 接入点：claude（`createElectronSpawnFunction` 包装 + abort 触发 terminateProcess，mock 断言调用）；codex（shutdown 走 terminateProcess；generation 不匹配时不终止）。
- POSIX 真实进程冒烟：win32 机器上仅 mock 覆盖，POSIX 冒烟列入人工 QA。

## 7. 验证方式

- 单测全绿；type:check / lint。
- 人工 QA（桌面）：claude/codex 会话切换终止无残留；挂死进程升级 SIGKILL；win32 taskkill 路径。

## 8. 实施顺序（TDD）

1. RED：`termination.ts` 基础分级（SIGTERM→SIGKILL→destroy）→ GREEN
2. RED：已退出早返回 + 幂等 + 监听器语义 → GREEN
3. RED：win32 taskkill 四路径 + fallback → GREEN
4. RED：`stderrBuffer.ts` → GREEN
5. RED：claude 包装 + codex shutdown 接入 → GREEN
6. 人工 QA
