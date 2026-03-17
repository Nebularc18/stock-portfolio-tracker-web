import { useState, useEffect, useCallback, useRef } from 'react'
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, BarChart, Bar, XAxis, YAxis, CartesianGrid, Legend } from 'recharts'
import { api, Dividend, DistributionResponse, DividendsByTicker } from '../services/api'
import { useSettings } from '../SettingsContext'
import { getLocaleForLanguage, t } from '../i18n'
import { formatDisplayName } from '../utils/displayName'
import { getQuantityHeldOnDate } from '../utils/positions'

const STOCK_COLORS = ['#7c3aed', '#06b6d4', '#22c55e', '#f59e0b', '#f43f5e', '#8b5cf6', '#14b8a6', '#3b82f6']
const SECTOR_COLORS = ['#f97316', '#eab308', '#84cc16', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899', '#ef4444']
const COUNTRY_COLORS = ['#0ea5e9', '#38bdf8', '#14b8a6', '#22c55e', '#eab308', '#f97316', '#f43f5e', '#a855f7']
const COMPARISON_COLORS = ['#818cf8', '#4ade80', '#fbbf24']

type DividendComparisonRow = {
  month: string
} & Record<string, number | string>

type DistributionDatum = {
  id?: string
  name: string
  value: number
}

function aggregateDistributionData(data: DistributionDatum[], othersLabel: string, limit: number = 4): DistributionDatum[] {
  const sortedData = [...data].sort((a, b) => b.value - a.value)
  if (sortedData.length <= limit) return sortedData

  const topEntries = sortedData.slice(0, limit)
  const remainingValue = sortedData.slice(limit).reduce((sum, entry) => sum + entry.value, 0)

  return remainingValue > 0
    ? [...topEntries, { name: othersLabel, value: remainingValue }]
    : topEntries
}

type PieLabelProps = {
  name: string
  percent: number
  index?: number
  x?: number
  y?: number
  cx?: number
}

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
 * Formats a numeric fraction as a locale-aware percentage string.
 *
 * @param value - The numeric fraction where 1 === 100% (for example, 0.25 for 25%).
 * @param locale - The BCP 47 locale identifier used for formatting (for example, "en-US").
 * @returns A localized percent string formatted with 0 to 1 decimal places (for example, "25%" or "25.5%").
 */
function formatPercent(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  }).format(value)
}

/**
 * Produces a Pie chart label renderer that colors labels from the provided palette and hides very small slices.
 *
 * The returned component renders a text label showing the slice name and its percentage (rounded to nearest whole percent)
 * and uses a color chosen from `colors` based on the slice index. Labels for slices with less than 5% (`percent < 0.05`)
 * are not rendered.
 *
 * @param colors - Array of CSS color strings used cyclically to color labels
 * @returns A React component suitable for use as a Pie label renderer that returns an SVG <text> element or `null`
 */
function createColoredPieLabel(colors: string[], locale: string) {
  return function ColoredPieLabel({ name, percent, index = 0, x = 0, y = 0, cx = 0 }: PieLabelProps) {
    if (percent < 0.05) return null
    return (
      <text
        x={x}
        y={y}
        fill={colors[index % colors.length]}
        textAnchor={x > cx ? 'start' : 'end'}
        dominantBaseline="central"
        style={{ fontSize: 12, fontWeight: 700 }}
      >
        {`${name} (${formatPercent(percent, locale)})`}
      </text>
    )
  }
}

/**
 * Render legend rows for distribution entries showing a colored swatch, truncated name, and localized percentage share.
 *
 * @param data - Distribution entries to display; each entry's `value` is used to compute its share of the total.
 * @param colors - Color palette used for swatches; colors are applied in order and wrap if there are fewer colors than entries.
 * @param locale - Locale identifier used to format the percentage values.
 * @returns An array of React elements where each element is a legend row containing a color swatch, the entry name, and the entry's percentage share of the total. Keys use `entry.id` when present or fall back to a deterministic name/index fallback.
function renderDistributionLegend(data: DistributionDatum[], colors: string[], locale: string) {
  const total = data.reduce((sum, entry) => sum + entry.value, 0)

  return data.map((entry, index) => {
    const share = total > 0 ? entry.value / total : 0
    return (
      <div
        key={entry.id || `${entry.name}-${index}`}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          padding: '10px 12px',
          background: 'rgba(255,255,255,0.03)',
          border: '1px solid rgba(255,255,255,0.06)',
          borderRadius: 10,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: colors[index % colors.length], boxShadow: `0 0 16px ${colors[index % colors.length]}66`, flexShrink: 0 }} />
          <span style={{ fontSize: 12, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{entry.name}</span>
        </div>
        <span style={{ fontSize: 12, fontWeight: 700, color: colors[index % colors.length], fontFamily: "'Fira Code', monospace" }}>
          {formatPercent(share, locale)}
        </span>
      </div>
    )
  })
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
  fxRates?: Record<string, number | null>
): number | null {
  const sourceCurrency = fromCurrency || toCurrency
  if (sourceCurrency === toCurrency) return amount
  if (!fxRates) return null
  const direct = fxRates[`${sourceCurrency}_${toCurrency}`]
  if (direct != null) return amount * direct
  const inverse = fxRates[`${toCurrency}_${sourceCurrency}`]
  if (inverse != null && inverse !== 0) return amount / inverse
  return null
}

/**
 * Render the Analytics page showing portfolio, sector, and country distributions and an optional dividend comparison chart.
 *
 * Handles data loading, retryable errors, empty-state display, and locale- and currency-aware formatting for charts and tooltips.
 *
 * @returns A React element containing the analytics dashboard UI
 */
