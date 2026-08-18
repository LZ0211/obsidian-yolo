import { ChevronDown, ChevronRight } from 'lucide-react'
import { memo, useRef, useState } from 'react'

import { Annotation } from '../../types/llm/response'
import { normalizeCitationUrl } from '../../utils/chat/inject-annotation-markers'

const AssistantMessageAnnotations = memo(function AssistantMessageAnnotations({
  annotations,
}: {
  annotations: Annotation[]
}) {
  const [isExpanded, setIsExpanded] = useState(false)
  const hasUserInteracted = useRef(false)

  const handleToggle = () => {
    hasUserInteracted.current = true
    setIsExpanded(!isExpanded)
  }

  return (
    <div
      className={`yolo-assistant-message-metadata${
        isExpanded ? ' is-expanded' : ''
      }`}
    >
      <button
        type="button"
        className="yolo-assistant-message-metadata-toggle"
        onClick={handleToggle}
      >
        <span>View Sources ({annotations.length})</span>
        {isExpanded ? (
          <ChevronDown className="yolo-assistant-message-metadata-toggle-icon" />
        ) : (
          <ChevronRight className="yolo-assistant-message-metadata-toggle-icon" />
        )}
      </button>
      {isExpanded && (
        <div className="yolo-assistant-message-metadata-content">
          <div className="yolo-assistant-message-metadata-annotations">
            {annotations.map((annotation, index) => {
              // Schemeless URLs would resolve as vault-relative paths in the
              // Electron window; normalize so the source opens externally.
              const url = normalizeCitationUrl(annotation.url_citation.url)
              if (!url) return null
              return (
                <div key={url}>
                  <span className="yolo-url-citation-text">
                    [{index + 1}]{' '}
                    <a
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {annotation.url_citation.title ?? url}
                    </a>
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
})

export default AssistantMessageAnnotations
