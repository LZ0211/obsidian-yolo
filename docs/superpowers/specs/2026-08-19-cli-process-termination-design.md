# CLI 进程分级终止统一（借鉴 Claudian ManagedStdioProcess）

日期：2026-08-19
状态：设计稿
参考来源：[Claudian](https://github.com/YishenTu/claudian)（`reference/claudian-main/`），具体见 §3

## 1. 背景与动机

YOLO 通过 CLI runtime（claude-code / codex / hermes / opencode / pi / acp）和 bash 工具 spawn 子进程。终止逻辑目前**三处各自实现、强度不一**：

- bash session-manager：完整（SIGTERM → 3s → SIGKILL；win32 taskkill /T /F）✅
- gitCommandRunner：状态机含 terminating + 2s watchdog + SIGKILL/taskkill 兜底 ✅
- **codex：win32 taskkill /t /f；非 win32 仅 SIGTERM，无升级** ⚠️
- **claude：仅 `child.kill('SIGTERM')`，无升级、无超时兜底** ⚠️

无升级的 SIGTERM 对挂死进程（死锁、等待网络、SIGTERM 未处理）等于没有终止；会话切换/取消时残留进程会继续占用 CPU 和 API 配额。目标：把 bash 已有的分级终止模式提炼为共享工具，补齐 claude/codex。

## 2. 现状分析（YOLO）

- `src/core/cli-runtime/claude/process.ts`：`resolveClaudeProcessSupport` → Electron spawn（`windowsHide: true`），AbortSignal 仅 `child.kill('SIGTERM')`。
- `src/core/cli-runtime/codex/process.ts`：`CodexAppServerProcess`，`.cmd` 经 cmd.exe 包裹（windowsVerbatimArguments）；`shutdown()`：win32 `taskkill /pid /t /f`，非 win32 仅 SIGTERM。
- `src/core/agent/bash/session-manager.ts`：`createKillProcess`——POSIX detached 进程组 `kill(-pid, SIGTERM)` → `SIGKILL_DELAY_MS`(3s) 后 SIGKILL；win32 `cross-spawn` + `taskkill /T /F`。stderr 用 `StringDecoder` + `CappedOutputCollector`（1MB 上限、头尾各 256KB）。
- `src/core/agent/git-diff/gitCommandRunner.ts`：状态机（terminating）+ 2s watchdog + SIGKILL/taskkill 兜底。
- 桌面依赖动态加载：`src/utils/platform/desktopNodeModule.ts`（`loadDesktopNodeModule`）、`src/core/cli-runtime/desktop.ts`、bash 非桌面直接 throw。

**差距**：claude/codex 无分级终止与超时兜底；三处逻辑重复（kill 顺序、win32 特判、等待退出）。

## 3. 参考设计（Claudian）

| 机制 | 参考实现 |
|---|---|
| 分级终止：`shutdown()` = SIGTERM → 3s 后 SIGKILL → 再 3s 强制 destroy 流 + 清理监听器 | `reference/claudian-main/src/core/process/ManagedStdioProcess.ts` |
| stderr 环形缓冲（8KB，诊断不丢） | 同文件 |
| Windows cmd shim 处理（`.cmd` 经 cmd.exe） | `reference/claudian-main/src/utils/windowsCmdShim`（YOLO codex 已有等价实现） |
| 生命周期租约 + generation 失效（进程代际标识，防旧进程清理误杀新进程） | `reference/claudian-main/src/core/execution/ProviderExecutionLifecycleRegistry.ts` |

## 4. 目标设计

### 4.1 共享终止工具（新增 `src/core/cli-runtime/termination.ts`）

```ts
export type TerminateOptions = {
  signal?: 'SIGTERM' | 'SIGKILL' | 'SIGINT' | 'taskkill'
  sigKillDelayMs?: number   // 默认 3000（对齐 bash SIGKILL_DELAY_MS）
  destroyTimeoutMs?: number // 默认 3000
}

/** 分级终止：graceful → 超时升级 → 强制销毁流，返回最终退出状态 */
export async function terminateProcess(
  child: ChildProcess,
  options?: TerminateOptions,
): Promise<{ exited: boolean; signal?: NodeJS.Signals | 'SIGKILL'; code?: number | null }>
```

行为（对齐 bash 语义并统一）：

1. POSIX：detached 时 `kill(-pid, SIGTERM)`（进程组），否则 `child.kill('SIGTERM')`；等 `exit` 或 `sigKillDelayMs` 超时。
2. 超时 → `kill(-pid, SIGKILL)` / `child.kill('SIGKILL')`；再等 `destroyTimeoutMs`。
3. 仍不退 → `child.kill()`（默认 SIGTERM 的最后一次）+ 对 stdio 流 `destroy()` + 移除全部监听器，返回超时标记。
4. win32：走 `taskkill /pid <pid> /t /f`（对齐 bash/codex 现状）——`cross-spawn` 或 `execFile('taskkill', ...)`，完成后等 exit。
5. 全部路径 `once('exit')` 收尾，防泄漏。

### 4.2 stderr 环形缓冲（`src/core/cli-runtime/stderrBuffer.ts`）

复用 bash 的 `CappedOutputCollector` 语义（1MB 上限、头尾 256KB），抽象为独立工具供 claude/codex 使用（bash 保持现状或迁移，见非目标）。

### 4.3 接入点

- `src/core/cli-runtime/claude/process.ts`：AbortSignal 处理改为 `terminateProcess`（替代裸 `kill('SIGTERM')`）。
- `src/core/cli-runtime/codex/process.ts`：`shutdown()` 改为 `terminateProcess`（win32 分支保留 taskkill 语义，由工具统一处理）。
- 生命周期租约：`cli-runtime/coordinator.ts` 维护活跃进程 registry（`Map<runtimeId, { generation, child }>`）；`terminateProcess` 前校验 generation，防"旧代清理误杀新一代进程"。

### 4.4 非桌面环境

保持现状：所有新代码仍在桌面分支动态 import（`loadDesktopNodeModule` / `import('node:child_process')`），移动端零影响。

## 5. 边界与非目标

- **不迁移 bash session-manager / gitCommandRunner 到新工具**（它们已有等价实现且测试充分；统一是后续债务项，本次只服务缺失的 claude/codex）。
- 不做进程退出码语义改动（调用方现状不变）。
- 不引入新依赖（`cross-spawn` 已是项目依赖，win32 可用）。

## 6. 测试计划

- `termination.test.ts`：POSIX 分级（mock child：SIGTERM 后退出 / 不退出触发 SIGKILL / 全不响应触发 destroy）；win32 taskkill 分支；超时参数覆盖；exit 监听器清理（无泄漏断言）。
- `stderrBuffer.test.ts`：环形截断（超 1MB 保头尾）。
- 接入点测试：claude/codex process 的 AbortSignal/shutdown 路径（mock `terminateProcess` 断言被调用且参数正确）。
- 沿用 jest 并行 + `npm run type:check`。

## 7. 验证方式

- 单测全绿；type:check / lint。
- 人工 QA（桌面）：启动 claude-code 会话 → 切换会话触发终止 → 进程列表确认无残留；codex 同验；挂死进程（如 sleep）确认升级 SIGKILL。

## 8. 实施顺序（TDD）

1. RED：`termination.ts` 测试（POSIX 分级三态）→ GREEN
2. RED：win32 taskkill 分支测试 → GREEN
3. RED：`stderrBuffer.ts` 测试 → GREEN
4. RED：claude/codex 接入测试 → GREEN 接线
5. 生命周期租约 registry + 测试
6. 人工 QA
