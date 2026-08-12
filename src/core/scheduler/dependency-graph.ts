import type { ScheduledTask } from './scheduledTasksStore'

export function buildDependencyGraph(
  tasks: Pick<ScheduledTask, 'id' | 'dependsOn'>[],
): Map<string, string[]> {
  const graph = new Map<string, string[]>()
  for (const task of tasks) graph.set(task.id, task.dependsOn ?? [])
  return graph
}

/** Classic three-color DFS. The graph may reference ids outside itself (a dependency on a deleted task) — those are simply not followed, not treated as a cycle. */
export function detectCycles(graph: Map<string, string[]>): string[][] {
  const cycles: string[][] = []
  const state = new Map<string, 'visiting' | 'done'>()
  const path: string[] = []

  function visit(id: string): void {
    if (state.get(id) === 'done') return
    if (state.get(id) === 'visiting') {
      const start = path.indexOf(id)
      cycles.push([...path.slice(start), id])
      return
    }
    state.set(id, 'visiting')
    path.push(id)
    for (const dep of graph.get(id) ?? []) visit(dep)
    path.pop()
    state.set(id, 'done')
  }

  for (const id of graph.keys()) visit(id)
  return cycles
}

/**
 * Callers must pass the full task list as it would look *after* the in-flight create/edit
 * is applied (dependsOn reflecting the form's current value), not the stale list already in
 * the store — otherwise a cycle introduced by the edit itself is invisible to this check.
 */
export function validateDependencyGraph(
  tasks: Pick<ScheduledTask, 'id' | 'dependsOn'>[],
): { field: 'dependsOn'; message: string } | null {
  const cycles = detectCycles(buildDependencyGraph(tasks))
  if (cycles.length > 0) {
    return {
      field: 'dependsOn',
      message: `检测到循环依赖: ${cycles[0].join(' → ')}`,
    }
  }
  return null
}
