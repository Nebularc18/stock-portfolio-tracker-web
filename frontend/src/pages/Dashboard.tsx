import { useState, useEffect, useCallback, useRef } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ResponsiveContainer, Tooltip, AreaChart, Area, XAxis, YAxis, CartesianGrid } from 'recharts'
import { api, PortfolioSummary, UpcomingDividend } from '../services/api'
import { useAuth } from '../AuthContext'
import { useSettings } from '../SettingsContext'
import { formatTimeInTimezone } from '../utils/time'
import { resolveBackendAssetUrl } from '../utils/assets'
import { getLocaleForLanguage, t, type Language, type TranslationKey } from '../i18n'
import { formatDisplayName } from '../utils/displayName'
import SortableHeader from '../components/SortableHeader'
import { sortTableItems, useTableSort } from '../utils/tableSort'

type HistoryRangeKey = '1D' | '1W' | '1M' | 'YTD' | '1Y' | 'SINCE_START'
type FetchOptions = { background?: boolean }

const HISTORY_RANGE_OPTIONS: Array<{ key: HistoryRangeKey; labelKey: TranslationKey; query: string }> = [
  { key: '1D', labelKey: 'dashboard.range1D', query: '1d' },
  { key: '1W', labelKey: 'dashboard.range1W', query: '1w' },
  { key: '1M', labelKey: 'dashboard.range1M', query: '1m' },
  { key: 'YTD', labelKey: 'dashboard.rangeYTD', query: 'ytd' },
  { key: '1Y', labelKey: 'dashboard.range1Y', query: '1y' },
  { key: 'SINCE_START', labelKey: 'dashboard.rangeSinceStart', query: 'since_start' },
]

type ChartPoint = { date: string; value: number }
const DEFAULT_HISTORY_RANGE: HistoryRangeKey = '1M'
const DASHBOARD_HISTORY_RANGE_STORAGE_KEY = 'dashboard.historyRange'
const DASHBOARD_AUTO_REFRESH_INTERVAL_MS = 10 * 60 * 1000
const DASHBOARD_AUTO_REFRESH_BUFFER_MS = 5_000
const DASHBOARD_AUTO_REFRESH_MIN_DELAY_MS = 5_000

type HoldingSortField = 'ticker' | 'name' | 'quantity' | 'price' | 'value' | 'gainLoss' | 'gainLossPercent'
type UpcomingSortField = 'name' | 'exDate' | 'paymentDate' | 'perShare' | 'total' | 'source'

function isHistoryRangeKey(value: string | null): value is HistoryRangeKey {
  return value !== null && HISTORY_RANGE_OPTIONS.some((option) => option.key === value)
}

function getStoredHistoryRange(userId?: number | null): HistoryRangeKey {
  try {
    const storage = typeof window !== 'undefined' ? window.localStorage : null
    if (!storage) return DEFAULT_HISTORY_RANGE
    const userKey = userId !== null && userId !== undefined
      ? `${DASHBOARD_HISTORY_RANGE_STORAGE_KEY}:${userId}`
      : null
    const storedValue = userKey ? storage.getItem(userKey) : null
    if (isHistoryRangeKey(storedValue)) return storedValue
    const legacyValue = storage.getItem(DASHBOARD_HISTORY_RANGE_STORAGE_KEY)
    return isHistoryRangeKey(legacyValue) ? legacyValue : DEFAULT_HISTORY_RANGE
  } catch {
    return DEFAULT_HISTORY_RANGE
  }
}

function getNextDashboardRefreshDelayMs(now: number = Date.now()): number {
  const nextRefreshAt = Math.ceil(now / DASHBOARD_AUTO_REFRESH_INTERVAL_MS) * DASHBOARD_AUTO_REFRESH_INTERVAL_MS
  return Math.max(
    nextRefreshAt - now + DASHBOARD_AUTO_REFRESH_BUFFER_MS,
    DASHBOARD_AUTO_REFRESH_MIN_DELAY_MS,
  )
}

/**
 * Format a numeric amount as a localized currency string.
 *
 * @param value - The monetary amount in major currency units (e.g., 12.34 for twelve dollars)
 * @param locale - A BCP 47 locale string used to localize number and currency formatting
 * @param currency - ISO 4217 currency code to format with (defaults to `USD`)
 * @returns The formatted currency string for the given locale and currency
 */
function formatCurrency(value: number, locale: string, currency: string = 'USD'): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(value)
}

/**
 * Format a percentage value for display according to locale.
 *
 * @param value - The percentage value in percentage points (e.g., `12.34` represents `12.34%`).
 * @param locale - The BCP 47 locale string used for formatting (e.g., `"en-US"`).
 * @returns The localized percentage string with an explicit sign and two decimal places (e.g., `"+12.34%"`).
 */
function formatPercent(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    signDisplay: 'always',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value / 100)
}

