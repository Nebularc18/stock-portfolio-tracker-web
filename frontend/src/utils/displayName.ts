export function formatDisplayName(name: string | null | undefined, fallback: string): string {
  if (!name) return fallback
  const trimmed = name.trim()
  if (trimmed === '') return fallback
  return trimmed
    .replace(/\s+\(The\)$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}
