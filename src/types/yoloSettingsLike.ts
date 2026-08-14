export type YoloSettingsLike = {
  yolo?: {
    baseDir?: string
    projectsDir?: string
  }
  chatOptions?: {
    chatExportIncludeThinking?: boolean
    chatExportIncludeToolCalls?: boolean
  }
  /** MinerU PDF conversion config (full `YoloSettings.mineru` is assignable). */
  mineru?: {
    enabled?: boolean
    baseUrl?: string
    apiKey?: string
  }
}
