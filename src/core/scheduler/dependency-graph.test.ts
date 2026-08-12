import {
  buildDependencyGraph,
  detectCycles,
  validateDependencyGraph,
} from './dependency-graph'
import type { ScheduledTask } from './scheduledTasksStore'

function makeTasks(
  deps: Record<string, string[] | null>,
): Pick<ScheduledTask, 'id' | 'dependsOn'>[] {
  return Object.entries(deps).map(([id, dependsOn]) => ({ id, dependsOn }))
}

describe('buildDependencyGraph', () => {
  it('maps each task id to its dependsOn list, defaulting null to an empty array', () => {
    const graph = buildDependencyGraph(
      makeTasks({ a: null, b: ['a'], c: ['a', 'b'] }),
    )
    expect(graph.get('a')).toEqual([])
    expect(graph.get('b')).toEqual(['a'])
    expect(graph.get('c')).toEqual(['a', 'b'])
  })
})

describe('detectCycles', () => {
  it('returns no cycles for a DAG', () => {
    const graph = buildDependencyGraph(
      makeTasks({ a: null, b: ['a'], c: ['b'] }),
    )
    expect(detectCycles(graph)).toEqual([])
  })

  it('detects a self-loop', () => {
    const graph = buildDependencyGraph(makeTasks({ a: ['a'] }))
    expect(detectCycles(graph)).toEqual([['a', 'a']])
  })

  it('detects a two-node cycle', () => {
    const graph = buildDependencyGraph(makeTasks({ a: ['b'], b: ['a'] }))
    const cycles = detectCycles(graph)
    expect(cycles).toHaveLength(1)
    expect(cycles[0]).toEqual(expect.arrayContaining(['a', 'b']))
  })

  it('does not treat a dependency on a task outside the graph as a cycle', () => {
    const graph = buildDependencyGraph(makeTasks({ a: ['deleted-task'] }))
    expect(detectCycles(graph)).toEqual([])
  })
})

describe('validateDependencyGraph', () => {
  it('returns null when there is no cycle', () => {
    expect(validateDependencyGraph(makeTasks({ a: null, b: ['a'] }))).toBeNull()
  })

  it('returns a dependsOn field error naming the cycle when one exists', () => {
    const error = validateDependencyGraph(makeTasks({ a: ['b'], b: ['a'] }))
    expect(error?.field).toBe('dependsOn')
    expect(error?.message).toContain('a')
    expect(error?.message).toContain('b')
  })
})
