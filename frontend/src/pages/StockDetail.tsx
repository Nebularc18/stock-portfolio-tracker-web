import { useState, useEffect, useId, useRef, useCallback } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { api, Stock, Dividend, StockUpcomingDividend, UpcomingDividend, AnalystData, ManualDividend, CompanyProfile, FinancialMetrics, VerificationResult, MarketstackUsage } from '../services/api'
import CompanyProfileComponent from '../components/CompanyProfile'
import FinancialMetricsComponent from '../components/FinancialMetrics'
import PeerCompanies from '../components/PeerCompanies'
import YfinanceAnalystPanel from '../components/YfinanceAnalystPanel'
import { useSettings } from '../SettingsContext'
import { formatTimeInTimezone } from '../utils/time'
import { getLocaleForLanguage, t } from '../i18n'
import { useModalFocusTrap } from '../hooks/useModalFocusTrap'

/**
 * Format a numeric value as a localized currency string.
 *
 * @param value - The numeric value to format, or `null` to indicate a missing value
 * @param locale - BCP 47 locale identifier used for formatting (defaults to `'en-US'`)
 * @param currency - ISO 4217 currency code to use for formatting (defaults to `'USD'`)
 * @returns A localized currency string (for example, `"$1,234.56"`), or `'-'` when `value` is `null`
 */
function formatCurrency(value: number | null, locale: string = 'en-US', currency: string = 'USD'): string {
  if (value === null) return '-'
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
  }).format(value)
}

/**
 * Formats an ISO date string ("YYYY-MM-DD") into a locale-specific short date.
 *
 * @param dateStr - Date string in "YYYY-MM-DD" format; empty or falsy returns "`-`".
 * @param locale - BCP 47 locale tag used for formatting (e.g., "en-US").
 * @returns The date formatted with localized month, day, and year (e.g., "Mar 5, 2026"), "`-`" for missing input, or the original string if it cannot be parsed as a valid date.
 */
function formatDate(dateStr: string, locale: string): string {
  if (!dateStr) return '-'
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(dateStr)
  let date: Date

  if (isDateOnly) {
    const [year, month, day] = dateStr.split('-').map(Number)
    if (!year || !month || !day) return dateStr
    date = new Date(Date.UTC(year, month - 1, day))
  } else {
    const parsed = new Date(dateStr)
    if (Number.isNaN(parsed.getTime())) return dateStr
    date = parsed
  }

  return date.toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

function normalizeToDay(dateInput: string | null | undefined): Date | null {
  if (!dateInput) return null
  const normalized = dateInput.replace('Z', '+00:00')
  const parsed = new Date(normalized)
  if (!Number.isFinite(parsed.getTime())) return null
  parsed.setUTCHours(0, 0, 0, 0)
  return parsed
}

/**
 * Produce a normalized display name for a company, using the ticker when `name` is null.
 *
 * Removes a trailing "(The)" (case-insensitive), collapses consecutive whitespace into single spaces, and trims leading/trailing whitespace from `name` before returning it. If `name` is null, returns `ticker`.
 *
 * @param name - The company's full name, or `null` to indicate no name is available
 * @param ticker - The company's ticker symbol returned when `name` is `null`
 * @returns The cleaned company display name or the `ticker` when no name is provided
 */
function formatDisplayName(name: string | null, ticker: string): string {
  if (!name) return ticker
  return name
    .replace(/\s+\(The\)$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Estimate the typical number of dividend payments per year from a list of dividends.
 *
 * @param dividends - Array of dividend records; each record may include `payment_date` or `date` (ISO date string) used to determine the payment year.
 * @returns A number between 1 and 12 representing the estimated number of dividend payments per year.
 */
function estimateDividendsPerYear(dividends: Dividend[]): number {
  const countsByYear = new Map<number, number>()

  for (const div of dividends) {
    const payoutDate = div.payment_date || div.date
    if (!payoutDate) continue
    const year = Number(payoutDate.slice(0, 4))
    if (!Number.isFinite(year)) continue
    countsByYear.set(year, (countsByYear.get(year) || 0) + 1)
  }

  const recentCounts = Array.from(countsByYear.entries())
    .sort((a, b) => b[0] - a[0])
    .slice(0, 3)
    .map(([, count]) => count)
    .filter((count) => count > 0)

  if (recentCounts.length === 0) return 1

  const frequencyMap = new Map<number, number>()
  for (const count of recentCounts) {
    frequencyMap.set(count, (frequencyMap.get(count) || 0) + 1)
  }

  const [mostCommon] = Array.from(frequencyMap.entries()).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1]
    return b[0] - a[0]
  })

  const estimated = mostCommon?.[0] ?? recentCounts[0]
  return Math.max(1, Math.min(12, estimated))
}

/**
 * Converts a monetary value to Swedish krona (SEK) using provided exchange rates.
 *
 * @param amount - The monetary amount to convert; may be `null`.
 * @param currency - The ISO currency code of `amount` (e.g., `"USD"`, `"EUR"`).
 * @param safeRates - A lookup of exchange rates where keys are formatted as `"{FROM}_{TO}"` (e.g., `"USD_SEK"` or `"SEK_USD"`). Values are the numeric exchange rate or `null` if unavailable.
 * @returns The converted amount in SEK, or `null` if `amount` is `null` or no applicable exchange rate is found.
 */
function convertToSEKValue(
  amount: number | null,
  currency: string,
  safeRates: Record<string, number | null>
): number | null {
  if (amount === null) return null
  if (currency === 'SEK') return amount
  const direct = safeRates[`${currency}_SEK`]
  if (direct != null) return amount * direct
  const inverse = safeRates[`SEK_${currency}`]
  if (inverse != null && inverse !== 0) return amount / inverse
  return null
}

function recalculateYearlyDividendState(
  items: UpcomingDividend[],
  quantity: number,
  safeRates: Record<string, number | null>
): {
  yearDividends: UpcomingDividend[]
  yearReceived: number | null
  yearRemaining: number | null
} {
  const yearDividends = items.map((div) => {
    const totalAmount = (div.amount_per_share ?? 0) * quantity
    return {
      ...div,
      quantity,
      total_amount: totalAmount,
      total_converted: convertToSEKValue(totalAmount, div.currency, safeRates),
    }
  })

  const aggregateYearlyTotal = (targetStatus: 'paid' | 'upcoming'): number | null => {
    let total = 0
    let hasMissingConversion = false

    for (const div of yearDividends) {
      if (div.status !== targetStatus) continue
      if (div.total_converted === null) {
        hasMissingConversion = true
        continue
      }
      total += div.total_converted
    }

    return hasMissingConversion ? null : total
  }

  return {
    yearDividends,
    yearReceived: aggregateYearlyTotal('paid'),
    yearRemaining: aggregateYearlyTotal('upcoming'),
  }
}

