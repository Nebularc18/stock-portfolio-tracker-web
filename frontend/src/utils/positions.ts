import { PositionEntry } from '../services/api'

function normalizeDate(value: string | null | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.slice(0, 10)
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
