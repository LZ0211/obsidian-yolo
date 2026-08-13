import {
  MEMORY_RECALL_EVAL_CASES,
  type MemoryRecallEvalCase,
} from './__fixtures__/memoryRecallEvalCases'
import { buildMemoryRecallTarget } from './memoryRecallTarget'

const expectLexicalTarget = (
  target: ReturnType<typeof buildMemoryRecallTarget>,
  testCase: MemoryRecallEvalCase,
): void => {
  expect(target.source).toBe('lexical')

  if (testCase.expectedEntity) {
    expect(target.entities).toContain(testCase.expectedEntity)
  }
  if (testCase.expectedPersistedAlias) {
    expect(target.keywords).toContain(testCase.expectedPersistedAlias)
  }
  if (testCase.expectedMissingKeyword) {
    expect(target.keywords).not.toContain(testCase.expectedMissingKeyword)
  }
}

describe('memory recall evaluation cases', () => {
  it.each(MEMORY_RECALL_EVAL_CASES)('$name', (testCase) => {
    const target = buildMemoryRecallTarget(testCase.input)

    expectLexicalTarget(target, testCase)
  })
})
