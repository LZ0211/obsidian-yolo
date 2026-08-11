import { buildMockLongTimelineMessages } from './mockFixtures'
import { createMockTransport } from './webMockTransport'

describe('createMockTransport', () => {
  it('starts unauthenticated before mock login succeeds', async () => {
    const { client } = createMockTransport()
    await expect(client.getWebAuthState()).resolves.toBeNull()
  })

  it('returns no session after logout until login succeeds again', async () => {
    const { client } = createMockTransport()

    await client.loginWithShareToken('token')
    await client.logout()

    await expect(client.getWebAuthState()).resolves.toBeNull()

    await client.loginWithShareToken('token')
    await expect(client.getWebAuthState()).resolves.toMatchObject({
      session: { agentId: expect.any(String) },
    })
  })

  it('builds a deterministic long timeline with stable message ids', () => {
    const messages = buildMockLongTimelineMessages(120)

    expect(messages).toHaveLength(240)
    expect(messages[0]).toMatchObject({ role: 'user', id: 'timeline-u-001' })
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      id: 'timeline-a-001',
    })
    expect(messages[19].content).toContain('```ts')
    expect(messages.map((message) => message.id)).toEqual(
      buildMockLongTimelineMessages(120).map((message) => message.id),
    )
  })

  it('serves long timeline messages through the mock transport', async () => {
    const { client, historyClient } = createMockTransport({
      timelineTurns: 120,
    })
    const [chat] = await historyClient.listChats()
    expect(chat).toBeDefined()

    // ShellClient 契约不含 getJson（mock 专用便利方法）——本文件既有 cast 先例
    const typedClient = client as typeof client & {
      getJson: <T>(path: string) => Promise<T>
    }
    const response = await typedClient.getJson<{
      messages: Array<{ id: string; content?: string | null }>
    }>(`/api/chat/get/${chat.id}`)

    expect(response.messages).toHaveLength(240)
    expect(response.messages[0]?.id).toBe('timeline-u-001')
    expect(response.messages[19]?.content).toContain('```ts')
  })

  it('exposes the web skill endpoint and complete workspace-agent policies', async () => {
    const { client } = createMockTransport({ workspaceRoot: 'Projects' })
    const typedClient = client as typeof client & {
      getSkills: () => Promise<unknown[]>
    }

    await expect(typedClient.getSkills()).resolves.toEqual([])
    const settings = (await client.getSettings()) as {
      workspaceAgents: unknown[]
    }
    expect(settings.workspaceAgents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          templateId: 'mock-agent',
          workspacePolicy: expect.objectContaining({
            workspaceRoot: 'Projects',
          }),
        }),
      ]),
    )
  })
})
