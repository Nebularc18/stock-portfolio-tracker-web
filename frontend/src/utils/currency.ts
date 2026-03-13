export function convertCurrencyValue(
  amount: number | null,
  fromCurrency: string,
  toCurrency: string,
  exchangeRates: Record<string, number | null>
): number | null {
  if (amount === null) return null
  if (amount === 0) return 0
  if (fromCurrency === toCurrency) return amount

  const directRate = exchangeRates[`${fromCurrency}_${toCurrency}`]
  if (typeof directRate === 'number' && Number.isFinite(directRate) && directRate !== 0) {
    return amount * directRate
  }

  const inverseRate = exchangeRates[`${toCurrency}_${fromCurrency}`]
  if (typeof inverseRate === 'number' && Number.isFinite(inverseRate) && inverseRate !== 0) {
    return amount / inverseRate
  }

  return null
}

export function convertCurrencyToSEK(
  amount: number | null,
  currency: string,
  exchangeRates: Record<string, number | null>
): number | null {
  return convertCurrencyValue(amount, currency, 'SEK', exchangeRates)
}
