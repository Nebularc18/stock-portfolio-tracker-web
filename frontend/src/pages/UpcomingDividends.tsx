import { useState, useEffect } from 'react'
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
 * Format a "YYYY-MM-DD" date string into a locale-specific date with numeric year, short month, and day.
 *
 * @param dateStr - Date in `YYYY-MM-DD` format (year, month, day). Time is treated as UTC.
 * @param locale - BCP 47 locale string used for formatting (for example `sv-SE` or `en-US`).
 * @returns A localized date string with numeric year, short month name, and day (for example `1 Jan 2025` or `1 jan. 2025` depending on `locale`)
 */
function formatDate(dateStr: string, locale: string): string {
  const [year, month, day] = dateStr.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })
}

/**
 * Calculates the number of days from today until the given date.
 *
 * @param dateStr - Date in `YYYY-MM-DD` format.
 * @returns The number of days from today to `dateStr`; `0` if the date is today, positive if in the future, negative if in the past.
 */
function getDaysUntil(dateStr: string): number {
  const [year, month, day] = dateStr.split('-').map(Number)
  const target = new Date(year, month - 1, day)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  target.setHours(0, 0, 0, 0)
  return Math.ceil((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
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

/**
 * Displays a list of upcoming dividend payments for the user's portfolio, including a summary, per-stock details, unmapped-stock warnings, and controls to refresh or retry loading.
 *
 * Renders loading and error states, fetches data on mount and when the user triggers a refresh, and shows converted totals when available.
 *
 * @returns The component's rendered JSX containing the upcoming dividends UI
 */
export default function UpcomingDividends() {
  const { language } = useSettings()
  const locale = getLocaleForLanguage(language)
  const [dividends, setDividends] = useState<UpcomingDividend[]>([])
  const [totalExpected, setTotalExpected] = useState(0)
  const [displayCurrency, setDisplayCurrency] = useState('SEK')
  const [exchangeRates, setExchangeRates] = useState<Record<string, number | null>>({})
  const [unmappedStocks, setUnmappedStocks] = useState<Array<{ ticker: string; name: string | null; reason: string }>>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchData()
  }, [])

  const fetchData = async () => {
    try {
      setLoading(true)
      setError(null)
      const data = await api.portfolio.upcomingDividends()
      setDividends(data.dividends)
      setTotalExpected(data.total_expected)
      setDisplayCurrency(data.display_currency)
      setUnmappedStocks(data.unmapped_stocks)
      const rates = await api.market.exchangeRates().catch(() => ({}))
      setExchangeRates(rates)
    } catch (err) {
      console.error('Failed to fetch upcoming dividends:', err)
      setError(t(language, 'upcoming.failedLoad'))
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return <div style={{ textAlign: 'center', padding: '40px' }}>{t(language, 'upcoming.loading')}</div>
  }

  if (error) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: '40px' }}>
        <p style={{ color: 'var(--text-secondary)' }}>{error}</p>
        <button onClick={fetchData} style={{ marginTop: '16px' }}>{t(language, 'common.retry')}</button>
      </div>
    )
  }

  const groupedByMonth = dividends.reduce((acc, div) => {
    const key = getMonthKey(div.ex_date)
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
      subtotal: items.reduce((sum, item) => {
        const displayedTotal = getDisplayedDividendTotal(item)
        return displayedTotal === null ? sum : sum + displayedTotal
      }, 0),
    }))

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <h2 style={{ fontSize: '24px', fontWeight: '600' }}>{t(language, 'upcoming.title')}</h2>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          <Link to="/dividends/history" style={{ color: 'var(--accent-blue)', textDecoration: 'none', fontSize: '14px' }}>
            {t(language, 'upcoming.viewHistory')} →
          </Link>
          <button onClick={fetchData} style={{ padding: '8px 16px' }}>{t(language, 'common.refresh')}</button>
        </div>
      </div>

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
                {stock.ticker}
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
          <div className="card" style={{ marginBottom: '24px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <h3 style={{ fontSize: '16px', color: 'var(--text-secondary)' }}>{t(language, 'upcoming.totalExpected')}</h3>
                <span style={{ fontSize: '28px', fontWeight: '600', color: 'var(--accent-green)' }}>
                  {formatCurrency(totalExpected, locale, displayCurrency)}
                </span>
              </div>
              <div style={{ textAlign: 'right' }}>
                <h3 style={{ fontSize: '16px', color: 'var(--text-secondary)' }}>{t(language, 'upcoming.upcomingPayments')}</h3>
                <span style={{ fontSize: '28px', fontWeight: '600' }}>{dividends.length}</span>
              </div>
            </div>
          </div>

          <div className="card">
            {monthlyGroups.map((group) => (
              <div key={group.monthKey} style={{ marginBottom: '24px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                  <h3 style={{ fontSize: '18px', margin: 0 }}>{formatMonthLabel(group.monthKey, locale)}</h3>
                  <span style={{ color: 'var(--accent-green)', fontWeight: '600' }}>
                    {formatCurrency(group.subtotal, locale, displayCurrency)}
                  </span>
                </div>

                <table>
                  <thead>
                    <tr>
                      <th>{t(language, 'upcoming.stock')}</th>
                      <th>{t(language, 'upcoming.exDate')}</th>
                      <th>{t(language, 'upcoming.dividendDate')}</th>
                      <th>{t(language, 'upcoming.perShare')}</th>
                      <th>{t(language, 'upcoming.quantity')}</th>
                      <th>{t(language, 'upcoming.total')}</th>
                      <th>{t(language, 'upcoming.source')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.items.map((div, i) => {
                      const daysUntil = getDaysUntil(div.ex_date)
                      const isSoon = daysUntil <= 7 && daysUntil >= 0
                      const displayedTotal = getDisplayedDividendTotal(div)

                      return (
                        <tr key={`${div.ticker}-${div.ex_date}-${div.payment_date ?? 'na'}-${div.dividend_type ?? 'na'}-${i}`}>
                          <td>
                            <Link to={`/stocks/${div.ticker}`} style={{ color: 'var(--accent-blue)', textDecoration: 'none', fontWeight: '600' }}>
                              {div.ticker}
                            </Link>
                            <span style={{ color: 'var(--text-secondary)', marginLeft: '8px', fontSize: '12px' }}>
                              {div.name}
                            </span>
                            {div.dividend_type && (
                              <span style={{ display: 'block', color: 'var(--text-secondary)', fontSize: '11px' }}>
                                {div.dividend_type}
                              </span>
                            )}
                          </td>
                          <td>
                            <span style={{
                              color: isSoon ? 'var(--accent-orange)' : 'inherit',
                              fontWeight: isSoon ? '600' : 'normal'
                            }}>
                              {formatDate(div.ex_date, locale)}
                            </span>
                            {daysUntil >= 0 && daysUntil <= 30 && (
                              <span style={{
                                display: 'block',
                                fontSize: '11px',
                                color: 'var(--text-secondary)'
                              }}>
                                {daysUntil === 0
                                  ? t(language, 'upcoming.today')
                                  : t(language, 'upcoming.inDays', {
                                      count: daysUntil,
                                      dayLabel: t(language, daysUntil > 1 ? 'upcoming.days' : 'upcoming.day'),
                                    })}
                              </span>
                            )}
                          </td>
                          <td>{div.payment_date ? formatDate(div.payment_date, locale) : '-'}</td>
                          <td>{formatCurrency(div.amount_per_share, locale, div.currency)}</td>
                          <td>{div.quantity}</td>
                          <td>
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
