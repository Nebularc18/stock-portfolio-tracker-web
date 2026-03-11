import { useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { api, Dividend, Stock } from '../services/api'
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

function getMissingConversionMessage(language: string, currencies: string[]): string {
  const uniqueCurrencies = [...new Set(currencies)].sort().join(', ')
  return language === 'sv'
    ? `Konvertering saknas för ${uniqueCurrencies}`
    : `Conversion missing for ${uniqueCurrencies}`
}

interface DividendWithStock {
  ticker: string
  name: string | null
  currency: string
  quantity: number
  purchaseDate: string | null
  date: string
  amount: number
  dividendCurrency: string
  dividendType: string | null
}

interface YearlyData {
  total: number
  months: Record<number, DividendWithStock[]>
}

const DIVIDEND_BATCH_SIZE = 25

/**
 * Display a yearly and monthly breakdown of historical dividends with per-share values and totals converted to SEK, and provide a selector to choose the year.
 *
 * @returns A React element containing the dividend history UI, including empty states when no stocks or no data for the selected year.
 */
export default function HistoricalDividends() {
  const { language } = useSettings()
  const locale = getLocaleForLanguage(language)
  const [stocks, setStocks] = useState<Stock[]>([])
  const [exchangeRates, setExchangeRates] = useState<Record<string, number | null>>({})
  const [loading, setLoading] = useState(true)
  const [selectedYear, setSelectedYear] = useState<number>(new Date().getFullYear() - 1)
  const [dividendsByYear, setDividendsByYear] = useState<Record<number, YearlyData>>({})
  const [availableYears, setAvailableYears] = useState<number[]>([])
  const [dividendsPartialLoad, setDividendsPartialLoad] = useState(false)
  const [dividendsLoadFailed, setDividendsLoadFailed] = useState(false)

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
      setDividendsPartialLoad(false)
      setDividendsLoadFailed(false)
      try {
        const todayIso = new Date().toISOString().slice(0, 10)
        const currentYear = new Date().getUTCFullYear()
        const earliestPurchaseYear = stocks.reduce((minYear, stock) => {
          if (!stock.purchase_date) return minYear
          const parsedYear = Number(stock.purchase_date.slice(0, 4))
          if (!Number.isFinite(parsedYear)) return minYear
          return Math.min(minYear, parsedYear)
        }, currentYear)
        const yearsToFetch = Math.max(1, currentYear - earliestPurchaseYear + 1)

        const dividendsByTicker = stocks.length > 0
          ? Object.assign({}, ...(await Promise.all(
            Array.from({ length: Math.ceil(stocks.length / DIVIDEND_BATCH_SIZE) }, (_, index) => {
              const batch = stocks.slice(index * DIVIDEND_BATCH_SIZE, (index + 1) * DIVIDEND_BATCH_SIZE)
              return api.stocks.dividendsForTickers(batch.map((stock) => stock.ticker), Math.min(yearsToFetch, 10))
                .catch((err) => {
                  console.error('Failed to fetch dividend history batch:', err)
                  setDividendsPartialLoad(true)
                  return {}
                })
            })
          )))
          : {}

        const allDividends: DividendWithStock[] = stocks.flatMap((stock) => {
          const stockDividends = (dividendsByTicker[stock.ticker] || []) as Dividend[]
          return stockDividends.flatMap((div: Dividend) => {
            if (stock.purchase_date && div.date < stock.purchase_date) {
              return []
            }
            return [{
              ticker: stock.ticker,
              name: stock.name,
              currency: stock.currency,
              quantity: stock.quantity,
              purchaseDate: stock.purchase_date,
              date: div.date,
              amount: div.amount,
              dividendCurrency: div.currency || stock.currency,
              dividendType: div.dividend_type || null,
            }]
          })
        })

        const byYear: Record<number, YearlyData> = {}
        
        const uniqueDividendMap = new Map<string, DividendWithStock>()
        for (const div of allDividends) {
          const uniqueKey = [
            div.ticker,
            div.date,
            div.amount,
            div.dividendCurrency,
            div.dividendType || '',
          ].join('|')
          if (!uniqueDividendMap.has(uniqueKey)) {
            uniqueDividendMap.set(uniqueKey, div)
          }
        }

        for (const div of uniqueDividendMap.values()) {
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

        const years = Object.keys(byYear).map(Number).sort((a, b) => b - a)
        setAvailableYears(years)
        if (years.length > 0) {
          setSelectedYear((currentSelectedYear) => (years.includes(currentSelectedYear) ? currentSelectedYear : years[0]))
        }
        setDividendsByYear(byYear)
      } catch (err) {
        console.error('Failed to fetch dividends:', err)
        setDividendsLoadFailed(true)
        setDividendsByYear({})
        setAvailableYears([])
      } finally {
        setLoading(false)
      }
    }

    fetchDividends()
  }, [stocks])

  const convertToSEK = (amount: number, currency: string): number | null => {
    if (currency === 'SEK') return amount
    const rate = exchangeRates[`${currency}_SEK`]
    if (rate != null) return amount * rate
    return null
  }

  const yearData = dividendsByYear[selectedYear]
  const sortedMonths = yearData?.months ? Object.keys(yearData.months).map(Number).sort((a, b) => a - b) : []

  const hasStocks = stocks.length > 0
  const hasAnyDividendHistory = useMemo(() => Object.keys(dividendsByYear).length > 0, [dividendsByYear])

  let yearTotalSEK = 0
  const yearMissingCurrencies = new Set<string>()
  if (yearData) {
    for (const monthDivs of Object.values(yearData.months)) {
      for (const div of monthDivs) {
        const converted = convertToSEK(div.amount * div.quantity, div.dividendCurrency)
        if (converted === null) {
          yearMissingCurrencies.add(div.dividendCurrency)
          continue
        }
        yearTotalSEK += converted
      }
    }
  }

  if (loading && stocks.length === 0) {
    return <div className="loading-state">{t(language, 'history.loading')}</div>
  }

  return (
    <div>
      {/* ── HERO HEADER ── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr auto',
        alignItems: 'center',
        borderBottom: '1px solid var(--border)',
        padding: '26px 28px',
        background: 'linear-gradient(115deg, #12141c 0%, var(--bg) 55%)',
        gap: 20,
      }}>
        <div>
          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 8 }}>
            {t(language, 'history.title')}
          </div>
          {yearData && (
            <>
              <div style={{ fontSize: 24, fontWeight: 800, letterSpacing: '-0.02em', color: 'var(--green)', fontFamily: "'Fira Code', monospace" }}>
                {formatCurrency(yearTotalSEK, locale, 'SEK')}
              </div>
              {yearMissingCurrencies.size > 0 && (
                <p style={{ color: 'var(--amber)', fontSize: 12, marginTop: 6 }}>
                  {getMissingConversionMessage(language, Array.from(yearMissingCurrencies))}
                </p>
              )}
            </>
          )}
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <label htmlFor="year-select" style={{ color: 'var(--muted)', fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
            {t(language, 'common.year')}
          </label>
          <select
            id="year-select"
            value={selectedYear}
            onChange={(e) => setSelectedYear(parseInt(e.target.value))}
          >
            {availableYears.map((year) => (
              <option key={year} value={year}>{year}</option>
            ))}
          </select>
        </div>
      </div>

      <div style={{ padding: '0 28px 28px' }}>
        {dividendsLoadFailed && (
          <div style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: 8, padding: '12px 16px', marginTop: 20 }}>
            <p style={{ color: 'var(--red)', fontSize: 13 }}>{t(language, 'history.failedLoadData')}</p>
          </div>
        )}
        {!dividendsLoadFailed && dividendsPartialLoad && (
          <div style={{ background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.25)', borderRadius: 8, padding: '12px 16px', marginTop: 20 }}>
            <p style={{ color: 'var(--amber)', fontSize: 13 }}>{t(language, 'history.partialLoadWarning')}</p>
          </div>
        )}
        {!hasStocks ? (
          <div className="empty-state" style={{ paddingTop: 60 }}>{t(language, 'history.noStocks')}</div>
        ) : dividendsLoadFailed ? (
          <div className="empty-state" style={{ paddingTop: 60 }}>{t(language, 'history.failedLoadData')}</div>
        ) : !hasAnyDividendHistory ? (
          <div className="empty-state" style={{ paddingTop: 60 }}>{t(language, 'history.noHistory')}</div>
        ) : !yearData || Object.keys(yearData.months).length === 0 ? (
          <div className="empty-state" style={{ paddingTop: 60 }}>{t(language, 'history.noDataYear', { year: selectedYear })}</div>
        ) : (
          <>
            {sortedMonths.map((month) => {
              const monthDivs = yearData.months[month]
              let monthTotal = 0
              const monthMissingCurrencies = new Set<string>()
              for (const div of monthDivs) {
                const converted = convertToSEK(div.amount * div.quantity, div.dividendCurrency)
                if (converted === null) {
                  monthMissingCurrencies.add(div.dividendCurrency)
                  continue
                }
                monthTotal += converted
              }

              return (
                <div key={month} style={{ marginTop: 20 }}>
                  {/* ── MONTH SECTION HEADER ── */}
                  <div className="sec-row">
                    <div>
                      <span className="sec-title">{getMonthName(month, locale)}</span>
                      {monthMissingCurrencies.size > 0 && (
                        <p style={{ color: 'var(--amber)', fontSize: 11, marginTop: 4 }}>
                          {getMissingConversionMessage(language, Array.from(monthMissingCurrencies))}
                        </p>
                      )}
                    </div>
                    <span style={{ fontFamily: "'Fira Code', monospace", fontSize: 13, fontWeight: 700, color: 'var(--green)' }}>
                      {formatCurrency(monthTotal, locale, 'SEK')}
                    </span>
                  </div>

                  <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8 }}>
                    <table>
                      <thead>
                        <tr>
                          <th>{t(language, 'performance.name')}</th>
                          <th>{t(language, 'history.date')}</th>
                          <th style={{ textAlign: 'right' }}>{t(language, 'history.perShare')}</th>
                          <th style={{ textAlign: 'right' }}>{t(language, 'history.totalSek')}</th>
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
                                   <Link to={`/stocks/${div.ticker}`} style={{ color: 'var(--v2)', textDecoration: 'none', fontWeight: 700 }}>
                                     {div.name || div.ticker}
                                   </Link>
                                   {div.dividendType && (
                                     <span className="badge badge-muted" style={{ marginLeft: 8 }}>
                                       {div.dividendType}
                                     </span>
                                   )}
                                 </td>
                                <td style={{ fontFamily: "'Fira Code', monospace", color: 'var(--muted)' }}>{div.date}</td>
                                <td style={{ fontFamily: "'Fira Code', monospace", textAlign: 'right' }}>
                                  {formatCurrency(div.amount, locale, div.dividendCurrency)}
                                </td>
                                 <td style={{ fontFamily: "'Fira Code', monospace", textAlign: 'right', color: 'var(--green)', fontWeight: 700 }}>
                                   {totalSEK !== null ? formatCurrency(totalSEK, locale, 'SEK') : getMissingConversionMessage(language, [div.dividendCurrency])}
                                 </td>
                              </tr>
                            )
                          })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )
            })}
          </>
        )}
      </div>
    </div>
  )
}
