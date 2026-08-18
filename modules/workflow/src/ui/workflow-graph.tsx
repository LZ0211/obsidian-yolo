import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'

import type { WorkflowCopy } from '../i18n'
import {
  type WorkflowConnectionCandidate,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowNodeKind,
  type WorkflowTopology,
} from '../domain/workflow-model'

const NODE_WIDTH = 208
const NODE_HEIGHT = 116
const MIN_ZOOM = 0.5
const MAX_ZOOM = 2.2
const INITIAL_VIEWPORT = Object.freeze({ x: 36, y: 36, zoom: 0.8 })

export type WorkflowGraphController = Readonly<{
  fit(): void
  focusNode(nodeId: string): void
  screenCenter(): Readonly<{ x: number; y: number }>
}>

export type WorkflowGraphProps = Readonly<{
  topology: WorkflowTopology
  selectedNodeId: string | null
  selectedEdgeId?: string | null
  copy: WorkflowCopy
  onSelectNode(nodeId: string | null): void
  onSelectEdge?(edgeId: string | null): void
  onMoveNode(nodeId: string, position: Readonly<{ x: number; y: number }>): void
  onConnect(candidate: WorkflowConnectionCandidate): void
  onReady?(controller: WorkflowGraphController): void
}>

type Viewport = Readonly<{ x: number; y: number; zoom: number }>
type DragState = Readonly<{
  nodeId: string
  pointerId: number
  origin: Readonly<{ x: number; y: number }>
  start: Readonly<{ x: number; y: number }>
}>
type ConnectionState = Readonly<{
  source: string
  pointerId: number
  point: Readonly<{ x: number; y: number }>
}>
type PanState = Readonly<{
  pointerId: number
  start: Readonly<{ x: number; y: number }>
  origin: Viewport
  moved: boolean
}>

