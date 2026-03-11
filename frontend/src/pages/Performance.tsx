import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { api, Stock } from '../services/api'
import { getLocaleForLanguage, t } from '../i18n'
import { useSettings } from '../SettingsContext'

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

type SortField = 'ticker' | 'name' | 'value' | 'cost' | 'gain' | 'gainPercent' | 'dailyChange' | 'dailyChangePercent'
type SortOrder = 'asc' | 'desc'

interface PerformanceData {
  ticker: string
  name: string | null
  quantity: number
  currency: string
  purchasePrice: number | null
  currentPrice: number | null
  previousClose: number | null
  value: number
  cost: number
  gain: number
  gainPercent: number
  dailyChange: number | null
  dailyChangePercent: number | null
  valueSEK: number
  costSEK: number
  gainSEK: number
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
function SortHeader({
  field,
  label,
  sortField,
  sortOrder,
  onSort,
}: {
  field: SortField
  label: string
  sortField: SortField
  sortOrder: SortOrder
  onSort: (field: SortField) => void
}) {
  return (
    <th
      onClick={() => onSort(field)}
      style={{ cursor: 'pointer', userSelect: 'none' }}
    >
      {label} {sortField === field ? (sortOrder === 'asc' ? '↑' : '↓') : ''}
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
  const [sortField, setSortField] = useState<SortField>('gainPercent')
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc')
  const { language } = useSettings()
  const locale = getLocaleForLanguage(language)

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true)
        const [stocksData, ratesData] = await Promise.all([
          api.stocks.list(),
          api.market.exchangeRates(),
        ])
        setStocks(stocksData)
        setExchangeRates(ratesData)
      } catch (err) {
        console.error('Failed to load data:', err)
      } finally {
        setLoading(false)
      }
    }
    fetchData()
  }, [])

  const convertToSEK = (amount: number, currency: string): number => {
    if (currency === 'SEK') return amount
    const rate = exchangeRates[`${currency}_SEK`]
    if (rate != null) return amount * rate
    return amount
  }

  const performanceData: PerformanceData[] = stocks.map(stock => {
    const value = (stock.current_price || 0) * stock.quantity
    const cost = (stock.purchase_price || 0) * stock.quantity
    const gain = value - cost
    const gainPercent = cost > 0 ? (gain / cost) * 100 : 0
    const dailyChange = stock.current_price != null && stock.previous_close != null
      ? (stock.current_price - stock.previous_close) * stock.quantity
      : null
    const dailyChangePercent = stock.current_price != null && stock.previous_close != null && stock.previous_close !== 0
      ? ((stock.current_price - stock.previous_close) / stock.previous_close) * 100
      : null

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
      valueSEK: convertToSEK(value, stock.currency),
      costSEK: convertToSEK(cost, stock.currency),
      gainSEK: convertToSEK(gain, stock.currency),
      dailyChangeSEK: dailyChange != null ? convertToSEK(dailyChange, stock.currency) : null,
    }
  })

  const sortedData = [...performanceData].sort((a, b) => {
    let aVal: number | string = 0
    let bVal: number | string = 0

    switch (sortField) {
      case 'ticker':
        aVal = a.ticker
        bVal = b.ticker
        break
      case 'name':
        aVal = a.name || a.ticker || ''
        bVal = b.name || b.ticker || ''
        break
      case 'value':
        aVal = a.valueSEK
        bVal = b.valueSEK
        break
      case 'cost':
        aVal = a.costSEK
        bVal = b.costSEK
        break
      case 'gain':
        aVal = a.gainSEK
        bVal = b.gainSEK
        break
      case 'gainPercent':
        aVal = a.gainPercent
        bVal = b.gainPercent
        break
      case 'dailyChange':
        aVal = a.dailyChangeSEK || 0
        bVal = b.dailyChangeSEK || 0
        break
      case 'dailyChangePercent':
        aVal = a.dailyChangePercent || 0
        bVal = b.dailyChangePercent || 0
        break
    }

    if (typeof aVal === 'string' && typeof bVal === 'string') {
      return sortOrder === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal)
    }
    return sortOrder === 'asc' ? (aVal as number) - (bVal as number) : (bVal as number) - (aVal as number)
  })

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')
    } else {
      setSortField(field)
      setSortOrder('desc')
    }
  }

  const bestPerformers = [...performanceData].sort((a, b) => b.gainPercent - a.gainPercent).slice(0, 3)
  const worstPerformers = [...performanceData].sort((a, b) => a.gainPercent - b.gainPercent).slice(0, 3)

  const totalValue = performanceData.reduce((sum, s) => sum + s.valueSEK, 0)
  const totalCost = performanceData.reduce((sum, s) => sum + s.costSEK, 0)
  const totalGain = totalValue - totalCost
  const totalGainPercent = totalCost > 0 ? (totalGain / totalCost) * 100 : 0
  const totalDailyChange = performanceData.reduce((sum, s) => sum + (s.dailyChangeSEK || 0), 0)

  const exportToCSV = () => {
    const headers = ['Ticker', 'Name', 'Quantity', 'Currency', 'Purchase Price', 'Current Price', 'Value', 'Cost', 'Gain', 'Gain %', 'Daily Change', 'Daily Change %']
    const rows = sortedData.map(s => [
      sanitizeCsvCell(s.ticker),
      sanitizeCsvCell(s.name),
      sanitizeCsvCell(s.quantity),
      sanitizeCsvCell(s.currency),
      sanitizeCsvCell(s.purchasePrice?.toFixed(2)),
      sanitizeCsvCell(s.currentPrice?.toFixed(2)),
      sanitizeCsvCell(s.value.toFixed(2)),
      sanitizeCsvCell(s.cost.toFixed(2)),
      sanitizeCsvCell(s.gain.toFixed(2)),
      sanitizeCsvCell(s.gainPercent.toFixed(2) + '%'),
      sanitizeCsvCell(s.dailyChange?.toFixed(2)),
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
        gridTemplateColumns: 'repeat(4, 1fr)',
        borderBottom: '1px solid var(--border)',
        background: 'linear-gradient(115deg, #12141c 0%, var(--bg) 55%)',
      }}>
        {[
          { label: t(language, 'performance.totalValue'), value: formatCurrency(totalValue, locale, 'SEK'), color: 'var(--text)' },
          { label: t(language, 'performance.totalCost'), value: formatCurrency(totalCost, locale, 'SEK'), color: 'var(--text2)' },
          { label: t(language, 'performance.totalGainLoss'), value: formatCurrency(totalGain, locale, 'SEK'), sub: formatPercent(totalGainPercent, locale), color: totalGain >= 0 ? 'var(--green)' : 'var(--red)' },
          { label: t(language, 'performance.dailyChange'), value: formatCurrency(totalDailyChange, locale, 'SEK'), color: totalDailyChange >= 0 ? 'var(--green)' : 'var(--red)' },
        ].map((stat, i, arr) => (
          <div key={stat.label} style={{
            padding: '26px 28px',
            borderRight: i < arr.length - 1 ? '1px solid var(--border)' : 'none',
          }}>
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 10 }}>
              {stat.label}
            </div>
            <div style={{ fontSize: 24, fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1, color: stat.color }}>
              {stat.value}
            </div>
            {stat.sub && (
              <div style={{ fontSize: 12, fontWeight: 600, marginTop: 4, color: stat.color, fontFamily: "'Fira Code', monospace" }}>{stat.sub}</div>
            )}
          </div>
        ))}
      </div>

      <div style={{ padding: '0 28px 28px' }}>

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
                  {bestPerformers.map((stock) => (
                    <div key={stock.ticker} style={{ display: 'flex', justifyContent: 'space-between', padding: '9px 0', borderBottom: '1px solid var(--border)' }}>
                      <Link to={`/stocks/${stock.ticker}`} style={{ color: 'var(--v2)', textDecoration: 'none', fontWeight: 700, fontSize: 13 }}>
                        {stock.name || stock.ticker}
                      </Link>
                      <span className="positive" style={{ fontFamily: "'Fira Code', monospace", fontSize: 12, fontWeight: 600 }}>
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
                  {worstPerformers.map((stock) => (
                    <div key={stock.ticker} style={{ display: 'flex', justifyContent: 'space-between', padding: '9px 0', borderBottom: '1px solid var(--border)' }}>
                      <Link to={`/stocks/${stock.ticker}`} style={{ color: 'var(--v2)', textDecoration: 'none', fontWeight: 700, fontSize: 13 }}>
                        {stock.name || stock.ticker}
                      </Link>
                      <span className="negative" style={{ fontFamily: "'Fira Code', monospace", fontSize: 12, fontWeight: 600 }}>
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
                <SortHeader field="name" label={t(language, 'performance.name')} sortField={sortField} sortOrder={sortOrder} onSort={handleSort} />
                <SortHeader field="ticker" label={t(language, 'performance.ticker')} sortField={sortField} sortOrder={sortOrder} onSort={handleSort} />
                <th>{t(language, 'performance.qty')}</th>
                <th>{t(language, 'performance.currency')}</th>
                <SortHeader field="cost" label={t(language, 'performance.costSek')} sortField={sortField} sortOrder={sortOrder} onSort={handleSort} />
                <SortHeader field="value" label={t(language, 'performance.valueSek')} sortField={sortField} sortOrder={sortOrder} onSort={handleSort} />
                <SortHeader field="gain" label={t(language, 'performance.gainLoss')} sortField={sortField} sortOrder={sortOrder} onSort={handleSort} />
                <SortHeader field="gainPercent" label={t(language, 'performance.returnPercent')} sortField={sortField} sortOrder={sortOrder} onSort={handleSort} />
                <SortHeader field="dailyChange" label={t(language, 'performance.dailySek')} sortField={sortField} sortOrder={sortOrder} onSort={handleSort} />
                <SortHeader field="dailyChangePercent" label={t(language, 'performance.dailyPercent')} sortField={sortField} sortOrder={sortOrder} onSort={handleSort} />
              </tr>
            </thead>
            <tbody>
              {sortedData.map((stock) => (
                <tr key={stock.ticker}>
                  <td>
                    <Link to={`/stocks/${stock.ticker}`} style={{ color: 'var(--v2)', textDecoration: 'none', fontWeight: 700 }}>
                      {stock.name || stock.ticker}
                    </Link>
                  </td>
                  <td style={{ color: 'var(--muted)', fontFamily: "'Fira Code', monospace" }}>{stock.ticker}</td>
                  <td style={{ fontFamily: "'Fira Code', monospace" }}>{stock.quantity}</td>
                  <td><span className="badge badge-muted">{stock.currency}</span></td>
                  <td style={{ fontFamily: "'Fira Code', monospace" }}>{formatCurrency(stock.costSEK, locale, 'SEK')}</td>
                  <td style={{ fontFamily: "'Fira Code', monospace" }}>{formatCurrency(stock.valueSEK, locale, 'SEK')}</td>
                  <td className={stock.gain >= 0 ? 'positive' : 'negative'} style={{ fontFamily: "'Fira Code', monospace" }}>
                    {formatCurrency(stock.gainSEK, locale, 'SEK')}
                  </td>
                  <td className={stock.gainPercent >= 0 ? 'positive' : 'negative'} style={{ fontFamily: "'Fira Code', monospace", fontWeight: 700 }}>
                    {formatPercent(stock.gainPercent, locale)}
                  </td>
                  <td className={stock.dailyChangeSEK != null ? (stock.dailyChangeSEK >= 0 ? 'positive' : 'negative') : ''} style={{ fontFamily: "'Fira Code', monospace" }}>
                    {stock.dailyChangeSEK !== null ? formatCurrency(stock.dailyChangeSEK, locale, 'SEK') : '-'}
                  </td>
                  <td className={stock.dailyChangePercent != null ? (stock.dailyChangePercent >= 0 ? 'positive' : 'negative') : ''} style={{ fontFamily: "'Fira Code', monospace" }}>
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
