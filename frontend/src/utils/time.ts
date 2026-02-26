export function formatTimeInTimezone(date: Date | string | null, timezone: string): string {
  if (!date) return '-'
  
  const d = typeof date === 'string' ? new Date(date) : date
  
  try {
    return d.toLocaleTimeString('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    })
  } catch {
    return d.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    })
  }
}

export function formatDateTimeInTimezone(date: Date | string | null, timezone: string): string {
  if (!date) return '-'
  
  const d = typeof date === 'string' ? new Date(date) : date
  
  try {
    return d.toLocaleString('en-US', {
      timeZone: timezone,
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    })
  } catch {
    return d.toLocaleString('en-US', {
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
