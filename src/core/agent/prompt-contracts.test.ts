import { buildMemoryExtractionContract } from './prompt-contracts'

describe('buildMemoryExtractionContract', () => {
  it('defines immutable durable-memory extraction rules', () => {
    expect(buildMemoryExtractionContract()).toMatchInlineSnapshot(`
"<memory_extraction_contract>
Extract only durable user profile facts, preferences, corrections, and long-term context.
Return no operations when no durable memory qualifies.
Do not create operations for transient tasks, tool output, specifications, or speculation.
Never store secrets, tokens, private keys, passwords, or sensitive document contents.
When a correction conflicts with existing memory, replace the conflicting entry.
Keep content concise and include concise aliases for named entities, projects, technologies, and concepts.
For add and update operations, sector values are episodic, semantic, procedural, emotional, and reflective.
Use semantic for profile and preferences, and episodic for other when adding memory.
For updates, omit sector to preserve the existing indexed sector.
Never use reflective for ordinary extraction.
Never call tools. Return strict JSON only.
</memory_extraction_contract>"
`)
  })

  it('defines the automatic extraction sector contract', () => {
    const contract = buildMemoryExtractionContract()

    expect(contract).toContain(
      'sector values are episodic, semantic, procedural, emotional, and reflective.',
    )
    expect(contract).toContain(
      'Use semantic for profile and preferences, and episodic for other when adding memory.',
    )
    expect(contract).toContain(
      'For updates, omit sector to preserve the existing indexed sector.',
    )
    expect(contract).toContain('Never use reflective for ordinary extraction.')
    expect(contract).toContain('Never call tools.')
    expect(contract).not.toContain('SQLite')
    expect(contract).not.toContain('D&D')
  })
})