/**
 * Parse a variety of date string formats into a Date object.
 *
 * Accepts:
 * - `YYYY-MM-DD` (interpreted as UTC midnight for that date),
 * - integer epoch values (treated as seconds if absolute value < 1e12, otherwise milliseconds),
 * - ISO-like datetime strings containing `T` (if no timezone is present, treated as UTC),
 * - any other string passed through to the `Date` constructor.
 *
 * @param value - The input date string to parse
 * @returns The resulting `Date` instance parsed from `value`
 */
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
 * Format an input date string as a localized short month/day representation using UTC.
 *
 * @param dateStr - Input date string to format; if it cannot be parsed, the original string is returned unchanged.
 * @param locale - BCP‑47 locale identifier used for formatting (e.g., "en-US").
 * @returns A localized short date like "Mar 5" (formatted in UTC), or the original `dateStr` if parsing fails.
 */
function formatDate(dateStr: string, locale: string): string {
  const date = parseDisplayDate(dateStr.trim())
  if (Number.isNaN(date.getTime())) return dateStr
  return date.toLocaleDateString(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

/**
 * Produce a month key in `YYYY-MM` format from a date string, or return the input unchanged when parsing fails.
 *
 * @param dateStr - A date string in a supported format (e.g., ISO, epoch seconds, T-based, or plain date)
 * @returns The month key `YYYY-MM` derived from `dateStr`, or the original `dateStr` if it cannot be parsed as a valid date
 */
function getMonthKey(dateStr: string): string {
  const date = parseDisplayDate(dateStr.trim())
  if (Number.isNaN(date.getTime())) return dateStr
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

/**
 * Formats a month key into a localized month and year label.
 *
 * @param monthKey - Month key in `YYYY-MM` format
 * @param locale - BCP 47 locale identifier (for example, `en-US`)
 * @returns A localized month and year string (for example, `January 2026`)
 */
function formatMonthLabel(monthKey: string, locale: string, language: Language): string {
  if (monthKey === 'tbd') return t(language, 'common.tbd')
  const [year, month] = monthKey.split('-').map(Number)
  if (!Number.isFinite(year) || !Number.isFinite(month)) return monthKey
  return new Date(Date.UTC(year, month - 1, 1))
    .toLocaleDateString(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' })
}

/**
 * Parse a history date string into a UTC Date.
 *
 * Accepts ISO date-time strings (with or without an explicit timezone) and date-only strings.
 * If the input lacks a timezone, it is interpreted as UTC. Date-only inputs are treated as midnight UTC.
 *
 * @param value - A date string in ISO date-time form, ISO date without timezone, or plain date (YYYY-MM-DD)
 * @returns The corresponding Date in UTC
 */
function parseHistoryDate(value: string): Date {
  const trimmed = value.trim()
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const numeric = Number(trimmed)
    if (!Number.isFinite(numeric)) return new Date(Number.NaN)
    const epochMilliseconds = Math.abs(numeric) < 1e12 ? numeric * 1000 : numeric
    return new Date(epochMilliseconds)
  }
  if (trimmed.includes('T')) {
    const hasTimezone = /([zZ]|[+-]\d{2}:\d{2})$/.test(trimmed)
    return new Date(hasTimezone ? trimmed : `${trimmed}Z`)
  }
  return new Date(`${trimmed}T00:00:00Z`)
}

/**
 * Format an x-axis tick label for portfolio history charts according to the selected range and locale.
 *
 * @param dateValue - Date or date-like string representing the tick's timestamp
 * @param range - History range key that determines the label granularity
 * @param locale - BCP 47 locale string used for localization of the label
 * @param timezone - IANA timezone identifier used for display formatting
 * @returns A localized label string for the tick, or an empty string if the date is invalid
 */
function formatXAxisTick(dateValue: string, range: HistoryRangeKey, locale: string, timezone: string): string {
  const date = parseHistoryDate(dateValue)
  if (Number.isNaN(date.getTime())) return ''
  if (range === '1D') return date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: timezone })
  if (range === '1W') return date.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', timeZone: timezone })
  if (range === '1M') return date.toLocaleDateString(locale, { month: 'short', day: 'numeric', timeZone: timezone })
  if (range === 'YTD' || range === '1Y') return date.toLocaleDateString(locale, { month: 'short', timeZone: timezone })
  return date.toLocaleDateString(locale, { month: 'short', year: '2-digit', timeZone: timezone })
}

/**
 * Format a history data point timestamp for display in chart tooltips.
 *
 * @param dateValue - The raw history date value (ISO, epoch seconds, or other supported formats)
 * @param range - The selected history range which determines whether the time component is included
 * @param locale - BCP 47 locale used for localized month/day/weekday labels
 * @param timezone - IANA timezone identifier used for display formatting
 * @returns A localized, human-readable date string; returns `dateValue` unchanged when the input cannot be parsed as a date
 */
function formatTooltipDate(dateValue: string, range: HistoryRangeKey, locale: string, timezone: string): string {
  const date = parseHistoryDate(dateValue)
  if (Number.isNaN(date.getTime())) return dateValue
  if (range === '1D' || range === '1W') {
    return date.toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: timezone })
  }
  return date.toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: timezone })
}

/**
 * Reduce a time-series to at most `targetPoints` by sampling the first and last points and evenly selecting intermediate points.
 *
 * @param data - Ordered array of chart points (time-series) to sample from
 * @param targetPoints - Maximum number of points to retain; if less than or equal to 0 or not smaller than `data.length`, the original `data` is returned
 * @returns An array with up to `targetPoints` `ChartPoint` entries, preserving the first and last items and sampled intermediate points
 */
