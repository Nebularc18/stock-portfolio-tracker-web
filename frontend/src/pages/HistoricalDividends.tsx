import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { api, Stock } from '../services/api'
import { getLocaleForLanguage, t } from '../i18n'
import { useSettings } from '../SettingsContext'

/**
 * Produces the locale-formatted short name for a given month.
 *
 * @param month - The month number (1 = January, 12 = December)
 * @param locale - BCP 47 locale string used for formatting (e.g., "en-US")
 * @returns The short month name formatted for `locale` (for example, "Jan" or its localized equivalent)
 */
function getMonthName(month: number, locale: string): string {
  const date = new Date(Date.UTC(2000, month - 1, 1))
  return new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }).format(date)
}

/**
 * Format a numeric amount as a localized currency string.
 *
 * @param value - The numeric amount to format
 * @param locale - BCP 47 locale identifier used for number formatting (e.g., `"en-US"`, `"sv-SE"`)
 * @param currency - ISO 4217 currency code to display (defaults to `"USD"`)
 * @returns The localized currency string, showing at least two fraction digits
 */
function formatCurrency(value: number, locale: string, currency: string = 'USD'): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(value)
}

interface DividendWithStock {
  ticker: string
  name: string | null
  currency: string
  quantity: number
  date: string
  amount: number
  dividendCurrency: string
}

interface YearlyData {
  total: number
  months: Record<number, DividendWithStock[]>
}

/**
 * Render a historical dividend overview grouped by year and month, including per-share values and totals converted to SEK and a year selector.
 *
 * The component fetches portfolio stocks, exchange rates, and recent dividends, excludes dividends without a date or dated in the future, computes monthly and yearly totals (converted to SEK when exchange rates are available), and displays appropriate empty states when the portfolio is empty or the selected year has no data.
 *
 * @returns The rendered dividend history UI as a React element.
 */
