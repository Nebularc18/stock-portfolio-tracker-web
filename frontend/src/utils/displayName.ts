export function formatDisplayName(name: string | null | undefined, fallback: string): string {
  if (!name) return fallback
  return name
    .replace(/\s+\(The\)$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}
