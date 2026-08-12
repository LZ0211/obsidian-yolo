import { Sparkles } from 'lucide-react'
import React from 'react'

import { useLanguage } from '../../contexts/language-context'

type DotLoaderProps = {
  text?: string
  variant?: 'sparkles' | 'dots'
  className?: string
}

export default function DotLoader({
  text,
  variant = 'sparkles',
  className = '',
}: DotLoaderProps) {
  const { t } = useLanguage()
  const loadingLabel = t('common.loading', 'Loading')
  const thinkingText = text ?? t('quickAsk.statusThinking', 'Thinking')

  if (variant === 'dots') {
    return (
      <span
        className={`yolo-dot-loader-minimal ${className}`.trim()}
        aria-label={loadingLabel}
      >
        <span />
        <span />
        <span />
      </span>
    )
  }

  return (
    <div
      className={`yolo-thinking-loader ${className}`.trim()}
      aria-label={loadingLabel}
    >
      <div className="yolo-thinking-icon">
        <Sparkles className="yolo-thinking-icon-svg" size={20} />
      </div>
      <div className="yolo-thinking-text">{thinkingText}</div>
    </div>
  )
}
