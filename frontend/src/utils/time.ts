/**
 * Normalize a Date or date string into a Date object while preserving UTC semantics.
 *
 * @param date - A Date instance or a date string. If a string matches `YYYY-MM-DD` it is treated as a date-only value (midnight UTC). If the string already contains a timezone designator (`Z`, `z`, or `±HH:MM`) it is used as-is; otherwise `Z` is appended to interpret the value as UTC.
 * @returns A Date representing the same instant. If a Date instance is provided, it is returned unchanged.
 */
function parseDatePreservingUtc(date: Date | string): Date {
  if (date instanceof Date) return date

  const value = date.trim()
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value)
  const hasTimezone = /([zZ]|[+-]\d{2}:\d{2})$/.test(value)
  const normalized = hasTimezone ? value : (isDateOnly ? `${value}T00:00:00Z` : `${value}Z`)
  return new Date(normalized)
}

/**
 * Format a date or timestamp as a 24-hour time string for a specified locale and IANA timezone.
 *
 * @param date - A Date object, an ISO date/time string, or `null`. If `null` or invalid, the function returns `-`.
 * @param timezone - IANA timezone identifier used when formatting (for example, "America/New_York").
 * @param locale - BCP 47 locale tag used for localization (defaults to `'en-US'`).
 * @returns The time formatted as `HH:MM:SS` in 24-hour form for the specified locale/timezone, or `-` if the input is `null` or invalid.
 */
export function formatTimeInTimezone(date: Date | string | null, timezone: string, locale: string = 'en-US'): string {
  if (!date) return '-'

  const d = parseDatePreservingUtc(date)
  if (Number.isNaN(d.getTime())) return '-'
  
  try {
    return d.toLocaleTimeString(locale, {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    })
  } catch {
    return d.toLocaleTimeString(locale, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    })
  }
}

/**
 * Format a date/time using short month, numeric day, and 24-hour time in the specified IANA timezone.
 *
 * @param date - The date to format; may be a Date or a date string. If `null` or `undefined`, `'-'` is returned.
 * @param timezone - IANA time zone identifier (for example, `"America/New_York"`) used for output conversion.
 * @param locale - BCP 47 language tag for locale-specific formatting (default: `'en-US'`).
 * @returns The localized date and time string (e.g., `Mar 5, 14:03`) or `'-'` if `date` is null or invalid.
 */
export function formatDateTimeInTimezone(date: Date | string | null, timezone: string, locale: string = 'en-US'): string {
  if (!date) return '-'

  const d = parseDatePreservingUtc(date)
  if (Number.isNaN(d.getTime())) return '-'
  
  try {
    return d.toLocaleString(locale, {
      timeZone: timezone,
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    })
  } catch {
    return d.toLocaleString(locale, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    })
  }
}

export function getTimeUntilNextInterval(intervalMinutes: number): number {
  const now = new Date()
  const currentMinutes = now.getMinutes()
  const currentSeconds = now.getSeconds()
  const currentMs = now.getMilliseconds()
  
  const minutesUntilNext = intervalMinutes - (currentMinutes % intervalMinutes)
  const msUntilNext = (minutesUntilNext * 60 - currentSeconds) * 1000 - currentMs
  
  return msUntilNext
}

export function getNextAlignedTime(intervalMinutes: number): Date {
  const now = new Date()
  const msUntilNext = getTimeUntilNextInterval(intervalMinutes)
  return new Date(now.getTime() + msUntilNext)
}

export function getLatestTimestamp(items: { last_updated: string | null }[]): string | null {
  return items.reduce((max: string | null, item) => {
    if (!item.last_updated) return max
    if (!max) return item.last_updated
    return item.last_updated > max ? item.last_updated : max
  }, null)
}
