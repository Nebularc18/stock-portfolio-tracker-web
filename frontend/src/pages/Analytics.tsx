import { useState, useEffect, useCallback } from 'react'
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, BarChart, Bar, XAxis, YAxis, CartesianGrid, Legend } from 'recharts'
import { api, Dividend, DistributionResponse, DividendsByTicker } from '../services/api'
import { useSettings } from '../SettingsContext'
import { getLocaleForLanguage, t } from '../i18n'

const COLORS = ['#6366f1', '#ec4899', '#ef4444', '#f97316', '#22c55e', '#3b82f6', '#a855f7', '#f43f5e']
const COMPARISON_COLORS = ['#22c55e', '#f59e0b', '#ec4899']

type DividendComparisonRow = {
  month: string
} & Record<string, number | string>

/**
 * Format a number as a currency string using the specified locale and currency.
 *
 * @param value - The numeric amount to format
 * @param locale - BCP 47 locale tag to use for formatting (e.g., "en-US")
 * @param currency - ISO 4217 currency code to display (defaults to 'USD')
 * @returns The formatted currency string (for example, "$1,234.56")
 */
function formatCurrency(value: number, locale: string, currency: string = 'USD'): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(value)
}

/**
 * Convert a dividend amount from one currency to another using provided FX rates.
 *
 * @param amount - The monetary amount to convert
 * @param fromCurrency - The source currency code; if undefined, `toCurrency` is assumed (no conversion)
 * @param toCurrency - The target currency code for the conversion
 * @param fxRates - A map of FX rates where keys are `"SRC_TGT"` (e.g., `"USD_EUR"`) and values are the rate or `null`
 * @returns The converted amount in `toCurrency`, or `null` if no applicable rate is available
 */
function convertDividendValue(
  amount: number,
  fromCurrency: string | undefined,
  toCurrency: string,
  fxRates: Record<string, number | null>
): number | null {
  const sourceCurrency = fromCurrency || toCurrency
  if (sourceCurrency === toCurrency) return amount
  const direct = fxRates[`${sourceCurrency}_${toCurrency}`]
  if (direct != null) return amount * direct
  const inverse = fxRates[`${toCurrency}_${sourceCurrency}`]
  if (inverse != null && inverse !== 0) return amount / inverse
  return null
}

/**
 * Render the Analytics page showing portfolio and sector distributions using pie charts.
 *
 * Displays locale- and currency-aware tooltips and manages loading, error (with retry), and empty-data states.
 *
 * @returns A React element that renders distribution charts, a centered loading indicator, an error card with a retry action, or an empty-data message.
 */
