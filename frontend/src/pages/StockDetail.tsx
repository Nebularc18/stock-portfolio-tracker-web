import { useState, useEffect, useId, useRef, useCallback } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { api, Stock, Dividend, UpcomingDividend, AnalystData, ManualDividend, CompanyProfile, FinancialMetrics, VerificationResult, MarketstackUsage, PortfolioSummaryStock, UpcomingDividendsResponse } from '../services/api'
import CompanyProfileComponent from '../components/CompanyProfile'
import FinancialMetricsComponent from '../components/FinancialMetrics'
import PeerCompanies from '../components/PeerCompanies'
import YfinanceAnalystPanel from '../components/YfinanceAnalystPanel'
import { useSettings } from '../SettingsContext'
import { formatTimeInTimezone } from '../utils/time'
import { getLocaleForLanguage, t } from '../i18n'
import { resolveBackendAssetUrl } from '../utils/assets'
import { useModalFocusTrap } from '../hooks/useModalFocusTrap'
import { formatDisplayName } from '../utils/displayName'
import SortableHeader from '../components/SortableHeader'
import { sortTableItems, useTableSort } from '../utils/tableSort'

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

function aggregateDividendTotal(
  items: UpcomingDividend[],
  targetStatus: 'paid' | 'upcoming'
): number | null {
    let total = 0
    let hasMissingConversion = false

    for (const div of items) {
      if (div.status !== targetStatus) continue
      if (div.total_converted === null) {
        hasMissingConversion = true
        continue
      }
      total += div.total_converted
    }

    return hasMissingConversion ? null : total
}

type LoadedStockPageData = {
  stockData: Stock
  stockSummaryData: PortfolioSummaryStock | null
  displayCurrencyData: string
  allDividendsData: Dividend[]
  dividendsData: Dividend[]
  allYearDividendsData: UpcomingDividend[]
  yearDividendsData: UpcomingDividend[]
  yearReceivedData: number | null
  yearRemainingData: number | null
  suppressedDividendsData: ManualDividend[]
}

type ManualDividendSortField = 'date' | 'amount' | 'note'
type YearDividendSortField = 'exDate' | 'paymentDate' | 'amount' | 'status' | 'source'
type HistorySortField = 'date' | 'amount'
type VerificationSortField = 'date' | 'type' | 'yahoo' | 'marketstack' | 'difference'

/**
 * Render the detailed stock page and manage its data and user interactions.
 *
 * Loads stock, dividend history, portfolio summary, stock-level current-year dividends,
 * company profile, financial metrics, peers, and analyst data; provides UI actions to edit
 * or delete the position, add/edit/delete manual dividends, suppress/restore dividends,
 * and verify dividends via Marketstack. Dates and currency values are formatted for the
 * current locale/timezone and backend-computed display-currency values are shown when available.
 *
 * @returns The React element for the stock detail page.
 */
