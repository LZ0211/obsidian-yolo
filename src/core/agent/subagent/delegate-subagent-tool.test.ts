import { getLocalFileTools } from '../../mcp/localFileTools'
import {
  clearFlightLog,
  getFlightEvents,
  setFlightLogEnabled,
} from '../../../utils/debug/flightLog'
import {
  recordParentSubagentTimeout,
  resetParentSubagentBreakers,
  setParentSubagentTimeoutConfig,
} from './pending-timeout-registry'
import { delegateSubagentDefinition } from '../../tools/delegate_subagent/definition'

import { DELEGATE_SUBAGENT_TOOL_SHORT_NAME } from './tool-name-utils'

describe('delegate_subagent tool registration', () => {
  it('registers description and prompt as required, plus optional delegation inputs', () => {
    const tools = getLocalFileTools({ vaultBasePath: '/vault' })
    const tool = tools.find(
      (entry) => entry.name === DELEGATE_SUBAGENT_TOOL_SHORT_NAME,
    )
    expect(tool).toBeDefined()
    expect(tool?.inputSchema).toMatchObject({
      type: 'object',
      required: ['description', 'prompt'],
      properties: {
        description: { type: 'string' },
        prompt: { type: 'string' },
        delegatedRoleId: { type: 'string' },
        modelId: { type: 'string' },
      },
    })
    expect(tool?.inputSchema.properties).not.toHaveProperty('mode')
    expect(tool?.inputSchema.properties).not.toHaveProperty('delegatedRole')
  })
})

describe('delegate_subagent flight log events', () => {
  beforeEach(() => {
    jest.spyOn(console, 'debug').mockImplementation(() => undefined)
    setFlightLogEnabled(true)
    clearFlightLog()
  })

  afterEach(() => {
    setFlightLogEnabled(false)
    clearFlightLog()
    jest.restoreAllMocks()
    resetParentSubagentBreakers()
  })

  it('records delegate and delegate-blocked events when the breaker is open', async () => {
    setParentSubagentTimeoutConfig({
      timeoutMs: 1,
      maxConsecutiveTimeouts: 1,
      cooldownMs: 10_000,
    })
    recordParentSubagentTimeout('c1')

    const result = await delegateSubagentDefinition.execute(
      { description: 'run task', prompt: 'do it' },
      {
        app: {} as never,
        subagentParentContext: { runId: 'parent' } as never,
        runSubagent: jest.fn() as never,
        conversationId: 'c1',
        settings: {} as never,
      } as never,
    )

    expect(result).toMatchObject({
      status: 'success',
      text: expect.stringContaining('"blocked":true'),
    })
    const events = getFlightEvents()
    expect(
      events.some((event) => event.scope === 'subagent' && event.event === 'delegate'),
    ).toBe(true)
    const blocked = events.find((event) => event.event === 'delegate-blocked')
    expect(blocked).toMatchObject({ scope: 'subagent', id: 'c1' })
  })
})