export function WorkflowGraph({
  topology,
  selectedNodeId,
  selectedEdgeId = null,
  copy,
  onSelectNode,
  onSelectEdge,
  onMoveNode,
  onConnect,
  onReady,
}: WorkflowGraphProps) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const viewportRef = useRef<Viewport>(INITIAL_VIEWPORT)
  const dragRef = useRef<DragState | null>(null)
  const panRef = useRef<PanState | null>(null)
  const connectionRef = useRef<ConnectionState | null>(null)
  const movedRef = useRef(false)
  const [viewport, setViewport] = useState<Viewport>(INITIAL_VIEWPORT)
  const [livePosition, setLivePosition] = useState<Readonly<{
    nodeId: string
    position: Readonly<{ x: number; y: number }>
  }> | null>(null)
  const [connectionPoint, setConnectionPoint] = useState<Readonly<{
    source: string
    point: Readonly<{ x: number; y: number }>
  }> | null>(null)
  const markerId = `yolo-workflow-arrow-${useId().replace(/:/g, '')}`

  const renderNodes = useMemo(
    () =>
      livePosition
        ? topology.nodes.map((node) =>
            node.id === livePosition.nodeId
              ? { ...node, position: livePosition.position }
              : node,
          )
        : topology.nodes,
    [livePosition, topology.nodes],
  )
  const nodesById = useMemo(
    () => new Map(renderNodes.map((node) => [node.id, node])),
    [renderNodes],
  )

  const updateViewport = useCallback((next: Viewport) => {
    viewportRef.current = next
    setViewport(next)
  }, [])

  const worldPoint = useCallback((clientX: number, clientY: number) => {
    const rect = rootRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    const current = viewportRef.current
    return {
      x: (clientX - rect.left - current.x) / current.zoom,
      y: (clientY - rect.top - current.y) / current.zoom,
    }
  }, [])

  const fit = useCallback(() => {
    const rect = rootRef.current?.getBoundingClientRect()
    if (!rect || renderNodes.length === 0) return
    const minX = Math.min(...renderNodes.map((node) => node.position.x))
    const minY = Math.min(...renderNodes.map((node) => node.position.y))
    const maxX = Math.max(
      ...renderNodes.map((node) => node.position.x + NODE_WIDTH),
    )
    const maxY = Math.max(
      ...renderNodes.map((node) => node.position.y + NODE_HEIGHT),
    )
    const padding = Math.max(36, Math.min(rect.width, rect.height) * 0.14)
    const graphWidth = Math.max(1, maxX - minX)
    const graphHeight = Math.max(1, maxY - minY)
    const zoom = clamp(
      Math.min(
        (rect.width - padding * 2) / graphWidth,
        (rect.height - padding * 2) / graphHeight,
      ),
      MIN_ZOOM,
      1.15,
    )
    updateViewport({
      x: (rect.width - graphWidth * zoom) / 2 - minX * zoom,
      y: (rect.height - graphHeight * zoom) / 2 - minY * zoom,
      zoom,
    })
  }, [renderNodes, updateViewport])

  const focusNode = useCallback(
    (nodeId: string) => {
      const rect = rootRef.current?.getBoundingClientRect()
      const node = nodesById.get(nodeId)
      if (!rect || !node) return
      const zoom = clamp(
        Math.max(viewportRef.current.zoom, 0.96),
        MIN_ZOOM,
        1.15,
      )
      updateViewport({
        x: rect.width / 2 - (node.position.x + NODE_WIDTH / 2) * zoom,
        y: rect.height / 2 - (node.position.y + NODE_HEIGHT / 2) * zoom,
        zoom,
      })
    },
    [nodesById, updateViewport],
  )

  const screenCenter = useCallback(() => {
    const rect = rootRef.current?.getBoundingClientRect()
    if (!rect) return { x: 160, y: 120 }
    const current = viewportRef.current
    return {
      x: Math.round(
        (rect.width / 2 - current.x) / current.zoom - NODE_WIDTH / 2,
      ),
      y: Math.round(
        (rect.height / 2 - current.y) / current.zoom - NODE_HEIGHT / 2,
      ),
    }
  }, [])

  useEffect(() => {
    onReady?.({ fit, focusNode, screenCenter })
  }, [fit, focusNode, onReady, screenCenter])

  const zoomAtCenter = useCallback(
    (factor: number) => {
      const rect = rootRef.current?.getBoundingClientRect()
      if (!rect) return
      const current = viewportRef.current
      const zoom = clamp(current.zoom * factor, MIN_ZOOM, MAX_ZOOM)
      updateViewport({
        x:
          rect.width / 2 - (rect.width / 2 - current.x) * (zoom / current.zoom),
        y:
          rect.height / 2 -
          (rect.height / 2 - current.y) * (zoom / current.zoom),
        zoom,
      })
    },
    [updateViewport],
  )

  const findNodeAt = useCallback((clientX: number, clientY: number) => {
    const ownerDocument = rootRef.current?.ownerDocument
    const element = ownerDocument?.elementFromPoint(clientX, clientY)
    const id = element
      ?.closest?.('[data-yolo-workflow-node]')
      ?.getAttribute('data-yolo-workflow-node')
    return id ?? null
  }, [])

  const releasePointer = useCallback((pointerId: number) => {
    const root = rootRef.current
    dragRef.current = null
    panRef.current = null
    connectionRef.current = null
    movedRef.current = false
    setLivePosition(null)
    setConnectionPoint(null)
    if (root?.hasPointerCapture(pointerId))
      root.releasePointerCapture(pointerId)
  }, [])

  const cancelPointer = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (
        dragRef.current?.pointerId === event.pointerId ||
        panRef.current?.pointerId === event.pointerId ||
        connectionRef.current?.pointerId === event.pointerId
      ) {
        releasePointer(event.pointerId)
      }
    },
    [releasePointer],
  )

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const pan = panRef.current
      if (pan?.pointerId === event.pointerId) {
        const dx = event.clientX - pan.start.x
        const dy = event.clientY - pan.start.y
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2)
          panRef.current = { ...pan, moved: true }
        updateViewport({
          x: pan.origin.x + dx,
          y: pan.origin.y + dy,
          zoom: pan.origin.zoom,
        })
        return
      }
      const drag = dragRef.current
      if (drag?.pointerId === event.pointerId) {
        const point = worldPoint(event.clientX, event.clientY)
        const position = {
          x: Math.round(drag.origin.x + point.x - drag.start.x),
          y: Math.round(drag.origin.y + point.y - drag.start.y),
        }
        movedRef.current = true
        setLivePosition({ nodeId: drag.nodeId, position })
        return
      }
      const connection = connectionRef.current
      if (connection?.pointerId === event.pointerId) {
        const point = worldPoint(event.clientX, event.clientY)
        setConnectionPoint({ source: connection.source, point })
      }
    },
    [updateViewport, worldPoint],
  )

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const pan = panRef.current
      if (pan?.pointerId === event.pointerId) {
        if (!pan.moved) onSelectNode(null)
        releasePointer(event.pointerId)
        return
      }
      const drag = dragRef.current
      if (drag?.pointerId === event.pointerId) {
        const position = livePosition?.position
        if (position) onMoveNode(drag.nodeId, position)
        releasePointer(event.pointerId)
        return
      }
      const connection = connectionRef.current
      if (connection?.pointerId === event.pointerId) {
        const target = findNodeAt(event.clientX, event.clientY)
        if (target && target !== connection.source) {
          onConnect({ source: connection.source, target })
        }
        releasePointer(event.pointerId)
      }
    },
    [
      findNodeAt,
      livePosition,
      onConnect,
      onMoveNode,
      onSelectNode,
      releasePointer,
    ],
  )

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      const target = event.target as HTMLElement
      if (
        target.closest('[data-yolo-workflow-node]') ||
        target.closest('[data-yolo-workflow-control]')
      )
        return
      const root = rootRef.current
      if (!root) return
      event.preventDefault()
      root.setPointerCapture(event.pointerId)
      panRef.current = {
        pointerId: event.pointerId,
        start: { x: event.clientX, y: event.clientY },
        origin: viewportRef.current,
        moved: false,
      }
      movedRef.current = false
    },
    [],
  )

  const startNodeDrag = useCallback(
    (node: WorkflowNode, event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      const target = event.target as HTMLElement
      if (target.closest('[data-yolo-workflow-handle]')) return
      const root = rootRef.current
      if (!root) return
      event.preventDefault()
      event.stopPropagation()
      root.setPointerCapture(event.pointerId)
      const point = worldPoint(event.clientX, event.clientY)
      dragRef.current = {
        nodeId: node.id,
        pointerId: event.pointerId,
        origin: node.position,
        start: point,
      }
      movedRef.current = false
      onSelectNode(node.id)
    },
    [onSelectNode, worldPoint],
  )

  const startConnection = useCallback(
    (nodeId: string, event: React.PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return
      const root = rootRef.current
      if (!root) return
      event.preventDefault()
      event.stopPropagation()
      root.setPointerCapture(event.pointerId)
      const point = worldPoint(event.clientX, event.clientY)
      connectionRef.current = {
        source: nodeId,
        pointerId: event.pointerId,
        point,
      }
      setConnectionPoint({ source: nodeId, point })
    },
    [worldPoint],
  )

  const handleWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      event.preventDefault()
      const factor = event.deltaY < 0 ? 1.08 : 0.92
      zoomAtCenter(factor)
    },
    [zoomAtCenter],
  )

  const worldWidth = Math.max(
    1600,
    ...renderNodes.map((node) => node.position.x + NODE_WIDTH + 320),
  )
  const worldHeight = Math.max(
    1000,
    ...renderNodes.map((node) => node.position.y + NODE_HEIGHT + 260),
  )

  return (
    <div
      ref={rootRef}
      className="yolo-workflow-graph"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={cancelPointer}
      onLostPointerCapture={cancelPointer}
      onWheel={handleWheel}
      role="application"
      aria-label={copy.studio.title}
    >
      <div
        className="yolo-workflow-graph__world"
        style={{
          width: worldWidth,
          height: worldHeight,
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
        }}
      >
        <svg
          className="yolo-workflow-graph__edges"
          width={worldWidth}
          height={worldHeight}
          viewBox={`0 0 ${worldWidth} ${worldHeight}`}
        >
          <defs>
            <marker
              id={markerId}
              markerWidth="8"
              markerHeight="8"
              refX="7"
              refY="4"
              orient="auto"
              markerUnits="strokeWidth"
            >
              <path d="M 0 0 L 8 4 L 0 8 z" />
            </marker>
          </defs>
          {topology.edges.map((edge) => {
            const geometry = edgeGeometry(edge, nodesById)
            if (!geometry) return null
            return (
              <g
                key={edge.id}
                className={`yolo-workflow-graph__edge${
                  edge.id === selectedEdgeId ? ' is-selected' : ''
                }`}
              >
                <path
                  d={geometry.path}
                  className="yolo-workflow-graph__edge-hitbox"
                  role="button"
                  tabIndex={0}
                  aria-label={`${copy.inspector.title}: ${edge.source} → ${edge.target}`}
                  onPointerDown={(event) => {
                    event.stopPropagation()
                    onSelectEdge?.(edge.id)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      onSelectEdge?.(edge.id)
                    }
                  }}
                />
                <path
                  d={geometry.path}
                  markerEnd={`url(#${markerId})`}
                  className="yolo-workflow-graph__edge-line"
                />
                {edge.branch ? (
                  <text
                    x={geometry.label.x}
                    y={geometry.label.y - 7}
                    className="yolo-workflow-graph__edge-label"
                  >
                    {copy.branchLabel[edge.branch]}
                  </text>
                ) : null}
              </g>
            )
          })}
          {connectionPoint ? (
            <path
              d={connectionPath(connectionPoint, nodesById)}
              className="yolo-workflow-graph__connection"
            />
          ) : null}
        </svg>
        {renderNodes.map((node) => (
          <WorkflowGraphNode
            key={node.id}
            node={node}
            copy={copy}
            selected={node.id === selectedNodeId}
            onPointerDown={startNodeDrag}
            onSourcePointerDown={startConnection}
          />
        ))}
      </div>
      <div className="yolo-workflow-graph__controls" data-yolo-workflow-control>
        <button
          type="button"
          aria-label={copy.toolbar.zoomOut}
          title={copy.toolbar.zoomOut}
          onClick={() => zoomAtCenter(0.84)}
        >
          −
        </button>
        <button
          type="button"
          aria-label={copy.toolbar.fit}
          title={copy.toolbar.fit}
          onClick={fit}
        >
          ⌂
        </button>
        <button
          type="button"
          aria-label={copy.toolbar.zoomIn}
          title={copy.toolbar.zoomIn}
          onClick={() => zoomAtCenter(1.18)}
        >
          +
        </button>
      </div>
      {connectionPoint ? (
        <div className="yolo-workflow-graph__hint" role="status">
          {copy.rail.addNode}
        </div>
      ) : null}
    </div>
  )
}

