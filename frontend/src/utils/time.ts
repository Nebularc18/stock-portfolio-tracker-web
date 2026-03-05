function parseDatePreservingUtc(date: Date | string): Date {
  if (date instanceof Date) return date

  const value = date.trim()
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value)
  const hasTimezone = /([zZ]|[+-]\d{2}:\d{2})$/.test(value)
  const normalized = hasTimezone ? value : (isDateOnly ? `${value}T00:00:00Z` : `${value}Z`)
  return new Date(normalized)
}

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
