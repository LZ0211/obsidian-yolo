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
