import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { api, UpcomingDividend } from '../services/api'
import { useSettings } from '../SettingsContext'
import { getLocaleForLanguage, t } from '../i18n'
import SortableHeader from '../components/SortableHeader'
import { sortTableItems, useTableSort } from '../utils/tableSort'
import { subscribeToPortfolioDataUpdates } from '../utils/portfolioSync'
/**
 * Format a number as a localized currency string.
 *
 * @param value - The numeric amount to format
 * @param locale - BCP 47 locale identifier used for localization (e.g., `sv-SE`, `en-US`)
 * @param currency - ISO 4217 currency code to display (e.g., `SEK`, `USD`). Defaults to `SEK`
 * @returns The input formatted as a currency string using the provided `locale` and `currency`, with two fraction digits
 */
function formatCurrency(value: number, locale: string, currency: string = 'SEK'): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(value)
}

/**
 * Formats a "YYYY-MM-DD" date string into a localized date string.
 *
 * @param dateStr - Date in `YYYY-MM-DD` format; components are interpreted in UTC.
 * @param locale - BCP 47 locale identifier used for formatting (e.g., `sv-SE`, `en-US`).
 * @param options - Intl.DateTimeFormatOptions to customize the output (defaults to `year: 'numeric', month: 'short', day: 'numeric'`).
 * @returns A localized date string formatted from the input date using the provided `locale` and `options` (for example `1 Jan 2025`).
 */
function formatDate(dateStr: string, locale: string, options: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' }): string {
  const [year, month, day] = dateStr.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.toLocaleDateString(locale, { timeZone: 'UTC', ...options })
}

/**
 * Extracts a year-month key from an ISO-like date string.
 *
 * @param dateStr - A date string in the format `YYYY-MM-DD` (or `YYYY-M-D`)
 * @returns A string in the form `YYYY-MM` with the month zero-padded
 */
function getMonthKey(dateStr: string): string {
  const [year, month] = dateStr.split('-').map(Number)
  return `${year}-${String(month).padStart(2, '0')}`
}

/**
 * Produces a localized month label from a year-month key.
 *
 * @param monthKey - Year-month key in the format `YYYY-MM`
 * @param locale - BCP 47 locale identifier used for formatting (for example `sv-SE`)
 * @returns The month and year formatted for `locale` (e.g., `March 2026`)
 */
function formatMonthLabel(monthKey: string, locale: string): string {
  if (monthKey === 'tbd') return 'TBD'
  const [year, month] = monthKey.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, 1))
  return date.toLocaleDateString(locale, { year: 'numeric', month: 'long', timeZone: 'UTC' })
}

type SortField = 'name' | 'exDate' | 'paymentDate' | 'perShare' | 'total' | 'source'

/**
 * Render the current year's upcoming dividend payments for the user's portfolio, including data fetching, refresh handling, and month-grouped listings.
 *
 * @returns The component's rendered JSX for the upcoming dividends UI
 */
