// Rendered as text only. Log lines, span attributes and audit payloads can carry
// attacker-influenced strings (Jira descriptions, log excerpts), so nothing here is ever
// interpreted as HTML.
export function JsonBlock({ value }: { value: unknown }) {
  return <pre className="json">{JSON.stringify(value, null, 2)}</pre>;
}
