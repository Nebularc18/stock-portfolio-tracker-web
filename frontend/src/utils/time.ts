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
