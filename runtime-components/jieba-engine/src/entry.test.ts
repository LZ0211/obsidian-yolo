export {}

type RegisteredDefinition = {
  id: string
  create: () => unknown
}

describe('jieba-engine runtime component', () => {
  it('registers its runtime component definition when loaded', async () => {
    let captured: RegisteredDefinition | undefined
    const previous = globalThis.__yolo_register_runtime_component__
    globalThis.__yolo_register_runtime_component__ = (definition) => {
      captured = definition
    }

    try {
      await import('./entry')
    } finally {
      globalThis.__yolo_register_runtime_component__ = previous
    }

    expect(captured).toEqual(
      expect.objectContaining({
        id: 'jieba-engine',
        create: expect.any(Function),
      }),
    )
  })
})
