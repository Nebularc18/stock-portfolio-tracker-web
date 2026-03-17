import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Link } from 'react-router-dom'
import { api, Stock } from '../services/api'
import { getLocaleForLanguage, t } from '../i18n'
import { useSettings } from '../SettingsContext'
import SortableHeader from '../components/SortableHeader'
import { convertCurrencyToSEK } from '../utils/currency'
import { sortTableItems, useTableSort } from '../utils/tableSort'

/**
 * Format a numeric amount as a localized currency string.
 *
 * @param value - The numeric amount to format; if `null`, a dash (`-`) is returned
 * @param locale - BCP 47 locale identifier used for localization (e.g., `en-US`, `sv-SE`)
 * @param currency - ISO 4217 currency code to use for formatting (defaults to `'USD'`)
 * @returns A localized currency string for `value`, or `'-'` if `value` is `null`
 */
function formatCurrency(value: number | null, locale: string, currency: string = 'USD'): string {
  if (value === null) return '-'
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(value)
}

/**
 * Formats a numeric percentage value for display with a sign and locale-aware percent formatting.
 *
 * @param value - The percentage as a number (e.g., `5` means 5%). If `null`, a dash (`-`) is returned.
 * @param locale - The locale identifier used for formatting (e.g., `en-US`).
 * @returns A signed, locale-formatted percent string (e.g., `+5.00%` or `-3.50%`), or `-` if `value` is `null`.
 */
