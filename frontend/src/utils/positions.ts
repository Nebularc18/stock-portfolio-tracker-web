import { PositionEntry } from '../services/api'

function normalizeDate(value: string | null | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const normalized = trimmed.slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return null

  const [year, month, day] = normalized.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (Number.isNaN(parsed.getTime())) return null
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() + 1 !== month
    || parsed.getUTCDate() !== day
  ) {
    return null
  }

  return normalized
}

export function getQuantityHeldOnDate(entries: PositionEntry[] | null | undefined, targetDate: string | null | undefined, fallbackQuantity: number): number {
  if (!entries || entries.length === 0) return fallbackQuantity
  const normalizedTargetDate = normalizeDate(targetDate)
  if (!normalizedTargetDate) {
    return entries
      .filter((entry) => !normalizeDate(entry.sell_date))
      .reduce((sum, entry) => sum + Number(entry.quantity || 0), 0)
  }

  return entries.reduce((sum, entry) => {
    const purchaseDate = normalizeDate(entry.purchase_date)
    const sellDate = normalizeDate(entry.sell_date)
    if (purchaseDate && purchaseDate >= normalizedTargetDate) return sum
    if (sellDate && sellDate <= normalizedTargetDate) return sum
    return sum + Number(entry.quantity || 0)
  }, 0)
}
