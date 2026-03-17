import { PositionEntry } from '../services/api'

/**
 * Validate and normalize a date string into the ISO date format YYYY-MM-DD.
 *
 * @param value - A date string (may include time or surrounding whitespace); the function uses the first 10 characters after trimming.
 * @returns The normalized `YYYY-MM-DD` string if `value` represents a valid UTC calendar date, `null` otherwise.
 */
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

/**
 * Calculate the total quantity held on a given date from a list of position entries.
 *
 * If `entries` is null/empty the function returns `fallbackQuantity`. If `targetDate` is not a valid YYYY-MM-DD date, the function sums quantities of entries that have no valid `sell_date`. Missing `quantity` values are treated as 0.
 *
 * @param entries - Array of position entries; only `purchase_date`, `sell_date`, and `quantity` are used
 * @param targetDate - Target date as a string (YYYY-MM-DD); when invalid, compute quantity for entries without a valid `sell_date`
 * @param fallbackQuantity - Value to return when `entries` is null or empty
 * @returns The summed quantity held on `targetDate`
 */
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
