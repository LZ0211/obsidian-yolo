describe('workflow module chat mode', () => {
  it('registers one localized workflow mode with the unified tools', async () => {
    const registerModule = jest.fn()
    Object.defineProperty(globalThis, 'yolo', {
      configurable: true,
      value: { registerModule },
    })
    const globalYolo = globalThis as typeof globalThis & {
      yolo: { registerModule: jest.Mock }
    }

    await import('./index')
    const definition = registerModule.mock.calls[0]?.[0] as {
      activate(host: YoloModuleHostApiV1): void
    }
    const host = fakeHost()

    definition.activate(host as unknown as YoloModuleHostApiV1)

    expect(globalYolo.yolo.registerModule).toHaveBeenCalledTimes(1)
    expect(host.chat.registerMode).toHaveBeenCalledTimes(1)
    expect(host.chat.registerMode).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'workflow',
        label: {
          en: 'Workflow Studio',
          zh: '\u6d41\u7a0b\u5de5\u4f5c\u5ba4',
          it: 'Studio del flusso di lavoro',
        },
        description: {
          en: 'Design and maintain document-driven agent workflows.',
          zh: '\u8bbe\u8ba1\u5e76\u7ef4\u62a4\u7531\u6587\u6863\u9a71\u52a8\u7684 Agent \u5de5\u4f5c\u6d41\u3002',
          it: 'Progetta e gestisci flussi di agenti basati su documenti.',
        },
        icon: 'workflow',
        capability: 'none',
        personaPrompt: expect.stringContaining('workflow_read'),
        skills: ['skills/workflow/SKILL.md'],
      }),
    )

    const mode = host.chat.registerMode.mock.calls[0][0] as {
      tools: readonly YoloModuleHostChatModeToolV1[]
      personaPrompt: string
    }
    expect(mode.personaPrompt).toContain('workflow_create')
    expect(mode.tools.map((tool) => tool.name)).toEqual([
      'workflow_read',
      'workflow_create',
    ])
    expect(mode.tools[0]?.requiresApproval).toBeUndefined()
    expect(mode.tools[1]?.requiresApproval).toBe(true)
  })
})

function fakeHost(): RegistrationHost {
  return {
    chat: { registerMode: jest.fn() },
    i18n: { getSnapshot: () => ({ locale: 'zh-CN' }) },
    paths: {
      getSnapshot: () => ({ contentRoot: 'managed/workflows' }),
    },
    vault: {},
  } as unknown as RegistrationHost
}

type RegistrationHost = Omit<YoloModuleHostApiV1, 'chat'> & {
  chat: { registerMode: jest.Mock }
}
