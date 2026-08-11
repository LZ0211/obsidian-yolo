export type YoloSettingsLike = {
  yolo?: {
    baseDir?: string
    projectsDir?: string
  }
  chatOptions?: {
    chatExportIncludeThinking?: boolean
    chatExportIncludeToolCalls?: boolean
  }
}