export default function Analytics() {
  const [distribution, setDistribution] = useState<DistributionResponse | null>(null)
  const [dividendComparisonData, setDividendComparisonData] = useState<DividendComparisonRow[]>([])
  const [availableComparisonYears, setAvailableComparisonYears] = useState<number[]>([])
  const [selectedComparisonYears, setSelectedComparisonYears] = useState<number[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const { displayCurrency, language } = useSettings()
  const locale = getLocaleForLanguage(language)
  const chartCurrency = distribution?.display_currency || displayCurrency

  const fetchData = useCallback(async () => {
    try {
      setLoading(true)
      const [distributionData, stocksData] = await Promise.all([
        api.portfolio.distribution(),
        api.stocks.list(),
      ])
      setDistribution(distributionData)
      const targetCurrency = distributionData.display_currency || displayCurrency

      const now = new Date()
      const currentYear = now.getUTCFullYear()
      const fallbackYears = [currentYear - 2, currentYear - 1, currentYear]
      const dividendEvents: Array<{ year: number; monthIndex: number; value: number }> = []

      const dividendsByTicker: DividendsByTicker = stocksData.length > 0
        ? await api.stocks.dividendsForTickers(stocksData.map((stock) => stock.ticker), 5)
        : {}

      const dividendResults = stocksData.map((stock) => ({
        stock,
        dividends: (dividendsByTicker[stock.ticker] || []) as Dividend[],
      }))

      const payoutDates = Array.from(new Set(
        dividendResults.flatMap(({ dividends }) => dividends.map((div) => div.payment_date || div.date).filter(Boolean))
      ))
      const fxRatesByDateEntries = await Promise.all(
        payoutDates.map(async (date) => [date, await api.market.exchangeRates(date)] as const)
      )
      const fxRatesByDate = Object.fromEntries(fxRatesByDateEntries) as Record<string, Record<string, number | null>>

      for (const { stock, dividends } of dividendResults) {
        for (const div of dividends) {
          if (stock.purchase_date && div.date < stock.purchase_date) continue
          const year = Number(div.date.slice(0, 4))
          const monthIndex = Number(div.date.slice(5, 7)) - 1
          if (!Number.isFinite(year) || monthIndex < 0 || monthIndex > 11) continue
          const fxDate = div.payment_date || div.date
          const fxRates = fxRatesByDate[fxDate]
          if (!fxRates) continue
          const convertedAmount = convertDividendValue(div.amount || 0, div.currency || stock.currency, targetCurrency, fxRates)
          if (convertedAmount === null) continue
          dividendEvents.push({
            year,
            monthIndex,
            value: convertedAmount * stock.quantity,
          })
        }
      }

      const sortedYears = Array.from(new Set([...fallbackYears, ...dividendEvents.map((event) => event.year)])).sort((a, b) => a - b)
      const monthTotals = Array.from({ length: 12 }, (_, monthIndex) => {
        const row: DividendComparisonRow = {
          month: new Date(Date.UTC(2000, monthIndex, 1)).toLocaleDateString(locale, { month: 'long', timeZone: 'UTC' }),
        }
        for (const year of sortedYears) {
          row[String(year)] = 0
        }
        return row
      })

      for (const event of dividendEvents) {
        const key = String(event.year)
        monthTotals[event.monthIndex][key] = Number(monthTotals[event.monthIndex][key] || 0) + event.value
      }

      setDividendComparisonData(monthTotals)
      setAvailableComparisonYears([...sortedYears].sort((a, b) => b - a))
      setSelectedComparisonYears((previousYears) => {
        const validPreviousYears = previousYears.filter((year) => sortedYears.includes(year))
        if (validPreviousYears.length > 0) {
          return validPreviousYears.slice(-3)
        }
        return sortedYears.slice(-3)
      })
      setError(null)
    } catch (err) {
      console.error('Failed to load analytics data:', err)
      setError(t(language, 'analytics.failedLoad'))
    } finally {
      setLoading(false)
    }
  }, [displayCurrency, language, locale])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const sectorData = distribution?.by_sector 
    ? Object.entries(distribution.by_sector).map(([name, value]) => ({ name, value }))
    : []

  const countryData = distribution?.by_country
    ? Object.entries(distribution.by_country).map(([name, value]) => ({ name, value }))
    : []
  
  const stockData = distribution?.by_stock
    ? Object.entries(distribution.by_stock).map(([name, value]) => ({ name, value }))
    : []

  const renderPieLabel = ({ name, percent }: { name: string; percent: number }) => {
    if (percent < 0.05) return null
    return `${name} (${(percent * 100).toFixed(0)}%)`
  }

  const handleToggleComparisonYear = (year: number) => {
    setSelectedComparisonYears((currentYears) => {
      if (currentYears.includes(year)) {
        return currentYears.length === 1 ? currentYears : currentYears.filter((entry) => entry !== year)
      }

      const nextYears = [...currentYears, year]
      if (nextYears.length > 3) {
        nextYears.shift()
      }
      return nextYears.sort((a, b) => a - b)
    })
  }

  if (loading) {
    return <div style={{ textAlign: 'center', padding: '40px' }}>{t(language, 'common.loading')}</div>
  }

  if (error) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: '40px' }}>
        <p style={{ color: 'var(--accent-red)', marginBottom: '16px' }}>{error}</p>
        <button className="btn btn-primary" onClick={fetchData}>{t(language, 'common.retry')}</button>
      </div>
    )
  }

  return (
    <div>
      <div style={{ marginBottom: '24px' }}>
        <h2 style={{ fontSize: '24px', fontWeight: '600' }}>{t(language, 'analytics.title')}</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginTop: '4px' }}>
          {t(language, 'analytics.overview')}
        </p>
      </div>

      {(sectorData.length > 0 || stockData.length > 0 || countryData.length > 0) ? (
        <div className="grid grid-2">
          {stockData.length > 0 && (
            <div className="card">
              <h3 style={{ marginBottom: '16px' }}>{t(language, 'analytics.portfolioDistribution')}</h3>
              <div style={{ height: 280 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={stockData}
                      cx="50%"
                      cy="50%"
                      labelLine={false}
                      label={renderPieLabel}
                      outerRadius={100}
                      fill="#8884d8"
                      dataKey="value"
                    >
                      {stockData.map((_, index) => (
                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip 
                      formatter={(value: number) => formatCurrency(value, locale, chartCurrency)}
                      contentStyle={{ 
                        background: '#2a2a2a', 
                        border: '1px solid #444', 
                        borderRadius: '8px',
                        color: '#fff'
                      }}
                      itemStyle={{ color: '#fff' }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
          
          {sectorData.length > 0 && (
            <div className="card">
              <h3 style={{ marginBottom: '16px' }}>{t(language, 'analytics.sectorDistribution')}</h3>
              <div style={{ height: 280 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={sectorData}
                      cx="50%"
                      cy="50%"
                      labelLine={false}
                      label={renderPieLabel}
                      outerRadius={100}
                      fill="#8884d8"
                      dataKey="value"
                    >
                      {sectorData.map((_, index) => (
                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip 
                      formatter={(value: number) => formatCurrency(value, locale, chartCurrency)}
                      contentStyle={{ 
                        background: '#2a2a2a', 
                        border: '1px solid #444', 
                        borderRadius: '8px',
                        color: '#fff'
                      }}
                      itemStyle={{ color: '#fff' }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {countryData.length > 0 && (
            <div className="card">
              <h3 style={{ marginBottom: '16px' }}>{t(language, 'analytics.countryDistribution')}</h3>
              <div style={{ height: 280 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={countryData}
                      cx="50%"
                      cy="50%"
                      labelLine={false}
                      label={renderPieLabel}
                      outerRadius={100}
                      fill="#8884d8"
                      dataKey="value"
                    >
                      {countryData.map((_, index) => (
                        <Cell key={`country-cell-${index}`} fill={COLORS[index % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip 
                      formatter={(value: number) => formatCurrency(value, locale, chartCurrency)}
                      contentStyle={{ 
                        background: '#2a2a2a', 
                        border: '1px solid #444', 
                        borderRadius: '8px',
                        color: '#fff'
                      }}
                      itemStyle={{ color: '#fff' }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {dividendComparisonData.length > 0 && (
            <div className="card" style={{ gridColumn: '1 / -1' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '16px', marginBottom: '16px', flexWrap: 'wrap' }}>
                <div>
                  <h3 style={{ marginBottom: '8px' }}>{t(language, 'analytics.dividendComparison')}</h3>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '12px', margin: 0 }}>{t(language, 'analytics.dividendComparisonHint')}</p>
                </div>
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  {availableComparisonYears.map((year) => {
                    const selected = selectedComparisonYears.includes(year)
                    return (
                      <button
                        key={year}
                        type="button"
                        className={selected ? 'btn btn-primary' : 'btn btn-secondary'}
                        style={{ padding: '6px 12px', fontSize: '12px' }}
                        onClick={() => handleToggleComparisonYear(year)}
                        aria-pressed={selected}
                      >
                        {year}
                      </button>
                    )
                  })}
                </div>
              </div>
              <div style={{ height: 320 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={dividendComparisonData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" vertical={true} />
                    <XAxis dataKey="month" stroke="#888" fontSize={12} />
                    <YAxis stroke="#888" fontSize={12} />
                    <Tooltip
                      formatter={(value: number) => formatCurrency(value, locale, chartCurrency)}
                      contentStyle={{
                        background: '#111827',
                        border: '1px solid #374151',
                        borderRadius: '10px',
                        color: '#fff'
                      }}
                      itemStyle={{ color: '#fff' }}
                    />
                    <Legend />
                    {selectedComparisonYears.map((year, index) => (
                      <Bar key={year} dataKey={String(year)} fill={COMPARISON_COLORS[index % COMPARISON_COLORS.length]} radius={[6, 6, 0, 0]} />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="card" style={{ textAlign: 'center', padding: '40px' }}>
          <p style={{ color: 'var(--text-secondary)' }}>{t(language, 'analytics.noData')}</p>
        </div>
      )}
    </div>
  )
}
