import { Sparkles } from 'lucide-react'
import React, { useEffect, useMemo, useRef, useState } from 'react'

import { useLanguage } from '../../contexts/language-context'
import {
  type ChatRuntimeId,
  type CliRuntimeId,
  getCliRuntimeDescriptor,
} from '../../core/cli-runtime'
import RollerSelect, { type RollerOption } from '../common/RollerSelect'
import { YoloOrbitIcon } from '../common/YoloOrbitIcon'

type ViewToggleProps = {
  activeView: 'chat' | 'composer'
  onChangeView: (view: 'chat' | 'composer') => void
  activeRuntimeId: ChatRuntimeId
  onChangeRuntime: (runtimeId: ChatRuntimeId) => void
  /** Native YOLO plus the locally detected CLI runtimes (in picker order). */
  runtimeOptions: readonly ChatRuntimeId[]
  showComposer?: boolean
  disabled?: boolean
}

const ViewToggle: React.FC<ViewToggleProps> = ({
  activeView,
  onChangeView,
  activeRuntimeId,
  onChangeRuntime,
  runtimeOptions,
  showComposer = true,
  disabled = false,
}) => {
  const { t } = useLanguage()
  const [hoveredView, setHoveredView] = useState<'chat' | 'composer' | null>(
    null,
  )
  const [isModeMenuOpen, setIsModeMenuOpen] = useState(false)
  const [isModeClickOpenBlocked, setIsModeClickOpenBlocked] = useState(false)
  const [toggleWidth, setToggleWidth] = useState<number | null>(null)
  const [popoverWidth, setPopoverWidth] = useState<number | null>(null)
  const toggleRef = useRef<HTMLDivElement | null>(null)
  const clickOpenBlockTimeoutRef = useRef<number | null>(null)
  const hoverCloseTimeoutRef = useRef<number | null>(null)

  const yoloLabel = t('sidebar.runtimeSelector.yoloLabel', 'YOLO')
  const composerLabel = t('sidebar.tabs.composer', 'Sparkle')

  const pickerOptions = useMemo<RollerOption[]>(() => {
    const cliOptions = runtimeOptions
      .filter((runtimeId): runtimeId is CliRuntimeId => runtimeId !== 'yolo')
      .map((runtimeId) => {
        const descriptor = getCliRuntimeDescriptor(runtimeId)
        return {
          value: runtimeId,
          label: t(descriptor.labelKey),
          description: t(descriptor.descriptionKey),
          icon: (
            <img
              className="yolo-runtime-selector__provider-logo"
              src={descriptor.icon.src}
              alt=""
              draggable={false}
              data-provider={descriptor.icon.provider}
            />
          ),
        }
      })
    return [
      {
        value: 'yolo',
        label: yoloLabel,
        description: t(
          'sidebar.runtimeSelector.chatDescription',
          'Built-in YOLO chat',
        ),
        icon: <YoloOrbitIcon size={14} />,
      },
      ...cliOptions,
    ]
  }, [runtimeOptions, t, yoloLabel])

  const expandedView = showComposer ? hoveredView || activeView : 'chat'
  const isActiveExpanded = expandedView === activeView
  const hasRuntimeChoices = pickerOptions.length > 1

  useEffect(() => {
    if (activeView !== 'chat') {
      if (hoverCloseTimeoutRef.current !== null) {
        window.clearTimeout(hoverCloseTimeoutRef.current)
        hoverCloseTimeoutRef.current = null
      }
      setIsModeMenuOpen(false)
    }
  }, [activeView])

  useEffect(() => {
    return () => {
      if (hoverCloseTimeoutRef.current !== null) {
        window.clearTimeout(hoverCloseTimeoutRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (!isModeClickOpenBlocked) {
      if (clickOpenBlockTimeoutRef.current !== null) {
        window.clearTimeout(clickOpenBlockTimeoutRef.current)
        clickOpenBlockTimeoutRef.current = null
      }
      return
    }

    clickOpenBlockTimeoutRef.current = window.setTimeout(() => {
      setIsModeClickOpenBlocked(false)
      clickOpenBlockTimeoutRef.current = null
    }, 220)

    return () => {
      if (clickOpenBlockTimeoutRef.current !== null) {
        window.clearTimeout(clickOpenBlockTimeoutRef.current)
      }
    }
  }, [isModeClickOpenBlocked])

  useEffect(() => {
    const element = toggleRef.current
    if (!element || !hasRuntimeChoices) return

    const updateWidth = () => {
      const nextToggleWidth = Math.round(element.getBoundingClientRect().width)
      const totalWidth = Number.parseFloat(
        (element.ownerDocument.defaultView ?? window)
          .getComputedStyle(element)
          .getPropertyValue('--yolo-total-width'),
      )

      setToggleWidth(nextToggleWidth)
      setPopoverWidth(
        Math.round(
          Number.isFinite(totalWidth) && totalWidth > 0
            ? totalWidth
            : nextToggleWidth,
        ),
      )
    }

    updateWidth()
    const resizeObserver = new ResizeObserver(updateWidth)
    resizeObserver.observe(element)
    return () => resizeObserver.disconnect()
  }, [hasRuntimeChoices])

  const clearHoverCloseTimeout = () => {
    if (hoverCloseTimeoutRef.current !== null) {
      window.clearTimeout(hoverCloseTimeoutRef.current)
      hoverCloseTimeoutRef.current = null
    }
  }

  const closeModeMenuWithDelay = () => {
    clearHoverCloseTimeout()
    hoverCloseTimeoutRef.current = window.setTimeout(() => {
      setIsModeMenuOpen(false)
      hoverCloseTimeoutRef.current = null
    }, 150)
  }

  const commitRuntimeChange = (runtimeId: ChatRuntimeId) => {
    onChangeRuntime(runtimeId)
    onChangeView('chat')
    clearHoverCloseTimeout()
    setIsModeMenuOpen(false)
  }

  const chatTriggerClassName = `yolo-view-toggle-button ${
    hasRuntimeChoices ? 'yolo-view-toggle-button--roller ' : ''
  }${activeView === 'chat' ? 'yolo-view-toggle-button--active' : ''} ${
    expandedView === 'chat' ? 'yolo-view-toggle-button--expanded' : ''
  }`

  return (
    <div
      ref={toggleRef}
      className={`yolo-view-toggle${showComposer ? '' : ' yolo-view-toggle--single'}`}
      data-expanded-view={expandedView}
      data-active-expanded={isActiveExpanded ? 'true' : 'false'}
    >
      {hasRuntimeChoices ? (
        <RollerSelect
          value={activeRuntimeId}
          options={pickerOptions}
          onActivate={() => {
            if (activeView !== 'chat') setIsModeClickOpenBlocked(true)
            onChangeView('chat')
          }}
          open={isModeMenuOpen}
          onOpenChange={(open) => {
            clearHoverCloseTimeout()
            if (
              disabled ||
              activeView !== 'chat' ||
              (open && isModeClickOpenBlocked)
            ) {
              setIsModeMenuOpen(false)
              return
            }
            setIsModeMenuOpen(open)
            if (open) setHoveredView('chat')
          }}
          onChange={(value) => {
            if (!runtimeOptions.includes(value as ChatRuntimeId)) return
            if (value === activeRuntimeId) return
            commitRuntimeChange(value as ChatRuntimeId)
          }}
          onValueClick={() => {
            // Quick toggle between exactly two choices; with more options the
            // click opens the menu instead.
            if (pickerOptions.length !== 2) return
            const other = pickerOptions.find(
              (option) => option.value !== activeRuntimeId,
            )
            if (other) commitRuntimeChange(other.value as ChatRuntimeId)
          }}
          disabled={disabled}
          ariaLabel={t(
            'sidebar.runtimeSelector.modeAccessibleLabel',
            'Chat mode',
          )}
          triggerClassName={chatTriggerClassName}
          contentStyle={
            (showComposer ? toggleWidth : popoverWidth)
              ? {
                  width: `${showComposer ? toggleWidth : popoverWidth}px`,
                  minWidth: `${showComposer ? toggleWidth : popoverWidth}px`,
                  maxWidth: `${showComposer ? toggleWidth : popoverWidth}px`,
                  marginLeft: '-4px',
                }
              : undefined
          }
          sideOffset={2}
          onTriggerMouseEnter={() => {
            if (disabled) return
            setHoveredView('chat')
            clearHoverCloseTimeout()
            if (activeView === 'chat') setIsModeMenuOpen(true)
          }}
          onTriggerMouseLeave={() => {
            setHoveredView(null)
            closeModeMenuWithDelay()
          }}
          onContentMouseEnter={() => {
            if (disabled) return
            setHoveredView('chat')
            clearHoverCloseTimeout()
          }}
          onContentMouseLeave={() => {
            setHoveredView(null)
            closeModeMenuWithDelay()
          }}
          popover={{
            variant: 'default',
            maxHeight: 400,
            className: 'yolo-popover-view-toggle-mode',
          }}
        />
      ) : (
        <button
          type="button"
          className={chatTriggerClassName}
          onClick={() => onChangeView('chat')}
          onMouseEnter={() => !disabled && setHoveredView('chat')}
          onMouseLeave={() => setHoveredView(null)}
          disabled={disabled}
          aria-pressed={activeView === 'chat'}
        >
          <span className="yolo-view-toggle-button-icon" aria-hidden="true">
            <YoloOrbitIcon size={16} />
          </span>
          <span className="yolo-view-toggle-button-label">{yoloLabel}</span>
        </button>
      )}
      {showComposer ? (
        <button
          type="button"
          className={`yolo-view-toggle-button ${
            activeView === 'composer' ? 'yolo-view-toggle-button--active' : ''
          } ${
            expandedView === 'composer'
              ? 'yolo-view-toggle-button--expanded'
              : ''
          }`}
          onClick={() => onChangeView('composer')}
          onMouseEnter={() => !disabled && setHoveredView('composer')}
          onMouseLeave={() => setHoveredView(null)}
          disabled={disabled}
          aria-pressed={activeView === 'composer'}
        >
          <span className="yolo-view-toggle-button-icon" aria-hidden="true">
            <Sparkles size={16} strokeWidth={2} />
          </span>
          <span className="yolo-view-toggle-button-label">{composerLabel}</span>
        </button>
      ) : null}
      <div
        className={`yolo-view-toggle-indicator${showComposer ? '' : ' yolo-view-toggle-indicator--single'}`}
        data-active-view={activeView}
      />
    </div>
  )
}

export default ViewToggle
