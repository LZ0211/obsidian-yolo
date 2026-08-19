import { parseWorkflowRunInput } from './workflow-run-input'

describe('parseWorkflowRunInput', () => {
  it('rejects blank input', () => {
    expect(parseWorkflowRunInput('')).toEqual({
      ok: false,
      message: expect.any(String),
    })
    expect(parseWorkflowRunInput('   \n\t ')).toEqual({
      ok: false,
      message: expect.any(String),
    })
  })

  it('passes plain text through as the trimmed string', () => {
    expect(parseWorkflowRunInput('hello world')).toEqual({
      ok: true,
      value: 'hello world',
    })
    expect(parseWorkflowRunInput('  hello world \n')).toEqual({
      ok: true,
      value: 'hello world',
    })
  })

  it('parses a JSON string', () => {
    expect(parseWorkflowRunInput('"hello"')).toEqual({
      ok: true,
      value: 'hello',
    })
  })

  it('parses JSON numbers', () => {
    expect(parseWorkflowRunInput('42')).toEqual({ ok: true, value: 42 })
    expect(parseWorkflowRunInput('-1.5')).toEqual({ ok: true, value: -1.5 })
  })

  it('parses JSON booleans and null', () => {
    expect(parseWorkflowRunInput('true')).toEqual({ ok: true, value: true })
    expect(parseWorkflowRunInput('false')).toEqual({ ok: true, value: false })
    expect(parseWorkflowRunInput('null')).toEqual({ ok: true, value: null })
  })

  it('parses JSON arrays', () => {
    expect(parseWorkflowRunInput('[1, "two", null]')).toEqual({
      ok: true,
      value: [1, 'two', null],
    })
  })

  it('parses JSON objects', () => {
    expect(parseWorkflowRunInput('{"topic": "demo", "count": 2}')).toEqual({
      ok: true,
      value: { topic: 'demo', count: 2 },
    })
  })

  it('rejects malformed JSON instead of passing it as a string', () => {
    const result = parseWorkflowRunInput('{"topic":')
    expect(result).toEqual({ ok: false, message: expect.any(String) })
    expect(result.ok).toBe(false)
  })

  it('rejects non-finite numbers produced by JSON.parse', () => {
    // JSON.parse('1e999') yields Infinity, which is not JSON-compatible.
    expect(parseWorkflowRunInput('1e999')).toEqual({
      ok: false,
      message: expect.any(String),
    })
  })

  it('rejects trailing garbage that JSON.parse would ignore', () => {
    expect(parseWorkflowRunInput('{"a":1} trailing')).toEqual({
      ok: false,
      message: expect.any(String),
    })
  })

  it('trims surrounding whitespace before parsing JSON', () => {
    expect(parseWorkflowRunInput('  {"topic": "demo"}  ')).toEqual({
      ok: true,
      value: { topic: 'demo' },
    })
  })
})