export default function Analytics() {
  const [distribution, setDistribution] = useState<DistributionResponse | null>(null)
  const [stockNamesByTicker, setStockNamesByTicker] = useState<Record<string, string>>({})
  const [dividendComparisonData, setDividendComparisonData] = useState<DividendComparisonRow[]>([])
  const [availableComparisonYears, setAvailableComparisonYears] = useState<number[]>([])
  const [selectedComparisonYears, setSelectedComparisonYears] = useState<number[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const latestFetchId = useRef(0)
  const { displayCurrency, language } = useSettings()
  const locale = getLocaleForLanguage(language)
  const chartCurrency = distribution?.display_currency || displayCurrency
  const stockPieLabel = createColoredPieLabel(STOCK_COLORS, locale)
  const sectorPieLabel = createColoredPieLabel(SECTOR_COLORS, locale)
  const countryPieLabel = createColoredPieLabel(COUNTRY_COLORS, locale)

  const fetchData = useCallback(async () => {
    const fetchId = latestFetchId.current + 1
    latestFetchId.current = fetchId
    const isCurrentFetch = () => latestFetchId.current === fetchId

    try {
      if (isCurrentFetch()) {
        setLoading(true)
      }
      const [distributionData, stocksData] = await Promise.all([
        api.portfolio.distribution(),
        api.stocks.list(),
      ])
      if (!isCurrentFetch()) return
      setDistribution(distributionData)
      setStockNamesByTicker(Object.fromEntries(
        stocksData.map((stock) => [stock.ticker, formatDisplayName(stock.name, stock.ticker)])
      ))
      try {
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
        const fxRatesByDate = payoutDates.length > 0
          ? await api.market.exchangeRatesBatch(payoutDates)
          : {}

        for (const { stock, dividends } of dividendResults) {
          for (const div of dividends) {
            const quantityAtPayout = getQuantityHeldOnDate(stock.position_entries || [], div.date, stock.quantity)
            if (quantityAtPayout <= 0) continue
            const payoutDate = div.payment_date || div.date
            if (!payoutDate) continue
            const year = Number(payoutDate.slice(0, 4))
            const monthIndex = Number(payoutDate.slice(5, 7)) - 1
            if (!Number.isFinite(year) || monthIndex < 0 || monthIndex > 11) continue
            const sourceCurrency = div.currency || stock.currency
            const fxRates = fxRatesByDate[payoutDate]
            if (!fxRates && sourceCurrency !== targetCurrency) continue
            const convertedAmount = convertDividendValue(div.amount || 0, div.currency || stock.currency, targetCurrency, fxRates)
            if (convertedAmount === null) continue
            dividendEvents.push({
              year,
              monthIndex,
              value: convertedAmount * quantityAtPayout,
            })
          }
        }

        const actualYears = Array.from(new Set(dividendEvents.map((event) => event.year))).sort((a, b) => a - b)
        const sortedYears = actualYears.length > 0 ? actualYears : fallbackYears
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

        if (!isCurrentFetch()) return
        setDividendComparisonData(monthTotals)
        setAvailableComparisonYears([...sortedYears].sort((a, b) => b - a))
        setSelectedComparisonYears((previousYears) => {
          const validPreviousYears = previousYears.filter((year) => sortedYears.includes(year))
          if (validPreviousYears.length > 0) {
            return validPreviousYears.slice(-3)
          }
          return actualYears.length > 0 ? actualYears.slice(-3) : sortedYears.slice(-3)
        })
      } catch (dividendError) {
        console.error('Failed to load analytics dividend comparison data:', dividendError)
        if (!isCurrentFetch()) return
        setDividendComparisonData([])
        setAvailableComparisonYears([])
        setSelectedComparisonYears([])
      }

      if (!isCurrentFetch()) return
      setError(null)
    } catch (err) {
      console.error('Failed to load analytics data:', err)
      if (isCurrentFetch()) {
        setError(t(language, 'analytics.failedLoad'))
      }
    } finally {
      if (isCurrentFetch()) {
        setLoading(false)
      }
    }
  }, [displayCurrency, language, locale])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const rawSectorData = distribution?.by_sector
    ? Object.entries(distribution.by_sector).map(([name, value]) => ({ name, value }))
    : []

  const rawCountryData = distribution?.by_country
    ? Object.entries(distribution.by_country).map(([name, value]) => ({ name, value }))
    : []

  const rawStockData = distribution?.by_stock
    ? Object.entries(distribution.by_stock).map(([ticker, value]) => {
        const label = stockNamesByTicker[ticker] || ticker
        return { id: ticker, name: label, value }
      })
    : []

  const othersLabel = t(language, 'analytics.others')
  const sectorData = aggregateDistributionData(rawSectorData, othersLabel)
  const countryData = aggregateDistributionData(rawCountryData, othersLabel)
  const stockData = [...rawStockData].sort((a, b) => b.value - a.value)

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

  const hasDividendComparisonData = dividendComparisonData.some((row) => (
    selectedComparisonYears.some((year) => Number(row[String(year)] || 0) > 0)
  ))

  if (loading) {
    return <div className="loading-state">{t(language, 'common.loading')}</div>
  }

  if (error) {
    return (
      <div style={{ padding: 28 }}>
        <div role="alert" aria-live="assertive" aria-atomic="true" style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, padding: '32px', textAlign: 'center' }}>
          <p style={{ color: 'var(--red)', marginBottom: 16 }}>{error}</p>
          <button className="btn btn-primary" onClick={fetchData}>{t(language, 'common.retry')}</button>
        </div>
      </div>
    )
  }

  const tooltipStyle = {
    background: 'var(--bg3)',
    border: '1px solid var(--border2)',
    borderRadius: 6,
    color: 'var(--text)',
    fontSize: 12,
    fontFamily: "'Fira Code', monospace",
  }

  return (
    <div>
      {/* ── HERO HEADER ── */}
      <div style={{
        borderBottom: '1px solid var(--border)',
        padding: '26px 28px',
        background: 'linear-gradient(115deg, #12141c 0%, var(--bg) 55%)',
      }}>
        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 8 }}>
          {t(language, 'analytics.overview')}
        </div>
        <h2 style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em' }}>{t(language, 'analytics.title')}</h2>
      </div>

      <div style={{ padding: '0 28px 28px' }}>

        {(sectorData.length > 0 || stockData.length > 0 || countryData.length > 0 || hasDividendComparisonData) ? (
          <>
            {/* ── DISTRIBUTION CHARTS ── */}
            <div className="grid grid-3" style={{ marginTop: 20, marginBottom: 20 }}>
              {stockData.length > 0 && (
                <div style={{ background: 'linear-gradient(180deg, rgba(124,58,237,0.16) 0%, rgba(6,182,212,0.06) 42%, var(--bg2) 100%)', border: '1px solid rgba(124,58,237,0.22)', borderRadius: 14, overflow: 'hidden', boxShadow: '0 18px 40px rgba(12,18,38,0.22)' }}>
                  <div style={{ padding: '12px 18px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                    <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--muted)' }}>
                      {t(language, 'analytics.portfolioDistribution')}
                    </span>
                  </div>
                  <div style={{ padding: 18, height: 280 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={stockData}
                          cx="50%"
                          cy="50%"
                          labelLine={false}
                          label={stockPieLabel}
                          outerRadius={92}
                          innerRadius={42}
                          dataKey="value"
                        >
                          {stockData.map((_, index) => (
                            <Cell key={`cell-${index}`} fill={STOCK_COLORS[index % STOCK_COLORS.length]} stroke="rgba(255,255,255,0.72)" strokeWidth={1.2} />
                          ))}
                        </Pie>
                        <Tooltip
                          formatter={(value: number) => formatCurrency(value, locale, chartCurrency)}
                          contentStyle={tooltipStyle}
                          itemStyle={{ color: 'var(--text2)' }}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <div style={{ padding: '0 18px 18px', display: 'grid', gap: 8 }}>
                    {renderDistributionLegend(stockData, STOCK_COLORS, locale)}
                  </div>
                </div>
              )}

              {sectorData.length > 0 && (
                <div style={{ background: 'linear-gradient(180deg, rgba(249,115,22,0.16) 0%, rgba(234,179,8,0.06) 42%, var(--bg2) 100%)', border: '1px solid rgba(249,115,22,0.22)', borderRadius: 14, overflow: 'hidden', boxShadow: '0 18px 40px rgba(12,18,38,0.22)' }}>
                  <div style={{ padding: '12px 18px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                    <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--muted)' }}>
                      {t(language, 'analytics.sectorDistribution')}
                    </span>
                  </div>
                  <div style={{ padding: 18, height: 280 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={sectorData}
                          cx="50%"
                          cy="50%"
                          labelLine={false}
                          label={sectorPieLabel}
                          outerRadius={92}
                          innerRadius={42}
                          dataKey="value"
                        >
                          {sectorData.map((_, index) => (
                            <Cell key={`cell-${index}`} fill={SECTOR_COLORS[index % SECTOR_COLORS.length]} stroke="rgba(255,255,255,0.72)" strokeWidth={1.2} />
                          ))}
                        </Pie>
                        <Tooltip
                          formatter={(value: number) => formatCurrency(value, locale, chartCurrency)}
                          contentStyle={tooltipStyle}
                          itemStyle={{ color: 'var(--text2)' }}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <div style={{ padding: '0 18px 18px', display: 'grid', gap: 8 }}>
                    {renderDistributionLegend(sectorData, SECTOR_COLORS, locale)}
                  </div>
                </div>
              )}

              {countryData.length > 0 && (
                <div style={{ background: 'linear-gradient(180deg, rgba(14,165,233,0.16) 0%, rgba(34,197,94,0.06) 42%, var(--bg2) 100%)', border: '1px solid rgba(14,165,233,0.22)', borderRadius: 14, overflow: 'hidden', boxShadow: '0 18px 40px rgba(12,18,38,0.22)' }}>
                  <div style={{ padding: '12px 18px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                    <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--muted)' }}>
                      {t(language, 'analytics.countryDistribution')}
                    </span>
                  </div>
                  <div style={{ padding: 18, height: 280 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={countryData}
                          cx="50%"
                          cy="50%"
                          labelLine={false}
                          label={countryPieLabel}
                          outerRadius={92}
                          innerRadius={42}
                          dataKey="value"
                        >
                          {countryData.map((_, index) => (
                            <Cell key={`country-cell-${index}`} fill={COUNTRY_COLORS[index % COUNTRY_COLORS.length]} stroke="rgba(255,255,255,0.72)" strokeWidth={1.2} />
                          ))}
                        </Pie>
                        <Tooltip
                          formatter={(value: number) => formatCurrency(value, locale, chartCurrency)}
                          contentStyle={tooltipStyle}
                          itemStyle={{ color: 'var(--text2)' }}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <div style={{ padding: '0 18px 18px', display: 'grid', gap: 8 }}>
                    {renderDistributionLegend(countryData, COUNTRY_COLORS, locale)}
                  </div>
                </div>
              )}
            </div>

            {/* ── DIVIDEND COMPARISON ── */}
            {hasDividendComparisonData && (
              <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8 }}>
                <div style={{ padding: '12px 18px 12px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
                  <div>
                    <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--muted)' }}>
                      {t(language, 'analytics.dividendComparison')}
                    </span>
                    <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>{t(language, 'analytics.dividendComparisonHint')}</p>
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {availableComparisonYears.map((year) => {
                      const selected = selectedComparisonYears.includes(year)
                      return (
                        <button
                          key={year}
                          type="button"
                          className={selected ? 'btn btn-primary' : 'btn btn-secondary'}
                          style={{ padding: '4px 12px', fontSize: 12, fontFamily: "'Fira Code', monospace" }}
                          onClick={() => handleToggleComparisonYear(year)}
                          aria-pressed={selected}
                        >
                          {year}
                        </button>
                      )
                    })}
                  </div>
                </div>
                <div style={{ padding: '18px 18px 12px', height: 320 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={dividendComparisonData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                      <XAxis dataKey="month" stroke="var(--muted)" fontSize={11} fontFamily="'Fira Code', monospace" tickLine={false} />
                      <YAxis stroke="var(--muted)" fontSize={11} fontFamily="'Fira Code', monospace" tickLine={false} axisLine={false} />
                      <Tooltip
                        formatter={(value: number) => formatCurrency(value, locale, chartCurrency)}
                        contentStyle={tooltipStyle}
                        itemStyle={{ color: 'var(--text2)' }}
                        cursor={{ fill: 'rgba(129,140,248,0.06)' }}
                      />
                      <Legend
                        wrapperStyle={{ fontSize: 12, fontFamily: "'Fira Code', monospace", color: 'var(--text2)' }}
                      />
                      {selectedComparisonYears.map((year, index) => (
                        <Bar key={year} dataKey={String(year)} fill={COMPARISON_COLORS[index % COMPARISON_COLORS.length]} radius={[4, 4, 0, 0]} maxBarSize={40} />
                      ))}
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="empty-state" style={{ paddingTop: 60 }}>{t(language, 'analytics.noData')}</div>
        )}
      </div>
    </div>
  )
}