export default function HistoricalDividends() {
  const { language } = useSettings()
  const locale = getLocaleForLanguage(language)
  const [stocks, setStocks] = useState<Stock[]>([])
  const [exchangeRates, setExchangeRates] = useState<Record<string, number | null>>({})
  const [loading, setLoading] = useState(true)
  const [selectedYear, setSelectedYear] = useState<number>(new Date().getFullYear())
  const [dividendsByYear, setDividendsByYear] = useState<Record<number, YearlyData>>({})
  const [availableYears, setAvailableYears] = useState<number[]>([])

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

  useEffect(() => {
    if (stocks.length === 0) return

    const fetchDividends = async () => {
      setLoading(true)
      try {
        const currentYear = new Date().getFullYear()
        const years = Array.from({ length: currentYear - 1999 }, (_, i) => currentYear - i)
        setAvailableYears(years)
        const todayIso = new Date().toISOString().slice(0, 10)

        const allDividends: DividendWithStock[] = []
        
        for (const stock of stocks) {
          try {
            const divs = await api.stocks.dividends(stock.ticker, 25)
            for (const div of divs) {
              allDividends.push({
                ticker: stock.ticker,
                name: stock.name,
                currency: stock.currency,
                quantity: stock.quantity,
                date: div.date,
                amount: div.amount,
                dividendCurrency: div.currency || stock.currency,
              })
            }
          } catch (err) {
            console.error(`Failed to fetch dividends for ${stock.ticker}:`, err)
          }
        }

        const byYear: Record<number, YearlyData> = {}
        
        for (const div of allDividends) {
          if (!div.date || div.date > todayIso) {
            continue
          }
          const year = parseInt(div.date.split('-')[0])
          if (!byYear[year]) {
            byYear[year] = { total: 0, months: {} }
          }
          const month = parseInt(div.date.split('-')[1])
          if (!byYear[year].months[month]) {
            byYear[year].months[month] = []
          }
          byYear[year].months[month].push(div)
        }

        setDividendsByYear(byYear)
      } catch (err) {
        console.error('Failed to fetch dividends:', err)
      } finally {
        setLoading(false)
      }
    }

    fetchDividends()
  }, [stocks])

  const convertToSEK = (amount: number, currency: string): number => {
    if (currency === 'SEK') return amount
    const rate = exchangeRates[`${currency}_SEK`]
    if (rate) return amount * rate
    return amount
  }

  const yearData = dividendsByYear[selectedYear]
  const sortedMonths = yearData?.months ? Object.keys(yearData.months).map(Number).sort((a, b) => a - b) : []

  let yearTotalSEK = 0
  if (yearData) {
    for (const monthDivs of Object.values(yearData.months)) {
      for (const div of monthDivs) {
        yearTotalSEK += convertToSEK(div.amount * div.quantity, div.dividendCurrency)
      }
    }
  }

  if (loading && stocks.length === 0) {
    return <div style={{ textAlign: 'center', padding: '40px' }}>{t(language, 'history.loading')}</div>
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <h2 style={{ fontSize: '24px', fontWeight: '600' }}>{t(language, 'history.title')}</h2>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          <label htmlFor="year-select" style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>{t(language, 'common.year')}:</label>
          <select
            id="year-select"
            value={selectedYear}
            onChange={(e) => setSelectedYear(parseInt(e.target.value))}
            style={{
              padding: '8px 12px',
              border: '1px solid var(--border-color)',
              borderRadius: '6px',
              background: 'var(--bg-tertiary)',
              color: 'var(--text-primary)',
              fontSize: '14px',
            }}
          >
            {availableYears.map((year) => (
              <option key={year} value={year}>
                {year}
              </option>
            ))}
          </select>
        </div>
      </div>

      {stocks.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '40px' }}>
          <p style={{ color: 'var(--text-secondary)' }}>{t(language, 'history.noStocks')}</p>
        </div>
      ) : !yearData || Object.keys(yearData.months).length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '40px' }}>
          <p style={{ color: 'var(--text-secondary)' }}>{t(language, 'history.noDataYear', { year: selectedYear })}</p>
        </div>
      ) : (
        <>
          <div className="card" style={{ marginBottom: '24px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ fontSize: '16px' }}>{t(language, 'history.totalYear', { year: selectedYear })}</h3>
              <span style={{ fontSize: '24px', fontWeight: '600', color: 'var(--accent-green)' }}>
                {formatCurrency(yearTotalSEK, locale, 'SEK')}
              </span>
            </div>
          </div>

          {sortedMonths.map((month) => {
            const monthDivs = yearData.months[month]
            let monthTotal = 0
            for (const div of monthDivs) {
              monthTotal += convertToSEK(div.amount * div.quantity, div.dividendCurrency)
            }

            return (
              <div key={month} className="card" style={{ marginBottom: '16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                  <h4 style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>{getMonthName(month, locale)}</h4>
                  <span style={{ color: 'var(--accent-green)', fontWeight: '600' }}>
                    {formatCurrency(monthTotal, locale, 'SEK')}
                  </span>
                </div>
                <table>
                  <thead>
                    <tr>
                      <th>{t(language, 'history.stock')}</th>
                      <th>{t(language, 'history.date')}</th>
                      <th>{t(language, 'history.perShare')}</th>
                      <th>{t(language, 'history.totalSek')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {monthDivs
                      .sort((a, b) => a.date.localeCompare(b.date))
                      .map((div, i) => {
                        const totalSEK = convertToSEK(div.amount * div.quantity, div.dividendCurrency)
                        return (
                          <tr key={`${div.ticker}-${i}`}>
                            <td>
                              <Link to={`/stocks/${div.ticker}`} style={{ color: 'var(--accent-blue)', textDecoration: 'none', fontWeight: '600' }}>
                                {div.ticker}
                              </Link>
                              <span style={{ color: 'var(--text-secondary)', marginLeft: '8px', fontSize: '12px' }}>
                                {div.name}
                              </span>
                            </td>
                            <td>{div.date}</td>
                            <td>{formatCurrency(div.amount, locale, div.dividendCurrency)}</td>
                            <td style={{ color: 'var(--accent-green)' }}>{formatCurrency(totalSEK, locale, 'SEK')}</td>
                          </tr>
                        )
                      })}
                  </tbody>
                </table>
              </div>
            )
          })}
        </>
      )}
    </div>
  )
}
