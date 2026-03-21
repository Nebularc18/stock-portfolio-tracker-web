import { PositionEntry } from '../services/api'
import { convertCurrencyValue } from './currency'

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

function parseQuantity(value: PositionEntry['quantity']): number {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''))
  return Number.isFinite(parsed) ? parsed : 0
}

function parseOptionalNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''))
  return Number.isFinite(parsed) ? parsed : null
}

export function getQuantityHeldOnDate(entries: PositionEntry[] | null | undefined, targetDate: string | null | undefined, fallbackQuantity: number): number {
  if (!entries || entries.length === 0) return fallbackQuantity
  const normalizedTargetDate = normalizeDate(targetDate)
  if (!normalizedTargetDate) {
    return entries
      .filter((entry) => !normalizeDate(entry.sell_date))
      .reduce((sum, entry) => sum + parseQuantity(entry.quantity), 0)
  }

  return entries.reduce((sum, entry) => {
    const purchaseDate = normalizeDate(entry.purchase_date)
    const sellDate = normalizeDate(entry.sell_date)
    if (purchaseDate && purchaseDate >= normalizedTargetDate) return sum
    if (sellDate && sellDate < normalizedTargetDate) return sum
    return sum + parseQuantity(entry.quantity)
  }, 0)
}

/**
 * Calculates the total acquisition cost of the position expressed in the target currency.
 *
 * Processes provided position entries (or a single fallback entry when none are supplied), ignores entries with a valid sell date, and sums each entry's purchase cost plus courtage after converting those amounts to `targetCurrency`. Returns `null` if no valid cost basis is found or if any required currency conversion fails.
 *
 * @param entries - Position entries to include in the calculation; if empty or absent a synthetic fallback entry is used.
 * @param fallbackQuantity - Quantity to use for the synthetic fallback entry when `entries` is empty or absent.
 * @param fallbackPurchasePrice - Purchase price to use for the synthetic fallback entry; may be `null` to indicate no price.
 * @param positionCurrency - Currency code of the position amounts (used as the default for unspecified courtage currency).
 * @param targetCurrency - Currency code to convert all costs into.
 * @param exchangeRates - Optional mapping of currency codes to conversion rates used by fallback conversion logic; defaults to an empty object.
 * @returns The summed cost (purchase cost plus courtage) converted to `targetCurrency`, or `null` if no cost basis applies or a conversion could not be performed.
 */
export function calculatePositionCostInCurrency(
  entries: PositionEntry[] | null | undefined,
  fallbackQuantity: number,
  fallbackPurchasePrice: number | null | undefined,
  positionCurrency: string,
  targetCurrency: string,
  exchangeRates: Record<string, number | null> = {},
): number | null {
  const effectiveEntries = entries && entries.length > 0
    ? entries
    : [{
        id: 'fallback',
        quantity: fallbackQuantity,
        purchase_price: fallbackPurchasePrice ?? null,
        courtage: 0,
        courtage_currency: null,
        exchange_rate: null,
        exchange_rate_currency: null,
        purchase_date: null,
        sell_date: null,
      }]

  let totalCost = 0
  let hasCostBasis = false

  for (const entry of effectiveEntries) {
    if (normalizeDate(entry.sell_date)) continue

    const quantity = parseQuantity(entry.quantity)
    const purchasePrice = parseOptionalNumber(entry.purchase_price)
    const courtage = parseOptionalNumber(entry.courtage) ?? 0
    const courtageCurrency = entry.courtage_currency?.trim().toUpperCase() || positionCurrency
    if (quantity <= 0 || purchasePrice === null) continue

    const nativeCost = purchasePrice * quantity
    let convertedCost: number | null = null

    if (positionCurrency === targetCurrency) {
      convertedCost = nativeCost
    } else {
      const historicalRate = parseOptionalNumber(entry.exchange_rate)
      const historicalRateCurrency = entry.exchange_rate_currency?.trim().toUpperCase() || null
      if (historicalRate !== null && historicalRateCurrency === targetCurrency) {
        convertedCost = nativeCost * historicalRate
      } else {
        convertedCost = convertCurrencyValue(nativeCost, positionCurrency, targetCurrency, exchangeRates)
      }
    }

    if (convertedCost === null) return null

    let convertedCourtage: number | null = 0
    if (courtage === 0) {
      convertedCourtage = 0
    } else if (courtageCurrency === targetCurrency) {
      convertedCourtage = courtage
    } else if (courtageCurrency === positionCurrency) {
      if (positionCurrency === targetCurrency) {
        convertedCourtage = courtage
      } else {
        const historicalRate = parseOptionalNumber(entry.exchange_rate)
        const historicalRateCurrency = entry.exchange_rate_currency?.trim().toUpperCase() || null
        if (historicalRate !== null && historicalRateCurrency === targetCurrency) {
          convertedCourtage = courtage * historicalRate
        } else {
          convertedCourtage = convertCurrencyValue(courtage, positionCurrency, targetCurrency, exchangeRates)
        }
      }
    } else {
      convertedCourtage = convertCurrencyValue(courtage, courtageCurrency, targetCurrency, exchangeRates)
    }

    if (convertedCourtage === null) return null

    totalCost += convertedCost + convertedCourtage
    hasCostBasis = true
  }

  return hasCostBasis ? totalCost : null
}
