import { useState, useEffect, useCallback, useRef } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ResponsiveContainer, Tooltip, AreaChart, Area, XAxis, YAxis, CartesianGrid } from 'recharts'
import { api, PortfolioSummary, Stock, UpcomingDividend } from '../services/api'
import { useSettings } from '../SettingsContext'
import { formatTimeInTimezone } from '../utils/time'
import { getLocaleForLanguage, t, type TranslationKey } from '../i18n'

type HistoryRangeKey = '1D' | '1W' | '1M' | 'YTD' | '1Y' | 'SINCE_START'

const HISTORY_RANGE_OPTIONS: Array<{ key: HistoryRangeKey; labelKey: TranslationKey; query: string }> = [
  { key: '1D', labelKey: 'dashboard.range1D', query: '1d' },
  { key: '1W', labelKey: 'dashboard.range1W', query: '1w' },
  { key: '1M', labelKey: 'dashboard.range1M', query: '1m' },
  { key: 'YTD', labelKey: 'dashboard.rangeYTD', query: 'ytd' },
  { key: '1Y', labelKey: 'dashboard.range1Y', query: '1y' },
  { key: 'SINCE_START', labelKey: 'dashboard.rangeSinceStart', query: 'since_start' },
]

type ChartPoint = {
  date: string
  value: number
}

/**
 * Format a numeric amount as a localized currency string.
 *
 * @param value - The numeric amount to format.
 * @param locale - A BCP 47 language tag (e.g., `"en-US"`) that controls locale-specific formatting.
 * @param currency - An ISO 4217 currency code (e.g., `"USD"`) to use for the currency symbol; defaults to `"USD"`.
 * @returns The localized currency string including currency symbol and two decimal places.
 */
function formatCurrency(value: number, locale: string, currency: string = 'USD'): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
  }).format(value)
}

function formatPercent(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    signDisplay: 'always',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value / 100)
}

function parseDisplayDate(value: string): Date {
  const trimmedDate = value.trim()

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmedDate)) {
    const [year, month, day] = trimmedDate.split('-').map(Number)
    return new Date(Date.UTC(year, month - 1, day))
  }

  if (/^-?\d+$/.test(trimmedDate)) {
    const epoch = Number(trimmedDate)
    const epochMilliseconds = Math.abs(epoch) < 1e12 ? epoch * 1000 : epoch
    return new Date(epochMilliseconds)
  }

  if (trimmedDate.includes('T')) {
    const hasTimezone = /([zZ]|[+-]\d{2}:\d{2})$/.test(trimmedDate)
    return new Date(hasTimezone ? trimmedDate : `${trimmedDate}Z`)
  }

  return new Date(trimmedDate)
}

/**
 * Format an ISO-style `YYYY-MM-DD` date string as a locale-aware short month and day.
 *
 * @param dateStr - Date in `YYYY-MM-DD` format (interpreted as a UTC date)
 * @param locale - BCP 47 locale identifier used for formatting (e.g., `"en-US"`, `"sv-SE"`)
 * @returns The date formatted with a short month and numeric day according to `locale` (for example, `"Mar 5"` or locale equivalent)
 */