export default function StockDetail() {
  const { ticker } = useParams<{ ticker: string }>()
  const navigate = useNavigate()
  const [stock, setStock] = useState<Stock | null>(null)
  const [, setAllDividends] = useState<Dividend[]>([])
  const [dividends, setDividends] = useState<Dividend[]>([])
  const [, setAllYearDividends] = useState<UpcomingDividend[]>([])
  const [yearDividends, setYearDividends] = useState<UpcomingDividend[]>([])
  const [yearReceived, setYearReceived] = useState<number | null>(0)
  const [yearRemaining, setYearRemaining] = useState<number | null>(0)
  const [stockSummary, setStockSummary] = useState<PortfolioSummaryStock | null>(null)
  const [displayCurrency, setDisplayCurrency] = useState('SEK')
  const [analystData, setAnalystData] = useState<AnalystData | null>(null)
  const [suppressedDividends, setSuppressedDividends] = useState<ManualDividend[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editError, setEditError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'overview' | 'profile' | 'dividends' | 'analyst'>('overview')
  const [showEditModal, setShowEditModal] = useState(false)
  const [editQuantity, setEditQuantity] = useState('')
  const [editPurchasePrice, setEditPurchasePrice] = useState('')
  const [editPurchaseDate, setEditPurchaseDate] = useState('')
  const [saving, setSaving] = useState(false)
  const [showDividendModal, setShowDividendModal] = useState(false)
  const [dividendError, setDividendError] = useState<string | null>(null)
  const [editingDividend, setEditingDividend] = useState<ManualDividend | null>(null)
  const [divDate, setDivDate] = useState('')
  const [divAmount, setDivAmount] = useState('')
  const [divNote, setDivNote] = useState('')
  const [companyProfile, setCompanyProfile] = useState<CompanyProfile | null>(null)
  const [financialMetrics, setFinancialMetrics] = useState<FinancialMetrics | null>(null)
  const [peers, setPeers] = useState<string[]>([])
  const [finnhubLoading, setFinnhubLoading] = useState(false)
  const [finnhubDataLoaded, setFinnhubDataLoaded] = useState(false)
  const [analystDataLoading, setAnalystDataLoading] = useState(false)
  const [analystDataLoaded, setAnalystDataLoaded] = useState(false)
  const [verificationResult, setVerificationResult] = useState<VerificationResult | null>(null)
  const [verificationLoading, setVerificationLoading] = useState(false)
  const [marketstackStatus, setMarketstackStatus] = useState<MarketstackUsage | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [logoFailed, setLogoFailed] = useState(false)
  const editModalRef = useRef<HTMLDivElement | null>(null)
  const dividendModalRef = useRef<HTMLDivElement | null>(null)
  const dividendDateInputRef = useRef<HTMLInputElement | null>(null)
  const tickerRef = useRef<string | undefined>(ticker)
  const finnhubRequestRef = useRef<Promise<void> | null>(null)
  const analystRequestRef = useRef<Promise<void> | null>(null)
  const marketstackRequestRef = useRef<Promise<void> | null>(null)
  const editModalHeadingId = useId()
  const dividendModalHeadingId = useId()
  const editQuantityInputId = useId()
  const editPurchasePriceInputId = useId()
  const editPurchaseDateInputId = useId()
  const dividendDateInputId = useId()
  const dividendAmountInputId = useId()
  const dividendNoteInputId = useId()
  const { timezone, language } = useSettings()
  const locale = getLocaleForLanguage(language)
  const { sortState: manualSortState, requestSort: requestManualSort } = useTableSort<ManualDividendSortField>({ field: 'date', direction: 'asc' })
  const { sortState: yearSortState, requestSort: requestYearSort } = useTableSort<YearDividendSortField>({ field: 'exDate', direction: 'asc' })
  const { sortState: historySortState, requestSort: requestHistorySort } = useTableSort<HistorySortField>({ field: 'date', direction: 'asc' })
  const { sortState: suppressedSortState, requestSort: requestSuppressedSort } = useTableSort<HistorySortField>({ field: 'date', direction: 'asc' })
  const { sortState: verificationSortState, requestSort: requestVerificationSort } = useTableSort<VerificationSortField>({ field: 'date', direction: 'asc' })
  const tabs = ['overview', 'profile', 'dividends', 'analyst'] as const
  const tabLabels: Record<(typeof tabs)[number], string> = {
    overview: t(language, 'stockDetail.tabOverview'),
    profile: t(language, 'stockDetail.tabProfile'),
    dividends: t(language, 'stockDetail.tabDividends'),
    analyst: t(language, 'stockDetail.tabAnalyst'),
  }

  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const { key } = event
    if (key !== 'ArrowLeft' && key !== 'ArrowRight' && key !== 'Home' && key !== 'End') return
    event.preventDefault()

    const currentIndex = tabs.indexOf(activeTab)
    if (currentIndex === -1) return

    let nextIndex = currentIndex
    if (key === 'ArrowLeft') {
      nextIndex = (currentIndex - 1 + tabs.length) % tabs.length
    } else if (key === 'ArrowRight') {
      nextIndex = (currentIndex + 1) % tabs.length
    } else if (key === 'Home') {
      nextIndex = 0
    } else if (key === 'End') {
      nextIndex = tabs.length - 1
    }

    const nextTab = tabs[nextIndex]
    setActiveTab(nextTab)
    window.requestAnimationFrame(() => {
      const nextButton = event.currentTarget.querySelector<HTMLButtonElement>(`#tab-${nextTab}`)
      nextButton?.focus()
    })
  }

  const closeEditModal = useCallback(() => {
    setShowEditModal(false)
    setEditError(null)
  }, [])
  const closeDividendModal = useCallback(() => {
    setShowDividendModal(false)
    setDividendError(null)
  }, [])

  useEffect(() => {
    tickerRef.current = ticker
  }, [ticker])

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

  const loadStockPageData = useCallback(async (tickerValue: string): Promise<LoadedStockPageData> => {
    const emptyUpcomingResponse: UpcomingDividendsResponse = {
      dividends: [],
      total_expected: 0,
      total_received: 0,
      total_remaining: 0,
      display_currency: 'SEK',
      unmapped_stocks: [],
    }

    const [stockData, divData, suppressedData, summaryData, portfolioUpcomingData] = await Promise.all([
      api.stocks.get(tickerValue),
      api.stocks.dividends(tickerValue),
      api.stocks.getSuppressedDividends(tickerValue).catch(() => []),
      api.portfolio.summary(),
      api.portfolio.upcomingDividends().catch(() => emptyUpcomingResponse),
    ])
    const stockSummaryData = summaryData.stocks.find((item) => item.ticker === stockData.ticker) ?? null
    const stockYearDividends = portfolioUpcomingData.dividends
      .filter((div) => div.ticker === stockData.ticker)
      .sort((a, b) => {
        const aDate = a.payment_date || a.ex_date
        const bDate = b.payment_date || b.ex_date
        return aDate.localeCompare(bDate)
      })

    return {
      stockData,
      stockSummaryData,
      displayCurrencyData: summaryData.display_currency,
      allDividendsData: divData,
      dividendsData: divData,
      allYearDividendsData: stockYearDividends,
      yearDividendsData: stockYearDividends,
      yearReceivedData: aggregateDividendTotal(stockYearDividends, 'paid'),
      yearRemainingData: aggregateDividendTotal(stockYearDividends, 'upcoming'),
      suppressedDividendsData: suppressedData,
    }
  }, [])

  const applyLoadedStockPageData = useCallback((data: LoadedStockPageData) => {
    setStock(data.stockData)
    setAllDividends(data.allDividendsData)
    setDividends(data.dividendsData)
    setAllYearDividends(data.allYearDividendsData)
    setYearDividends(data.yearDividendsData)
    setYearReceived(data.yearReceivedData)
    setYearRemaining(data.yearRemainingData)
    setStockSummary(data.stockSummaryData)
    setDisplayCurrency(data.displayCurrencyData)
    setSuppressedDividends(data.suppressedDividendsData)
    setEditPurchaseDate(data.stockData.purchase_date || '')
    setError(null)
  }, [])

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
        const data = await loadStockPageData(ticker)
        if (!active) return
        applyLoadedStockPageData(data)
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
    
    fetchData()

    return () => {
      active = false
    }
  }, [applyLoadedStockPageData, loadStockPageData, ticker])

  useEffect(() => {
    setStock(null)
    setError(null)
    setRefreshing(false)
    setCompanyProfile(null)
    setFinancialMetrics(null)
    setPeers([])
    setFinnhubLoading(false)
    setFinnhubDataLoaded(false)
    finnhubRequestRef.current = null
    setAnalystData(null)
    setAnalystDataLoaded(false)
    setAnalystDataLoading(false)
    analystRequestRef.current = null
    marketstackRequestRef.current = null
    setLogoFailed(false)
    setStockSummary(null)
  }, [ticker])

  const loadFinnhubData = useCallback((force: boolean = false) => {
    if (!ticker) return Promise.resolve()
    if (!force && finnhubDataLoaded) return Promise.resolve()
    if (finnhubRequestRef.current) return finnhubRequestRef.current

    const activeTicker = ticker
    setFinnhubLoading(true)

    const request = Promise.allSettled([
      api.finnhub.profile(activeTicker),
      api.finnhub.metrics(activeTicker),
      api.finnhub.peers(activeTicker),
    ]).then((results) => {
      if (tickerRef.current !== activeTicker) return
      const [profileResult, metricsResult, peersResult] = results
      if (profileResult.status === 'fulfilled') {
        setCompanyProfile(profileResult.value)
      } else {
        console.error('Failed to load Finnhub profile', profileResult.reason)
      }
      if (metricsResult.status === 'fulfilled') {
        setFinancialMetrics(metricsResult.value)
      } else {
        console.error('Failed to load Finnhub metrics', metricsResult.reason)
      }
      if (peersResult.status === 'fulfilled') {
        setPeers(peersResult.value)
      } else {
        console.error('Failed to load Finnhub peers', peersResult.reason)
      }
      if (
        profileResult.status === 'fulfilled'
        && metricsResult.status === 'fulfilled'
        && peersResult.status === 'fulfilled'
      ) {
        setFinnhubDataLoaded(true)
      }
    }).finally(() => {
      if (finnhubRequestRef.current === request) {
        finnhubRequestRef.current = null
      }
      if (tickerRef.current === activeTicker) {
        setFinnhubLoading(false)
      }
    })

    finnhubRequestRef.current = request
    return request
  }, [ticker, finnhubDataLoaded])

  const loadAnalystData = useCallback((force: boolean = false) => {
    if (!ticker) return Promise.resolve()
    if (!force && analystDataLoaded) return Promise.resolve()
    if (analystRequestRef.current) return analystRequestRef.current

    const activeTicker = ticker
    setAnalystDataLoading(true)

    const request = api.stocks.analyst(activeTicker)
      .then((analystInfo) => {
        if (tickerRef.current !== activeTicker) return
        setAnalystData(analystInfo)
        setAnalystDataLoaded(true)
      })
      .catch((err) => {
        if (tickerRef.current === activeTicker) {
          console.error('Failed to load analyst data', err)
        }
      })
      .finally(() => {
        if (analystRequestRef.current === request) {
          analystRequestRef.current = null
        }
        if (tickerRef.current === activeTicker) {
          setAnalystDataLoading(false)
        }
      })

    analystRequestRef.current = request
    return request
  }, [ticker, analystDataLoaded])

  const loadMarketstackStatus = useCallback((force: boolean = false) => {
    if (!ticker) return Promise.resolve()
    if (marketstackRequestRef.current) return marketstackRequestRef.current
    if (!force && marketstackStatus) return Promise.resolve()

    const activeTicker = ticker
    const request = api.marketstack.status()
      .then((status) => {
        if (tickerRef.current !== activeTicker) return
        setMarketstackStatus(status)
      })
      .catch(() => undefined)
      .finally(() => {
        if (marketstackRequestRef.current === request) {
          marketstackRequestRef.current = null
        }
      })

    marketstackRequestRef.current = request
    return request
  }, [ticker, marketstackStatus])

  useEffect(() => {
    if (activeTab !== 'profile') return
    void loadFinnhubData()
  }, [activeTab, loadFinnhubData])

  useEffect(() => {
    if (activeTab !== 'analyst') return
    void loadAnalystData()
  }, [activeTab, loadAnalystData])

  useEffect(() => {
    if (activeTab !== 'dividends') return
    void loadMarketstackStatus()
  }, [activeTab, loadMarketstackStatus])

  useEffect(() => {
    if (!ticker || loading) return

    const prefetchTimer = window.setTimeout(() => {
      void loadFinnhubData()
      void loadAnalystData()
      void loadMarketstackStatus()
    }, 150)

    return () => {
      window.clearTimeout(prefetchTimer)
    }
  }, [ticker, loading, loadFinnhubData, loadAnalystData, loadMarketstackStatus])

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
      setEditError(null)
      setEditQuantity(stock.quantity.toString())
      setEditPurchasePrice(stock.purchase_price?.toString() || '')
      setEditPurchaseDate(stock.purchase_date || '')
      setShowEditModal(true)
    }
  }

  const handleSaveEdit = async () => {
    if (!ticker || !stock) return
    const quantityValue = editQuantity.trim()
    const purchasePriceValue = editPurchasePrice.trim()
    const parsedQuantity = Number(quantityValue)
    const parsedPurchasePrice = Number(purchasePriceValue)
    const nextQuantity = quantityValue === '' ? undefined : parsedQuantity
    const nextPurchasePrice = purchasePriceValue === '' ? undefined : parsedPurchasePrice

    if (
      (nextQuantity !== undefined && (!Number.isFinite(nextQuantity) || nextQuantity < 0))
      || (nextPurchasePrice !== undefined && (!Number.isFinite(nextPurchasePrice) || nextPurchasePrice < 0))
    ) {
      setEditError(t(language, 'stockDetail.invalidPositionValues'))
      return
    }

    if (editPurchaseDate) {
      const [year, month, day] = editPurchaseDate.split('-').map(Number)
      const parsedDate = Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(day)
        ? new Date(year, month - 1, day)
        : null
      if (parsedDate) {
        parsedDate.setHours(0, 0, 0, 0)
        const today = new Date()
        today.setHours(0, 0, 0, 0)
        if (parsedDate.getTime() > today.getTime()) {
          setEditError(t(language, 'stockDetail.invalidPurchaseDate'))
          return
        }
      }
    }

    try {
      setEditError(null)
      setSaving(true)
      await api.stocks.update(ticker, {
        quantity: nextQuantity,
        purchase_price: nextPurchasePrice,
        purchase_date: editPurchaseDate || null,
      })
      const data = await loadStockPageData(ticker)
      if (tickerRef.current !== ticker) return
      applyLoadedStockPageData(data)
      setShowEditModal(false)
    } catch (err) {
      setEditError(err instanceof Error ? err.message : String(err))
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

  const handleRefresh = async () => {
    if (!ticker) return

    try {
      setRefreshing(true)
      setError(null)

      await api.stocks.refresh(ticker)
      const data = await loadStockPageData(ticker)

      if (tickerRef.current !== ticker) return

      applyLoadedStockPageData(data)
      setVerificationResult(null)

      const followUpRequests: Promise<unknown>[] = []
      if (activeTab === 'profile' || finnhubDataLoaded) {
        followUpRequests.push(loadFinnhubData(true))
      }
      if (activeTab === 'analyst' || analystDataLoaded) {
        followUpRequests.push(loadAnalystData(true))
      }
      if (activeTab === 'dividends' || marketstackStatus) {
        followUpRequests.push(loadMarketstackStatus(true))
      }

      if (followUpRequests.length > 0) {
        await Promise.allSettled(followUpRequests)
      }
    } catch (err) {
      if (tickerRef.current === ticker) {
        setError(err instanceof Error ? err.message : t(language, 'stockDetail.failedLoad'))
      }
    } finally {
      if (tickerRef.current === ticker) {
        setRefreshing(false)
      }
    }
  }

  const openAddDividendModal = () => {
    setDividendError(null)
    setEditingDividend(null)
    setDivDate('')
    setDivAmount('')
    setDivNote('')
    setShowDividendModal(true)
  }

  const openEditDividendModal = (div: ManualDividend) => {
    setDividendError(null)
    setEditingDividend(div)
    setDivDate(div.date)
    setDivAmount(div.amount.toString())
    setDivNote(div.note || '')
    setShowDividendModal(true)
  }

  const handleSaveDividend = async () => {
    if (!ticker || !divDate || !divAmount) return
    const amount = Number.parseFloat(divAmount)
    if (!Number.isFinite(amount) || amount < 0) {
      setDividendError(t(language, 'stockDetail.invalidDividendAmount'))
      return
    }
    try {
      setDividendError(null)
      setSaving(true)
      if (editingDividend) {
        const updated = await api.stocks.updateManualDividend(ticker, editingDividend.id, {
          date: divDate,
          amount,
          note: divNote || undefined,
        })
        setStock(updated)
      } else {
        const updated = await api.stocks.addManualDividend(ticker, {
          date: divDate,
          amount,
          currency: stock?.currency,
          note: divNote || undefined,
        })
        setStock(updated)
      }
      setShowDividendModal(false)
    } catch (err) {
      setDividendError(err instanceof Error ? err.message : String(err))
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

  if (loading || (ticker && stock && stock.ticker !== ticker.toUpperCase())) {
    return <div className="loading-state">{t(language, 'common.loading')}</div>
  }

  if (error || !stock) {
    return (
      <div style={{ textAlign: 'center', padding: '60px 24px' }}>
        <p style={{ color: 'var(--red)', marginBottom: '16px' }}>{error || t(language, 'stockDetail.notFound')}</p>
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

  const displayPurchasePrice =
    stockSummary?.total_cost_converted && stockSummary.total_cost !== null && stock.quantity > 0
      ? stockSummary.total_cost / stock.quantity
      : null
  const displayCurrentPrice = stockSummary?.display_price_converted ? stockSummary.display_price : null
  const displayCurrentValue = stockSummary?.current_value_converted ? stockSummary.current_value : null
  const displayTotalCost = stockSummary?.total_cost_converted ? (stockSummary.total_cost ?? null) : null

  const renderValueWithDisplayCurrency = (
    amount: number | null,
    fromCurrency: string,
    displayAmount: number | null,
    align: 'left' | 'right' = 'right',
  ) => {
    const textAlign = align

    return (
      <div style={{ textAlign }}>
        <div>{formatCurrency(amount, locale, fromCurrency)}</div>
        {amount !== null && fromCurrency !== displayCurrency && displayAmount !== null && (
          <div style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>
            {formatCurrency(displayAmount, locale, displayCurrency)}
          </div>
        )}
      </div>
    )
  }

  const formatYearTotal = (value: number | null) => {
    if (value === null) return t(language, 'stockDetail.partial')
    return formatCurrency(value, locale, displayCurrency)
  }

  const displayName = formatDisplayName(stock.name, stock.ticker)
  const resolvedLogoUrl = resolveBackendAssetUrl(stock.logo)
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
  const sortedManualDividends = sortTableItems(
    stock.manual_dividends ?? [],
    manualSortState,
    {
      date: (div) => div.date,
      amount: (div) => div.amount,
      note: (div) => div.note,
    },
    locale,
    (div) => div.id
  )
  const sortedYearDividends = sortTableItems(
    yearDividends,
    yearSortState,
    {
      exDate: (div) => div.ex_date,
      paymentDate: (div) => div.payment_date,
      amount: (div) => div.amount_per_share,
      status: (div) => div.status,
      source: (div) => div.source,
    },
    locale,
    (div) => `${div.ex_date}|${div.payment_date ?? ''}|${div.source ?? ''}`
  )
  const sortedHistoryDividends = sortTableItems(
    dividends,
    historySortState,
    {
      date: (div) => div.date,
      amount: (div) => div.amount,
    },
    locale,
    (div) => `${div.date}|${div.amount}|${div.currency ?? stock.currency}`
  ).slice(0, 20)
  const sortedVerificationDiscrepancies = sortTableItems(
    verificationResult?.discrepancies ?? [],
    verificationSortState,
    {
      date: (item) => item.date,
      type: (item) => item.type,
      yahoo: (item) => item.yahoo_amount,
      marketstack: (item) => item.marketstack_amount,
      difference: (item) => item.difference,
    },
    locale,
    (item) => `${item.date}|${item.type}`
  )
  const sortedSuppressedDividends = sortTableItems(
    suppressedDividends,
    suppressedSortState,
    {
      date: (div) => div.date,
      amount: (div) => div.amount,
    },
    locale,
    (div) => div.id
  )

  const panelStyle = { background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8 }
  const secLabel = { fontSize: 9, fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase' as const, color: 'var(--muted)' }

  return (
    <div>
      {/* Back link */}
      <div style={{ marginBottom: '20px' }}>
        <Link to="/stocks" style={{ color: 'var(--v2)', textDecoration: 'none', fontSize: 13 }}>
          ← {t(language, 'stockDetail.backToStocks')}
        </Link>
      </div>

      {/* Hero header */}
      <div style={{
        background: 'linear-gradient(115deg, #12141c 0%, var(--bg) 55%)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: '28px 28px 24px',
        marginBottom: 20,
        position: 'relative',
        overflow: 'hidden',
      }}>
        {/* Radial glow */}
        <div style={{
          position: 'absolute', top: -60, right: -60,
          width: 280, height: 280,
          background: 'radial-gradient(circle, rgba(129,140,248,0.07) 0%, transparent 70%)',
          pointerEvents: 'none',
        }} />

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, position: 'relative' }}>
          {/* Left: logo + name + price */}
          <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
            {resolvedLogoUrl && !logoFailed ? (
              <img
                src={resolvedLogoUrl || undefined}
                alt={displayName}
                style={{ width: 52, height: 52, borderRadius: 10, objectFit: 'contain', background: 'var(--bg3)', padding: 6, border: '1px solid var(--border2)', flexShrink: 0 }}
                onError={() => setLogoFailed(true)}
              />
            ) : (
              <div style={{ width: 52, height: 52, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, fontWeight: 700, color: 'var(--muted)', background: 'var(--bg3)', border: '1px solid var(--border2)', flexShrink: 0 }}>
                {displayName.charAt(0).toUpperCase()}
              </div>
            )}
            <div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 2 }}>
                <h1 style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-0.02em', margin: 0 }}>{stock.ticker}</h1>
                <span style={{ color: 'var(--text2)', fontSize: 15 }}>{displayName}</span>
                {stock.sector && <span className="badge badge-muted">{stock.sector}</span>}
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginTop: 10 }}>
                <span className="mono" style={{ fontSize: 30, fontWeight: 700, color: 'var(--text)' }}>
                  {formatCurrency(stock.current_price, locale, stock.currency)}
                </span>
                {stock.currency !== displayCurrency && displayCurrentPrice !== null && (
                  <span className="mono" style={{ fontSize: 14, color: 'var(--muted)' }}>
                    {formatCurrency(displayCurrentPrice, locale, displayCurrency)}
                  </span>
                )}
                {dailyChange !== null && (
                  <span className={`mono ${dailyChange >= 0 ? 'up' : 'dn'}`} style={{ fontSize: 15 }}>
                    {dailyChange >= 0 ? '+' : ''}{formatCurrency(dailyChange, locale, stock.currency)}
                    {dailyChangePercent !== null && ` (${dailyChangePercent.toFixed(2)}%)`}
                  </span>
                )}
                <span style={{ color: 'var(--muted)', fontSize: 12 }}>{stock.currency}</span>
              </div>
              <div style={{ marginTop: 8, color: 'var(--muted)', fontSize: 11 }}>
                {t(language, 'common.lastUpdated')}: {formatTimeInTimezone(stock.last_updated, timezone, locale)} · {t(language, 'common.autoRefresh10m')}
              </div>
            </div>
          </div>

          {/* Right: action buttons */}
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            <button className="btn btn-secondary" onClick={handleRefresh} disabled={refreshing}>
              {refreshing ? t(language, 'common.refreshing') : t(language, 'common.refresh')}
            </button>
            <button className="btn btn-secondary" onClick={openEditModal}>{t(language, 'stockDetail.edit')}</button>
            <button className="btn btn-danger" onClick={handleDelete}>{t(language, 'common.delete')}</button>
          </div>
        </div>
      </div>

      {/* Tab bar */}
      <div style={{ marginBottom: 20, borderBottom: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', gap: 4 }} role="tablist" onKeyDown={handleTabKeyDown}>
          {tabs.map((tab) => (
            <button
              key={tab}
              id={`tab-${tab}`}
              onClick={() => setActiveTab(tab)}
              type="button"
              role="tab"
              aria-selected={activeTab === tab}
              aria-controls={`panel-${tab}`}
              tabIndex={activeTab === tab ? 0 : -1}
              style={{
                padding: '10px 16px',
                background: 'none',
                border: 'none',
                borderBottom: activeTab === tab ? '2px solid var(--v)' : '2px solid transparent',
                color: activeTab === tab ? 'var(--text)' : 'var(--muted)',
                cursor: 'pointer',
                fontSize: 13,
                fontWeight: activeTab === tab ? 600 : 400,
                transition: 'color 0.15s',
              }}
            >
              {tabLabels[tab] ?? tab}
            </button>
          ))}
        </div>
      </div>

      {/* Overview tab */}
      {activeTab === 'overview' && (
        <div className="grid grid-2" role="tabpanel" id="panel-overview" aria-labelledby="tab-overview">
          <div style={panelStyle}>
            <div className="sec-row" style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
              <span className="sec-title">{t(language, 'stockDetail.position')}</span>
            </div>
            <table style={{ margin: 0 }}>
              <tbody>
                <tr>
                  <td style={{ color: 'var(--muted)', fontSize: 13 }}>{t(language, 'stockDetail.quantity')}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{stock.quantity}</td>
                </tr>
                <tr>
                  <td style={{ color: 'var(--muted)', fontSize: 13 }}>{t(language, 'stockDetail.purchasePrice')}</td>
                  <td>{renderValueWithDisplayCurrency(stock.purchase_price, stock.currency, displayPurchasePrice)}</td>
                </tr>
                <tr>
                  <td style={{ color: 'var(--muted)', fontSize: 13 }}>{t(language, 'stockDetail.purchaseDate')}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{stock.purchase_date ? formatDate(stock.purchase_date, locale) : '-'}</td>
                </tr>
                <tr>
                  <td style={{ color: 'var(--muted)', fontSize: 13 }}>{t(language, 'stockDetail.currentValue')}</td>
                  <td>{renderValueWithDisplayCurrency(stock.current_price != null ? stock.current_price * stock.quantity : null, stock.currency, displayCurrentValue)}</td>
                </tr>
                <tr>
                  <td style={{ color: 'var(--muted)', fontSize: 13 }}>{t(language, 'stockDetail.totalCost')}</td>
                  <td>{renderValueWithDisplayCurrency(stock.purchase_price != null ? stock.purchase_price * stock.quantity : null, stock.currency, displayTotalCost)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div style={panelStyle}>
            <div className="sec-row" style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
              <span className="sec-title">{t(language, 'stockDetail.dividendInfo')}</span>
            </div>
            <table style={{ margin: 0 }}>
              <tbody>
                <tr>
                  <td style={{ color: 'var(--muted)', fontSize: 13 }}>{t(language, 'stockDetail.dividendYield')}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>
                    {displayDividendYield !== null
                      ? new Intl.NumberFormat(locale, { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(displayDividendYield / 100)
                      : '-'}
                  </td>
                </tr>
                <tr>
                  <td style={{ color: 'var(--muted)', fontSize: 13 }}>{t(language, 'stockDetail.dividendPerShare')}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{formatCurrency(displayDividendPerShare, locale, stock.currency)}</td>
                </tr>
                <tr>
                  <td style={{ color: 'var(--muted)', fontSize: 13 }}>{t(language, 'stockDetail.annualIncome')}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>
                    {displayAnnualIncome !== null ? formatCurrency(displayAnnualIncome, locale, stock.currency) : '-'}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Profile tab */}
      {activeTab === 'profile' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }} role="tabpanel" id="panel-profile" aria-labelledby="tab-profile">
          <CompanyProfileComponent profile={companyProfile} loading={finnhubLoading} />
          <FinancialMetricsComponent metrics={financialMetrics} loading={finnhubLoading} />
          <PeerCompanies peers={peers} loading={finnhubLoading} />
          {!finnhubLoading && finnhubDataLoaded && !hasProfileContent && (
            <div style={panelStyle}>
              <div className="sec-row" style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
                <span className="sec-title">{t(language, 'stockDetail.profileSnapshot')}</span>
              </div>
              <div style={{ padding: '16px' }}>
                <p style={{ color: 'var(--muted)', marginBottom: 16, fontSize: 13 }}>
                  {t(language, 'stockDetail.profileSnapshotDesc')}
                </p>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
                  {[
                    { label: t(language, 'stockDetail.sector'), value: stock.sector || '-' },
                    { label: t(language, 'stockDetail.dividendPerShareModeled'), value: formatCurrency(displayDividendPerShare, locale, stock.currency) },
                    { label: t(language, 'stockDetail.annualIncome'), value: displayAnnualIncome !== null ? formatCurrency(displayAnnualIncome, locale, stock.currency) : '-' },
                  ].map(({ label, value }) => (
                    <div key={label} style={{ background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6, padding: '12px 14px' }}>
                      <div style={{ ...secLabel, marginBottom: 6 }}>{label}</div>
                      <div className="mono" style={{ fontSize: 15, fontWeight: 600 }}>{value}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Dividends tab */}
      {activeTab === 'dividends' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }} role="tabpanel" id="panel-dividends" aria-labelledby="tab-dividends">

          {/* Manual dividends */}
          <div style={panelStyle}>
            <div className="sec-row" style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
              <span className="sec-title">{t(language, 'stockDetail.manualDividends')}</span>
              <button className="btn btn-primary" style={{ padding: '5px 14px', fontSize: 12 }} onClick={openAddDividendModal}>
                {t(language, 'stockDetail.addDividend')}
              </button>
            </div>
            {stock.manual_dividends && stock.manual_dividends.length > 0 ? (
              <table style={{ margin: 0 }}>
                <thead>
                  <tr>
                    <SortableHeader field="date" label={t(language, 'stockDetail.date')} sortState={manualSortState} onSort={requestManualSort} />
                    <SortableHeader field="amount" label={t(language, 'stockDetail.amount')} sortState={manualSortState} onSort={requestManualSort} align="right" />
                    <SortableHeader field="note" label={t(language, 'stockDetail.note')} sortState={manualSortState} onSort={requestManualSort} />
                    <th>{t(language, 'common.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedManualDividends.map((div) => (
                    <tr key={div.id}>
                      <td className="mono">{formatDate(div.date, locale)}</td>
                      <td className="mono" style={{ color: 'var(--green)' }}>{formatCurrency(div.amount, locale, div.currency)}</td>
                      <td style={{ color: 'var(--text2)', fontSize: 12 }}>{div.note || '-'}</td>
                      <td>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button className="btn btn-secondary" style={{ padding: '3px 10px', fontSize: 11 }} onClick={() => openEditDividendModal(div)}>
                            {t(language, 'stockDetail.edit')}
                          </button>
                          <button className="btn btn-danger" style={{ padding: '3px 10px', fontSize: 11 }} onClick={() => handleDeleteDividend(div.id)}>
                            {t(language, 'common.delete')}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="empty-state">{t(language, 'stockDetail.noManualDividends')}</div>
            )}
          </div>

          {/* Dividends this year */}
          {yearDividends.length > 0 && (
            <div style={panelStyle}>
              <div className="sec-row" style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
                <span className="sec-title">{t(language, 'stockDetail.dividendsThisYear')}</span>
                <div style={{ display: 'flex', gap: 20, fontSize: 12 }}>
                  <span style={{ color: 'var(--muted)' }}>
                    {t(language, 'stockDetail.received')}: <strong className="mono" style={{ color: 'var(--green)' }}>{formatYearTotal(yearReceived)}</strong>
                  </span>
                  <span style={{ color: 'var(--muted)' }}>
                    {t(language, 'stockDetail.remaining')}: <strong className="mono" style={{ color: 'var(--v2)' }}>{formatYearTotal(yearRemaining)}</strong>
                  </span>
                </div>
              </div>
              <table style={{ margin: 0 }}>
                <thead>
                  <tr>
                    <SortableHeader field="exDate" label={t(language, 'stockDetail.exDate')} sortState={yearSortState} onSort={requestYearSort} />
                    <SortableHeader field="paymentDate" label={t(language, 'stockDetail.dividendDate')} sortState={yearSortState} onSort={requestYearSort} />
                    <SortableHeader field="amount" label={t(language, 'stockDetail.amount')} sortState={yearSortState} onSort={requestYearSort} align="right" />
                    <SortableHeader field="status" label={t(language, 'stockDetail.status')} sortState={yearSortState} onSort={requestYearSort} />
                    <SortableHeader field="source" label={t(language, 'stockDetail.source')} sortState={yearSortState} onSort={requestYearSort} />
                  </tr>
                </thead>
                <tbody>
                  {sortedYearDividends.map((div) => (
                    <tr key={`${div.ex_date}-${div.payment_date || ''}-${div.amount_per_share ?? ''}-${div.dividend_type || ''}-${div.source || ''}`}>
                      <td className="mono">{formatDate(div.ex_date, locale)}</td>
                      <td className="mono">{div.payment_date ? formatDate(div.payment_date, locale) : '-'}</td>
                      <td className="mono">{formatCurrency(div.amount_per_share, locale, div.currency || stock.currency)}</td>
                      <td>
                        <span className={`badge ${div.status === 'paid' ? 'badge-green' : 'badge-violet'}`}>
                          {div.status === 'paid' ? t(language, 'stockDetail.paid') : t(language, 'stockDetail.upcoming')}
                        </span>
                      </td>
                      <td><span className="badge badge-muted">{div.source || 'historical'}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* 5-year history */}
          <div style={panelStyle}>
            <div className="sec-row" style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
              <span className="sec-title">{t(language, 'stockDetail.history5y')}</span>
            </div>
            {dividends.length === 0 ? (
              <div className="empty-state">{t(language, 'stockDetail.noHistory')}</div>
            ) : (
              <table style={{ margin: 0 }}>
                <thead>
                  <tr>
                    <SortableHeader field="date" label={t(language, 'stockDetail.date')} sortState={historySortState} onSort={requestHistorySort} />
                    <SortableHeader field="amount" label={t(language, 'stockDetail.amount')} sortState={historySortState} onSort={requestHistorySort} align="right" />
                    <th>{t(language, 'common.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedHistoryDividends.map((div) => {
                    const suppressed = isDividendSuppressed(div.date)
                    const rowKey = [
                      div.date,
                      div.amount,
                      div.currency || stock.currency,
                    ].join('|')
                    return (
                      <tr key={rowKey} style={{ opacity: suppressed ? 0.45 : 1 }}>
                        <td className="mono">{formatDate(div.date, locale)}</td>
                        <td className="mono" style={{ color: suppressed ? 'var(--muted)' : 'var(--green)' }}>
                          {formatCurrency(div.amount, locale, div.currency || stock.currency)}
                          {suppressed && <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--muted)' }}>{t(language, 'stockDetail.suppressedTag')}</span>}
                        </td>
                        <td>
                          {suppressed ? (
                            <button className="btn btn-secondary" style={{ padding: '3px 10px', fontSize: 11 }} onClick={() => handleRestoreDividend(div.date)}>
                              {t(language, 'stockDetail.restore')}
                            </button>
                          ) : (
                            <button className="btn btn-secondary" style={{ padding: '3px 10px', fontSize: 11 }} onClick={() => handleSuppressDividend(div.date, div.amount)}>
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

          {/* Verification */}
          <div style={panelStyle}>
            <div className="sec-row" style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
              <span className="sec-title">{t(language, 'stockDetail.verification')}</span>
              {marketstackStatus && (
                <span className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>
                  API: {marketstackStatus.calls_remaining}/{marketstackStatus.calls_limit} {t(language, 'stockDetail.callsRemaining')}
                </span>
              )}
            </div>
            <div style={{ padding: '16px' }}>
              {marketstackStatus && marketstackStatus.api_configured === false ? (
                <p className="empty-state">{t(language, 'stockDetail.apiNotConfigured')}</p>
              ) : verificationLoading ? (
                <p className="loading-state">{t(language, 'stockDetail.verifying')}</p>
              ) : verificationResult ? (
                <div>
                  <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
                    {[
                      { label: 'Yahoo', value: verificationResult.summary.yahoo_count, color: 'var(--text)' },
                      { label: 'Marketstack', value: verificationResult.summary.marketstack_count, color: 'var(--text)' },
                      { label: t(language, 'stockDetail.matches'), value: verificationResult.summary.match_count, color: 'var(--green)' },
                      { label: t(language, 'stockDetail.discrepancies'), value: verificationResult.summary.discrepancy_count, color: verificationResult.summary.discrepancy_count > 0 ? 'var(--red)' : 'var(--text)' },
                    ].map(({ label, value, color }) => (
                      <div key={label} style={{ padding: '10px 16px', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6, minWidth: 90 }}>
                        <div style={{ ...secLabel, marginBottom: 4 }}>{label}</div>
                        <div className="mono" style={{ fontSize: 22, fontWeight: 700, color }}>{value}</div>
                      </div>
                    ))}
                  </div>
                  {verificationResult.cached && (
                    <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 12 }}>
                      {t(language, 'stockDetail.cachedAt', { date: new Date(verificationResult.verified_at).toLocaleString(locale) })}
                    </p>
                  )}
                  {verificationResult.discrepancies.length > 0 && (
                    <div style={{ marginBottom: 16 }}>
                      <div style={{ ...secLabel, marginBottom: 10 }}>{t(language, 'stockDetail.discrepancyDetails')}</div>
                      <table style={{ margin: 0 }}>
                        <thead>
                          <tr>
                            <SortableHeader field="date" label={t(language, 'stockDetail.date')} sortState={verificationSortState} onSort={requestVerificationSort} />
                            <SortableHeader field="type" label={t(language, 'stockDetail.type')} sortState={verificationSortState} onSort={requestVerificationSort} />
                            <SortableHeader field="yahoo" label="Yahoo" sortState={verificationSortState} onSort={requestVerificationSort} align="right" />
                            <SortableHeader field="marketstack" label="Marketstack" sortState={verificationSortState} onSort={requestVerificationSort} align="right" />
                            <SortableHeader field="difference" label={t(language, 'stockDetail.difference')} sortState={verificationSortState} onSort={requestVerificationSort} align="right" />
                          </tr>
                        </thead>
                        <tbody>
                          {sortedVerificationDiscrepancies.map((d, i) => (
                            <tr key={i}>
                              <td className="mono">{d.date || '-'}</td>
                              <td>
                                <span className="badge" style={{
                                  background: d.type === 'amount_mismatch' ? 'rgba(251,191,36,0.15)' :
                                             d.type === 'missing_from_yahoo' ? 'rgba(56,189,248,0.15)' :
                                             d.type === 'missing_from_marketstack' ? 'rgba(249,115,22,0.15)' : 'rgba(248,113,113,0.15)',
                                  color: d.type === 'amount_mismatch' ? 'var(--amber)' :
                                         d.type === 'missing_from_yahoo' ? 'var(--sky)' :
                                         d.type === 'missing_from_marketstack' ? '#f97316' : 'var(--red)',
                                }}>
                                  {d.type.replace(/_/g, ' ')}
                                </span>
                              </td>
                              <td className="mono">{d.yahoo_amount !== null ? formatCurrency(d.yahoo_amount, locale, stock.currency) : '-'}</td>
                              <td className="mono">{d.marketstack_amount !== null ? formatCurrency(d.marketstack_amount, locale, stock.currency) : '-'}</td>
                              <td className="mono">{d.difference !== null ? formatCurrency(d.difference, locale, stock.currency) : '-'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <button className="btn btn-secondary" onClick={handleVerifyDividends}
                    disabled={verificationLoading || (marketstackStatus !== null && (marketstackStatus.calls_remaining ?? 0) <= 0)}>
                    {t(language, 'stockDetail.reverify')}
                  </button>
                </div>
              ) : (
                <div style={{ textAlign: 'center', padding: '20px 0' }}>
                  <p style={{ color: 'var(--muted)', marginBottom: 16, fontSize: 13 }}>
                    {t(language, 'stockDetail.verifyDescription')}
                  </p>
                  <button className="btn btn-primary" onClick={handleVerifyDividends}
                    disabled={verificationLoading || (marketstackStatus !== null && (marketstackStatus.calls_remaining ?? 0) <= 0)}>
                    {t(language, 'stockDetail.verify')}
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Suppressed dividends */}
          {suppressedDividends.length > 0 && (
            <div style={panelStyle}>
              <div className="sec-row" style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
                <span className="sec-title" style={{ color: 'var(--muted)' }}>{t(language, 'stockDetail.suppressedDividends')}</span>
              </div>
              <table style={{ margin: 0 }}>
                <thead>
                  <tr>
                    <SortableHeader field="date" label={t(language, 'stockDetail.date')} sortState={suppressedSortState} onSort={requestSuppressedSort} />
                    <SortableHeader field="amount" label={t(language, 'stockDetail.amount')} sortState={suppressedSortState} onSort={requestSuppressedSort} align="right" />
                    <th>{t(language, 'common.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedSuppressedDividends.map((div) => (
                    <tr key={div.id}>
                      <td className="mono">{formatDate(div.date, locale)}</td>
                      <td className="mono">{formatCurrency(div.amount || 0, locale, div.currency || stock.currency)}</td>
                      <td>
                        <button className="btn btn-secondary" style={{ padding: '3px 10px', fontSize: 11 }} onClick={() => handleRestoreDividend(div.date)}>
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

      {/* Analyst tab */}
      {activeTab === 'analyst' && (
        <div role="tabpanel" id="panel-analyst" aria-labelledby="tab-analyst">
          {analystDataLoading ? (
            <div className="loading-state">{t(language, 'stockDetail.loadingAnalyst')}</div>
          ) : (
            <>
              <YfinanceAnalystPanel
                priceTargets={analystData?.price_targets || null}
                recommendations={analystData?.recommendations || null}
                finnhubRecommendations={analystData?.finnhub_recommendations || null}
                currency={stock?.currency || 'USD'}
                currentPrice={stock?.current_price ?? null}
              />
              {!analystData?.price_targets && !analystData?.recommendations?.length && !analystData?.finnhub_recommendations?.length && !analystDataLoading && analystDataLoaded && (
                <div className="empty-state">{t(language, 'stockDetail.noAnalyst')}</div>
              )}
            </>
          )}
        </div>
      )}

      {/* Edit position modal */}
      {showEditModal && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
          onClick={closeEditModal}
        >
          <div
            style={{ width: 400, maxWidth: '92vw', background: 'var(--bg2)', border: '1px solid var(--border2)', borderRadius: 10, padding: 24 }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby={editModalHeadingId}
            ref={editModalRef}
            tabIndex={-1}
          >
            <h3 id={editModalHeadingId} style={{ marginBottom: 20, fontSize: 16, fontWeight: 600 }}>{t(language, 'stockDetail.editPosition')}</h3>
            <div style={{ marginBottom: 14 }}>
              <label htmlFor={editQuantityInputId} style={{ display: 'block', marginBottom: 6, color: 'var(--muted)', fontSize: 12 }}>{t(language, 'stockDetail.quantity')}</label>
              <input id={editQuantityInputId} type="number" step="0.01" min="0" value={editQuantity} onChange={(e) => setEditQuantity(e.target.value)} style={{ width: '100%' }} />
            </div>
            <div style={{ marginBottom: 14 }}>
              <label htmlFor={editPurchasePriceInputId} style={{ display: 'block', marginBottom: 6, color: 'var(--muted)', fontSize: 12 }}>{t(language, 'stockDetail.purchasePrice')} ({stock?.currency})</label>
              <input id={editPurchasePriceInputId} type="number" step="0.01" min="0" value={editPurchasePrice} onChange={(e) => setEditPurchasePrice(e.target.value)} style={{ width: '100%' }} placeholder="e.g. 150.00" />
            </div>
            <div style={{ marginBottom: 22 }}>
              <label htmlFor={editPurchaseDateInputId} style={{ display: 'block', marginBottom: 6, color: 'var(--muted)', fontSize: 12 }}>{t(language, 'stockDetail.purchaseDate')}</label>
              <input id={editPurchaseDateInputId} type="date" value={editPurchaseDate} onChange={(e) => setEditPurchaseDate(e.target.value)} style={{ width: '100%' }} />
            </div>
            {editError && (
              <p role="alert" style={{ color: 'var(--red)', fontSize: 12, marginBottom: 14 }}>{editError}</p>
            )}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={closeEditModal}>{t(language, 'stockDetail.cancel')}</button>
              <button className="btn btn-primary" onClick={handleSaveEdit} disabled={saving}>
                {saving ? t(language, 'stockDetail.saving') : t(language, 'stockDetail.save')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add/edit dividend modal */}
      {showDividendModal && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
          onClick={closeDividendModal}
        >
          <div
            style={{ width: 400, maxWidth: '92vw', background: 'var(--bg2)', border: '1px solid var(--border2)', borderRadius: 10, padding: 24 }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby={dividendModalHeadingId}
            ref={dividendModalRef}
            tabIndex={-1}
          >
            <h3 id={dividendModalHeadingId} style={{ marginBottom: 20, fontSize: 16, fontWeight: 600 }}>
              {editingDividend ? t(language, 'stockDetail.editDividend') : t(language, 'stockDetail.addDividend')}
            </h3>
            <div style={{ marginBottom: 14 }}>
              <label htmlFor={dividendDateInputId} style={{ display: 'block', marginBottom: 6, color: 'var(--muted)', fontSize: 12 }}>{t(language, 'stockDetail.date')}</label>
              <input id={dividendDateInputId} ref={dividendDateInputRef} type="date" value={divDate} onChange={(e) => setDivDate(e.target.value)} style={{ width: '100%' }} />
            </div>
            <div style={{ marginBottom: 14 }}>
              <label htmlFor={dividendAmountInputId} style={{ display: 'block', marginBottom: 6, color: 'var(--muted)', fontSize: 12 }}>{t(language, 'stockDetail.amount')} ({stock?.currency})</label>
              <input id={dividendAmountInputId} type="number" step="0.01" min="0" value={divAmount} onChange={(e) => setDivAmount(e.target.value)} style={{ width: '100%' }} placeholder="e.g. 1.50" />
            </div>
            <div style={{ marginBottom: 22 }}>
              <label htmlFor={dividendNoteInputId} style={{ display: 'block', marginBottom: 6, color: 'var(--muted)', fontSize: 12 }}>{t(language, 'stockDetail.noteOptional')}</label>
              <input id={dividendNoteInputId} type="text" value={divNote} onChange={(e) => setDivNote(e.target.value)} style={{ width: '100%' }} placeholder="e.g. Q1 2024 dividend" />
            </div>
            {dividendError && (
              <p role="alert" style={{ color: 'var(--red)', fontSize: 12, marginBottom: 14 }}>{dividendError}</p>
            )}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={closeDividendModal}>{t(language, 'stockDetail.cancel')}</button>
              <button className="btn btn-primary" onClick={handleSaveDividend} disabled={saving || !divDate || !divAmount}>
                {saving ? t(language, 'stockDetail.saving') : t(language, 'stockDetail.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
