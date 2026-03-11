export function resolveBackendAssetUrl(value: string | null | undefined): string | null {
  if (!value) return null
  if (/^https?:\/\//i.test(value)) return value
  if (value.startsWith('/api/static/')) return value
  if (value.startsWith('/static/')) return `/api${value}`
  if (value.startsWith('static/')) return `/api/${value}`
  return value
}