function WorkflowGraphNode({
  node,
  copy,
  selected,
  onPointerDown,
  onSourcePointerDown,
}: Readonly<{
  node: WorkflowNode
  copy: WorkflowCopy
  selected: boolean
  onPointerDown(
    node: WorkflowNode,
    event: React.PointerEvent<HTMLDivElement>,
  ): void
  onSourcePointerDown(
    nodeId: string,
    event: React.PointerEvent<HTMLButtonElement>,
  ): void
}>) {
  const kind = node.kind as WorkflowNodeKind
  const kindLabel =
    kind === 'condition' && node.gateType
      ? `${copy.nodeKind[kind]} · ${copy.gateType[node.gateType]}`
      : copy.nodeKind[kind]
  return (
    <div
      className={`yolo-workflow-graph__node yolo-workflow-graph__node--${kind}${
        selected ? ' is-selected' : ''
      }`}
      data-yolo-workflow-node={node.id}
      style={{ left: node.position.x, top: node.position.y }}
      onPointerDown={(event) => onPointerDown(node, event)}
    >
      <button
        type="button"
        className="yolo-workflow-graph__handle yolo-workflow-graph__handle--target"
        data-yolo-workflow-handle
        aria-label={`${copy.inspector.title}: ${node.label}`}
        tabIndex={-1}
      />
      <div className="yolo-workflow-graph__node-kind">{kindLabel}</div>
      <div className="yolo-workflow-graph__node-label">{node.label}</div>
      <div className="yolo-workflow-graph__node-path">{node.stepPath}</div>
      <button
        type="button"
        className="yolo-workflow-graph__handle yolo-workflow-graph__handle--source"
        data-yolo-workflow-handle
        aria-label={`${copy.rail.addNode}: ${node.label}`}
        title={copy.rail.addNode}
        onPointerDown={(event) => onSourcePointerDown(node.id, event)}
      />
    </div>
  )
}

