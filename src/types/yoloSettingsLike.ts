export type YoloSettingsLike = {
  yolo?: {
    baseDir?: string
  }
  chatOptions?: {
    chatExportIncludeThinking?: boolean
    chatExportIncludeToolCalls?: boolean
  }
}
