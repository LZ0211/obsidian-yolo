import type { AgentGitFileDiff } from '../../../types/chat'

export type ParsedGitNumstat = AgentGitFileDiff & {
  path: string
  oldPath?: string
  binary: boolean
}

type CursorField = {
  value: string
  nextCursor: number
}

const readCursorField = (
  output: string,
  cursor: number,
  delimiter: string,
): CursorField | null => {
  const delimiterIndex = output.indexOf(delimiter, cursor)
  if (delimiterIndex === -1) {
    return null
  }

  return {
    value: output.slice(cursor, delimiterIndex),
    nextCursor: delimiterIndex + delimiter.length,
  }
}

const parseCount = (value: string): number | null => {
  if (value === '-') {
    return 0
  }
  if (!/^\d+$/.test(value)) {
    return null
  }

  const count = Number(value)
  return Number.isSafeInteger(count) ? count : null
}

export const parseGitNumstat = (output: string): ParsedGitNumstat[] => {
  const records: ParsedGitNumstat[] = []
  let cursor = 0

  while (cursor < output.length) {
    const additionsField = readCursorField(output, cursor, '\t')
    if (!additionsField) {
      break
    }
    cursor = additionsField.nextCursor

    const deletionsField = readCursorField(output, cursor, '\t')
    if (!deletionsField) {
      break
    }
    cursor = deletionsField.nextCursor

    const pathField = readCursorField(output, cursor, '\0')
    if (!pathField) {
      break
    }
    cursor = pathField.nextCursor

    const additions = parseCount(additionsField.value)
    const deletions = parseCount(deletionsField.value)
    if (additions === null || deletions === null) {
      break
    }

    const binary = additionsField.value === '-' || deletionsField.value === '-'

    if (pathField.value) {
      records.push({
        path: pathField.value,
        additions,
        deletions,
        binary,
      })
      continue
    }

    const oldPathField = readCursorField(output, cursor, '\0')
    if (!oldPathField) {
      break
    }
    cursor = oldPathField.nextCursor

    const newPathField = readCursorField(output, cursor, '\0')
    if (!newPathField) {
      break
    }
    cursor = newPathField.nextCursor

    records.push({
      oldPath: oldPathField.value,
      path: newPathField.value,
      additions,
      deletions,
      binary,
    })
  }

  return records
}