function formatDate(dateStr: string, locale: string): string {
  const trimmedDate = dateStr.trim()
  const date = parseDisplayDate(trimmedDate)

  if (Number.isNaN(date.getTime())) {
    return trimmedDate
  }

  return date.toLocaleDateString(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

/**
 * Produce a year-month key (YYYY-MM) from a date string.
 *
 * Accepts strings like `YYYY-MM-DD`, `YYYY-M`, or similar hyphen-separated forms and extracts the year and month.
 *
 * @param dateStr - The input date string containing a year and month (examples: `2026-3`, `2026-03-15`)
 * @returns The normalized year-month string in `YYYY-MM` format (e.g., `2026-03`)
 */
function getMonthKey(dateStr: string): string {
  const trimmedDate = dateStr.trim()
  const date = parseDisplayDate(trimmedDate)
  if (Number.isNaN(date.getTime())) {
    return trimmedDate
  }

  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

/**
 * Formats a year-month key into a localized month and year label.
 *
 * @param monthKey - Year-month string in the `YYYY-MM` format.
 * @param locale - BCP 47 locale identifier used for formatting (e.g., `en-US`).
 * @returns The localized month and year label (for example, `January 2024`).
 */
function formatMonthLabel(monthKey: string, locale: string): string {
  const [year, month] = monthKey.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, 1))
  return date.toLocaleDateString(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' })
}

/**
 * Parse a history date string into a Date, interpreting date-only or timezone-less timestamps as UTC.
 *
 * @param value - An ISO-like date or datetime string; accepted forms include date-only ("YYYY-MM-DD"), datetime without timezone, or datetime with an explicit timezone.
 * @returns A Date representing the same instant; inputs that are date-only or lack a timezone are interpreted in UTC.
 */
function parseHistoryDate(value: string): Date {
  if (value.includes('T')) {
    const hasTimezone = /([zZ]|[+-]\d{2}:\d{2})$/.test(value)
    return new Date(hasTimezone ? value : `${value}Z`)
  }
  return new Date(`${value}T00:00:00Z`)
}

/**
 * Produce a localized x-axis tick label for a history chart based on the selected range.
 *
 * @param dateValue - An ISO-like history date string to format
 * @param range - The history range key controlling the label granularity
 * @param locale - BCP 47 locale used for formatting (e.g., "en-US")
 * @returns The localized tick label for the given date and range, or an empty string if the date is invalid
 */
function formatXAxisTick(dateValue: string, range: HistoryRangeKey, locale: string): string {
  const date = parseHistoryDate(dateValue)
  if (Number.isNaN(date.getTime())) return ''

  if (range === '1D') {
    return date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' })
  }
  if (range === '1W') {
    return date.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', timeZone: 'UTC' })
  }
  if (range === '1M') {
    return date.toLocaleDateString(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' })
  }
  if (range === 'YTD' || range === '1Y') {
    return date.toLocaleDateString(locale, { month: 'short', timeZone: 'UTC' })
  }
  return date.toLocaleDateString(locale, { month: 'short', year: '2-digit', timeZone: 'UTC' })
}

/**
 * Format a history timestamp for display in chart tooltips using the given locale and range.
 *
 * @param dateValue - The history timestamp string to format.
 * @param range - The selected history range; `'1D'` and `'1W'` include time in the output.
 * @param locale - BCP 47 locale identifier used for localization.
 * @returns The localized, human-readable date or date-time string for tooltip display; if `dateValue` cannot be parsed, returns the original `dateValue`.
 */
function formatTooltipDate(dateValue: string, range: HistoryRangeKey, locale: string): string {
  const date = parseHistoryDate(dateValue)
  if (Number.isNaN(date.getTime())) return dateValue

  if (range === '1D' || range === '1W') {
    return date.toLocaleDateString(locale, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'UTC',
    })
  }
  return date.toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

/**
 * Reduces a time-ordered series to at most `targetPoints` by sampling evenly while preserving the first and last points.
 *
 * @param data - Array of chart points ordered by time.
 * @param targetPoints - Desired maximum number of points in the result; if <= 0 or greater than or equal to the input length, the original `data` is returned.
 * @returns An array of chart points containing the first and last original points and evenly sampled intermediate points up to `targetPoints`.
 */
function downsampleChartData(data: ChartPoint[], targetPoints: number): ChartPoint[] {
  if (targetPoints <= 0 || data.length <= targetPoints) {
    return data
  }

  const sampled: ChartPoint[] = [data[0]]
  const step = (data.length - 1) / (targetPoints - 1)

  for (let index = 1; index < targetPoints - 1; index += 1) {
    const sourceIndex = Math.round(index * step)
    sampled.push(data[sourceIndex])
  }

  sampled.push(data[data.length - 1])
  return sampled
}

/**
 * Compute the desired number of chart data points to use when downsampling for a given history range.
 *
 * @param range - The history range key (e.g., '1D', '1W', '1M', 'YTD', '1Y', 'SINCE_START')
 * @returns The target number of points to downsample to, or `null` when downsampling should be skipped (used for high-frequency ranges like `1D` and `1W`)
 */
function getRangeTargetPoints(range: HistoryRangeKey): number | null {
  if (range === '1D' || range === '1W') {
    return null
  }
  if (range === '1M') {
    return 120
  }
  if (range === '1Y') {
    return 180
  }
  if (range === 'SINCE_START') {
    return 240
  }

  const now = new Date()
  const elapsedMonths = now.getUTCMonth() + 1
  return Math.min(220, Math.max(80, elapsedMonths * 18))
}

/**
  * Render the portfolio dashboard UI with summary cards, a performance chart, holdings table, and upcoming dividends.
  *
  * The component fetches portfolio and market data, supports history range selection, performs currency conversion using available exchange rates, and formats numbers and dates according to the current language and timezone settings. It handles loading and error states and provides interactive navigation to individual stock pages.
  *
  * @returns A JSX element that renders the portfolio dashboard.
  */
export default function Dashboard() {
  const navigate = useNavigate()
  const [summary, setSummary] = useState<PortfolioSummary | null>(null)
  const [upcomingDividends, setUpcomingDividends] = useState<UpcomingDividend[]>([])
  const [totalRemainingDividends, setTotalRemainingDividends] = useState(0)
  const [stocks, setStocks] = useState<Stock[]>([])
  const [exchangeRates, setExchangeRates] = useState<Record<string, number | null>>({})
  const [portfolioHistory, setPortfolioHistory] = useState<{ date: string; value: number }[]>([])
  const [historyRange, setHistoryRange] = useState<HistoryRangeKey>('1M')
  const [failedLogos, setFailedLogos] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(true)
  const [historyLoading, setHistoryLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const historyRequestIdRef = useRef(0)
  const dataRequestIdRef = useRef(0)
  const { displayCurrency, timezone, language } = useSettings()
  const locale = getLocaleForLanguage(language)
  const historyRangeTitle = (key: HistoryRangeKey) => {
    const labels: Record<HistoryRangeKey, string> = {
      '1D': t(language, 'dashboard.range1D'),
      '1W': t(language, 'dashboard.range1W'),
      '1M': t(language, 'dashboard.range1M'),
      'YTD': t(language, 'dashboard.rangeYTD'),
      '1Y': t(language, 'dashboard.range1Y'),
      'SINCE_START': t(language, 'dashboard.rangeSinceStart'),
    }
    return labels[key]
  }

  const fetchHistory = useCallback(async (range: HistoryRangeKey) => {
    const requestId = historyRequestIdRef.current + 1
    historyRequestIdRef.current = requestId
    setHistoryLoading(true)
    setPortfolioHistory([])
    const rangeQuery = HISTORY_RANGE_OPTIONS.find((option) => option.key === range)?.query || '1m'
    try {
      const historyData = await api.portfolio.history({ range: rangeQuery }).catch(() => [])
      if (requestId !== historyRequestIdRef.current) {
        return
      }
      setPortfolioHistory(historyData)
    } finally {
      if (requestId === historyRequestIdRef.current) {
        setHistoryLoading(false)
      }
    }
  }, [])

  const fetchData = useCallback(async () => {
    const requestId = dataRequestIdRef.current + 1
    dataRequestIdRef.current = requestId

    try {
      setLoading(true)
      const [summaryData, stocksData, ratesData, upcomingDivsData] = await Promise.all([
        api.portfolio.summary(),
        api.stocks.list(),
        api.market.exchangeRates(),
        api.portfolio.upcomingDividends().catch(() => ({ dividends: [], total_expected: 0, total_received: 0, total_remaining: 0, display_currency: displayCurrency, unmapped_stocks: [] })),
      ])
      if (requestId !== dataRequestIdRef.current) {
        return
      }
      setSummary(summaryData)
      setStocks(stocksData)
      setExchangeRates(ratesData)
      setUpcomingDividends(upcomingDivsData.dividends)
      setTotalRemainingDividends(upcomingDivsData.total_remaining)
      setFailedLogos({})
      setError(null)
    } catch (err) {
      if (requestId !== dataRequestIdRef.current) {
        return
      }
      setError(t(language, 'dashboard.failedLoad'))
    } finally {
      if (requestId === dataRequestIdRef.current) {
        setLoading(false)
      }
    }
  }, [displayCurrency, language])

  useEffect(() => {
    fetchData()
    return () => {
      dataRequestIdRef.current += 1
    }
  }, [fetchData])

  useEffect(() => {
    fetchHistory(historyRange)
    return () => {
      historyRequestIdRef.current += 1
    }
  }, [fetchHistory, historyRange])

  const tryConvertToCurrency = (amount: number, currency: string): number | null => {
    if (currency === displayCurrency) return amount
    const rate = exchangeRates[`${currency}_${displayCurrency}`]
    if (rate) return amount * rate
    const inverseRate = exchangeRates[`${displayCurrency}_${currency}`]
    if (inverseRate) return amount / inverseRate
    return null
  }

  const convertToCurrency = (amount: number, currency: string): number | null => {
    return tryConvertToCurrency(amount, currency)
  }

  const dailyChangeAggregate = stocks.reduce((acc, stock) => {
    if (stock.current_price === null || stock.previous_close === null) {
      acc.partial = true
      return acc
    }

    const change = (stock.current_price - stock.previous_close) * stock.quantity
    const converted = convertToCurrency(change, stock.currency)
    if (converted === null) {
      acc.partial = true
      return acc
    }

    acc.total += converted
    return acc
  }, { total: 0, partial: false })

  const totalValueAggregate = stocks.reduce((acc, stock) => {
    if (stock.current_price === null) {
      acc.partial = true
      return acc
    }

    const value = stock.current_price * stock.quantity
    const converted = convertToCurrency(value, stock.currency)
    if (converted === null) {
      acc.partial = true
      return acc
    }

    acc.total += converted
    return acc
  }, { total: 0, partial: false })

  const portfolioDividendYield = stocks.reduce((acc, stock) => {
    if (stock.current_price === null || stock.quantity <= 0 || stock.dividend_yield === null) {
      acc.partial = true
      return acc
    }

    const positionValue = stock.current_price * stock.quantity
    const convertedValue = convertToCurrency(positionValue, stock.currency)
    if (convertedValue === null || convertedValue <= 0) {
      acc.partial = true
      return acc
    }

    acc.weightedYield += convertedValue * stock.dividend_yield
    acc.totalValue += convertedValue
    return acc
  }, { weightedYield: 0, totalValue: 0, partial: false })

  const dividendYieldPercent = portfolioDividendYield.totalValue > 0
    ? portfolioDividendYield.weightedYield / portfolioDividendYield.totalValue
    : 0

  const lastUpdate = stocks.reduce((max: string | null, stock) => {
    if (!stock.last_updated) return max
    if (!max) return stock.last_updated
    return stock.last_updated > max ? stock.last_updated : max
  }, null)

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

  const currency = summary?.display_currency || displayCurrency
  const gainLossClass = (summary?.total_gain_loss ?? 0) >= 0 ? 'positive' : 'negative'
  const dailyChangeClass = dailyChangeAggregate.total >= 0 ? 'positive' : 'negative'
  const selectedHistoryRange = HISTORY_RANGE_OPTIONS.find((option) => option.key === historyRange) || HISTORY_RANGE_OPTIONS[1]

  const chartData: ChartPoint[] = portfolioHistory
    .map((h) => {
      const convertedValue = convertToCurrency(h.value, 'SEK')
      if (convertedValue === null || !Number.isFinite(convertedValue)) {
        return null
      }

      return {
        date: h.date,
        value: convertedValue,
      }
    })
    .filter((point): point is ChartPoint => point !== null)
  const rangeTargetPoints = getRangeTargetPoints(historyRange)
  const displayedChartData = rangeTargetPoints ? downsampleChartData(chartData, rangeTargetPoints) : chartData
  const hasChartData = chartData.length > 0

  let minValue = 0
  let maxValue = 0
  if (hasChartData) {
    minValue = chartData[0].value
    maxValue = chartData[0].value
    for (let i = 1; i < chartData.length; i += 1) {
      const value = chartData[i].value
      if (value < minValue) minValue = value
      if (value > maxValue) maxValue = value
    }
  }
  const valueRange = maxValue - minValue || 1
  const yMin = Math.max(0, minValue - valueRange * 0.1)
  const yMax = maxValue + valueRange * 0.1
  const baselineValue = displayedChartData.length > 0 ? displayedChartData[0].value : 0

  const groupedDividends = upcomingDividends
    .filter((div) => div.status !== 'paid')
    .reduce((acc, div) => {
    const payoutDate = div.payout_date || div.payment_date || div.ex_date
    const key = getMonthKey(payoutDate)
    if (!acc[key]) {
      acc[key] = []
    }
    acc[key].push(div)
    return acc
  }, {} as Record<string, UpcomingDividend[]>)

  const getDisplayedDividendAmount = (item: UpcomingDividend): { amount: number; currency: string } => {
    if (item.total_converted !== null) {
      return { amount: item.total_converted, currency }
    }

    const converted = tryConvertToCurrency(item.total_amount, item.currency)
    if (converted !== null) {
      return { amount: converted, currency }
    }

    return { amount: item.total_amount, currency: item.currency }
  }

  const renderConvertedAmount = (amount: number | null | undefined, originalCurrency: string) => {
    if (amount == null) {
      return '—'
    }

    const converted = convertToCurrency(amount, originalCurrency)
    if (converted !== null) {
      return formatCurrency(converted, locale, currency)
    }
    return formatCurrency(amount, locale, originalCurrency)
  }

  const monthlyUpcoming = Object.entries(groupedDividends)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([monthKey, items]) => ({
      monthKey,
      items,
      subtotalsByCurrency: items.reduce((acc, item) => {
        const displayed = getDisplayedDividendAmount(item)
        if (!Number.isFinite(displayed.amount)) {
          return acc
        }
        acc[displayed.currency] = (acc[displayed.currency] ?? 0) + displayed.amount
        return acc
      }, {} as Record<string, number>),
    }))

  return (
    <div>
      <div style={{ marginBottom: '24px' }}>
        <h2 style={{ fontSize: '24px', fontWeight: '600' }}>{t(language, 'nav.dashboard')}</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginTop: '4px' }}>
          {t(language, 'common.lastUpdated')}: {formatTimeInTimezone(lastUpdate, timezone, locale)} · {t(language, 'common.autoRefresh10m')}
        </p>
      </div>

      <div className="grid" style={{ marginBottom: '24px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '24px' }}>
        <div className="card">
          <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginBottom: '8px' }}>{t(language, 'dashboard.totalValue')} ({currency})</p>
          <p style={{ fontSize: '28px', fontWeight: '600' }}>
            {formatCurrency(totalValueAggregate.total, locale, currency)}{totalValueAggregate.partial ? ` (${t(language, 'dashboard.partial')})` : ''}
          </p>
        </div>
        <div className="card">
          <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginBottom: '8px' }}>{t(language, 'dashboard.dailyChange')}</p>
          <p style={{ fontSize: '28px', fontWeight: '600' }} className={dailyChangeClass}>
            {formatCurrency(dailyChangeAggregate.total, locale, currency)}{dailyChangeAggregate.partial ? ` (${t(language, 'dashboard.partial')})` : ''}
          </p>
        </div>
        <div className="card">
          <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginBottom: '8px' }}>{t(language, 'dashboard.gainLoss')}</p>
          <p style={{ fontSize: '28px', fontWeight: '600' }} className={gainLossClass}>
            {formatCurrency(summary?.total_gain_loss ?? 0, locale, currency)}
          </p>
        </div>
        <div className="card">
          <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginBottom: '8px' }}>{t(language, 'dashboard.returnPercent')}</p>
          <p style={{ fontSize: '28px', fontWeight: '600' }} className={gainLossClass}>
            {formatPercent(summary?.total_gain_loss_percent ?? 0, locale)}
          </p>
        </div>
        <div className="card">
          <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginBottom: '8px' }}>{t(language, 'dashboard.dividendYield')}</p>
          <p style={{ fontSize: '28px', fontWeight: '600', color: 'var(--accent-green)' }}>
            {formatPercent(dividendYieldPercent, locale)}{portfolioDividendYield.partial ? ` (${t(language, 'dashboard.partial')})` : ''}
          </p>
        </div>
      </div>

      <div className="card" style={{ marginBottom: '24px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
            <h3 style={{ margin: 0 }}>{t(language, 'dashboard.performanceTitle')} ({historyRangeTitle(selectedHistoryRange.key)})</h3>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {HISTORY_RANGE_OPTIONS.map((option) => {
                const selected = option.key === historyRange
                return (
                  <button
                    key={option.key}
                    type="button"
                    onClick={() => setHistoryRange(option.key)}
                    aria-pressed={selected}
                    style={{
                      border: '1px solid var(--border-color)',
                      borderRadius: 6,
                      padding: '4px 10px',
                      fontSize: '12px',
                      fontWeight: 600,
                      color: selected ? 'white' : 'var(--text-secondary)',
                      background: selected ? 'var(--accent-blue)' : 'transparent',
                      cursor: 'pointer'
                    }}
                  >
                    {t(language, option.labelKey)}
                  </button>
                )
              })}
            </div>
          </div>
          {!historyLoading && hasChartData && (
            <div style={{ display: 'flex', gap: '16px', fontSize: '12px', color: 'var(--text-secondary)' }}>
              <span>{t(language, 'dashboard.low')}: {formatCurrency(minValue, locale, currency)}</span>
              <span>{t(language, 'dashboard.high')}: {formatCurrency(maxValue, locale, currency)}</span>
            </div>
          )}
        </div>
        {historyLoading ? (
          <div style={{ height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)' }}>
            {t(language, 'common.loading')}
          </div>
        ) : hasChartData ? (
          <div style={{ height: 300 }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={displayedChartData} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="#6366f1" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                <XAxis
                  dataKey="date"
                  stroke="#888"
                  fontSize={11}
                  interval="preserveStartEnd"
                  minTickGap={24}
                  tickFormatter={(value) => formatXAxisTick(String(value), historyRange, locale)}
                />
                <YAxis
                  stroke="#888"
                  fontSize={11}
                  domain={[yMin, yMax]}
                  tickFormatter={(v) => Math.abs(v) >= 1000 ? `${(v/1000).toFixed(0)}k` : v.toFixed(0)}
                />
                <Tooltip
                  formatter={(value: number) => [formatCurrency(value, locale, currency), t(language, 'dashboard.portfolioValue')]}
                  labelFormatter={(label) => formatTooltipDate(String(label), historyRange, locale)}
                  contentStyle={{
                    background: '#2a2a2a',
                    border: '1px solid #444',
                    borderRadius: '8px',
                    color: '#fff',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.3)'
                  }}
                  itemStyle={{ color: '#fff' }}
                  content={({ active, payload, label }) => {
                    if (!active || !payload || !payload.length) return null
                    const currentValue = Number(payload[0].value ?? 0)
                    const absoluteChange = currentValue - baselineValue
                    const percentChange = baselineValue !== 0 ? (absoluteChange / baselineValue) * 100 : 0
                    const percentChangeText = percentChange.toLocaleString(locale, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })
                    const changeColor = absoluteChange >= 0 ? 'var(--accent-green)' : 'var(--accent-red)'
                    const sign = percentChange >= 0 ? '+' : ''

                    return (
                      <div style={{
                        background: '#2a2a2a',
                        border: '1px solid #444',
                        borderRadius: '8px',
                        color: '#fff',
                        boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
                        padding: '10px 12px'
                      }}>
                        <div style={{ marginBottom: '8px', fontWeight: 600 }}>{formatTooltipDate(String(label), historyRange, locale)}</div>
                        <div style={{ marginBottom: '6px' }}>{t(language, 'dashboard.portfolioValue')}: {formatCurrency(currentValue, locale, currency)}</div>
                        <div style={{ color: changeColor, fontWeight: 600 }}>
                          {t(language, 'dashboard.change')}: {sign}{formatCurrency(absoluteChange, locale, currency)} ({sign}{percentChangeText}%)
                        </div>
                      </div>
                    )
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="value"
                  stroke="#6366f1"
                  strokeWidth={2}
                  fillOpacity={1}
                  fill="url(#colorValue)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div style={{ height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)' }}>
            {t(language, 'dashboard.noHistoryData')}
          </div>
        )}
      </div>

      <div className="card" style={{ marginBottom: '24px' }}>
        <h3 style={{ marginBottom: '16px' }}>{t(language, 'dashboard.holdings')} ({summary?.stock_count ?? 0})</h3>
        
        {!summary?.stocks?.length ? (
          <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '40px' }}>
            {t(language, 'dashboard.noStocks')}
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{t(language, 'performance.ticker')}</th>
                <th>{t(language, 'dashboard.name')}</th>
                <th>{t(language, 'dashboard.qty')}</th>
                <th>{t(language, 'dashboard.price')} ({currency})</th>
                <th>{t(language, 'dashboard.value')} ({currency})</th>
                <th>{t(language, 'dashboard.gainLoss')}</th>
                <th>{t(language, 'dashboard.returnPercent')}</th>
              </tr>
            </thead>
            <tbody>
              {summary?.stocks?.map((stock) => (
                <tr 
                  key={stock.ticker} 
                  onClick={() => navigate(`/stocks/${stock.ticker}`)}
                  style={{ cursor: 'pointer' }}
                >
                  <td>
                    <Link 
                      to={`/stocks/${stock.ticker}`} 
                      style={{ color: 'var(--accent-blue)', textDecoration: 'none', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '8px' }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {stock.logo && !failedLogos[stock.ticker] ? (
                        <img 
                          src={stock.logo} 
                          alt={stock.name || stock.ticker}
                          style={{ 
                            width: 24, 
                            height: 24, 
                            borderRadius: 4, 
                            objectFit: 'contain',
                            background: 'var(--bg-secondary)',
                            padding: 2
                          }}
                          onError={(e) => {
                            ;(e.target as HTMLImageElement).style.display = 'none'
                            setFailedLogos((prev) => ({ ...prev, [stock.ticker]: true }))
                          }}
                        />
                      ) : (
                        <span
                          style={{
                            width: 24,
                            height: 24,
                            borderRadius: 4,
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: '12px',
                            fontWeight: '700',
                            color: 'var(--text-secondary)',
                            background: 'var(--bg-secondary)'
                          }}
                        >
                          {(stock.name || stock.ticker || '?').charAt(0).toUpperCase()}
                        </span>
                      )}
                      {stock.ticker}
                    </Link>
                  </td>
                  <td>{stock.name || '-'}</td>
                  <td>{stock.quantity}</td>
                  <td>{renderConvertedAmount(stock.current_price, stock.currency)}</td>
                  <td>
                    {stock.current_value_converted && stock.current_value != null
                      ? formatCurrency(stock.current_value, locale, currency)
                      : renderConvertedAmount(stock.current_value, stock.currency)}
                  </td>
                  <td className={stock.gain_loss === null ? '' : (stock.gain_loss >= 0 ? 'positive' : 'negative')}>
                    {stock.gain_loss !== null ? formatCurrency(stock.gain_loss, locale, currency) : '-'}
                  </td>
                  <td className={stock.gain_loss_percent === null ? '' : (stock.gain_loss_percent >= 0 ? 'positive' : 'negative')}>
                    {stock.gain_loss_percent !== null ? formatPercent(stock.gain_loss_percent, locale) : '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
         )}
       </div>

      {monthlyUpcoming.length > 0 && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <h3>{t(language, 'dashboard.upcomingDividends')}</h3>
            <span style={{ color: 'var(--accent-green)', fontWeight: '600', fontSize: '18px' }}>
              {formatCurrency(totalRemainingDividends, locale, currency)}
            </span>
          </div>
          {monthlyUpcoming.map((group) => (
            <div key={group.monthKey} style={{ marginBottom: '20px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <h4 style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '14px' }}>{formatMonthLabel(group.monthKey, locale)}</h4>
                <span style={{ color: 'var(--accent-green)', fontWeight: '600' }}>
                  {Object.entries(group.subtotalsByCurrency)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([subtotalCurrency, subtotalAmount]) => formatCurrency(subtotalAmount, locale, subtotalCurrency))
                    .join(' + ')}
                </span>
              </div>
              <table style={{ width: '100%', tableLayout: 'fixed' }}>
                <thead>
                  <tr>
                    <th style={{ width: '18%' }}>{t(language, 'performance.name')}</th>
                    <th style={{ width: '14%' }}>{t(language, 'dashboard.exDate')}</th>
                    <th style={{ width: '16%' }}>{t(language, 'dashboard.dividendDate')}</th>
                    <th style={{ width: '18%', textAlign: 'right' }}>{t(language, 'dashboard.perShare')}</th>
                    <th style={{ width: '18%', textAlign: 'right' }}>{t(language, 'dashboard.total')}</th>
                    <th style={{ width: '16%' }}>{t(language, 'dashboard.source')}</th>
                  </tr>
                </thead>
                <tbody>
                  {group.items.map((div, i) => {
                     const displayed = getDisplayedDividendAmount(div)
                     const payoutDisplayDate = div.payout_date || div.payment_date || div.ex_date
                     return (
                    <tr key={`${div.ticker}-${div.ex_date}-${payoutDisplayDate ?? 'na'}-${div.dividend_type ?? 'na'}-${i}`}>
                      <td>
                        <Link to={`/stocks/${div.ticker}`} style={{ color: 'var(--accent-blue)', textDecoration: 'none', fontWeight: '600' }}>
                          {div.name || div.ticker}
                        </Link>
                      </td>
                      <td>{formatDate(div.ex_date, locale)}</td>
                      <td>{payoutDisplayDate ? formatDate(payoutDisplayDate, locale) : '-'}</td>
                      <td style={{ textAlign: 'right' }}>{formatCurrency(div.amount_per_share, locale, div.currency)}</td>
                      <td style={{ color: 'var(--accent-green)', textAlign: 'right' }}>
                        {formatCurrency(displayed.amount, locale, displayed.currency)}
                      </td>
                      <td>
                        <span style={{
                          padding: '2px 8px',
                          borderRadius: '4px',
                          fontSize: '11px',
                          fontWeight: '600',
                          background: div.source === 'avanza' ? 'var(--accent-green)' : (div.source === 'yahoo' ? 'var(--accent-blue)' : 'var(--text-secondary)'),
                          color: 'white'
                        }}>
                          {div.source === 'avanza' ? 'Avanza' : (div.source === 'yahoo' ? 'Yahoo' : t(language, 'dashboard.unknown'))}
                        </span>
                      </td>
                    </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
     </div>
   )
 }
