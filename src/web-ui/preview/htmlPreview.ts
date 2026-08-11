// Match event-handler attributes (onclick/onerror/onload/...) only when
// `on` actually starts an attribute name — i.e. preceded by a word
// boundary. The previous /on\w+\s*=/ matched substrings inside ordinary
// attribute values like `<meta content="...">` (the `on` inside `content`
// triggered it), so every non-trivial HTML file kept prompting.
const DANGEROUS_PATTERNS = /<script[\s>]|\bon[a-z]+\s*=|javascript\s*:/i

export function hasActiveContent(html: string): boolean {
  return DANGEROUS_PATTERNS.test(html)
}
