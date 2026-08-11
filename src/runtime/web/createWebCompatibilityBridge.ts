import type { YoloRuntimeCompatibilityBridge } from '../yoloRuntime.types'

import {
  Keymap,
  MarkdownRenderer,
  MarkdownView,
  Platform,
  TFile,
  TFolder,
  htmlToMarkdown,
  normalizePath,
} from './obsidianCompat'

export function createWebCompatibilityBridge({
  app,
  plugin,
}: {
  app: unknown
  plugin: unknown
}): YoloRuntimeCompatibilityBridge {
  return {
    app,
    plugin,
    TFile,
    TFolder,
    MarkdownView,
    MarkdownRenderer,
    platform: Platform,
    keymap: Keymap,
    utils: {
      htmlToMarkdown,
      normalizePath,
    },
  }
}