function downsampleChartData(data: ChartPoint[], targetPoints: number): ChartPoint[] {
  if (targetPoints <= 0 || data.length <= targetPoints) return data
  const sampled: ChartPoint[] = [data[0]]
  const step = (data.length - 1) / (targetPoints - 1)
  for (let index = 1; index < targetPoints - 1; index += 1) {
    sampled.push(data[Math.round(index * step)])
  }
  sampled.push(data[data.length - 1])
  return sampled
}

/**
 * Determine the target number of points to downsample chart data for a given history range.
 *
 * For ranges that should use raw data without downsampling (`1D`, `1W`) this returns `null`.
 *
 * @param range - The selected history range key
 * @returns The target number of chart points to downsample to, or `null` when no target is specified
 */
function getRangeTargetPoints(range: HistoryRangeKey): number | null {
  if (range === '1D' || range === '1W') return null
  if (range === '1M') return 120
  if (range === '1Y') return 180
  if (range === 'SINCE_START') return 240
  const elapsedMonths = new Date().getUTCMonth() + 1
  return Math.min(220, Math.max(80, elapsedMonths * 18))
}

/**
 * Render the portfolio dashboard page with hero statistics, a selectable performance chart, a sortable holdings table, and grouped upcoming dividends.
 *
 * @returns The dashboard UI as JSX elements.
 */
