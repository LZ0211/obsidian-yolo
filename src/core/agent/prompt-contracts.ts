const MEMORY_EXTRACTION_CONTRACT = `<memory_extraction_contract>
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
For add and update operations, reason is an optional short phrase explaining why this memory matters or when to apply it (e.g. "user corrected this twice"). Omit it for self-evident entries.
category must be exactly one of: profile, preferences, other. Never use a sector value as the category.
For add, use this shape: {"op":"add","content":"...","category":"preferences","scope":"global","keywords":["..."],"sector":"semantic"}.
For update, use this shape: {"op":"update","id":"Preference_1","new_content":"..."}.
If nothing is durable, return exactly {"operations":[]}.
Do not wrap the JSON in Markdown or add an explanation.
Never call tools. Return strict JSON only.
</memory_extraction_contract>`

export const buildMemoryExtractionContract = (): string =>
  MEMORY_EXTRACTION_CONTRACT