function formatPercent(value: number | null, locale: string): string {
  if (value === null) return '-'
  const absValue = Math.abs(value) / 100
  const formatted = new Intl.NumberFormat(locale, {
    style: 'percent',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(absValue)
  return value >= 0 ? `+${formatted}` : `-${formatted}`
}

/**
 * Sanitize a value for safe inclusion as a CSV cell.
 *
 * Converts null/undefined to an empty quoted cell `""`, escapes internal double quotes by doubling them,
 * and wraps the result in double quotes. If the original string (after optional control/whitespace)
 * begins with `=`, `+`, `-`, or `@`, prefixes the cell content with a tab character inside the quotes
 * to mitigate CSV injection.
 *
 * @param value - The value to sanitize for CSV output (string, number, null, or undefined)
 * @returns A CSV-safe, quoted cell string with internal quotes escaped; tab-prefixed inside the quotes when the value could trigger CSV injection
 */
function sanitizeCsvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '""'
  const str = String(value)
  const escaped = str.replace(/"/g, '""')
  if (/^[\u0000-\u001F\s]*[=+\-@]/.test(str)) {
    return `"\t${escaped}"`
  }
  return `"${escaped}"`
}

type SortField =
  | 'ticker'
  | 'name'
  | 'quantity'
  | 'currency'
  | 'value'
  | 'cost'
  | 'gain'
  | 'gainPercent'
  | 'dailyChange'
  | 'dailyChangePercent'

interface PerformanceData {
  ticker: string
  name: string | null
  quantity: number
  currency: string
  purchasePrice: number | null
  currentPrice: number | null
  previousClose: number | null
  value: number | null
  cost: number | null
  gain: number | null
  gainPercent: number | null
  dailyChange: number | null
  dailyChangePercent: number | null
  valueSEK: number | null
  costSEK: number | null
  gainSEK: number | null
  dailyChangeSEK: number | null
}

/**
 * Renders a table header cell that toggles sorting for a given field.
 *
 * @param field - The sort key represented by this header.
 * @param label - Visible header text.
 * @param sortField - Currently active sort field.
 * @param sortOrder - Current sort order ('asc' or 'desc').
 * @param onSort - Callback invoked with `field` when the header is clicked.
 * @returns The table header cell (<th>) element showing the label and an ascending/descending indicator when active.
 */
export function SortHeader({
  field,
  label,
  sortField,
  sortOrder,
  onSort,
}: {
  field: SortField
  label: string
  sortField: SortField
  sortOrder: 'asc' | 'desc'
  onSort: (field: SortField) => void
}) {
  const isActive = sortField === field
  const ariaSort = isActive ? (sortOrder === 'asc' ? 'ascending' : 'descending') : 'none'

  return (
    <th aria-sort={ariaSort} scope="col">
      <button
        type="button"
        onClick={() => onSort(field)}
        style={{
          cursor: 'pointer',
          userSelect: 'none',
          background: 'none',
          border: 0,
          color: 'inherit',
          font: 'inherit',
          padding: 0,
          textAlign: 'left',
          width: '100%',
        }}
      >
        {label} {isActive ? (sortOrder === 'asc' ? '↑' : '↓') : ''}
      </button>
    </th>
  )
}

/**
 * Display the portfolio performance dashboard with summary cards, best/worst performer lists, a sortable holdings table, and CSV export.
 *
 * @returns The React element for the performance dashboard.
 */
export default function Performance() {
  const [stocks, setStocks] = useState<Stock[]>([])
  const [exchangeRates, setExchangeRates] = useState<Record<string, number | null>>({})
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<Error | null>(null)
  const { sortState, requestSort } = useTableSort<SortField>({ field: 'ticker', direction: 'asc' })
  const { language } = useSettings()
  const locale = getLocaleForLanguage(language)
  const latestFetchIdRef = useRef(0)

  const fetchData = useCallback(async () => {
    const fetchId = latestFetchIdRef.current + 1
    latestFetchIdRef.current = fetchId
    try {
      if (latestFetchIdRef.current !== fetchId) return
      setLoadError(null)
      setLoading(true)
      const stocksData = await api.stocks.list()
      if (latestFetchIdRef.current !== fetchId) return
      setStocks(stocksData)
      try {
        const ratesData = await api.market.exchangeRates()
        if (latestFetchIdRef.current !== fetchId) return
        setExchangeRates(ratesData)
      } catch (ratesError) {
        if (latestFetchIdRef.current !== fetchId) return
        console.error('Failed to load exchange rates:', ratesError)
        setExchangeRates({})
      }
    } catch (err) {
      if (latestFetchIdRef.current !== fetchId) return
      console.error('Failed to load data:', err)
      setLoadError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      if (latestFetchIdRef.current === fetchId) {
        setLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    fetchData()
    return () => {
      latestFetchIdRef.current += 1
    }
  }, [fetchData])

  const performanceData: PerformanceData[] = useMemo(() => (
    stocks.map(stock => {
      const value = stock.current_price != null ? stock.current_price * stock.quantity : null
      const cost = stock.purchase_price != null ? stock.purchase_price * stock.quantity : null
      const gain = value != null && cost != null ? value - cost : null
      const gainPercent = gain != null && cost != null && cost !== 0 ? (gain / cost) * 100 : null
      const dailyChange = stock.current_price != null && stock.previous_close != null
        ? (stock.current_price - stock.previous_close) * stock.quantity
        : null
      const dailyChangePercent = stock.current_price != null && stock.previous_close != null && stock.previous_close !== 0
        ? ((stock.current_price - stock.previous_close) / stock.previous_close) * 100
        : null

      const valueSEK = convertCurrencyToSEK(value, stock.currency, exchangeRates)
      const costSEK = convertCurrencyToSEK(cost, stock.currency, exchangeRates)

      return {
        ticker: stock.ticker,
        name: stock.name,
        quantity: stock.quantity,
        currency: stock.currency,
        purchasePrice: stock.purchase_price,
        currentPrice: stock.current_price,
        previousClose: stock.previous_close,
        value,
        cost,
        gain,
        gainPercent,
        dailyChange,
        dailyChangePercent,
        valueSEK,
        costSEK,
        gainSEK: valueSEK !== null && costSEK !== null ? valueSEK - costSEK : null,
        dailyChangeSEK: convertCurrencyToSEK(dailyChange, stock.currency, exchangeRates),
      }
    })
  ), [stocks, exchangeRates])

  const sortedData = useMemo(() => (
    sortTableItems(
      performanceData,
      sortState,
      {
        ticker: (item) => item.ticker,
        name: (item) => item.name || item.ticker,
        quantity: (item) => item.quantity,
        currency: (item) => item.currency,
        value: (item) => item.valueSEK,
        cost: (item) => item.costSEK,
        gain: (item) => item.gainSEK,
        gainPercent: (item) => item.gainPercent,
        dailyChange: (item) => item.dailyChangeSEK,
        dailyChangePercent: (item) => item.dailyChangePercent,
      },
      locale,
      (item) => item.ticker
    )
  ), [locale, performanceData, sortState])

  const { bestPerformers, worstPerformers } = useMemo(() => {
    const comparable = performanceData.filter((stock) => stock.gainPercent !== null)
    const best = [...comparable]
      .sort((a, b) => (b.gainPercent ?? -Infinity) - (a.gainPercent ?? -Infinity))
      .slice(0, 3)
    const bestTickers = new Set(best.map((stock) => stock.ticker))
    const worst = comparable
      .filter((stock) => !bestTickers.has(stock.ticker))
      .sort((a, b) => (a.gainPercent ?? Infinity) - (b.gainPercent ?? Infinity))
      .slice(0, 3)
    return { bestPerformers: best, worstPerformers: worst }
  }, [performanceData])

  const {
    missingRateStocks,
    hasMissing,
    hasMissingDailyChange,
    totalValue,
    totalCost,
    totalGain,
    totalGainPercent,
    totalDailyChange,
  } = useMemo(() => {
    const missing = performanceData.filter((stock) => {
      if (stock.currency === 'SEK') return false
      const valueRateMissing = stock.value !== null && stock.valueSEK === null
      const costRateMissing = stock.cost !== null && stock.costSEK === null
      const gainRateMissing = stock.gain !== null && stock.gainSEK === null
      return valueRateMissing || costRateMissing || gainRateMissing
    })
    const hasNullLocalInputs = performanceData.some((stock) => (
      stock.value === null || stock.cost === null || stock.gain === null
    ))
    const totalVal = performanceData.reduce((sum, s) => sum + (s.valueSEK ?? 0), 0)
    const totalCostLocal = performanceData.reduce((sum, s) => sum + (s.costSEK ?? 0), 0)
    const totalGainLocal = performanceData.reduce((sum, s) => {
      if (s.gainSEK !== null) return sum + s.gainSEK
      if (s.valueSEK !== null && s.costSEK !== null) return sum + (s.valueSEK - s.costSEK)
      return sum
    }, 0)
    const totalGainPercentLocal = totalCostLocal > 0 ? (totalGainLocal / totalCostLocal) * 100 : 0
    const totalDailyChangeLocal = performanceData.reduce((sum, s) => sum + (s.dailyChangeSEK ?? 0), 0)
    const missingDailyChange = performanceData.some((stock) => stock.dailyChange === null || stock.dailyChangeSEK === null)
    return {
      missingRateStocks: missing,
      hasMissing: missing.length > 0 || hasNullLocalInputs,
      hasMissingDailyChange: missingDailyChange,
      totalValue: totalVal,
      totalCost: totalCostLocal,
      totalGain: totalGainLocal,
      totalGainPercent: totalGainPercentLocal,
      totalDailyChange: totalDailyChangeLocal,
    }
  }, [performanceData])

  const exportToCSV = () => {
    const headers = ['Ticker', 'Name', 'Quantity', 'Currency', 'Purchase Price', 'Current Price', 'Value', 'Cost', 'Gain', 'Gain %', 'Daily Change', 'Daily Change %']
    const rows = sortedData.map(s => [
      sanitizeCsvCell(s.ticker),
      sanitizeCsvCell(s.name),
      sanitizeCsvCell(s.quantity),
      sanitizeCsvCell(s.currency),
      sanitizeCsvCell(s.purchasePrice?.toFixed(2)),
      sanitizeCsvCell(s.currentPrice?.toFixed(2)),
      sanitizeCsvCell(s.value !== null ? s.value.toFixed(2) : ''),
      sanitizeCsvCell(s.cost !== null ? s.cost.toFixed(2) : ''),
      sanitizeCsvCell(s.gain !== null ? s.gain.toFixed(2) : ''),
      sanitizeCsvCell(s.gainPercent !== null ? s.gainPercent.toFixed(2) + '%' : ''),
      sanitizeCsvCell(s.dailyChange !== null ? s.dailyChange.toFixed(2) : ''),
      sanitizeCsvCell(s.dailyChangePercent != null ? s.dailyChangePercent.toFixed(2) + '%' : ''),
    ])
    
    const csvContent = [headers.map(sanitizeCsvCell).join(','), ...rows.map(r => r.join(','))].join('\n')
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `portfolio_performance_${new Date().toISOString().split('T')[0]}.csv`
    link.click()
    URL.revokeObjectURL(url)
    link.remove()
  }

  if (loading) {
    return <div className="loading-state">{t(language, 'common.loading')}</div>
  }

  if (loadError) {
    return (
      <div style={{ padding: 28 }}>
        <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, padding: '32px', textAlign: 'center' }}>
          <p role="alert" aria-live="assertive" aria-atomic="true" style={{ color: 'var(--red)', marginBottom: 16 }}>
            {t(language, 'performance.failedLoad')}
          </p>
          <button className="btn btn-primary" onClick={fetchData}>
            {t(language, 'common.retry')}
          </button>
        </div>
      </div>
    )
  }

  if (stocks.length === 0) {
    return (
      <div style={{ padding: 28 }}>
        <div className="card">
          <div className="empty-state">{t(language, 'performance.noStocks')}</div>
        </div>
      </div>
    )
  }

  return (
    <div>
      {/* ── HERO STATS ── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
        borderBottom: '1px solid var(--border)',
        background: 'linear-gradient(115deg, var(--bg-dark, #12141c) 0%, var(--bg) 55%)',
      }}>
        {[
          { label: t(language, 'performance.totalValue'), value: formatCurrency(totalValue, locale, 'SEK'), color: 'var(--text)', incomplete: hasMissing },
          { label: t(language, 'performance.totalCost'), value: formatCurrency(totalCost, locale, 'SEK'), color: 'var(--text2)', incomplete: hasMissing },
          { label: t(language, 'performance.totalGainLoss'), value: formatCurrency(totalGain, locale, 'SEK'), sub: formatPercent(totalGainPercent, locale), color: totalGain >= 0 ? 'var(--green)' : 'var(--red)', incomplete: hasMissing },
          { label: t(language, 'performance.dailyChange'), value: formatCurrency(totalDailyChange, locale, 'SEK'), color: totalDailyChange >= 0 ? 'var(--green)' : 'var(--red)', incomplete: hasMissingDailyChange },
        ].map((stat, i, arr) => (
          <div key={stat.label} style={{
            padding: '26px 28px',
            borderRight: i < arr.length - 1 ? '1px solid var(--border)' : 'none',
          }}>
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 10 }}>
              {stat.label}
            </div>
            <div style={{ fontSize: 24, fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1, color: stat.color }}>
              {stat.value}{stat.incomplete ? ' *' : ''}
            </div>
            {stat.sub && (
              <div style={{ fontSize: 12, fontWeight: 600, marginTop: 4, color: stat.color, fontFamily: "'Fira Code', monospace" }}>{stat.sub}</div>
            )}
          </div>
        ))}
      </div>

      <div style={{ padding: '0 28px 28px' }}>
        {missingRateStocks.length > 0 && (
          <div style={{ marginTop: 16, padding: '10px 16px', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.25)', borderRadius: 6 }}>
            <p style={{ color: 'var(--amber)', margin: 0, fontSize: 13 }}>
              {t(language, 'performance.missingRatesWarning')}
            </p>
          </div>
        )}
        {hasMissingDailyChange && (
          <div style={{ marginTop: 12, padding: '10px 16px', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.25)', borderRadius: 6 }}>
            <p style={{ color: 'var(--amber)', margin: 0, fontSize: 13 }}>
              {t(language, 'performance.missingDailyChangeWarning')}
            </p>
          </div>
        )}

        {/* ── PAGE HEADER ── */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 0 14px' }}>
          <h2 style={{ fontSize: 16, fontWeight: 800, letterSpacing: '-0.01em' }}>{t(language, 'performance.title')}</h2>
          <button className="btn btn-secondary" onClick={exportToCSV}>
            {t(language, 'performance.exportCsv')}
          </button>
        </div>

        {/* ── BEST / WORST ── */}
        {(bestPerformers.length > 0 || worstPerformers.length > 0) && (
          <div className="grid grid-2" style={{ marginBottom: 16 }}>
            {bestPerformers.length > 0 && (
              <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8 }}>
                <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--border)' }}>
                  <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--green)' }}>
                    {t(language, 'performance.bestPerformers')}
                  </span>
                </div>
                <div style={{ padding: '8px 18px' }}>
                    {bestPerformers.map((stock, index) => (
                     <div key={stock.ticker} style={{ display: 'flex', justifyContent: 'space-between', padding: '9px 0', borderBottom: index < bestPerformers.length - 1 ? '1px solid var(--border)' : 'none' }}>
                      <Link to={`/stocks/${encodeURIComponent(stock.ticker)}`} style={{ color: 'var(--v2)', textDecoration: 'none', fontWeight: 700, fontSize: 13 }}>
                        {stock.name || stock.ticker}
                      </Link>
                      <span className={stock.gainPercent != null && stock.gainPercent >= 0 ? 'positive' : 'negative'} style={{ fontFamily: "'Fira Code', monospace", fontSize: 12, fontWeight: 600 }}>
                        {formatPercent(stock.gainPercent, locale)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {worstPerformers.length > 0 && (
              <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8 }}>
                <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--border)' }}>
                  <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--red)' }}>
                    {t(language, 'performance.worstPerformers')}
                  </span>
                </div>
                <div style={{ padding: '8px 18px' }}>
                    {worstPerformers.map((stock, index) => (
                     <div key={stock.ticker} style={{ display: 'flex', justifyContent: 'space-between', padding: '9px 0', borderBottom: index < worstPerformers.length - 1 ? '1px solid var(--border)' : 'none' }}>
                      <Link to={`/stocks/${encodeURIComponent(stock.ticker)}`} style={{ color: 'var(--v2)', textDecoration: 'none', fontWeight: 700, fontSize: 13 }}>
                        {stock.name || stock.ticker}
                      </Link>
                      <span className={stock.gainPercent != null && stock.gainPercent >= 0 ? 'positive' : 'negative'} style={{ fontFamily: "'Fira Code', monospace", fontSize: 12, fontWeight: 600 }}>
                        {formatPercent(stock.gainPercent, locale)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── HOLDINGS TABLE ── */}
        <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8 }}>
          <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--border)' }}>
            <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--muted)' }}>
              {t(language, 'performance.holdingsPerformance')}
            </span>
          </div>
          <table>
            <thead>
              <tr>
                <SortableHeader field="name" label={t(language, 'performance.name')} sortState={sortState} onSort={requestSort} />
                <SortableHeader field="ticker" label={t(language, 'performance.ticker')} sortState={sortState} onSort={requestSort} />
                <SortableHeader field="quantity" label={t(language, 'performance.qty')} sortState={sortState} onSort={requestSort} align="right" />
                <SortableHeader field="currency" label={t(language, 'performance.currency')} sortState={sortState} onSort={requestSort} />
                <SortableHeader field="cost" label={t(language, 'performance.costSek')} sortState={sortState} onSort={requestSort} align="right" />
                <SortableHeader field="value" label={t(language, 'performance.valueSek')} sortState={sortState} onSort={requestSort} align="right" />
                <SortableHeader field="gain" label={t(language, 'performance.gainLoss')} sortState={sortState} onSort={requestSort} align="right" />
                <SortableHeader field="gainPercent" label={t(language, 'performance.returnPercent')} sortState={sortState} onSort={requestSort} align="right" />
                <SortableHeader field="dailyChange" label={t(language, 'performance.dailySek')} sortState={sortState} onSort={requestSort} align="right" />
                <SortableHeader field="dailyChangePercent" label={t(language, 'performance.dailyPercent')} sortState={sortState} onSort={requestSort} align="right" />
              </tr>
            </thead>
            <tbody>
              {sortedData.map((stock) => (
                <tr key={stock.ticker}>
                  <td>
                    <Link to={`/stocks/${encodeURIComponent(stock.ticker)}`} style={{ color: 'var(--v2)', textDecoration: 'none', fontWeight: 700 }}>
                      {stock.name || stock.ticker}
                    </Link>
                  </td>
                  <td style={{ color: 'var(--muted)', fontFamily: "'Fira Code', monospace" }}>{stock.ticker}</td>
                  <td style={{ fontFamily: "'Fira Code', monospace" }}>{stock.quantity}</td>
                  <td><span className="badge badge-muted">{stock.currency}</span></td>
                  <td style={{ fontFamily: "'Fira Code', monospace" }}>
                    {stock.cost === null ? '-' : (stock.costSEK !== null ? formatCurrency(stock.costSEK, locale, 'SEK') : t(language, 'performance.rateMissing'))}
                  </td>
                  <td style={{ fontFamily: "'Fira Code', monospace" }}>
                    {stock.value === null ? '-' : (stock.valueSEK !== null ? formatCurrency(stock.valueSEK, locale, 'SEK') : t(language, 'performance.rateMissing'))}
                  </td>
                   <td className={stock.gainSEK !== null ? (stock.gainSEK >= 0 ? 'positive' : 'negative') : ''} style={{ fontFamily: "'Fira Code', monospace" }}>
                    {stock.gain === null ? '-' : (stock.gainSEK !== null ? formatCurrency(stock.gainSEK, locale, 'SEK') : t(language, 'performance.rateMissing'))}
                  </td>
                  <td className={stock.gainPercent !== null ? (stock.gainPercent >= 0 ? 'positive' : 'negative') : ''} style={{ fontFamily: "'Fira Code', monospace", fontWeight: 700 }}>
                    {formatPercent(stock.gainPercent, locale)}
                  </td>
                   <td className={stock.dailyChangeSEK !== null ? (stock.dailyChangeSEK >= 0 ? 'positive' : 'negative') : ''} style={{ fontFamily: "'Fira Code', monospace" }}>
                    {stock.dailyChange === null ? '-' : (stock.dailyChangeSEK !== null ? formatCurrency(stock.dailyChangeSEK, locale, 'SEK') : t(language, 'performance.rateMissing'))}
                  </td>
                   <td className={stock.dailyChangePercent !== null ? (stock.dailyChangePercent >= 0 ? 'positive' : 'negative') : ''} style={{ fontFamily: "'Fira Code', monospace" }}>
                    {formatPercent(stock.dailyChangePercent, locale)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
