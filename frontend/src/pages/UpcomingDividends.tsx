import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { api, UpcomingDividend } from '../services/api'
import { useSettings } from '../SettingsContext'
import { getLocaleForLanguage, t } from '../i18n'
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
 * Produce a localized month label from a year-month key.
 *
 * @param monthKey - Year-month key in the format `YYYY-MM`
 * @param locale - BCP 47 locale identifier used for formatting (for example `sv-SE`)
 * @returns A locale-formatted month label (e.g., `March 2026`)
 */
function formatMonthLabel(monthKey: string, locale: string): string {
  const [year, month] = monthKey.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, 1))
  return date.toLocaleDateString(locale, { year: 'numeric', month: 'long', timeZone: 'UTC' })
}

function getDaysInYear(year: number): number {
  const start = Date.UTC(year, 0, 1)
  const end = Date.UTC(year + 1, 0, 1)
  return Math.round((end - start) / (1000 * 60 * 60 * 24))
}

/**
 * Displays the current year's dividend payments for the user's portfolio.
 *
 * Renders loading and error states, fetches data on mount and refresh, and groups dividend rows by month using the dashboard-style table layout.
 *
 * @returns The component's rendered JSX containing the current-year dividends UI
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
  const [exchangeRates, setExchangeRates] = useState<Record<string, number | null>>({})
  const [unmappedStocks, setUnmappedStocks] = useState<Array<{ ticker: string; name: string | null; reason: string }>>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshError, setRefreshError] = useState<string | null>(null)

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
      const rates = await api.market.exchangeRates().catch(() => ({}))
      setExchangeRates(rates)
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

  if (loading) {
    return <div style={{ textAlign: 'center', padding: '40px' }}>{t(language, 'upcoming.loading')}</div>
  }

  if (error) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: '40px' }}>
        <p style={{ color: 'var(--text-secondary)' }}>{error}</p>
        <button className="btn btn-primary" onClick={() => fetchData(true)} style={{ marginTop: '16px' }}>
          {t(language, 'common.retry')}
        </button>
      </div>
    )
  }

  const groupedByMonth = dividends.reduce((acc, div) => {
    const key = getMonthKey(div.payout_date ?? div.payment_date ?? div.ex_date)
    if (!acc[key]) {
      acc[key] = []
    }
    acc[key].push(div)
    return acc
  }, {} as Record<string, UpcomingDividend[]>)

  const getDisplayedDividendTotal = (item: UpcomingDividend): number | null => {
    if (item.total_converted !== null) {
      return item.total_converted
    }
    if (item.currency === displayCurrency) {
      return item.total_amount
    }

    const direct = exchangeRates[`${item.currency}_${displayCurrency}`]
    if (direct != null) {
      return item.total_amount * direct
    }

    const inverse = exchangeRates[`${displayCurrency}_${item.currency}`]
    if (inverse != null && inverse !== 0) {
      return item.total_amount / inverse
    }

    return null
  }

  const monthlyGroups = Object.entries(groupedByMonth)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([monthKey, items]) => ({
      monthKey,
      items,
      subtotal: items.some((item) => getDisplayedDividendTotal(item) === null)
        ? null
        : items.reduce((acc, item) => acc + (getDisplayedDividendTotal(item) ?? 0), 0),
    }))

  const daysInYear = getDaysInYear(currentYear)
  const averagePerQuarterThisYear = totalExpected / 4
  const averagePerMonthThisYear = totalExpected / 12
  const averagePerDayThisYear = totalExpected / daysInYear

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
         <h2 style={{ fontSize: '24px', fontWeight: '600' }}>{t(language, 'upcoming.titleWithYear', { year: currentYear })}</h2>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
           <Link to="/dividends/history" style={{ color: 'var(--accent-blue)', textDecoration: 'none', fontSize: '14px' }}>
             {t(language, 'upcoming.viewHistory')} →
           </Link>
          <button className="btn btn-primary" onClick={() => fetchData(false)} disabled={refreshing}>
            {refreshing ? t(language, 'common.refreshing') : t(language, 'common.refresh')}
          </button>
        </div>
      </div>

      {refreshError && (
        <div className="card" style={{ marginBottom: '16px', borderLeft: '4px solid var(--accent-orange)' }}>
          <p style={{ margin: 0, color: 'var(--text-secondary)' }}>{refreshError}</p>
        </div>
      )}

      {unmappedStocks.length > 0 && (
        <div className="card" style={{ marginBottom: '24px', borderLeft: '4px solid var(--accent-orange)' }}>
          <h3 style={{ fontSize: '16px', marginBottom: '12px', color: 'var(--accent-orange)' }}>
            {t(language, 'upcoming.unmappedTitle', { count: unmappedStocks.length })}
          </h3>
          <p style={{ fontSize: '14px', color: 'var(--text-secondary)', marginBottom: '12px' }}>
            {t(language, 'upcoming.unmappedDescription')}
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
            {unmappedStocks.slice(0, 5).map((stock) => (
              <span
                key={stock.ticker}
                style={{
                  padding: '6px 12px',
                  fontSize: '13px',
                  background: 'var(--bg-tertiary)',
                  border: '1px solid var(--border-color)',
                  borderRadius: '4px',
                }}
              >
                {stock.name || stock.ticker}
              </span>
            ))}
            {unmappedStocks.length > 5 && (
              <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                +{unmappedStocks.length - 5} {t(language, 'upcoming.more')}
              </span>
            )}
            <Link 
              to="/settings" 
              style={{ 
                marginLeft: '8px',
                fontSize: '14px',
                color: 'var(--accent-blue)',
                textDecoration: 'underline'
              }}
            >
              {t(language, 'upcoming.mapInSettings')}
            </Link>
          </div>
        </div>
      )}

      {dividends.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '40px' }}>
          <p style={{ color: 'var(--text-secondary)' }}>{t(language, 'upcoming.noneFound')}</p>
        </div>
      ) : (
        <>
          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px' }}>
              <div>
                <h3 style={{ margin: 0 }}>{t(language, 'upcoming.totalExpected')}</h3>
                <div style={{ display: 'flex', gap: '20px', marginTop: '12px', fontSize: '13px', flexWrap: 'wrap' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>
                    {t(language, 'dashboard.received')}: <strong style={{ color: 'var(--accent-green)' }}>{formatCurrency(totalReceived, locale, displayCurrency)}</strong>
                  </span>
                  <span style={{ color: 'var(--text-secondary)' }}>
                    {t(language, 'dashboard.remaining')}: <strong style={{ color: 'var(--accent-blue)' }}>{formatCurrency(totalRemaining, locale, displayCurrency)}</strong>
                  </span>
                  <span style={{ color: 'var(--text-secondary)' }}>
                    {t(language, 'upcoming.perQuarter')} ({t(language, 'upcoming.averageThisYear')}): <strong style={{ color: 'var(--text-primary)' }}>{formatCurrency(averagePerQuarterThisYear, locale, displayCurrency)}</strong>
                  </span>
                  <span style={{ color: 'var(--text-secondary)' }}>
                    {t(language, 'upcoming.perMonth')} ({t(language, 'upcoming.averageThisYear')}): <strong style={{ color: 'var(--text-primary)' }}>{formatCurrency(averagePerMonthThisYear, locale, displayCurrency)}</strong>
                  </span>
                  <span style={{ color: 'var(--text-secondary)' }}>
                    {t(language, 'upcoming.perDay')} ({t(language, 'upcoming.averageThisYear')}): <strong style={{ color: 'var(--text-primary)' }}>{formatCurrency(averagePerDayThisYear, locale, displayCurrency)}</strong>
                  </span>
                </div>
              </div>
              <span style={{ color: 'var(--accent-green)', fontWeight: '600', fontSize: '18px' }}>
                {formatCurrency(totalExpected, locale, displayCurrency)}
              </span>
            </div>

            {monthlyGroups.map((group) => (
              <div key={group.monthKey} style={{ marginBottom: '24px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                  <h4 style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '14px' }}>{formatMonthLabel(group.monthKey, locale)}</h4>
                  <span style={{ color: 'var(--accent-green)', fontWeight: '600' }}>
                    {group.subtotal !== null ? formatCurrency(group.subtotal, locale, displayCurrency) : '-'}
                  </span>
                </div>

                <table style={{ width: '100%', tableLayout: 'fixed' }}>
                  <thead>
                    <tr>
                      <th style={{ width: '24%' }}>{t(language, 'performance.name')}</th>
                      <th style={{ width: '16%' }}>{t(language, 'dashboard.exDate')}</th>
                      <th style={{ width: '18%' }}>{t(language, 'dashboard.dividendDate')}</th>
                      <th style={{ width: '16%', textAlign: 'right' }}>{t(language, 'dashboard.perShare')}</th>
                      <th style={{ width: '14%', textAlign: 'right' }}>{t(language, 'dashboard.total')}</th>
                      <th style={{ width: '12%' }}>{t(language, 'dashboard.source')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.items.map((div, i) => {
                      const displayedTotal = getDisplayedDividendTotal(div)
                      const payoutDisplayDate = div.payout_date ?? div.payment_date ?? div.ex_date

                      return (
                        <tr key={`${div.ticker}-${div.ex_date}-${div.payment_date ?? 'na'}-${div.dividend_type ?? 'na'}-${i}`}>
                          <td>
                            <Link to={`/stocks/${div.ticker}`} style={{ color: 'var(--accent-blue)', textDecoration: 'none', fontWeight: '600' }}>
                              {div.name || div.ticker}
                            </Link>
                            {div.dividend_type && (
                              <span style={{ display: 'block', color: 'var(--text-secondary)', fontSize: '11px' }}>
                                {div.dividend_type}
                              </span>
                            )}
                          </td>
                          <td>{formatDate(div.ex_date, locale, { month: 'short', day: 'numeric' })}</td>
                          <td>{formatDate(payoutDisplayDate, locale, { month: 'short', day: 'numeric' })}</td>
                          <td style={{ textAlign: 'right' }}>{formatCurrency(div.amount_per_share, locale, div.currency)}</td>
                          <td style={{ textAlign: 'right' }}>
                            <span style={{ color: 'var(--accent-green)', fontWeight: '600' }}>
                              {displayedTotal !== null
                                ? formatCurrency(displayedTotal, locale, displayCurrency)
                                : '-'}
                            </span>
                            {displayedTotal !== null && div.currency !== displayCurrency && (
                              <span style={{ display: 'block', fontSize: '11px', color: 'var(--text-secondary)' }}>
                                {formatCurrency(div.total_amount, locale, div.currency)}
                              </span>
                            )}
                          </td>
                          <td>
                            <span style={{
                              padding: '2px 8px',
                              borderRadius: '4px',
                              fontSize: '11px',
                              fontWeight: '600',
                              background: div.source === 'avanza' ? 'var(--accent-green)' : 'var(--accent-blue)',
                              color: 'white'
                            }}>
                              {div.source === 'avanza' ? 'Avanza' : 'Yahoo'}
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
        </>
      )}
    </div>
  )
}