export default function UpcomingDividends() {
  const { language } = useSettings()
  const locale = getLocaleForLanguage(language)
  const currentYear = new Date().getUTCFullYear()
  const [dividends, setDividends] = useState<UpcomingDividend[]>([])
  const [totalExpected, setTotalExpected] = useState(0)
  const [totalReceived, setTotalReceived] = useState(0)
  const [totalRemaining, setTotalRemaining] = useState(0)
  const [displayCurrency, setDisplayCurrency] = useState('SEK')
  const [unmappedStocks, setUnmappedStocks] = useState<Array<{ ticker: string; name: string | null; reason: string }>>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const { sortState, requestSort } = useTableSort<SortField>({ field: 'name', direction: 'asc' })

  const fetchData = useCallback(async (showLoadingState: boolean = true) => {
    try {
      setRefreshError(null)
      if (showLoadingState) {
        setLoading(true)
      } else {
        setRefreshing(true)
      }
      if (showLoadingState) {
        setError(null)
      }
      const data = await api.portfolio.upcomingDividends()
      setDividends(data.dividends)
      setTotalExpected(data.total_expected)
      setTotalReceived(data.total_received)
      setTotalRemaining(data.total_remaining)
      setDisplayCurrency(data.display_currency)
      setUnmappedStocks(data.unmapped_stocks)
    } catch (err) {
      console.error('Failed to fetch upcoming dividends:', err)
      if (showLoadingState) {
        setError(t(language, 'upcoming.failedLoad'))
      } else {
        setRefreshError(t(language, 'upcoming.failedLoad'))
      }
    } finally {
      if (showLoadingState) {
        setLoading(false)
      } else {
        setRefreshing(false)
      }
    }
  }, [language])

  useEffect(() => {
    fetchData(true)
  }, [fetchData])

  useEffect(() => {
    return subscribeToPortfolioDataUpdates(() => {
      void fetchData(true)
    })
  }, [fetchData])

  const groupedByMonth = dividends.reduce((acc, div) => {
    const payoutDate = div.payment_date
    const key = payoutDate ? getMonthKey(payoutDate) : 'tbd'
    if (!acc[key]) {
      acc[key] = []
    }
    acc[key].push(div)
    return acc
  }, {} as Record<string, UpcomingDividend[]>)

  const getDisplayedDividendTotal = (item: UpcomingDividend): number | null => {
    return item.total_converted
  }

  const monthlyGroups = Object.entries(groupedByMonth)
    .sort(([a], [b]) => {
      if (a === 'tbd') return 1
      if (b === 'tbd') return -1
      return a.localeCompare(b)
    })
    .map(([monthKey, items]) => ({
      monthKey,
      items: sortTableItems(
        items,
        sortState,
        {
          name: (item) => item.name || item.ticker,
          exDate: (item) => item.ex_date,
          paymentDate: (item) => item.payment_date,
          perShare: (item) => item.amount_per_share,
          total: (item) => getDisplayedDividendTotal(item),
          source: (item) => item.source,
        },
        locale,
        (item) => item.ticker
      ),
      subtotal: items.some((item) => getDisplayedDividendTotal(item) === null)
        ? null
        : items.reduce((acc, item) => acc + (getDisplayedDividendTotal(item) ?? 0), 0),
    }))

  const averagePerMonthThisYear = totalExpected / 12

  if (loading) {
    return <div className="loading-state">{t(language, 'upcoming.loading')}</div>
  }

  if (error) {
    return (
      <div style={{ padding: 28 }}>
        <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, padding: '32px', textAlign: 'center' }}>
          <p role="alert" aria-live="assertive" aria-atomic="true" style={{ color: 'var(--muted)', marginBottom: 16 }}>{error}</p>
          <button className="btn btn-primary" onClick={() => fetchData(true)}>
            {t(language, 'common.retry')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div>
      {/* ── HERO STATS ── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
        borderBottom: '1px solid var(--border)',
        background: 'linear-gradient(115deg, #12141c 0%, var(--bg) 55%)',
      }}>
        {[
          { label: t(language, 'upcoming.totalExpected'), value: formatCurrency(totalExpected, locale, displayCurrency), color: 'var(--text)', accent: true },
          { label: t(language, 'dashboard.received'), value: formatCurrency(totalReceived, locale, displayCurrency), color: 'var(--green)' },
          { label: t(language, 'dashboard.remaining'), value: formatCurrency(totalRemaining, locale, displayCurrency), color: 'var(--v2)' },
          { label: `${t(language, 'upcoming.perMonth')} (${t(language, 'upcoming.averageThisYear')})`, value: formatCurrency(averagePerMonthThisYear, locale, displayCurrency), color: 'var(--text2)' },
        ].map((stat, i, arr) => (
          <div key={stat.label} style={{
            padding: '26px 28px',
            borderRight: i < arr.length - 1 ? '1px solid var(--border)' : 'none',
            borderLeft: i === 0 ? '2px solid var(--v)' : 'none',
          }}>
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 10 }}>
              {stat.label}
            </div>
            <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1, color: stat.color, fontFamily: "'Fira Code', monospace" }}>
              {stat.value}
            </div>
          </div>
        ))}
      </div>

      <div style={{ padding: '0 28px 28px' }}>

        {/* ── PAGE HEADER ── */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 0 14px' }}>
          <h2 style={{ fontSize: 16, fontWeight: 800, letterSpacing: '-0.01em' }}>
            {t(language, 'upcoming.titleWithYear', { year: currentYear })}
          </h2>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <Link to="/dividends/history" style={{ color: 'var(--v2)', textDecoration: 'none', fontSize: 13, fontWeight: 600 }}>
              {t(language, 'upcoming.viewHistory')} →
            </Link>
            <button className="btn btn-secondary" onClick={() => fetchData(false)} disabled={refreshing}>
              {refreshing ? t(language, 'common.refreshing') : t(language, 'common.refresh')}
            </button>
          </div>
        </div>

        {refreshError && (
          <div role="status" aria-live="polite" aria-atomic="true" style={{ marginBottom: 14, padding: '10px 16px', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.2)', borderRadius: 6 }}>
            <p style={{ margin: 0, color: 'var(--amber)', fontSize: 13 }}>{refreshError}</p>
          </div>
        )}

        {unmappedStocks.length > 0 && (
          <div style={{ marginBottom: 20, padding: '14px 18px', background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.18)', borderRadius: 8, borderLeft: '3px solid var(--amber)' }}>
            <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 8, color: 'var(--amber)' }}>
              {t(language, 'upcoming.unmappedTitle', { count: unmappedStocks.length })}
            </h3>
            <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>
              {t(language, 'upcoming.unmappedDescription')}
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              {unmappedStocks.slice(0, 5).map((stock) => (
                <span key={stock.ticker} className="badge badge-muted">
                  {stock.name || stock.ticker}
                </span>
              ))}
              {unmappedStocks.length > 5 && (
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                  +{unmappedStocks.length - 5} {t(language, 'upcoming.more')}
                </span>
              )}
              <Link to="/settings" style={{ marginLeft: 8, fontSize: 13, color: 'var(--v2)', textDecoration: 'underline' }}>
                {t(language, 'upcoming.mapInSettings')}
              </Link>
            </div>
          </div>
        )}

        {dividends.length === 0 ? (
          <div className="empty-state" style={{ paddingTop: 60 }}>{t(language, 'upcoming.noneFound')}</div>
        ) : (
          <>
            {monthlyGroups.map((group) => (
              <div key={group.monthKey} style={{ marginTop: 20 }}>
                {/* ── MONTH SECTION HEADER ── */}
                <div className="sec-row">
                  <span className="sec-title">{formatMonthLabel(group.monthKey, locale)}</span>
                  <span style={{ fontFamily: "'Fira Code', monospace", fontSize: 13, fontWeight: 700, color: 'var(--green)' }}>
                    {group.subtotal !== null ? formatCurrency(group.subtotal, locale, displayCurrency) : '-'}
                  </span>
                </div>

                <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8 }}>
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ tableLayout: 'fixed', minWidth: 720, width: '100%' }}>
                      <thead>
                        <tr>
                          <SortableHeader field="name" label={t(language, 'performance.name')} sortState={sortState} onSort={requestSort} style={{ width: '24%' }} />
                          <SortableHeader field="exDate" label={t(language, 'dashboard.exDate')} sortState={sortState} onSort={requestSort} style={{ width: '14%' }} />
                          <SortableHeader field="paymentDate" label={t(language, 'dashboard.dividendDate')} sortState={sortState} onSort={requestSort} style={{ width: '16%' }} />
                          <SortableHeader field="perShare" label={t(language, 'dashboard.perShare')} sortState={sortState} onSort={requestSort} align="right" style={{ width: '16%' }} />
                          <SortableHeader field="total" label={t(language, 'dashboard.total')} sortState={sortState} onSort={requestSort} align="right" style={{ width: '16%' }} />
                          <SortableHeader field="source" label={t(language, 'dashboard.source')} sortState={sortState} onSort={requestSort} style={{ width: '14%' }} />
                        </tr>
                      </thead>
                      <tbody>
                        {group.items.map((div, i) => {
                          const displayedTotal = getDisplayedDividendTotal(div)
                          const payoutDisplayDate = div.payment_date

                          return (
                            <tr key={`${div.ticker}-${div.ex_date}-${div.payment_date ?? 'tbd'}-${div.dividend_type ?? 'na'}-${i}`}>
                              <td>
                                <Link to={`/stocks/${encodeURIComponent(div.ticker)}`} style={{ color: 'var(--v2)', textDecoration: 'none', fontWeight: 700 }}>
                                  {div.name || div.ticker}
                                </Link>
                                {div.dividend_type && (
                                  <span style={{ display: 'block', color: 'var(--muted)', fontSize: 11 }}>
                                    {div.dividend_type}
                                  </span>
                                )}
                              </td>
                              <td style={{ fontFamily: "'Fira Code', monospace", color: 'var(--muted)' }}>
                                {formatDate(div.ex_date, locale, { month: 'short', day: 'numeric' })}
                              </td>
                              <td style={{ fontFamily: "'Fira Code', monospace" }}>
                                {payoutDisplayDate ? formatDate(payoutDisplayDate, locale, { month: 'short', day: 'numeric' }) : 'TBD'}
                              </td>
                              <td style={{ fontFamily: "'Fira Code', monospace", textAlign: 'right' }}>
                                {formatCurrency(div.amount_per_share, locale, div.currency)}
                              </td>
                              <td style={{ textAlign: 'right' }}>
                                <span style={{ color: 'var(--green)', fontWeight: 700, fontFamily: "'Fira Code', monospace" }}>
                                  {displayedTotal !== null ? formatCurrency(displayedTotal, locale, displayCurrency) : '-'}
                                </span>
                                {displayedTotal !== null && div.currency !== displayCurrency && (
                                  <span style={{ display: 'block', fontSize: 11, color: 'var(--muted)', fontFamily: "'Fira Code', monospace" }}>
                                    {formatCurrency(div.total_amount, locale, div.currency)}
                                  </span>
                                )}
                              </td>
                              <td>
                                <span className={div.source === 'avanza' ? 'badge badge-green' : 'badge badge-violet'}>
                                  {div.source === 'avanza' ? 'Avanza' : 'Yahoo'}
                                </span>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  )
}