export default function Dashboard() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [summary, setSummary] = useState<PortfolioSummary | null>(null)
  const [upcomingDividends, setUpcomingDividends] = useState<UpcomingDividend[]>([])
  const [totalRemainingDividends, setTotalRemainingDividends] = useState(0)
  const [portfolioHistory, setPortfolioHistory] = useState<{ date: string; value: number }[]>([])
  const [historyRange, setHistoryRange] = useState<HistoryRangeKey>(() => getStoredHistoryRange(user?.id))
  const [failedLogos, setFailedLogos] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(true)
  const [historyLoading, setHistoryLoading] = useState(true)
  const [historyError, setHistoryError] = useState<Error | null>(null)
  const [error, setError] = useState<string | null>(null)
  const historyRequestIdRef = useRef(0)
  const foregroundDataRequestIdRef = useRef(0)
  const backgroundDataRequestIdRef = useRef(0)
  const autoRefreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastAutoRefreshRunRef = useRef<symbol | null>(null)
  const { displayCurrency, timezone, language } = useSettings()
  const locale = getLocaleForLanguage(language)
  const { sortState: holdingsSortState, requestSort: requestHoldingsSort } = useTableSort<HoldingSortField>({ field: 'ticker', direction: 'asc' })
  const { sortState: upcomingSortState, requestSort: requestUpcomingSort } = useTableSort<UpcomingSortField>({ field: 'name', direction: 'asc' })

  const fetchHistory = useCallback(async (range: HistoryRangeKey, options: FetchOptions = {}) => {
    const { background = false } = options
    const requestId = historyRequestIdRef.current + 1
    historyRequestIdRef.current = requestId
    if (!background) {
      setHistoryLoading(true)
      setHistoryError(null)
    }
    const rangeQuery = HISTORY_RANGE_OPTIONS.find((o) => o.key === range)?.query || '1m'
    try {
      const historyData = await api.portfolio.history({ range: rangeQuery })
      if (requestId !== historyRequestIdRef.current) return
      setPortfolioHistory(historyData)
      setHistoryError(null)
    } catch (error) {
      if (requestId !== historyRequestIdRef.current) return
      console.error('Failed to load portfolio history:', error)
      if (!background) {
        setHistoryError(error instanceof Error ? error : new Error(String(error)))
      }
    } finally {
      if (requestId === historyRequestIdRef.current && !background) setHistoryLoading(false)
    }
  }, [])

  const fetchData = useCallback(async (options: FetchOptions = {}) => {
    const { background = false } = options
    const requestIdRef = background ? backgroundDataRequestIdRef : foregroundDataRequestIdRef
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    let loadingStarted = false
    let loadingCleared = false
    const clearLoading = () => {
      if (loadingStarted && !loadingCleared) {
        setLoading(false)
        loadingCleared = true
      }
    }
    try {
      if (!background) {
        setLoading(true)
        loadingStarted = true
      }
      const [summaryResult, upcomingDivsResult] = await Promise.allSettled([
        api.portfolio.summary(),
        api.portfolio.upcomingDividends().catch(() => ({ dividends: [], total_expected: 0, total_received: 0, total_remaining: 0, totals_partial: false, display_currency: displayCurrency, unmapped_stocks: [] })),
        api.portfolio.upcomingDividends(),
      ])
      if (requestId !== dataRequestIdRef.current) return
      if (summaryResult.status !== 'fulfilled') {
        throw summaryResult.reason
      const upcomingDivsPromise = api.portfolio.upcomingDividends()
        .then((value) => ({ status: 'fulfilled' as const, value }))
        .catch((reason) => ({ status: 'rejected' as const, reason }))
      const summaryData = await api.portfolio.summary()
      if (requestId !== requestIdRef.current) {
        clearLoading()
        return
      }
      setSummary(summaryData)
      setFailedLogos({})
      setError(null)
      if (!background) {
        clearLoading()
      }
      const upcomingDivsResult = await upcomingDivsPromise
      if (requestId !== requestIdRef.current) {
        clearLoading()
        return
      }
      if (upcomingDivsResult.status === 'fulfilled') {
        setUpcomingDividends(upcomingDivsResult.value.dividends)
        setTotalRemainingDividends(upcomingDivsResult.value.total_remaining)
      } else {
        console.error('Failed to load upcoming dividends:', upcomingDivsResult.reason)
      }
    } catch (error) {
      if (requestId !== requestIdRef.current) {
        clearLoading()
        return
      }
      console.error('Failed to load dashboard data:', error)
      if (!background) {
        setError(t(language, 'dashboard.failedLoad'))
        clearLoading()
      }
    } finally {
      if (!background && requestId === requestIdRef.current) {
        clearLoading()
      }
    }
  }, [language])

  useEffect(() => {
    fetchData()
    return () => {
      foregroundDataRequestIdRef.current += 1
      backgroundDataRequestIdRef.current += 1
    }
  }, [fetchData])

  useEffect(() => {
    fetchHistory(historyRange)
    return () => { historyRequestIdRef.current += 1 }
  }, [fetchHistory, historyRange])

  useEffect(() => {
    const storedRange = getStoredHistoryRange(user?.id)
    setHistoryRange((currentRange) => currentRange === storedRange ? currentRange : storedRange)
  }, [user?.id])

  useEffect(() => {
    try {
      const storage = typeof window !== 'undefined' ? window.localStorage : null
      if (!storage) return
      storage.setItem(DASHBOARD_HISTORY_RANGE_STORAGE_KEY, historyRange)
      if (user?.id !== null && user?.id !== undefined) {
        storage.setItem(`${DASHBOARD_HISTORY_RANGE_STORAGE_KEY}:${user.id}`, historyRange)
      }
    } catch {
      // Ignore storage write failures.
    }
  }, [historyRange, user?.id])

  useEffect(() => {
    const runId = Symbol('dashboard-auto-refresh')
    lastAutoRefreshRunRef.current = runId
    if (autoRefreshTimeoutRef.current) {
      clearTimeout(autoRefreshTimeoutRef.current)
      autoRefreshTimeoutRef.current = null
    }

    const scheduleNextRefresh = () => {
      if (lastAutoRefreshRunRef.current !== runId) return
      autoRefreshTimeoutRef.current = setTimeout(() => {
        Promise.allSettled([
          fetchData({ background: true }),
          fetchHistory(historyRange, { background: true }),
        ]).finally(() => {
          if (lastAutoRefreshRunRef.current === runId) {
            scheduleNextRefresh()
          }
        })
      }, getNextDashboardRefreshDelayMs())
    }

    scheduleNextRefresh()

    return () => {
      if (lastAutoRefreshRunRef.current === runId) {
        lastAutoRefreshRunRef.current = null
      }
      if (autoRefreshTimeoutRef.current) {
        clearTimeout(autoRefreshTimeoutRef.current)
        autoRefreshTimeoutRef.current = null
      }
    }
  }, [fetchData, fetchHistory, historyRange])

  useEffect(() => {
    let lastResumeRefreshAt = 0

    const refreshAfterReturn = () => {
      if (document.visibilityState !== 'visible') return
      const now = Date.now()
      if (now - lastResumeRefreshAt < DASHBOARD_AUTO_REFRESH_MIN_DELAY_MS) return
      lastResumeRefreshAt = now
      void fetchData({ background: true })
      void fetchHistory(historyRange, { background: true })
    }

    document.addEventListener('visibilitychange', refreshAfterReturn)
    window.addEventListener('focus', refreshAfterReturn)

    return () => {
      document.removeEventListener('visibilitychange', refreshAfterReturn)
      window.removeEventListener('focus', refreshAfterReturn)
    }
  }, [fetchData, fetchHistory, historyRange])

  const currency = summary?.display_currency || displayCurrency
  const gainLoss = summary?.total_gain_loss ?? 0
  const gainLossIsPos = gainLoss >= 0
  const dailyChange = summary?.daily_change ?? 0
  const dailyIsPos = dailyChange >= 0
  const dividendYieldPercent = summary?.dividend_yield ?? 0
  const lastUpdate = summary?.last_updated ?? null

  const rawChartData: ChartPoint[] = portfolioHistory
    .map((h) => {
      if (!Number.isFinite(h.value)) return null
      return { date: h.date, value: h.value }
    })
    .filter((p): p is ChartPoint => p !== null)

  const rangeTargetPoints = getRangeTargetPoints(historyRange)
  const displayedChartData = rangeTargetPoints ? downsampleChartData(rawChartData, rangeTargetPoints) : rawChartData
  const hasChartData = rawChartData.length > 0

  let minValue = 0, maxValue = 0
  if (hasChartData) {
    minValue = rawChartData[0].value; maxValue = rawChartData[0].value
    for (let i = 1; i < rawChartData.length; i++) {
      if (rawChartData[i].value < minValue) minValue = rawChartData[i].value
      if (rawChartData[i].value > maxValue) maxValue = rawChartData[i].value
    }
  }
  const valueRange = maxValue - minValue || 1
  const yMin = Math.max(0, minValue - valueRange * 0.1)
  const yMax = maxValue + valueRange * 0.1
  const baselineValue = displayedChartData.length > 0 ? displayedChartData[0].value : 0

  const groupedDividends = upcomingDividends
    .filter((div) => div.status !== 'paid')
    .reduce((acc, div) => {
      const key = div.payment_date ? getMonthKey(div.payment_date) : 'tbd'
      if (!acc[key]) acc[key] = []
      acc[key].push(div)
      return acc
    }, {} as Record<string, UpcomingDividend[]>)

  const getDisplayedDividendAmount = (item: UpcomingDividend): { amount: number; currency: string } => {
    if (item.total_converted !== null) return { amount: item.total_converted, currency }
    return { amount: item.total_amount, currency: item.currency }
  }

  const renderAmount = (amount: number | null | undefined, amountCurrency: string) => {
    if (amount == null) return '—'
    return formatCurrency(amount, locale, amountCurrency)
  }

  const monthlyUpcoming = Object.entries(groupedDividends)
    .sort(([a], [b]) => {
      if (a === 'tbd') return 1
      if (b === 'tbd') return -1
      return a.localeCompare(b)
    })
    .map(([monthKey, items]) => ({
      monthKey,
      items: sortTableItems(
        items,
        upcomingSortState,
        {
          name: (item) => item.name || item.ticker,
          exDate: (item) => item.ex_date,
          paymentDate: (item) => item.payment_date,
          perShare: (item) => item.amount_per_share,
          total: (item) => getDisplayedDividendAmount(item).amount,
          source: (item) => item.source,
        },
        locale,
        (item) => item.ticker
      ),
      subtotalsByCurrency: items.reduce((acc, item) => {
        const displayed = getDisplayedDividendAmount(item)
        if (!Number.isFinite(displayed.amount)) return acc
        acc[displayed.currency] = (acc[displayed.currency] ?? 0) + displayed.amount
        return acc
      }, {} as Record<string, number>),
    }))

  const sortedSummaryStocks = sortTableItems(
    summary?.stocks ?? [],
    holdingsSortState,
    {
      ticker: (stock) => stock.ticker,
      name: (stock) => formatDisplayName(stock.name, stock.ticker),
      quantity: (stock) => stock.quantity,
      price: (stock) => (stock.display_price_converted ? stock.display_price : null),
      value: (stock) => (stock.current_value_converted ? stock.current_value : null),
      gainLoss: (stock) => stock.gain_loss,
      gainLossPercent: (stock) => stock.gain_loss_percent,
    },
    locale,
    (stock) => stock.ticker
  )

  if (loading) {
    return <div className="loading-state">{t(language, 'common.loading')}</div>
  }

  if (error) {
    return (
      <div style={{ padding: '28px' }}>
        <div className="card" style={{ textAlign: 'center', padding: '40px' }}>
          <p style={{ color: 'var(--red)', marginBottom: '16px' }}>{error}</p>
          <button className="btn btn-primary" onClick={() => { void fetchData() }}>{t(language, 'common.retry')}</button>
        </div>
      </div>
    )
  }

  // ── HERO STATS ──
  const heroStats = [
    {
      label: t(language, 'dashboard.totalValue'),
      value: formatCurrency(summary?.total_value ?? 0, locale, currency),
      partial: summary?.total_value_partial ?? false,
      color: 'var(--text)',
    },
    {
      label: t(language, 'dashboard.dailyChange'),
      value: formatCurrency(dailyChange, locale, currency),
      partial: summary?.daily_change_partial ?? false,
      color: dailyIsPos ? 'var(--green)' : 'var(--red)',
    },
    {
      label: t(language, 'dashboard.gainLoss'),
      value: formatCurrency(gainLoss, locale, currency),
      partial: summary?.total_gain_loss_partial ?? false,
      color: gainLossIsPos ? 'var(--green)' : 'var(--red)',
    },
    {
      label: t(language, 'dashboard.returnPercent'),
      value: formatPercent(summary?.total_gain_loss_percent ?? 0, locale),
      partial: summary?.total_gain_loss_partial ?? false,
      color: gainLossIsPos ? 'var(--green)' : 'var(--red)',
    },
    {
      label: t(language, 'dashboard.dividendYield'),
      value: formatPercent(dividendYieldPercent, locale),
      partial: summary?.dividend_yield_partial ?? false,
      color: 'var(--teal)',
    },
  ]

  return (
    <div>
      {/* ── HERO ROW ── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${heroStats.length}, 1fr)`,
        borderBottom: '1px solid var(--border)',
        background: 'linear-gradient(115deg, var(--bg-dark, #12141c) 0%, var(--bg) 55%)',
        position: 'relative',
        overflow: 'hidden',
      }}>
        {/* subtle violet glow */}
        <div style={{
          position: 'absolute', top: -80, right: 80,
          width: 420, height: 420,
          background: 'radial-gradient(circle, rgba(129,140,248,0.055) 0%, transparent 65%)',
          pointerEvents: 'none',
        }} />

        {heroStats.map((stat, i) => (
          <div key={stat.label} className="hero-stat" style={{
            padding: '26px 28px',
            borderRight: i < heroStats.length - 1 ? '1px solid var(--border)' : 'none',
            position: 'relative',
            transition: 'background 0.15s',
          }}>
            {i === 0 && (
              <div style={{
                position: 'absolute', left: 0, top: '20%', bottom: '20%',
                width: 2,
                background: 'linear-gradient(180deg, transparent, var(--v), transparent)',
                borderRadius: 2,
              }} />
            )}
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 10 }}>
              {stat.label}
            </div>
            <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1, color: stat.color, animation: `fade-up 0.45s ${i * 0.1}s ease both` }}>
              {stat.value}
              {stat.partial && <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--muted)', marginLeft: 6 }}>({t(language, 'dashboard.partial')})</span>}
            </div>
          </div>
        ))}
      </div>

      {/* last updated */}
      <div style={{ padding: '8px 28px', background: 'var(--bg1)', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 16 }}>
        <span style={{ fontSize: 10, color: 'var(--muted)', letterSpacing: '0.04em' }}>
          {t(language, 'common.lastUpdated')}: <span style={{ fontFamily: "'Fira Code', monospace" }}>{formatTimeInTimezone(lastUpdate, timezone, locale)}</span>
        </span>
        <span style={{ fontSize: 10, color: 'var(--muted)' }}>·</span>
        <span style={{ fontSize: 10, color: 'var(--muted)' }}>{t(language, 'common.autoRefresh10m')}</span>
      </div>

      <div style={{ padding: '0 28px 28px' }}>

        {/* ── CHART ── */}
        <div style={{ marginTop: 20, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 20px', borderBottom: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', color: 'var(--muted)' }}>
                {t(language, 'dashboard.performanceTitle')}
              </span>
              <div style={{ display: 'flex', gap: 4 }}>
                {HISTORY_RANGE_OPTIONS.map((option) => {
                  const sel = option.key === historyRange
                  return (
                    <button
                      key={option.key}
                      type="button"
                      onClick={() => setHistoryRange(option.key)}
                      style={{
                        border: `1px solid ${sel ? 'var(--v)' : 'var(--border2)'}`,
                        borderRadius: 5,
                        padding: '3px 9px',
                        fontSize: 11,
                        fontWeight: 600,
                        color: sel ? 'var(--v2)' : 'var(--muted)',
                        background: sel ? 'rgba(129,140,248,0.12)' : 'transparent',
                        cursor: 'pointer',
                        fontFamily: "'Plus Jakarta Sans', sans-serif",
                        transition: 'all 0.15s',
                      }}
                    >
                      {t(language, option.labelKey)}
                    </button>
                  )
                })}
              </div>
            </div>
            {!historyLoading && hasChartData && (
              <div style={{ display: 'flex', gap: 16, fontSize: 11, color: 'var(--muted)', fontFamily: "'Fira Code', monospace" }}>
                <span>L: {formatCurrency(minValue, locale, currency)}</span>
                <span>H: {formatCurrency(maxValue, locale, currency)}</span>
              </div>
            )}
          </div>
          <div style={{ padding: '16px 20px 8px' }}>
            {historyLoading ? (
              <div style={{ height: 280, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)' }}>
                {t(language, 'common.loading')}
              </div>
            ) : historyError ? (
              <div style={{ height: 280, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, color: 'var(--muted)' }}>
                <span>{t(language, 'dashboard.failedHistoryLoad')}</span>
                <button className="btn btn-primary" onClick={() => fetchHistory(historyRange)}>
                  {t(language, 'common.retry')}
                </button>
              </div>
            ) : hasChartData ? (
              <div style={{ height: 280 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={displayedChartData} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#818cf8" stopOpacity={0.25} />
                        <stop offset="95%" stopColor="#818cf8" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
                    <XAxis
                      dataKey="date"
                      stroke="var(--border2)"
                      tick={{ fill: 'var(--muted)', fontSize: 10, fontFamily: "'Fira Code', monospace" }}
                      interval="preserveStartEnd"
                      minTickGap={32}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(v) => formatXAxisTick(String(v), historyRange, locale, timezone)}
                    />
                    <YAxis
                      stroke="var(--border2)"
                      tick={{ fill: 'var(--muted)', fontSize: 10, fontFamily: "'Fira Code', monospace" }}
                      domain={[yMin, yMax]}
                      tickLine={false}
                      axisLine={false}
                      width={60}
                      tickFormatter={(v) => Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(0)}k` : v.toFixed(0)}
                    />
                    <Tooltip
                      content={({ active, payload, label }) => {
                        if (!active || !payload || !payload.length) return null
                        const currentValue = Number(payload[0].value ?? 0)
                        const absoluteChange = currentValue - baselineValue
                        const percentChange = baselineValue !== 0 ? (absoluteChange / baselineValue) * 100 : 0
                        const changeColor = absoluteChange >= 0 ? 'var(--green)' : 'var(--red)'
                        const sign = percentChange >= 0 ? '+' : ''
                        return (
                          <div style={{ background: 'var(--bg3)', border: '1px solid var(--border2)', borderRadius: 8, padding: '10px 14px', fontSize: 12, boxShadow: '0 4px 16px rgba(0,0,0,0.4)' }}>
                            <div style={{ color: 'var(--muted)', marginBottom: 6, fontSize: 11 }}>{formatTooltipDate(String(label), historyRange, locale, timezone)}</div>
                            <div style={{ color: 'var(--text)', fontWeight: 700, marginBottom: 4, fontFamily: "'Fira Code', monospace" }}>{formatCurrency(currentValue, locale, currency)}</div>
                            <div style={{ color: changeColor, fontWeight: 600, fontFamily: "'Fira Code', monospace" }}>
                              {sign}{formatCurrency(absoluteChange, locale, currency)} ({sign}{percentChange.toFixed(2)}%)
                            </div>
                          </div>
                        )
                      }}
                    />
                    <Area
                      type="monotone"
                      dataKey="value"
                      stroke="var(--v)"
                      strokeWidth={1.5}
                      fillOpacity={1}
                      fill="url(#chartGrad)"
                      dot={false}
                      activeDot={{ r: 4, fill: 'var(--v)', stroke: 'var(--bg)', strokeWidth: 2 }}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div style={{ height: 280, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)' }}>
                {t(language, 'dashboard.noHistoryData')}
              </div>
            )}
          </div>
        </div>

        {/* ── HOLDINGS TABLE ── */}
        <div style={{ marginTop: 16, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 20px', borderBottom: '1px solid var(--border)' }}>
            <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', color: 'var(--muted)' }}>
              {t(language, 'dashboard.holdings')} <span style={{ color: 'var(--v2)', marginLeft: 4 }}>{summary?.stock_count ?? 0}</span>
            </span>
          </div>
          {!summary?.stocks?.length ? (
            <div className="empty-state">{t(language, 'dashboard.noStocks')}</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <SortableHeader field="ticker" label={t(language, 'performance.ticker')} sortState={holdingsSortState} onSort={requestHoldingsSort} />
                  <SortableHeader field="name" label={t(language, 'dashboard.name')} sortState={holdingsSortState} onSort={requestHoldingsSort} />
                  <SortableHeader field="quantity" label={t(language, 'dashboard.qty')} sortState={holdingsSortState} onSort={requestHoldingsSort} align="right" />
                  <SortableHeader field="price" label={`${t(language, 'dashboard.price')} (${currency})`} sortState={holdingsSortState} onSort={requestHoldingsSort} align="right" />
                  <SortableHeader field="value" label={`${t(language, 'dashboard.value')} (${currency})`} sortState={holdingsSortState} onSort={requestHoldingsSort} align="right" />
                  <SortableHeader field="gainLoss" label={t(language, 'dashboard.gainLoss')} sortState={holdingsSortState} onSort={requestHoldingsSort} align="right" />
                  <SortableHeader field="gainLossPercent" label={t(language, 'dashboard.returnPercent')} sortState={holdingsSortState} onSort={requestHoldingsSort} align="right" />
                </tr>
              </thead>
              <tbody>
                {sortedSummaryStocks.map((stock) => {
                  const logoUrl = resolveBackendAssetUrl(stock.logo)
                  const displayName = formatDisplayName(stock.name, stock.ticker)
                  return <tr
                    key={stock.ticker}
                    onClick={() => navigate(`/stocks/${encodeURIComponent(stock.ticker)}`)}
                    style={{ cursor: 'pointer' }}
                  >
                    <td>
                      <Link
                        to={`/stocks/${encodeURIComponent(stock.ticker)}`}
                        style={{ color: 'var(--v2)', textDecoration: 'none', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {logoUrl && !failedLogos[stock.ticker] ? (
                          <img
                            src={logoUrl}
                            alt={displayName}
                            style={{ width: 22, height: 22, borderRadius: 4, objectFit: 'contain', background: 'var(--bg3)', padding: 2 }}
                            onError={(e) => {
                              ;(e.target as HTMLImageElement).style.display = 'none'
                              setFailedLogos((prev) => ({ ...prev, [stock.ticker]: true }))
                            }}
                          />
                        ) : (
                          <span style={{ width: 22, height: 22, borderRadius: 4, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: 'var(--muted)', background: 'var(--bg3)' }}>
                            {(displayName || stock.ticker || '?').charAt(0).toUpperCase()}
                          </span>
                        )}
                        {stock.ticker}
                      </Link>
                    </td>
                    <td style={{ color: 'var(--text2)' }}>{displayName}</td>
                    <td style={{ textAlign: 'right', fontFamily: "'Fira Code', monospace", color: 'var(--text2)' }}>{stock.quantity}</td>
                    <td style={{ textAlign: 'right', fontFamily: "'Fira Code', monospace", color: 'var(--text2)' }}>
                      {renderAmount(stock.display_price, stock.display_price_converted ? currency : stock.currency)}
                    </td>
                    <td style={{ textAlign: 'right', fontFamily: "'Fira Code', monospace", color: 'var(--text2)' }}>
                      {renderAmount(stock.current_value, stock.current_value_converted ? currency : stock.currency)}
                    </td>
                    <td style={{ textAlign: 'right', fontFamily: "'Fira Code', monospace" }} className={stock.gain_loss === null ? '' : (stock.gain_loss >= 0 ? 'positive' : 'negative')}>
                      {stock.gain_loss !== null ? formatCurrency(stock.gain_loss, locale, currency) : '-'}
                    </td>
                    <td style={{ textAlign: 'right', fontFamily: "'Fira Code', monospace" }} className={stock.gain_loss_percent === null ? '' : (stock.gain_loss_percent >= 0 ? 'positive' : 'negative')}>
                      {stock.gain_loss_percent !== null ? formatPercent(stock.gain_loss_percent, locale) : '-'}
                    </td>
                  </tr>
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* ── UPCOMING DIVIDENDS ── */}
        {monthlyUpcoming.length > 0 && (
          <div style={{ marginTop: 16, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 20px', borderBottom: '1px solid var(--border)' }}>
              <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', color: 'var(--muted)' }}>
                {t(language, 'dashboard.upcomingDividends')}
              </span>
              <span style={{ fontFamily: "'Fira Code', monospace", fontSize: 13, fontWeight: 700, color: 'var(--green)' }}>
                {formatCurrency(totalRemainingDividends, locale, currency)}
              </span>
            </div>
            <div style={{ padding: '16px 20px' }}>
              {monthlyUpcoming.map((group) => (
                <div key={group.monthKey} style={{ marginBottom: 24 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                    <h4 style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--muted)' }}>
                      {formatMonthLabel(group.monthKey, locale, language)}
                    </h4>
                    <span style={{ fontFamily: "'Fira Code', monospace", fontSize: 12, color: 'var(--green)', fontWeight: 600 }}>
                      {Object.entries(group.subtotalsByCurrency)
                        .sort(([a], [b]) => a.localeCompare(b))
                        .map(([c, a]) => formatCurrency(a, locale, c))
                        .join(' + ')}
                    </span>
                  </div>
                  <table style={{ width: '100%', tableLayout: 'fixed' }}>
                    <thead>
                      <tr>
                        <SortableHeader field="name" label={t(language, 'performance.name')} sortState={upcomingSortState} onSort={requestUpcomingSort} style={{ width: '18%' }} />
                        <SortableHeader field="exDate" label={t(language, 'dashboard.exDate')} sortState={upcomingSortState} onSort={requestUpcomingSort} style={{ width: '14%' }} />
                        <SortableHeader field="paymentDate" label={t(language, 'dashboard.dividendDate')} sortState={upcomingSortState} onSort={requestUpcomingSort} style={{ width: '16%' }} />
                        <SortableHeader field="perShare" label={t(language, 'dashboard.perShare')} sortState={upcomingSortState} onSort={requestUpcomingSort} align="right" style={{ width: '18%' }} />
                        <SortableHeader field="total" label={t(language, 'dashboard.total')} sortState={upcomingSortState} onSort={requestUpcomingSort} align="right" style={{ width: '18%' }} />
                        <SortableHeader field="source" label={t(language, 'dashboard.source')} sortState={upcomingSortState} onSort={requestUpcomingSort} style={{ width: '16%' }} />
                      </tr>
                    </thead>
                    <tbody>
                      {group.items.map((div, i) => {
                        const displayed = getDisplayedDividendAmount(div)
                        const payoutDisplayDate = div.payment_date
                        const payoutKey = payoutDisplayDate || 'tbd'
                        return (
                          <tr key={`${div.ticker}-${div.ex_date}-${payoutKey}-${div.dividend_type ?? 'na'}-${i}`}>
                            <td>
                              <Link to={`/stocks/${encodeURIComponent(div.ticker)}`} style={{ color: 'var(--v2)', textDecoration: 'none', fontWeight: 700 }}>
                                {div.name || div.ticker}
                              </Link>
                            </td>
                            <td style={{ fontFamily: "'Fira Code', monospace", color: 'var(--text2)' }}>{formatDate(div.ex_date, locale)}</td>
                            <td style={{ fontFamily: "'Fira Code', monospace", color: 'var(--text2)' }}>{payoutDisplayDate ? formatDate(payoutDisplayDate, locale) : t(language, 'common.tbd')}</td>
                            <td style={{ textAlign: 'right', fontFamily: "'Fira Code', monospace", color: 'var(--text2)' }}>{formatCurrency(div.amount_per_share, locale, div.currency)}</td>
                            <td style={{ textAlign: 'right', fontFamily: "'Fira Code', monospace", color: 'var(--green)' }}>
                              {formatCurrency(displayed.amount, locale, displayed.currency)}
                            </td>
                            <td>
                              <span className={`badge ${div.source === 'avanza' ? 'badge-green' : (div.source === 'yahoo' ? 'badge-violet' : 'badge-muted')}`}>
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
          </div>
        )}
      </div>
    </div>
  )
}
