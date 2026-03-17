import { useState, useEffect, useMemo, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { api, Dividend, Stock } from '../services/api'
import { getLocaleForLanguage, t, type Language } from '../i18n'
import { useSettings } from '../SettingsContext'
import { getQuantityHeldOnDate } from '../utils/positions'
import SortableHeader from '../components/SortableHeader'
import { sortTableItems, useTableSort } from '../utils/tableSort'

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

function getMissingConversionMessage(language: Language, currencies: string[]): string {
  const uniqueCurrencies = [...new Set(currencies)].sort().join(', ')
  return t(language, 'history.conversionMissing', { currencies: uniqueCurrencies })
}

interface DividendWithStock {
  ticker: string
  name: string | null
  currency: string
  quantity: number
  purchaseDate: string | null
  date: string
  paymentDate: string
  amount: number
  dividendCurrency: string
  dividendType: string | null
}

interface YearlyData {
  total: number
  months: Record<number, DividendWithStock[]>
}

type SortField = 'name' | 'date' | 'perShare' | 'totalSek'

const DIVIDEND_BATCH_SIZE = 25
const MAX_DIVIDEND_YEARS = 10

/**
 * Display a yearly and monthly breakdown of historical dividends with per-share values and totals converted to SEK, and provide a selector to choose the year.
 *
 * @returns A React element containing the dividend history UI, including empty states when no stocks or no data for the selected year.
 */
export default function HistoricalDividends() {
  const { language } = useSettings()
  const locale = getLocaleForLanguage(language)
  const [stocks, setStocks] = useState<Stock[]>([])
  const [exchangeRatesByDate, setExchangeRatesByDate] = useState<Record<string, Record<string, number | null>>>({})
  const [loading, setLoading] = useState(true)
  const [selectedYear, setSelectedYear] = useState<number>(new Date().getFullYear() - 1)
  const [dividendsByYear, setDividendsByYear] = useState<Record<number, YearlyData>>({})
  const [availableYears, setAvailableYears] = useState<number[]>([])
  const [dividendsPartialLoad, setDividendsPartialLoad] = useState(false)
  const [dividendsLoadFailed, setDividendsLoadFailed] = useState(false)
  const [showDividendRangeWarning, setShowDividendRangeWarning] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const { sortState, requestSort } = useTableSort<SortField>({ field: 'name', direction: 'asc' })

  const loadStocks = useCallback(async () => {
    try {
      setFetchError(null)
      setLoading(true)
      const stocksData = await api.stocks.list()
      setStocks(stocksData)
    } catch (err) {
      console.error('Failed to load data:', err)
      setFetchError(t(language, 'history.failedLoadData'))
    } finally {
      setLoading(false)
    }
  }, [language])

  useEffect(() => {
    loadStocks()
  }, [loadStocks])

  useEffect(() => {
    if (stocks.length === 0) {
      setDividendsByYear({})
      setAvailableYears([])
      setExchangeRatesByDate({})
      setDividendsPartialLoad(false)
      setDividendsLoadFailed(false)
      setShowDividendRangeWarning(false)
      return
    }

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
        }, Number.POSITIVE_INFINITY)
        const isSynthetic = earliestPurchaseYear === Number.POSITIVE_INFINITY
        const resolvedEarliestPurchaseYear = isSynthetic
          ? currentYear - (MAX_DIVIDEND_YEARS - 1)
          : earliestPurchaseYear
        const yearsToFetch = Math.max(1, currentYear - resolvedEarliestPurchaseYear + 1)
        setShowDividendRangeWarning(isSynthetic || yearsToFetch > MAX_DIVIDEND_YEARS)

        const dividendBatchResults = stocks.length > 0
          ? await Promise.allSettled(
              Array.from({ length: Math.ceil(stocks.length / DIVIDEND_BATCH_SIZE) }, (_, index) => {
                const batch = stocks.slice(index * DIVIDEND_BATCH_SIZE, (index + 1) * DIVIDEND_BATCH_SIZE)
                return api.stocks.dividendsForTickers(batch.map((stock) => stock.ticker), Math.min(yearsToFetch, MAX_DIVIDEND_YEARS))
              })
            )
          : []

        const successfulDividendBatches = dividendBatchResults.filter(
          (result): result is PromiseFulfilledResult<Record<string, Dividend[]>> => result.status === 'fulfilled'
        )
        const failedDividendBatches = dividendBatchResults.length - successfulDividendBatches.length

        if (failedDividendBatches > 0) {
          setDividendsPartialLoad(true)
          dividendBatchResults.forEach((result) => {
            if (result.status === 'rejected') {
              console.error('Failed to fetch dividend history batch:', result.reason)
            }
          })
        }

        if (dividendBatchResults.length > 0 && successfulDividendBatches.length === 0) {
          setDividendsLoadFailed(true)
          setDividendsByYear({})
          setAvailableYears([])
          setExchangeRatesByDate({})
          return
        }

        const dividendsByTicker = Object.assign({}, ...successfulDividendBatches.map((result) => result.value))

        const allDividends: DividendWithStock[] = stocks.flatMap((stock) => {
          const stockDividends = (dividendsByTicker[stock.ticker] || []) as Dividend[]
          return stockDividends.flatMap((div: Dividend) => {
            const quantityHeld = getQuantityHeldOnDate(stock.position_entries || [], div.date, stock.quantity)
            if (quantityHeld <= 0) {
              return []
            }
            return [{
              ticker: stock.ticker,
              name: stock.name,
              currency: stock.currency,
              quantity: quantityHeld,
              purchaseDate: stock.purchase_date,
              date: div.date,
              paymentDate: div.payment_date ?? div.date,
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
            div.paymentDate,
            div.amount,
            div.dividendCurrency,
            div.dividendType || '',
          ].join('|')
          if (!uniqueDividendMap.has(uniqueKey)) {
            uniqueDividendMap.set(uniqueKey, div)
          }
        }

        const payoutDates = Array.from(new Set(
          Array.from(uniqueDividendMap.values())
            .map((div) => div.paymentDate)
            .filter(Boolean)
        ))

        if (payoutDates.length > 0) {
          try {
            const ratesByDate = await api.market.exchangeRatesBatch(payoutDates)
            setExchangeRatesByDate(ratesByDate)
          } catch (err) {
            console.error('Failed to fetch historical dividend FX rates:', err)
            setExchangeRatesByDate({})
            setDividendsPartialLoad(true)
          }
        } else {
          setExchangeRatesByDate({})
        }

        for (const div of uniqueDividendMap.values()) {
          if (!div.date || div.date > todayIso) {
            continue
          }
          const [yearPart, monthPart] = div.date.split('-')
          const year = Number(yearPart)
          const month = Number(monthPart)
          if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
            continue
          }
          if (!byYear[year]) {
            byYear[year] = { total: 0, months: {} }
          }
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

  const convertToSEK = (amount: number, currency: string, paymentDate: string): number | null => {
    if (currency === 'SEK') return amount
    const rate = exchangeRatesByDate[paymentDate]?.[`${currency}_SEK`]
    if (rate != null) return amount * rate
    return null
  }

  const yearData = dividendsByYear[selectedYear]
  const sortedMonths = yearData?.months ? Object.keys(yearData.months).map(Number).sort((a, b) => a - b) : []

  const hasStocks = stocks.length > 0
  const hasAnyDividendHistory = useMemo(() => Object.keys(dividendsByYear).length > 0, [dividendsByYear])

  let yearTotalSEK: number | null = 0
  let yearHasConvertedValues = false
  const yearMissingCurrencies = new Set<string>()
  if (yearData) {
    for (const monthDivs of Object.values(yearData.months)) {
      for (const div of monthDivs) {
        const converted = convertToSEK(div.amount * div.quantity, div.dividendCurrency, div.paymentDate)
        if (converted === null) {
          yearMissingCurrencies.add(div.dividendCurrency)
          continue
        }
        yearHasConvertedValues = true
        yearTotalSEK += converted
      }
    }
    if (!yearHasConvertedValues || yearMissingCurrencies.size > 0) {
      yearTotalSEK = null
    }
  }

  if (loading && stocks.length === 0) {
    return <div className="loading-state">{t(language, 'history.loading')}</div>
  }

  if (fetchError && stocks.length === 0) {
    return (
      <div style={{ padding: 28 }}>
        <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, padding: '32px', textAlign: 'center' }}>
          <p role="alert" aria-live="assertive" aria-atomic="true" style={{ color: 'var(--red)', marginBottom: 16 }}>{fetchError}</p>
          <button className="btn btn-primary" onClick={loadStocks}>
            {t(language, 'common.retry')}
          </button>
        </div>
      </div>
    )
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
                {yearTotalSEK !== null
                  ? formatCurrency(yearTotalSEK, locale, 'SEK')
                  : getMissingConversionMessage(language, Array.from(yearMissingCurrencies))}
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
        {fetchError && (
          <div style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: 8, padding: '12px 16px', marginTop: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
            <p role="alert" aria-live="assertive" aria-atomic="true" style={{ color: 'var(--red)', fontSize: 13, margin: 0 }}>{fetchError}</p>
            <button className="btn btn-primary" onClick={loadStocks}>{t(language, 'common.retry')}</button>
          </div>
        )}
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
        {!dividendsLoadFailed && showDividendRangeWarning && (
          <div style={{ background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.25)', borderRadius: 8, padding: '12px 16px', marginTop: 12 }}>
            <p style={{ color: 'var(--amber)', fontSize: 13 }}>
              {t(language, 'history.rangeWarning', { years: MAX_DIVIDEND_YEARS })}
            </p>
          </div>
        )}
        {loading ? (
          <div className="loading-state" style={{ paddingTop: 60 }}>{t(language, 'history.loading')}</div>
        ) : !hasStocks ? (
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
              let monthTotalSEK: number | null = 0
              let monthHasConvertedValues = false
              const monthMissingCurrencies = new Set<string>()
              for (const div of monthDivs) {
                const converted = convertToSEK(div.amount * div.quantity, div.dividendCurrency, div.paymentDate)
                if (converted === null) {
                  monthMissingCurrencies.add(div.dividendCurrency)
                  continue
                }
                monthHasConvertedValues = true
                monthTotalSEK += converted
              }
              if (!monthHasConvertedValues || monthMissingCurrencies.size > 0) {
                monthTotalSEK = null
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
                      {monthTotalSEK !== null
                        ? formatCurrency(monthTotalSEK, locale, 'SEK')
                        : getMissingConversionMessage(language, Array.from(monthMissingCurrencies))}
                    </span>
                  </div>

                  <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8 }}>
                    <table>
                      <thead>
                        <tr>
                          <SortableHeader field="name" label={t(language, 'performance.name')} sortState={sortState} onSort={requestSort} />
                          <SortableHeader field="date" label={t(language, 'history.date')} sortState={sortState} onSort={requestSort} />
                          <SortableHeader field="perShare" label={t(language, 'history.perShare')} sortState={sortState} onSort={requestSort} align="right" />
                          <SortableHeader field="totalSek" label={t(language, 'history.totalSek')} sortState={sortState} onSort={requestSort} align="right" />
                        </tr>
                      </thead>
                      <tbody>
                        {sortTableItems(
                          monthDivs,
                          sortState,
                          {
                            name: (div) => div.name || div.ticker,
                            date: (div) => div.date,
                            perShare: (div) => div.amount,
                            totalSek: (div) => convertToSEK(div.amount * div.quantity, div.dividendCurrency, div.paymentDate),
                          },
                          locale,
                          (div) => div.ticker
                        ).map((div) => {
                            const totalSEK = convertToSEK(div.amount * div.quantity, div.dividendCurrency, div.paymentDate)
                            const rowKey = [
                              div.ticker,
                              div.date,
                              div.paymentDate,
                              div.amount,
                              div.dividendCurrency,
                              div.dividendType ?? 'none',
                            ].join('|')
                            return (
                              <tr key={rowKey}>
                                 <td>
                                    <Link to={`/stocks/${encodeURIComponent(div.ticker)}`} style={{ color: 'var(--v2)', textDecoration: 'none', fontWeight: 700 }}>
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
