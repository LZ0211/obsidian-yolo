import React, { createContext, useContext } from 'react'

import type { YoloRuntime } from './yoloRuntime.types'

const YoloRuntimeContext = createContext<YoloRuntime | null>(null)

export function YoloRuntimeProvider({
  runtime,
  children,
}: {
  runtime: YoloRuntime
  children: React.ReactNode
}) {
  return (
    <YoloRuntimeContext.Provider value={runtime}>
      {children}
    </YoloRuntimeContext.Provider>
  )
}

export function useYoloRuntime(): YoloRuntime {
  const runtime = useContext(YoloRuntimeContext)
  if (!runtime) {
    throw new Error('YoloRuntimeProvider is missing.')
  }
  return runtime
}

/**
 * 非抛出版本：桌面宿主不挂 YoloRuntimeProvider，Chat.tsx 仅在
 * buildRuntime 注入（Web 端）存在时消费 runtime，缺省回退 null。
 */
export function useOptionalYoloRuntime(): YoloRuntime | null {
  return useContext(YoloRuntimeContext)
}