function edgeGeometry(
  edge: WorkflowEdge,
  nodesById: ReadonlyMap<string, WorkflowNode>,
): Readonly<{
  start: Readonly<{ x: number; y: number }>
  end: Readonly<{ x: number; y: number }>
  label: Readonly<{ x: number; y: number }>
  path: string
}> | null {
  const source = nodesById.get(edge.source)
  const target = nodesById.get(edge.target)
  if (!source || !target) return null
  const start = {
    x: source.position.x + NODE_WIDTH,
    y: source.position.y + NODE_HEIGHT / 2,
  }
  const end = { x: target.position.x, y: target.position.y + NODE_HEIGHT / 2 }
  const bend = Math.max(54, Math.abs(end.x - start.x) * 0.46)
  return {
    start,
    end,
    label: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 },
    path: `M ${start.x} ${start.y} C ${start.x + bend} ${start.y}, ${
      end.x - bend
    } ${end.y}, ${end.x} ${end.y}`,
  }
}

function connectionPath(
  connection: Readonly<{
    source: string
    point: Readonly<{ x: number; y: number }>
  }>,
  nodesById: ReadonlyMap<string, WorkflowNode>,
): string {
  const source = nodesById.get(connection.source)
  if (!source) return ''
  const start = {
    x: source.position.x + NODE_WIDTH,
    y: source.position.y + NODE_HEIGHT / 2,
  }
  const bend = Math.max(54, Math.abs(connection.point.x - start.x) * 0.46)
  return `M ${start.x} ${start.y} C ${start.x + bend} ${start.y}, ${
    connection.point.x - bend
  } ${connection.point.y}, ${connection.point.x} ${connection.point.y}`
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}
