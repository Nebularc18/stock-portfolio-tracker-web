/**
 * Normalize frontend asset paths into backend-accessible URLs.
 *
 * @param value - An asset path or URL (may be an absolute `http(s)` URL, an absolute or relative `/static` path, or `null`/`undefined`)
 * @returns `null` if `value` is falsy; otherwise a string where:
 *  - absolute `http(s)` URLs are returned unchanged,
 *  - paths starting with `/api/static/` are returned unchanged,
 *  - `/static/...` is rewritten to `/api/static/...`,
 *  - `static/...` is rewritten to `/api/static/...`,
 *  - all other inputs are returned unchanged
 */
export function resolveBackendAssetUrl(value: string | null | undefined): string | null {
  if (!value) return null
  if (/^https?:\/\//i.test(value)) return value
  if (value.startsWith('/api/static/')) return value
  if (value.startsWith('/static/')) return `/api${value}`
  if (value.startsWith('static/')) return `/api/${value}`
  return value
}