/**
 * Renders a detailed view for a single stock and manages its related data and user actions.
 *
 * Shows overview, profile, dividends, and analyst tabs; loads stock, dividend, upcoming dividend,
 * suppressed dividend, Finnhub profile/metrics/peers, analyst data, and exchange rates; displays
 * locale- and timezone-aware currency and date values (including SEK conversions when rates are available);
 * and exposes UI actions to edit or delete the position, add/edit/delete manual dividends, suppress/restore
 * dividends, and verify dividend data with Marketstack.
 *
 * @returns The React element for the stock detail page.
 */
export default function StockDetail() {
  const { ticker } = useParams<{ ticker: string }>()
  const navigate = useNavigate()
  const [stock, setStock] = useState<Stock | null>(null)
  const [dividends, setDividends] = useState<Dividend[]>([])
  const [yearDividends, setYearDividends] = useState<UpcomingDividend[]>([])
  const [yearReceived, setYearReceived] = useState<number | null>(0)
  const [yearRemaining, setYearRemaining] = useState<number | null>(0)
  const [analystData, setAnalystData] = useState<AnalystData | null>(null)
  const [suppressedDividends, setSuppressedDividends] = useState<ManualDividend[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'overview' | 'profile' | 'dividends' | 'analyst'>('overview')
  const [showEditModal, setShowEditModal] = useState(false)
  const [editQuantity, setEditQuantity] = useState('')
  const [editPurchasePrice, setEditPurchasePrice] = useState('')
  const [editPurchaseDate, setEditPurchaseDate] = useState('')
  const [saving, setSaving] = useState(false)
  const [showDividendModal, setShowDividendModal] = useState(false)
  const [editingDividend, setEditingDividend] = useState<ManualDividend | null>(null)
  const [divDate, setDivDate] = useState('')
  const [divAmount, setDivAmount] = useState('')
  const [divNote, setDivNote] = useState('')
  const [companyProfile, setCompanyProfile] = useState<CompanyProfile | null>(null)
  const [financialMetrics, setFinancialMetrics] = useState<FinancialMetrics | null>(null)
  const [peers, setPeers] = useState<string[]>([])
  const [finnhubLoading, setFinnhubLoading] = useState(false)
  const [analystDataLoading, setAnalystDataLoading] = useState(false)
  const [analystDataLoaded, setAnalystDataLoaded] = useState(false)
  const [verificationResult, setVerificationResult] = useState<VerificationResult | null>(null)
  const [verificationLoading, setVerificationLoading] = useState(false)
  const [marketstackStatus, setMarketstackStatus] = useState<MarketstackUsage | null>(null)
  const [exchangeRates, setExchangeRates] = useState<Record<string, number | null>>({})
  const editModalRef = useRef<HTMLDivElement | null>(null)
  const dividendModalRef = useRef<HTMLDivElement | null>(null)
  const dividendDateInputRef = useRef<HTMLInputElement | null>(null)
  const editModalHeadingId = useId()
  const dividendModalHeadingId = useId()
  const { timezone, language } = useSettings()
  const locale = getLocaleForLanguage(language)
  const tabs = ['overview', 'profile', 'dividends', 'analyst'] as const
  const tabLabels: Record<(typeof tabs)[number], string> = {
    overview: t(language, 'stockDetail.tabOverview'),
    profile: t(language, 'stockDetail.tabProfile'),
    dividends: t(language, 'stockDetail.tabDividends'),
    analyst: t(language, 'stockDetail.tabAnalyst'),
  }

  const closeEditModal = useCallback(() => setShowEditModal(false), [])
  const closeDividendModal = useCallback(() => setShowDividendModal(false), [])

  useModalFocusTrap({
    modalRef: editModalRef,
    open: showEditModal,
    onClose: closeEditModal,
  })

  useModalFocusTrap({
    modalRef: dividendModalRef,
    open: showDividendModal,
    onClose: closeDividendModal,
    initialFocusRef: dividendDateInputRef,
  })

  useEffect(() => {
    if (!ticker) return
    let active = true
    
    setVerificationResult(null)
    setMarketstackStatus(null)
    
    const fetchData = async () => {
      try {
        if (active) {
          setLoading(true)
        }
        const [stockData, divData, stockUpcomingData, suppressedData, ratesData] = await Promise.all([
          api.stocks.get(ticker),
          api.stocks.dividends(ticker),
          api.stocks.upcomingDividends(ticker).catch(() => []),
          api.stocks.getSuppressedDividends(ticker).catch(() => []),
          api.market.exchangeRates().catch(() => ({})),
        ])
        if (!active) return

        const safeRates = ratesData as Record<string, number | null>

        const todayDate = new Date()
        todayDate.setUTCHours(0, 0, 0, 0)
        const currentYear = todayDate.getUTCFullYear()

        const purchaseDate = normalizeToDay(stockData.purchase_date)

        const historicalYearDividends: UpcomingDividend[] = divData
          .filter((div: Dividend) => {
            const payoutDate = div.payment_date || div.date
            if (!payoutDate?.startsWith(`${currentYear}-`)) return false
            const exDate = normalizeToDay(div.date)
            if (!purchaseDate || !exDate) return true
            return exDate.getTime() >= purchaseDate.getTime()
          })
          .map((div: Dividend) => {
            const amountPerShare = div.amount ?? 0
            const totalAmount = amountPerShare * stockData.quantity
            const divCurrency = div.currency || stockData.currency
            const totalConverted = convertToSEKValue(totalAmount, divCurrency, safeRates)
            const payoutDate = div.payment_date || div.date
            const payoutDateParsed = normalizeToDay(payoutDate)
            const status = payoutDateParsed && payoutDateParsed.getTime() <= todayDate.getTime() ? 'paid' : 'upcoming'

            return {
              ticker: stockData.ticker,
              name: stockData.name,
              quantity: stockData.quantity,
              ex_date: div.date,
              payment_date: div.payment_date,
              payout_date: payoutDate,
              status,
              dividend_type: null,
              amount_per_share: amountPerShare,
              total_amount: totalAmount,
              currency: divCurrency,
              total_converted: totalConverted,
              display_currency: 'SEK',
              source: div.source || 'yahoo'
            }
          })

        const upcomingYearDividends: UpcomingDividend[] = stockUpcomingData
          .filter((div: StockUpcomingDividend) => {
            const payoutDate = div.payment_date || div.ex_date
            if (!payoutDate?.startsWith(`${currentYear}-`)) return false
            const exDate = normalizeToDay(div.ex_date)
            if (!purchaseDate || !exDate) return true
            return exDate.getTime() >= purchaseDate.getTime()
          })
          .map((div: StockUpcomingDividend) => {
            const amountPerShare = div.amount ?? 0
            const totalAmount = amountPerShare * stockData.quantity
            const divCurrency = div.currency || stockData.currency
            const totalConverted = convertToSEKValue(totalAmount, divCurrency, safeRates)
            const payoutDate = div.payment_date || div.ex_date
            const payoutDateParsed = normalizeToDay(payoutDate)
            const status = payoutDateParsed && payoutDateParsed.getTime() <= todayDate.getTime() ? 'paid' : 'upcoming'

            return {
              ticker: stockData.ticker,
              name: stockData.name,
              quantity: stockData.quantity,
              ex_date: div.ex_date,
              payment_date: div.payment_date,
              payout_date: payoutDate,
              status,
              dividend_type: div.dividend_type,
              amount_per_share: amountPerShare,
              total_amount: totalAmount,
              currency: divCurrency,
              total_converted: totalConverted,
              display_currency: 'SEK',
              source: div.source || 'yahoo'
            }
          })

        const mergedYearDividends = [...historicalYearDividends, ...upcomingYearDividends]
        const dedupedMap = new Map<string, UpcomingDividend>()
        for (const div of mergedYearDividends) {
          const key = [
            div.ex_date,
            div.payment_date || '',
            div.amount_per_share,
            div.currency,
            div.dividend_type || '',
            div.source || ''
          ].join('|')
          dedupedMap.set(key, div)
        }

        const effectiveYearDividends = Array.from(dedupedMap.values()).sort((a, b) => {
          const aDate = a.payout_date || a.payment_date || a.ex_date
          const bDate = b.payout_date || b.payment_date || b.ex_date
          return aDate.localeCompare(bDate)
        })

        const yearlyState = recalculateYearlyDividendState(effectiveYearDividends, stockData.quantity, safeRates)

        const filteredHistoryDividends = divData.filter((div: Dividend) => {
          if (!purchaseDate) return true
          const exDate = normalizeToDay(div.date)
          if (!exDate) return true
          return exDate.getTime() >= purchaseDate.getTime()
        })

        setStock(stockData)
        setDividends(filteredHistoryDividends)
        setYearDividends(yearlyState.yearDividends)
        setYearReceived(yearlyState.yearReceived)
        setYearRemaining(yearlyState.yearRemaining)
        setSuppressedDividends(suppressedData)
        setExchangeRates(ratesData)
        setError(null)
        setEditPurchaseDate(stockData.purchase_date || '')
      } catch (err: any) {
        if (active) {
          setError(err.message || t(language, 'stockDetail.failedLoad'))
        }
      } finally {
        if (active) {
          setLoading(false)
        }
      }
    }
    
    const fetchFinnhubData = async () => {
      try {
        if (active) {
          setFinnhubLoading(true)
        }
        const [profile, metrics, peersData] = await Promise.all([
          api.finnhub.profile(ticker).catch(() => null),
          api.finnhub.metrics(ticker).catch(() => null),
          api.finnhub.peers(ticker).catch(() => []),
        ])
        if (!active) return
        setCompanyProfile(profile)
        setFinancialMetrics(metrics)
        setPeers(peersData)
      } catch (err) {
        console.error('Failed to load Finnhub data', err)
      } finally {
        if (active) {
          setFinnhubLoading(false)
        }
      }
    }
    
    fetchData()
    fetchFinnhubData()

    return () => {
      active = false
    }
  }, [ticker])

  useEffect(() => {
    setAnalystData(null)
    setAnalystDataLoaded(false)
    setAnalystDataLoading(false)
  }, [ticker])

  useEffect(() => {
    if (!ticker || analystDataLoaded || activeTab !== 'analyst') return

    let isCurrent = true
    setAnalystData(null)
    setAnalystDataLoaded(false)
    setAnalystDataLoading(true)

    const fetchAnalystData = async () => {
      try {
        const analystInfo = await api.stocks.analyst(ticker).catch(() => null)
        if (!isCurrent) return
        setAnalystData(analystInfo)
        setAnalystDataLoaded(true)
      } catch (err) {
        if (isCurrent) {
          console.error('Failed to load analyst data', err)
        }
      } finally {
        if (isCurrent) {
          setAnalystDataLoading(false)
        }
      }
    }

    fetchAnalystData()

    return () => {
      isCurrent = false
    }
  }, [ticker, activeTab, analystDataLoaded])

  useEffect(() => {
    if (activeTab !== 'dividends') return
    api.marketstack.status().then(setMarketstackStatus).catch(() => null)
  }, [activeTab, ticker])

  const handleVerifyDividends = async () => {
    if (!ticker) return
    try {
      setVerificationLoading(true)
      const result = await api.marketstack.verify(ticker)
      setVerificationResult(result)
      setMarketstackStatus(result.usage)
    } catch (err: any) {
      console.error('Failed to verify dividends', err)
    } finally {
      setVerificationLoading(false)
    }
  }

  const openEditModal = () => {
    if (stock) {
      setEditQuantity(stock.quantity.toString())
      setEditPurchasePrice(stock.purchase_price?.toString() || '')
      setEditPurchaseDate(stock.purchase_date || '')
      setShowEditModal(true)
    }
  }

  const handleSaveEdit = async () => {
    if (!ticker || !stock) return
    try {
      setSaving(true)
      const parsedQuantity = parseFloat(editQuantity)
      const parsedPurchasePrice = parseFloat(editPurchasePrice)
      const updated = await api.stocks.update(ticker, {
        quantity: Number.isNaN(parsedQuantity) ? undefined : parsedQuantity,
        purchase_price: Number.isNaN(parsedPurchasePrice) ? undefined : parsedPurchasePrice,
        purchase_date: editPurchaseDate || undefined,
      })
      const yearlyState = recalculateYearlyDividendState(yearDividends, updated.quantity, exchangeRates)
      setStock(updated)
      setYearDividends(yearlyState.yearDividends)
      setYearReceived(yearlyState.yearReceived)
      setYearRemaining(yearlyState.yearRemaining)
      setShowEditModal(false)
    } catch (err) {
      console.error('Failed to save', err)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!ticker || !confirm(t(language, 'stockDetail.deleteStockConfirm', { ticker }))) return
    try {
      await api.stocks.delete(ticker)
      navigate('/stocks')
    } catch (err) {
      console.error('Failed to delete', err)
    }
  }

  const openAddDividendModal = () => {
    setEditingDividend(null)
    setDivDate('')
    setDivAmount('')
    setDivNote('')
    setShowDividendModal(true)
  }

  const openEditDividendModal = (div: ManualDividend) => {
    setEditingDividend(div)
    setDivDate(div.date)
    setDivAmount(div.amount.toString())
    setDivNote(div.note || '')
    setShowDividendModal(true)
  }

  const handleSaveDividend = async () => {
    if (!ticker || !divDate || !divAmount) return
    try {
      setSaving(true)
      if (editingDividend) {
        const updated = await api.stocks.updateManualDividend(ticker, editingDividend.id, {
          date: divDate,
          amount: parseFloat(divAmount),
          note: divNote || undefined,
        })
        setStock(updated)
      } else {
        const updated = await api.stocks.addManualDividend(ticker, {
          date: divDate,
          amount: parseFloat(divAmount),
          currency: stock?.currency,
          note: divNote || undefined,
        })
        setStock(updated)
      }
      setShowDividendModal(false)
    } catch (err) {
      console.error('Failed to save dividend', err)
    } finally {
      setSaving(false)
    }
  }

  const handleDeleteDividend = async (dividendId: string) => {
    if (!ticker || !confirm(t(language, 'stockDetail.deleteDividendConfirm'))) return
    try {
      await api.stocks.deleteManualDividend(ticker, dividendId)
      if (stock) {
        setStock({
          ...stock,
          manual_dividends: stock.manual_dividends?.filter(d => d.id !== dividendId) || []
        })
      }
    } catch (err) {
      console.error('Failed to delete dividend', err)
    }
  }

  const handleSuppressDividend = async (date: string, amount: number) => {
    if (!ticker) return
    try {
      await api.stocks.suppressDividend(ticker, { date, amount, currency: stock?.currency })
      const suppressed = await api.stocks.getSuppressedDividends(ticker)
      setSuppressedDividends(suppressed)
    } catch (err) {
      console.error('Failed to suppress dividend', err)
    }
  }

  const handleRestoreDividend = async (date: string) => {
    if (!ticker) return
    try {
      await api.stocks.restoreDividend(ticker, date)
      setSuppressedDividends(suppressedDividends.filter(d => d.date !== date))
    } catch (err) {
      console.error('Failed to restore dividend', err)
    }
  }

  const isDividendSuppressed = (date: string) => {
    return suppressedDividends.some(s => s.date === date)
  }

  if (loading) {
    return <div style={{ textAlign: 'center', padding: '40px' }}>{t(language, 'common.loading')}</div>
  }

  if (error || !stock) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: '40px' }}>
        <p style={{ color: 'var(--accent-red)', marginBottom: '16px' }}>{error || t(language, 'stockDetail.notFound')}</p>
        <Link to="/stocks" className="btn btn-primary">{t(language, 'stockDetail.backToStocks')}</Link>
      </div>
    )
  }

  const dailyChange = stock.current_price !== null && stock.previous_close !== null
    ? stock.current_price - stock.previous_close 
    : null
  const dailyChangePercent = dailyChange !== null && stock.previous_close !== null && stock.previous_close !== 0
    ? (dailyChange / stock.previous_close) * 100 
    : null

  const convertToSEK = (amount: number | null, fromCurrency: string): number | null => {
    return convertToSEKValue(amount, fromCurrency, exchangeRates)
  }

  const renderValueWithSEK = (amount: number | null, fromCurrency: string, align: 'left' | 'right' = 'right') => {
    const sekValue = convertToSEK(amount, fromCurrency)
    const textAlign = align

    return (
      <div style={{ textAlign }}>
        <div>{formatCurrency(amount, locale, fromCurrency)}</div>
        {amount !== null && fromCurrency !== 'SEK' && sekValue !== null && (
          <div style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>
            {formatCurrency(sekValue, locale, 'SEK')}
          </div>
        )}
      </div>
    )
  }

  const formatYearTotal = (value: number | null) => {
    if (value === null) return t(language, 'stockDetail.partial')
    return formatCurrency(value, locale, 'SEK')
  }

  const displayName = formatDisplayName(stock.name, stock.ticker)
  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)
  const oneYearAgo = new Date(today)
  oneYearAgo.setUTCFullYear(today.getUTCFullYear() - 1)

  let derivedDividendPerShare: number | null = null
  let derivedDividendEvents = 0

  for (const div of dividends) {
    const payoutDate = div.payment_date || div.date
    if (!payoutDate) continue

    const eventDate = normalizeToDay(payoutDate)
    if (eventDate === null || Number.isNaN(eventDate.getTime())) continue

    const eventTimestamp = eventDate.getTime()
    if (eventTimestamp >= oneYearAgo.getTime() && eventTimestamp <= today.getTime()) {
      if (derivedDividendPerShare === null) derivedDividendPerShare = 0
      derivedDividendPerShare += div.amount
      derivedDividendEvents += 1
    }
  }

  if (derivedDividendEvents === 0) {
    derivedDividendPerShare = null
  }

  const estimatedDividendsPerYear = estimateDividendsPerYear(dividends)
  const upcomingThisYearAmounts = yearDividends
    .filter((div) => div.status === 'upcoming')
    .map((div) => div.amount_per_share)
    .filter((amount): amount is number => amount !== null && amount > 0)
  const knownThisYearAmounts = yearDividends
    .map((div) => div.amount_per_share)
    .filter((amount): amount is number => amount !== null && amount > 0)

  const knownThisYearCount = knownThisYearAmounts.length
  const knownThisYearPerShare = knownThisYearCount > 0
    ? knownThisYearAmounts.reduce((sum, amount) => sum + amount, 0)
    : null

  let modeledPerShareFromYearData: number | null = null
  if (knownThisYearPerShare !== null) {
    modeledPerShareFromYearData = knownThisYearPerShare
    if (knownThisYearCount < estimatedDividendsPerYear) {
      const missingCount = estimatedDividendsPerYear - knownThisYearCount
      const representativeUpcomingAmount = upcomingThisYearAmounts.length > 0
        ? upcomingThisYearAmounts[0]
        : knownThisYearAmounts[knownThisYearAmounts.length - 1]

      if (representativeUpcomingAmount > 0) {
        modeledPerShareFromYearData += representativeUpcomingAmount * missingCount
      }
    }
  }

  const displayDividendPerShare =
    modeledPerShareFromYearData ??
    stock.dividend_per_share ??
    financialMetrics?.dividend_per_share_annual ??
    derivedDividendPerShare

  const derivedDividendYield =
    displayDividendPerShare !== null && stock.current_price !== null && stock.current_price > 0
      ? (displayDividendPerShare / stock.current_price) * 100
      : null

  const displayDividendYield =
    stock.dividend_yield ??
    financialMetrics?.dividend_yield ??
    derivedDividendYield

  const displayAnnualIncome =
    displayDividendPerShare !== null ? displayDividendPerShare * stock.quantity : null
  const hasProfileContent = Boolean(companyProfile || financialMetrics || (peers && peers.length > 0))

  return (
    <div>
      <div style={{ marginBottom: '24px' }}>
        <Link to="/stocks" style={{ color: 'var(--accent-blue)', textDecoration: 'none' }}>
          ← {t(language, 'stockDetail.backToStocks')}
        </Link>
      </div>

      <div className="card" style={{ marginBottom: '24px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div style={{ display: 'flex', gap: '14px', alignItems: 'flex-start' }}>
            {stock.logo ? (
              <img
                src={stock.logo}
                alt={displayName}
                style={{
                  width: 48,
                  height: 48,
                  borderRadius: 10,
                  objectFit: 'contain',
                  background: 'var(--bg-secondary)',
                  padding: 6,
                  border: '1px solid var(--border-color)'
                }}
              />
            ) : (
              <div
                style={{
                  width: 48,
                  height: 48,
                  borderRadius: 10,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 18,
                  fontWeight: 700,
                  color: 'var(--text-secondary)',
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border-color)'
                }}
              >
                {displayName.charAt(0).toUpperCase()}
              </div>
            )}
            <div>
              <h1 style={{ fontSize: '32px', fontWeight: '600', marginBottom: '8px' }}>
                {stock.ticker}
              </h1>
              <p style={{ color: 'var(--text-secondary)', fontSize: '18px' }}>
                {displayName}
              </p>
            </div>
            {stock.sector && (
              <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginTop: '4px' }}>
                {stock.sector}
              </p>
            )}
            <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginTop: '8px' }}>
              {t(language, 'common.lastUpdated')}: {formatTimeInTimezone(stock.last_updated, timezone, locale)} · {t(language, 'common.autoRefresh10m')}
            </p>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button className="btn btn-secondary" onClick={openEditModal}>
              {t(language, 'stockDetail.edit')}
            </button>
            <button className="btn btn-danger" onClick={handleDelete}>
              {t(language, 'common.delete')}
            </button>
          </div>
        </div>
        
        <div style={{ marginTop: '24px', display: 'flex', gap: '32px', alignItems: 'baseline' }}>
          <div>
            <div style={{ fontSize: '36px', fontWeight: '600' }}>
              {formatCurrency(stock.current_price, locale, stock.currency)}
            </div>
            {stock.currency !== 'SEK' && convertToSEK(stock.current_price, stock.currency) !== null && (
              <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginTop: '4px' }}>
                {formatCurrency(convertToSEK(stock.current_price, stock.currency), locale, 'SEK')}
              </p>
            )}
            {dailyChange !== null && (
              <p style={{ 
                color: dailyChange >= 0 ? 'var(--accent-green)' : 'var(--accent-red)',
                fontSize: '16px'
              }}>
                {dailyChange >= 0 ? '+' : ''}{formatCurrency(dailyChange, locale, stock.currency)} {dailyChangePercent !== null ? `(${dailyChangePercent.toFixed(2)}%)` : '(—)'}
              </p>
            )}
            {dailyChange !== null && stock.currency !== 'SEK' && convertToSEK(dailyChange, stock.currency) !== null && (
              <p style={{ color: 'var(--text-secondary)', fontSize: '13px', marginTop: '2px' }}>
                {dailyChange >= 0 ? '+' : ''}{formatCurrency(convertToSEK(dailyChange, stock.currency), locale, 'SEK')}
              </p>
            )}
          </div>
          <p style={{ color: 'var(--text-secondary)' }}>
            {stock.currency}
          </p>
        </div>
      </div>

      <div style={{ marginBottom: '24px', borderBottom: '1px solid var(--border-color)' }}>
        <div style={{ display: 'flex', gap: '24px' }}>
          {tabs.map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              style={{
                padding: '12px 0',
                background: 'none',
                border: 'none',
                color: activeTab === tab ? 'var(--text-primary)' : 'var(--text-secondary)',
                borderBottom: activeTab === tab ? '2px solid var(--accent-blue)' : 'none',
                cursor: 'pointer',
                fontSize: '14px',
                fontWeight: 500,
              }}
            >
              {tabLabels[tab] ?? tab}
            </button>
          ))}
        </div>
      </div>

      {activeTab === 'overview' && (
        <div className="grid grid-2">
          <div className="card">
            <h3 style={{ marginBottom: '16px' }}>{t(language, 'stockDetail.position')}</h3>
            <table>
              <tbody>
                <tr>
                  <td style={{ color: 'var(--text-secondary)' }}>{t(language, 'stockDetail.quantity')}</td>
                  <td style={{ textAlign: 'right' }}>{stock.quantity}</td>
                </tr>
                <tr>
                  <td style={{ color: 'var(--text-secondary)' }}>{t(language, 'stockDetail.purchasePrice')}</td>
                  <td>{renderValueWithSEK(stock.purchase_price, stock.currency)}</td>
                </tr>
                <tr>
                  <td style={{ color: 'var(--text-secondary)' }}>{t(language, 'stockDetail.purchaseDate')}</td>
                  <td style={{ textAlign: 'right' }}>{stock.purchase_date ? formatDate(stock.purchase_date, locale) : '-'}</td>
                </tr>
                <tr>
                  <td style={{ color: 'var(--text-secondary)' }}>{t(language, 'stockDetail.currentValue')}</td>
                  <td>{renderValueWithSEK(stock.current_price != null ? stock.current_price * stock.quantity : null, stock.currency)}</td>
                </tr>
                <tr>
                  <td style={{ color: 'var(--text-secondary)' }}>{t(language, 'stockDetail.totalCost')}</td>
                  <td>{renderValueWithSEK(stock.purchase_price != null ? stock.purchase_price * stock.quantity : null, stock.currency)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          
          <div className="card">
            <h3 style={{ marginBottom: '16px' }}>{t(language, 'stockDetail.dividendInfo')}</h3>
            <table>
              <tbody>
                <tr>
                  <td style={{ color: 'var(--text-secondary)' }}>{t(language, 'stockDetail.dividendYield')}</td>
                      <td style={{ textAlign: 'right' }}>
                        {displayDividendYield !== null
                        ? new Intl.NumberFormat(locale, {
                            style: 'percent',
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          }).format(displayDividendYield / 100)
                        : '-'}
                  </td>
                </tr>
                <tr>
                  <td style={{ color: 'var(--text-secondary)' }}>{t(language, 'stockDetail.dividendPerShare')}</td>
                  <td style={{ textAlign: 'right' }}>{formatCurrency(displayDividendPerShare, locale, stock.currency)}</td>
                </tr>
                <tr>
                  <td style={{ color: 'var(--text-secondary)' }}>{t(language, 'stockDetail.annualIncome')}</td>
                  <td style={{ textAlign: 'right' }}>
                    {displayAnnualIncome !== null ? formatCurrency(displayAnnualIncome, locale, stock.currency) : '-'}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === 'profile' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <CompanyProfileComponent profile={companyProfile} loading={finnhubLoading} />
          <FinancialMetricsComponent metrics={financialMetrics} loading={finnhubLoading} />
          <PeerCompanies peers={peers} loading={finnhubLoading} />
          {!finnhubLoading && !hasProfileContent && (
            <div className="card">
              <h3 style={{ marginBottom: '12px' }}>{t(language, 'stockDetail.profileSnapshot')}</h3>
              <p style={{ color: 'var(--text-secondary)', marginBottom: '14px' }}>
                {t(language, 'stockDetail.profileSnapshotDesc')}
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '12px' }}>
                <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 8, padding: '12px' }}>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginBottom: '4px' }}>{t(language, 'stockDetail.sector')}</p>
                  <p>{stock.sector || '-'}</p>
                </div>
                <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 8, padding: '12px' }}>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginBottom: '4px' }}>{t(language, 'stockDetail.dividendPerShareModeled')}</p>
                  <p>{formatCurrency(displayDividendPerShare, locale, stock.currency)}</p>
                </div>
                <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 8, padding: '12px' }}>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginBottom: '4px' }}>{t(language, 'stockDetail.annualIncome')}</p>
                  <p>{displayAnnualIncome !== null ? formatCurrency(displayAnnualIncome, locale, stock.currency) : '-'}</p>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {activeTab === 'dividends' && (
        <div>
          <div className="card" style={{ marginBottom: '20px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <h3>{t(language, 'stockDetail.manualDividends')}</h3>
              <button className="btn btn-primary" onClick={openAddDividendModal}>
                {t(language, 'stockDetail.addDividend')}
              </button>
            </div>
            {stock.manual_dividends && stock.manual_dividends.length > 0 ? (
              <table>
                <thead>
                  <tr>
                    <th>{t(language, 'stockDetail.date')}</th>
                    <th>{t(language, 'stockDetail.amount')}</th>
                    <th>{t(language, 'stockDetail.note')}</th>
                    <th>{t(language, 'common.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {stock.manual_dividends.map((div) => (
                    <tr key={div.id}>
                      <td>{formatDate(div.date, locale)}</td>
                      <td style={{ color: 'var(--accent-green)' }}>{formatCurrency(div.amount, locale, div.currency)}</td>
                      <td>{div.note || '-'}</td>
                      <td>
                        <div style={{ display: 'flex', gap: '8px' }}>
                          <button 
                            className="btn btn-secondary" 
                            style={{ padding: '4px 8px', fontSize: '12px' }}
                            onClick={() => openEditDividendModal(div)}
                          >
                            {t(language, 'stockDetail.edit')}
                          </button>
                          <button 
                            className="btn btn-danger" 
                            style={{ padding: '4px 8px', fontSize: '12px' }}
                            onClick={() => handleDeleteDividend(div.id)}
                          >
                            {t(language, 'common.delete')}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '20px' }}>
                {t(language, 'stockDetail.noManualDividends')}
              </p>
            )}
          </div>
          
          {yearDividends.length > 0 && (
            <div className="card" style={{ marginBottom: '20px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                <h3>{t(language, 'stockDetail.dividendsThisYear')}</h3>
                <div style={{ display: 'flex', gap: '16px', fontSize: '13px' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>
                    {t(language, 'stockDetail.received')}: <strong style={{ color: 'var(--accent-green)' }}>{formatYearTotal(yearReceived)}</strong>
                  </span>
                  <span style={{ color: 'var(--text-secondary)' }}>
                    {t(language, 'stockDetail.remaining')}: <strong style={{ color: 'var(--accent-blue)' }}>{formatYearTotal(yearRemaining)}</strong>
                  </span>
                </div>
              </div>
              <table>
                <thead>
                  <tr>
                    <th>{t(language, 'stockDetail.exDate')}</th>
                    <th>{t(language, 'stockDetail.dividendDate')}</th>
                    <th>{t(language, 'stockDetail.amount')}</th>
                    <th>{t(language, 'stockDetail.status')}</th>
                    <th>{t(language, 'stockDetail.source')}</th>
                  </tr>
                </thead>
                <tbody>
                  {yearDividends.map((div) => (
                    <tr key={`${div.ex_date}-${div.payment_date || ''}-${div.amount_per_share ?? ''}-${div.source || ''}`}>
                      <td>{formatDate(div.ex_date, locale)}</td>
                      <td>{div.payment_date ? formatDate(div.payment_date, locale) : '-'}</td>
                      <td>{formatCurrency(div.amount_per_share, locale, div.currency || stock.currency)}</td>
                      <td style={{ color: div.status === 'paid' ? 'var(--accent-green)' : 'var(--accent-blue)', fontSize: '12px' }}>
                        {div.status === 'paid' ? t(language, 'stockDetail.paid') : t(language, 'stockDetail.upcoming')}
                      </td>
                      <td style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>
                        {div.source || 'historical'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          
          <div className="card">
            <h3 style={{ marginBottom: '16px' }}>{t(language, 'stockDetail.history5y')}</h3>
            {dividends.length === 0 ? (
              <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '20px' }}>
                {t(language, 'stockDetail.noHistory')}
              </p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>{t(language, 'stockDetail.date')}</th>
                    <th>{t(language, 'stockDetail.amount')}</th>
                    <th>{t(language, 'common.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {dividends.slice(0, 20).map((div, i) => {
                    const suppressed = isDividendSuppressed(div.date)
                    return (
                      <tr key={i} style={{ opacity: suppressed ? 0.5 : 1 }}>
                        <td>{formatDate(div.date, locale)}</td>
                        <td style={{ color: suppressed ? 'var(--text-secondary)' : 'var(--accent-green)' }}>
                          {formatCurrency(div.amount, locale, div.currency || stock.currency)}
                          {suppressed && <span style={{ marginLeft: '8px', fontSize: '12px' }}>{t(language, 'stockDetail.suppressedTag')}</span>}
                        </td>
                        <td>
                          {suppressed ? (
                            <button 
                              className="btn btn-secondary" 
                              style={{ padding: '4px 8px', fontSize: '12px' }}
                              onClick={() => handleRestoreDividend(div.date)}
                            >
                              {t(language, 'stockDetail.restore')}
                            </button>
                          ) : (
                            <button 
                              className="btn btn-secondary" 
                              style={{ padding: '4px 8px', fontSize: '12px' }}
                              onClick={() => handleSuppressDividend(div.date, div.amount)}
                            >
                              {t(language, 'stockDetail.hide')}
                            </button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
          
          <div className="card" style={{ marginTop: '20px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <h3>{t(language, 'stockDetail.verification')}</h3>
              {marketstackStatus && (
                <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                  API: {marketstackStatus.calls_remaining}/{marketstackStatus.calls_limit} {t(language, 'stockDetail.callsRemaining')}
                </span>
              )}
            </div>
            
            {marketstackStatus && marketstackStatus.api_configured === false ? (
              <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '20px' }}>
                {t(language, 'stockDetail.apiNotConfigured')}
              </p>
            ) : verificationLoading ? (
              <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '20px' }}>
                {t(language, 'stockDetail.verifying')}
              </p>
            ) : verificationResult ? (
              <div>
                <div style={{ display: 'flex', gap: '16px', marginBottom: '16px', flexWrap: 'wrap' }}>
                  <div style={{ padding: '12px 16px', background: 'var(--card-bg-alt)', borderRadius: '8px' }}>
                    <span style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>Yahoo</span>
                    <p style={{ fontSize: '20px', fontWeight: '600' }}>{verificationResult.summary.yahoo_count}</p>
                  </div>
                  <div style={{ padding: '12px 16px', background: 'var(--card-bg-alt)', borderRadius: '8px' }}>
                    <span style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>Marketstack</span>
                    <p style={{ fontSize: '20px', fontWeight: '600' }}>{verificationResult.summary.marketstack_count}</p>
                  </div>
                  <div style={{ padding: '12px 16px', background: 'rgba(34, 197, 94, 0.15)', borderRadius: '8px' }}>
                    <span style={{ color: 'var(--accent-green)', fontSize: '12px' }}>{t(language, 'stockDetail.matches')}</span>
                    <p style={{ fontSize: '20px', fontWeight: '600', color: 'var(--accent-green)' }}>{verificationResult.summary.match_count}</p>
                  </div>
                  <div style={{ padding: '12px 16px', background: verificationResult.summary.discrepancy_count > 0 ? 'var(--accent-red)' : 'var(--card-bg-alt)', borderRadius: '8px' }}>
                    <span style={{ color: verificationResult.summary.discrepancy_count > 0 ? '#ffffff' : 'var(--text-secondary)', fontSize: '12px' }}>{t(language, 'stockDetail.discrepancies')}</span>
                    <p style={{ fontSize: '20px', fontWeight: '600', color: verificationResult.summary.discrepancy_count > 0 ? '#ffffff' : 'var(--text-primary)' }}>{verificationResult.summary.discrepancy_count}</p>
                  </div>
                </div>
                
                {verificationResult.cached && (
                  <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '12px' }}>
                    {t(language, 'stockDetail.cachedAt', { date: new Date(verificationResult.verified_at).toLocaleString(locale) })}
                  </p>
                )}
                
                {verificationResult.discrepancies.length > 0 && (
                  <div>
                    <h4 style={{ marginBottom: '12px', fontSize: '14px' }}>{t(language, 'stockDetail.discrepancyDetails')}</h4>
                    <table>
                      <thead>
                        <tr>
                          <th>{t(language, 'stockDetail.date')}</th>
                          <th>{t(language, 'stockDetail.type')}</th>
                          <th>Yahoo</th>
                          <th>Marketstack</th>
                          <th>{t(language, 'stockDetail.difference')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {verificationResult.discrepancies.map((d, i) => (
                          <tr key={i}>
                            <td>{d.date || '-'}</td>
                            <td>
                              <span style={{
                                padding: '2px 8px',
                                borderRadius: '4px',
                                fontSize: '11px',
                                fontWeight: 500,
                                background: d.type === 'amount_mismatch' ? '#fbbf24' : 
                                           d.type === 'missing_from_yahoo' ? '#3b82f6' :
                                           d.type === 'missing_from_marketstack' ? '#f97316' : '#ef4444',
                                color: '#1a1a1a',
                              }}>
                                {d.type.replace(/_/g, ' ')}
                              </span>
                            </td>
                            <td>{d.yahoo_amount !== null ? formatCurrency(d.yahoo_amount, locale, stock.currency) : '-'}</td>
                            <td>{d.marketstack_amount !== null ? formatCurrency(d.marketstack_amount, locale, stock.currency) : '-'}</td>
                            <td>{d.difference !== null ? formatCurrency(d.difference, locale, stock.currency) : '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                
                <div style={{ marginTop: '16px' }}>
                  <button 
                    className="btn btn-secondary" 
                    onClick={handleVerifyDividends}
                    disabled={verificationLoading || (marketstackStatus !== null && (marketstackStatus.calls_remaining ?? 0) <= 0)}
                  >
                    {t(language, 'stockDetail.reverify')}
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ textAlign: 'center', padding: '20px' }}>
                <p style={{ color: 'var(--text-secondary)', marginBottom: '12px' }}>
                  {t(language, 'stockDetail.verifyDescription')}
                </p>
                <button 
                  className="btn btn-primary" 
                  onClick={handleVerifyDividends}
                  disabled={verificationLoading || (marketstackStatus !== null && (marketstackStatus.calls_remaining ?? 0) <= 0)}
                >
                  {t(language, 'stockDetail.verify')}
                </button>
              </div>
            )}
          </div>
          
          {suppressedDividends.length > 0 && (
            <div className="card" style={{ marginTop: '20px' }}>
              <h3 style={{ marginBottom: '16px', color: 'var(--text-secondary)' }}>{t(language, 'stockDetail.suppressedDividends')}</h3>
              <table>
                <thead>
                  <tr>
                    <th>{t(language, 'stockDetail.date')}</th>
                    <th>{t(language, 'stockDetail.amount')}</th>
                    <th>{t(language, 'common.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {suppressedDividends.map((div) => (
                    <tr key={div.id}>
                      <td>{formatDate(div.date, locale)}</td>
                      <td>{formatCurrency(div.amount || 0, locale, div.currency || stock.currency)}</td>
                      <td>
                        <button 
                          className="btn btn-secondary" 
                          style={{ padding: '4px 8px', fontSize: '12px' }}
                          onClick={() => handleRestoreDividend(div.date)}
                        >
                          {t(language, 'stockDetail.restore')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {activeTab === 'analyst' && (
        <div>
          {analystDataLoading ? (
            <div className="card">
              <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '40px' }}>
                {t(language, 'stockDetail.loadingAnalyst')}
              </p>
            </div>
          ) : (
            <>
              <YfinanceAnalystPanel
                priceTargets={analystData?.price_targets || null}
                recommendations={analystData?.recommendations || null}
                finnhubRecommendations={analystData?.finnhub_recommendations || null}
                currency={stock?.currency || 'USD'}
                currentPrice={stock?.current_price ?? null}
              />

              {!analystData?.price_targets && !analystData?.recommendations?.length && !analystData?.finnhub_recommendations?.length && !finnhubLoading && !analystDataLoading && (
                <div className="card">
                  <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '40px' }}>
                    {t(language, 'stockDetail.noAnalyst')}
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {showEditModal && (
        <div 
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0, 0, 0, 0.7)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
          onClick={() => setShowEditModal(false)}
        >
          <div 
            className="card" 
            style={{ width: '400px', maxWidth: '90%' }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby={editModalHeadingId}
            ref={editModalRef}
            tabIndex={-1}
          >
            <h3 id={editModalHeadingId} style={{ marginBottom: '20px' }}>{t(language, 'stockDetail.editPosition')}</h3>
            <div style={{ marginBottom: '16px' }}>
              <label style={{ display: 'block', marginBottom: '8px', color: 'var(--text-secondary)', fontSize: '14px' }}>
                {t(language, 'stockDetail.quantity')}
              </label>
              <input
                type="number"
                step="0.01"
                value={editQuantity}
                onChange={(e) => setEditQuantity(e.target.value)}
                style={{ width: '100%' }}
              />
            </div>
            <div style={{ marginBottom: '24px' }}>
              <label style={{ display: 'block', marginBottom: '8px', color: 'var(--text-secondary)', fontSize: '14px' }}>
                {t(language, 'stockDetail.purchasePrice')} ({stock?.currency})
              </label>
              <input
                type="number"
                step="0.01"
                value={editPurchasePrice}
                onChange={(e) => setEditPurchasePrice(e.target.value)}
                style={{ width: '100%' }}
                placeholder="e.g. 150.00"
              />
            </div>
            <div style={{ marginBottom: '24px' }}>
              <label style={{ display: 'block', marginBottom: '8px', color: 'var(--text-secondary)', fontSize: '14px' }}>
                {t(language, 'stockDetail.purchaseDate')}
              </label>
              <input
                type="date"
                value={editPurchaseDate}
                onChange={(e) => setEditPurchaseDate(e.target.value)}
                style={{ width: '100%' }}
              />
            </div>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => setShowEditModal(false)}>
                {t(language, 'stockDetail.cancel')}
              </button>
              <button className="btn btn-primary" onClick={handleSaveEdit} disabled={saving}>
                {saving ? t(language, 'stockDetail.saving') : t(language, 'stockDetail.save')}
              </button>
            </div>
          </div>
        </div>
      )}

      {showDividendModal && (
        <div 
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0, 0, 0, 0.7)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
          onClick={() => setShowDividendModal(false)}
        >
          <div 
            className="card" 
            style={{ width: '400px', maxWidth: '90%' }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby={dividendModalHeadingId}
            ref={dividendModalRef}
            tabIndex={-1}
          >
            <h3 id={dividendModalHeadingId} style={{ marginBottom: '20px' }}>
              {editingDividend ? t(language, 'stockDetail.editDividend') : t(language, 'stockDetail.addDividend')}
            </h3>
            <div style={{ marginBottom: '16px' }}>
              <label style={{ display: 'block', marginBottom: '8px', color: 'var(--text-secondary)', fontSize: '14px' }}>
                {t(language, 'stockDetail.date')}
              </label>
              <input
                ref={dividendDateInputRef}
                type="date"
                value={divDate}
                onChange={(e) => setDivDate(e.target.value)}
                style={{ width: '100%' }}
              />
            </div>
            <div style={{ marginBottom: '16px' }}>
              <label style={{ display: 'block', marginBottom: '8px', color: 'var(--text-secondary)', fontSize: '14px' }}>
                {t(language, 'stockDetail.amount')} ({stock?.currency})
              </label>
              <input
                type="number"
                step="0.01"
                value={divAmount}
                onChange={(e) => setDivAmount(e.target.value)}
                style={{ width: '100%' }}
                placeholder="e.g. 1.50"
              />
            </div>
            <div style={{ marginBottom: '24px' }}>
              <label style={{ display: 'block', marginBottom: '8px', color: 'var(--text-secondary)', fontSize: '14px' }}>
                {t(language, 'stockDetail.noteOptional')}
              </label>
              <input
                type="text"
                value={divNote}
                onChange={(e) => setDivNote(e.target.value)}
                style={{ width: '100%' }}
                placeholder="e.g. Q1 2024 dividend"
              />
            </div>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => setShowDividendModal(false)}>
                {t(language, 'stockDetail.cancel')}
              </button>
              <button 
                className="btn btn-primary" 
                onClick={handleSaveDividend} 
                disabled={saving || !divDate || !divAmount}
              >
                {saving ? t(language, 'stockDetail.saving') : t(language, 'stockDetail.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
