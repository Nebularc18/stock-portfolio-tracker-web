import { useState, useEffect, useCallback, useRef, useId, useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, PositionEntry, Stock, TickerValidationResult } from '../services/api'
import { useSettings } from '../SettingsContext'
import { formatTimeInTimezone, getLatestTimestamp } from '../utils/time'
import { resolveBackendAssetUrl } from '../utils/assets'
import { getLocaleForLanguage, t } from '../i18n'
import supportedExchanges from '../config/supportedExchanges.json'
import { useModalFocusTrap } from '../hooks/useModalFocusTrap'
import SortableHeader from '../components/SortableHeader'
import { sortTableItems, useTableSort } from '../utils/tableSort'
import { notifyPortfolioDataUpdated } from '../utils/portfolioSync'

/**
 * Formats a numeric value as a localized currency string or returns "-" when the value is null.
 *
 * @param value - Numeric amount to format; pass `null` to indicate missing value
 * @param locale - BCP 47 language tag used for localization (e.g., `"en-US"`)
 * @param currency - ISO 4217 currency code to format with (defaults to `"USD"`)
 * @returns The formatted currency string for `value`, or `"-"` if `value` is `null`
 */
function formatCurrency(value: number | null, locale: string, currency: string = 'USD'): string {
  if (value === null) return '-'
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(value)
}

function formatPurchaseDate(value: string | null, locale: string): string {
  if (!value) return '-'
  const [year, month, day] = value.split('-').map(Number)
  if (!year || !month || !day) return value
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })
}

function normalizePlatform(value: string | null | undefined): string | null {
  const normalized = value?.trim() || ''
  return normalized || null
}

function getSoldQuantity(entry: PositionEntry): number {
  const quantity = Number(entry.quantity) || 0
  if ('sold_quantity' in entry && entry.sold_quantity !== null && entry.sold_quantity !== undefined) {
    const soldQuantity = Number(entry.sold_quantity)
    return Number.isFinite(soldQuantity) && soldQuantity > 0 ? Math.min(soldQuantity, quantity) : 0
  }
  return entry.sell_date ? quantity : 0
}

function getRemainingEntryQuantity(entry: PositionEntry): number {
  const quantity = Number(entry.quantity) || 0
  return Math.max(quantity - getSoldQuantity(entry), 0)
}

function sortEntriesForSale(entries: PositionEntry[]): PositionEntry[] {
  return [...entries].sort((a, b) => {
    const aDate = a.purchase_date || '9999-12-31'
    const bDate = b.purchase_date || '9999-12-31'
    if (aDate !== bDate) return aDate.localeCompare(bDate)
    return a.id.localeCompare(b.id)
  })
}

function getOpenPlatforms(entries: PositionEntry[] | undefined): string[] {
  const platformSet = new Set<string>()
  for (const entry of entries || []) {
    if (getRemainingEntryQuantity(entry) <= 0) continue
    const platform = normalizePlatform(entry.platform)
    if (platform) {
      platformSet.add(platform)
    }
  }
  return [...platformSet].sort((a, b) => a.localeCompare(b))
}

function getPlatformSortValue(stock: Stock, unassignedLabel: string): string {
  const platforms = getOpenPlatforms(stock.position_entries)
  return platforms.length > 0 ? platforms.join(', ') : unassignedLabel
}

const EXCHANGES = [
  ...supportedExchanges,
]
const MAX_PLATFORM_LENGTH = 100

/**
 * Formats a Date as a local `YYYY-MM-DD` string suitable for date input values.
 *
 * @param value - Date to format; defaults to the current local date
 * @returns The date formatted as `YYYY-MM-DD` using local date components
 */
function getLocalDateInputValue(value: Date = new Date()): string {
  const year = value.getFullYear()
  const month = `${value.getMonth() + 1}`.padStart(2, '0')
  const day = `${value.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Create a unique client-side identifier for new position entries.
 *
 * Prefers a cryptographically random UUID when available; otherwise returns a timestamp-based fallback with a short random suffix.
 *
 * @returns A string identifier suitable for client-generated position entries (UUID when available, otherwise a timestamp-random fallback)
 */
function generateClientId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }

  return `entry-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Create a new position entry populated with default/empty values and a client-generated id.
 *
 * @returns A `PositionEntry` with `id` set to a client-generated identifier, `quantity` 0, `purchase_price` `null`, `courtage` 0, and `purchase_date` and `sell_date` set to `null`.
 */
function createEmptyPositionEntry(): PositionEntry {
  return {
    id: generateClientId(),
    quantity: 0,
    sold_quantity: null,
    purchase_price: null,
    courtage: 0,
    courtage_currency: null,
    exchange_rate: null,
    exchange_rate_currency: null,
    platform: null,
    purchase_date: null,
    sell_date: null,
  }
}

function splitTickerAndExchange(ticker: string): { baseTicker: string; exchangeCode: string } {
  const normalizedTicker = ticker.trim().toUpperCase()
  const match = [...EXCHANGES]
    .sort((a, b) => (b.suffix?.length || 0) - (a.suffix?.length || 0))
    .find((exchange) => exchange.suffix && normalizedTicker.endsWith(exchange.suffix.toUpperCase()))

  if (!match || !match.suffix) {
    return { baseTicker: normalizedTicker, exchangeCode: 'US' }
  }

  return {
    baseTicker: normalizedTicker.slice(0, -match.suffix.length),
    exchangeCode: match.code,
  }
}

type SortField =
  | 'ticker'
  | 'name'
  | 'quantity'
  | 'currency'
  | 'platform'
  | 'purchasePrice'
  | 'purchaseDate'
  | 'currentPrice'
  | 'dailyChangePercent'
  | 'dividendYield'

/**
 * Stocks page component that displays and manages the user's stock positions.
 *
 * Provides a localized interface to view current prices and daily changes, add new positions, edit existing position entries (lots), and remove holdings. Loads stocks on mount and exposes sorting, validation, and modal editing behaviour consistent with the current language and timezone settings.
 *
 * @returns A React element containing the Stocks management user interface.
 */
export default function Stocks() {
  const navigate = useNavigate()
  const [stocks, setStocks] = useState<Stock[]>([])
  const [loading, setLoading] = useState(true)
  const [showAddForm, setShowAddForm] = useState(false)
  const [newTicker, setNewTicker] = useState('')
  const [newQuantity, setNewQuantity] = useState('')
  const [newPurchasePrice, setNewPurchasePrice] = useState('')
  const [newCourtage, setNewCourtage] = useState('')
  const [newExchangeRate, setNewExchangeRate] = useState('')
  const [newPlatform, setNewPlatform] = useState('')
  const [newPurchaseDate, setNewPurchaseDate] = useState('')
  const [selectedExchange, setSelectedExchange] = useState('ST')
  const [searchTicker, setSearchTicker] = useState('')
  const [searchExchange, setSearchExchange] = useState('US')
  const [searchValidationStatus, setSearchValidationStatus] = useState<'idle' | 'checking' | 'valid' | 'invalid'>('idle')
  const [searchTickerInfo, setSearchTickerInfo] = useState<TickerValidationResult | null>(null)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)
  const [platformFilter, setPlatformFilter] = useState('all')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [validationStatus, setValidationStatus] = useState<'idle' | 'checking' | 'valid' | 'invalid'>('idle')
  const [validatedTickerInfo, setValidatedTickerInfo] = useState<TickerValidationResult | null>(null)
  const [editStock, setEditStock] = useState<Stock | null>(null)
  const [editEntries, setEditEntries] = useState<PositionEntry[]>([])
  const [editTicker, setEditTicker] = useState('')
  const [editName, setEditName] = useState('')
  const [editExchange, setEditExchange] = useState('US')
  const [editValidationStatus, setEditValidationStatus] = useState<'idle' | 'checking' | 'valid' | 'invalid'>('idle')
  const [editValidatedTickerInfo, setEditValidatedTickerInfo] = useState<TickerValidationResult | null>(null)
  const [saving, setSaving] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  const [sellStock, setSellStock] = useState<Stock | null>(null)
  const [sellQuantity, setSellQuantity] = useState('')
  const [sellDate, setSellDate] = useState(getLocalDateInputValue())
  const [sellError, setSellError] = useState<string | null>(null)
  const [selling, setSelling] = useState(false)
  const [splitStock, setSplitStock] = useState<Stock | null>(null)
  const [splitRatio, setSplitRatio] = useState('')
  const [splitDate, setSplitDate] = useState(getLocalDateInputValue())
  const [splitError, setSplitError] = useState<string | null>(null)
  const [splitting, setSplitting] = useState(false)
  const [refreshingAll, setRefreshingAll] = useState(false)
  const [lastUpdate, setLastUpdate] = useState<string | null>(null)
  const [failedLogos, setFailedLogos] = useState<Record<string, boolean>>({})
  const editModalRef = useRef<HTMLDivElement | null>(null)
  const sellModalRef = useRef<HTMLDivElement | null>(null)
  const splitModalRef = useRef<HTMLDivElement | null>(null)
  const addFormRef = useRef<HTMLDivElement | null>(null)
  const editQuantityInputRef = useRef<HTMLInputElement | null>(null)
  const sellQuantityInputRef = useRef<HTMLInputElement | null>(null)
  const splitRatioInputRef = useRef<HTMLInputElement | null>(null)
  const editModalHeadingId = useId()
  const sellModalHeadingId = useId()
  const splitModalHeadingId = useId()
  const editQuantityInputId = useId()
  const editPurchasePriceInputId = useId()
  const editPurchaseDateInputId = useId()
  const sellQuantityInputId = useId()
  const sellDateInputId = useId()
  const splitRatioInputId = useId()
  const splitDateInputId = useId()
  const { timezone, language, displayCurrency, platforms } = useSettings()
  const locale = getLocaleForLanguage(language)
  const unassignedPlatformLabel = t(language, 'stocks.platformUnassigned')
  const maxPurchaseDate = getLocalDateInputValue()
  const { sortState, requestSort } = useTableSort<SortField>({ field: 'ticker', direction: 'asc' })
  const logoTileStyle = {
    background: 'linear-gradient(180deg, rgba(255,255,255,0.96) 0%, rgba(238,242,255,0.92) 100%)',
    border: '1px solid rgba(255,255,255,0.14)',
    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.45), 0 6px 16px rgba(0,0,0,0.16)',
  }

  const closeEditModal = useCallback(() => setEditStock(null), [])
  const closeSellModal = useCallback(() => {
    setSellStock(null)
    setSellQuantity('')
    setSellDate(getLocalDateInputValue())
    setSellError(null)
  }, [])
  const closeSplitModal = useCallback(() => {
    setSplitStock(null)
    setSplitRatio('')
    setSplitDate(getLocalDateInputValue())
    setSplitError(null)
  }, [])

  useModalFocusTrap({
    modalRef: editModalRef,
    open: editStock !== null,
    onClose: closeEditModal,
    initialFocusRef: editQuantityInputRef,
  })

  useModalFocusTrap({
    modalRef: sellModalRef,
    open: sellStock !== null,
    onClose: closeSellModal,
    initialFocusRef: sellQuantityInputRef,
  })

  useModalFocusTrap({
    modalRef: splitModalRef,
    open: splitStock !== null,
    onClose: closeSplitModal,
    initialFocusRef: splitRatioInputRef,
  })

  const fetchStocks = useCallback(async () => {
    try {
      setLoading(true)
      const data = await api.stocks.list()
      setStocks(data)
      setFailedLogos({})
      setLastUpdate(getLatestTimestamp(data))
      setError(null)
    } catch (err) {
      setError(t(language, 'stocks.failedLoad'))
    } finally {
      setLoading(false)
    }
  }, [language])

  useEffect(() => {
    fetchStocks()
  }, [fetchStocks])

  const getFullTicker = (ticker: string, exchange: string) => {
    const ex = EXCHANGES.find(e => e.code === exchange)
    const suffix = ex?.suffix || ''
    return ticker.toUpperCase() + suffix
  }

  const handleTickerChange = (value: string) => {
    setNewTicker(value.toUpperCase())
    setValidationStatus('idle')
    setValidatedTickerInfo(null)
  }

  const handleExchangeChange = (exchange: string) => {
    setSelectedExchange(exchange)
    setValidationStatus('idle')
    setValidatedTickerInfo(null)
  }

  const handleSearchTickerChange = (value: string) => {
    setSearchTicker(value.toUpperCase())
    setSearchValidationStatus('idle')
    setSearchTickerInfo(null)
    setSearchError(null)
  }

  const handleSearchExchangeChange = (exchange: string) => {
    setSearchExchange(exchange)
    setSearchValidationStatus('idle')
    setSearchTickerInfo(null)
    setSearchError(null)
  }

  const selectedExchangeData = EXCHANGES.find(e => e.code === selectedExchange)
  const fullTicker = useMemo(() => getFullTicker(newTicker, selectedExchange), [newTicker, selectedExchange])
  const searchFullTicker = useMemo(() => getFullTicker(searchTicker, searchExchange), [searchTicker, searchExchange])
  const existingStock = useMemo(() => stocks.find((stock) => stock.ticker === fullTicker), [fullTicker, stocks])
  const existingSearchStock = useMemo(() => stocks.find((stock) => stock.ticker === searchFullTicker), [searchFullTicker, stocks])
  const effectiveTickerCurrency = validatedTickerInfo?.currency || selectedExchangeData?.currency || displayCurrency
  const needsExchangeFields = !!effectiveTickerCurrency && effectiveTickerCurrency !== displayCurrency
  const editExchangeData = EXCHANGES.find((exchange) => exchange.code === editExchange)
  const editFullTicker = useMemo(() => getFullTicker(editTicker, editExchange), [editTicker, editExchange])
  const editEffectiveTickerCurrency = editValidatedTickerInfo?.currency || editExchangeData?.currency || editStock?.currency || displayCurrency
  const editNeedsExchangeFields = !!editEffectiveTickerCurrency && editEffectiveTickerCurrency !== displayCurrency
  const normalizedPlatforms = useMemo(() => [...platforms].sort((a, b) => a.localeCompare(b, locale)), [locale, platforms])
  const sellableEntries = useMemo(() => (
    sortEntriesForSale((sellStock?.position_entries || [])
      .filter((entry) => getRemainingEntryQuantity(entry) > 0))
  ), [sellStock])
  const totalSellableQuantity = useMemo(() => (
    sellableEntries.reduce((sum, entry) => sum + getRemainingEntryQuantity(entry), 0)
  ), [sellableEntries])

  useEffect(() => {
    const normalizedTicker = newTicker.trim()
    if (!normalizedTicker) {
      setValidationStatus('idle')
      setValidatedTickerInfo(null)
      return
    }

    const tickerToValidate = getFullTicker(normalizedTicker, selectedExchange)
    setValidationStatus('checking')
    setValidatedTickerInfo(null)

    const timeoutId = window.setTimeout(() => {
      api.stocks.validate(tickerToValidate)
        .then((result) => {
          setValidationStatus(result.valid ? 'valid' : 'invalid')
          setValidatedTickerInfo(result)
        })
        .catch(() => {
          setValidationStatus('invalid')
          setValidatedTickerInfo(null)
        })
    }, 350)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [newTicker, selectedExchange])

  useEffect(() => {
    const normalizedTicker = searchTicker.trim()
    if (!normalizedTicker) {
      setSearchValidationStatus('idle')
      setSearchTickerInfo(null)
      return
    }

    const tickerToValidate = getFullTicker(normalizedTicker, searchExchange)
    setSearchValidationStatus('checking')
    setSearchTickerInfo(null)

    const timeoutId = window.setTimeout(() => {
      api.stocks.validate(tickerToValidate)
        .then((result) => {
          setSearchValidationStatus(result.valid ? 'valid' : 'invalid')
          setSearchTickerInfo(result)
        })
        .catch(() => {
          setSearchValidationStatus('invalid')
          setSearchTickerInfo(null)
        })
    }, 300)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [searchTicker, searchExchange])

  useEffect(() => {
    if (!editStock) {
      setEditValidationStatus('idle')
      setEditValidatedTickerInfo(null)
      return
    }

    const normalizedTicker = editTicker.trim()
    if (!normalizedTicker) {
      setEditValidationStatus('idle')
      setEditValidatedTickerInfo(null)
      return
    }

    const tickerToValidate = getFullTicker(normalizedTicker, editExchange)
    if (tickerToValidate === editStock.ticker) {
      setEditValidationStatus('valid')
      setEditValidatedTickerInfo({
        valid: true,
        name: editStock.name,
        currency: editStock.currency,
      })
      return
    }

    setEditValidationStatus('checking')
    setEditValidatedTickerInfo(null)

    const timeoutId = window.setTimeout(() => {
      api.stocks.validate(tickerToValidate)
        .then((result) => {
          setEditValidationStatus(result.valid ? 'valid' : 'invalid')
          setEditValidatedTickerInfo(result)
        })
        .catch(() => {
          setEditValidationStatus('invalid')
          setEditValidatedTickerInfo(null)
        })
    }, 350)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [editExchange, editStock, editTicker])

  const handleAddStock = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newTicker || !newQuantity) return

    const parsedPurchasePrice = newPurchasePrice ? parseFloat(newPurchasePrice) : null
    const parsedCourtage = newCourtage ? parseFloat(newCourtage) : null
    const parsedExchangeRate = newExchangeRate ? parseFloat(newExchangeRate) : null

    if (validationStatus === 'invalid') {
      setError(t(language, 'stocks.invalidTicker'))
      return
    }
    if (validationStatus === 'checking') {
      setError(t(language, 'stocks.validatingTicker'))
      return
    }

    if (parsedCourtage !== null && parsedCourtage > 0 && (parsedPurchasePrice === null || !Number.isFinite(parsedPurchasePrice) || parsedPurchasePrice <= 0)) {
      setError(t(language, 'stocks.invalidEditValues'))
      return
    }
    if (parsedExchangeRate !== null && (!Number.isFinite(parsedExchangeRate) || parsedExchangeRate <= 0)) {
      setError(t(language, 'stocks.invalidEditValues'))
      return
    }
    if ((normalizePlatform(newPlatform)?.length || 0) > MAX_PLATFORM_LENGTH) {
      setError(t(language, 'stocks.platformTooLong'))
      return
    }
    try {
      setAdding(true)
      setError(null)
      await api.stocks.create({
        ticker: fullTicker,
        quantity: parseFloat(newQuantity),
        purchase_price: parsedPurchasePrice ?? undefined,
        courtage: parsedCourtage ?? undefined,
        courtage_currency: parsedCourtage !== null ? (needsExchangeFields ? displayCurrency : effectiveTickerCurrency) : undefined,
        exchange_rate: needsExchangeFields ? (parsedExchangeRate ?? undefined) : undefined,
        exchange_rate_currency: needsExchangeFields && parsedExchangeRate !== null ? displayCurrency : undefined,
        platform: normalizePlatform(newPlatform) ?? undefined,
        purchase_date: newPurchaseDate || undefined,
      })
      setNewTicker('')
      setNewQuantity('')
      setNewPurchasePrice('')
      setNewCourtage('')
      setNewExchangeRate('')
      setNewPlatform('')
      setNewPurchaseDate('')
      setValidationStatus('idle')
      setValidatedTickerInfo(null)
      setShowAddForm(false)
      notifyPortfolioDataUpdated()
      await fetchStocks()
    } catch (err: any) {
      setError(err.message || t(language, 'stocks.failedAdd'))
    } finally {
      setAdding(false)
    }
  }

  const handleSearchStock = async (e: React.FormEvent) => {
    e.preventDefault()
    const normalizedTicker = searchTicker.trim()
    if (!normalizedTicker) {
      setSearchError(t(language, 'stocks.invalidTicker'))
      return
    }

    const lookupTicker = getFullTicker(normalizedTicker, searchExchange)
    if (searchValidationStatus === 'invalid') {
      setSearchError(t(language, 'stocks.invalidTicker'))
      return
    }
    if (searchValidationStatus === 'checking') {
      setSearchError(t(language, 'stocks.validatingTicker'))
      return
    }

    try {
      setSearching(true)
      setSearchError(null)
      navigate(`/stocks/${encodeURIComponent(lookupTicker)}`)
    } finally {
      setSearching(false)
    }
  }

  const handleDeleteStock = async (ticker: string) => {
    if (!confirm(t(language, 'stocks.removeConfirm', { ticker }))) return
    
    try {
      await api.stocks.delete(ticker)
      notifyPortfolioDataUpdated()
      await fetchStocks()
    } catch (err) {
      setError(t(language, 'stocks.failedDelete'))
    }
  }

  const handleRefreshAllStocks = async () => {
    try {
      setRefreshingAll(true)
      setError(null)
      await api.portfolio.refreshAll()
      notifyPortfolioDataUpdated()
      await fetchStocks()
    } catch (err) {
      setError(t(language, 'stocks.failedLoad'))
    } finally {
      setRefreshingAll(false)
    }
  }

  const openSellModal = (stock: Stock) => {
    const openEntries = (stock.position_entries || []).filter((entry) => getRemainingEntryQuantity(entry) > 0)
    if (openEntries.length === 0) return
    setSellStock(stock)
    setSellQuantity('')
    setSellDate(getLocalDateInputValue())
    setSellError(null)
  }

  const openSplitModal = (stock: Stock) => {
    const openEntries = (stock.position_entries || []).filter((entry) => getRemainingEntryQuantity(entry) > 0)
    if (openEntries.length === 0) return
    setSplitStock(stock)
    setSplitRatio('')
    setSplitDate(getLocalDateInputValue())
    setSplitError(null)
  }

  const openAddFormForStock = (stock: Stock) => {
    const { baseTicker, exchangeCode } = splitTickerAndExchange(stock.ticker)
    const platforms = getOpenPlatforms(stock.position_entries)

    setShowAddForm(true)
    setNewTicker(baseTicker)
    setSelectedExchange(exchangeCode)
    setValidationStatus('valid')
    setValidatedTickerInfo({
      valid: true,
      name: stock.name,
      currency: stock.currency,
    })
    setNewQuantity('')
    setNewPurchasePrice('')
    setNewCourtage('')
    setNewExchangeRate('')
    setNewPlatform(platforms.length === 1 ? platforms[0] : '')
    setNewPurchaseDate('')
    setError(null)

    window.requestAnimationFrame(() => {
      addFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }

  const handleSellStock = async () => {
    if (!sellStock) return
    const parsedSellQuantity = Number(sellQuantity)
    const latestAllowedSellDate = getLocalDateInputValue()

    if (!Number.isFinite(parsedSellQuantity) || parsedSellQuantity <= 0 || parsedSellQuantity > totalSellableQuantity) {
      setSellError(t(language, 'stocks.sellInvalidQuantity'))
      return
    }
    const earliestPurchaseDate = sellableEntries[0]?.purchase_date || null
    if (!sellDate || sellDate > latestAllowedSellDate || (earliestPurchaseDate && sellDate < earliestPurchaseDate)) {
      setSellError(t(language, 'stocks.sellInvalidDate'))
      return
    }

    const updatedEntries: PositionEntry[] = []
    let remainingToSell = parsedSellQuantity
    const sortedSellableEntryIds = new Set(sellableEntries.map((entry) => entry.id))
    const orderedEntries = [
      ...sellableEntries,
      ...(sellStock.position_entries || []).filter((entry) => !sortedSellableEntryIds.has(entry.id)),
    ]

    for (const entry of orderedEntries) {
      const currentRemainingQuantity = getRemainingEntryQuantity(entry)
      if (currentRemainingQuantity <= 0 || remainingToSell <= 0) {
        updatedEntries.push(entry)
        continue
      }

      const existingSoldQuantity = getSoldQuantity(entry)
      const soldFromEntry = Math.min(currentRemainingQuantity, remainingToSell)
      const remainingAfterSale = currentRemainingQuantity - soldFromEntry

      const baseEntry = {
        purchase_price: entry.purchase_price ?? null,
        courtage: entry.courtage ?? 0,
        courtage_currency: entry.courtage_currency ?? null,
        exchange_rate: entry.exchange_rate ?? null,
        exchange_rate_currency: entry.exchange_rate_currency ?? null,
        platform: entry.platform ?? null,
        purchase_date: entry.purchase_date ?? null,
      }

      if (existingSoldQuantity > 0) {
        updatedEntries.push({
          id: generateClientId(),
          ...baseEntry,
          quantity: existingSoldQuantity,
          sold_quantity: existingSoldQuantity,
          sell_date: entry.sell_date ?? null,
        })
      }

      updatedEntries.push({
        id: generateClientId(),
        ...baseEntry,
        quantity: soldFromEntry,
        sold_quantity: soldFromEntry,
        sell_date: sellDate,
      })

      if (remainingAfterSale > 0) {
        updatedEntries.push({
          id: generateClientId(),
          ...baseEntry,
          quantity: remainingAfterSale,
          sold_quantity: null,
          sell_date: null,
        })
      }

      remainingToSell -= soldFromEntry
    }

    try {
      setSellError(null)
      setSelling(true)
      await api.stocks.update(sellStock.ticker, {
        position_entries: updatedEntries,
      })
      closeSellModal()
      notifyPortfolioDataUpdated()
      await fetchStocks()
    } catch (err) {
      setSellError(err instanceof Error ? err.message : t(language, 'stocks.failedSave'))
    } finally {
      setSelling(false)
    }
  }

  const handleApplySplit = async () => {
    if (!splitStock) return
    const parsedSplitRatio = Number(splitRatio)
    const latestAllowedSplitDate = getLocalDateInputValue()

    if (!Number.isFinite(parsedSplitRatio) || parsedSplitRatio <= 0 || parsedSplitRatio === 1) {
      setSplitError(t(language, 'stocks.splitInvalidRatio'))
      return
    }
    if (!splitDate || splitDate > latestAllowedSplitDate) {
      setSplitError(t(language, 'stocks.splitInvalidDate'))
      return
    }

    try {
      setSplitError(null)
      setSplitting(true)
      await api.stocks.split(splitStock.ticker, {
        ratio: parsedSplitRatio,
        split_date: splitDate,
      })
      closeSplitModal()
      notifyPortfolioDataUpdated()
      await fetchStocks()
    } catch (err) {
      setSplitError(err instanceof Error ? err.message : t(language, 'stocks.failedSplit'))
    } finally {
      setSplitting(false)
    }
  }

  const openEditModal = (stock: Stock) => {
    const { baseTicker, exchangeCode } = splitTickerAndExchange(stock.ticker)
    setEditError(null)
    setEditStock(stock)
    setEditTicker(baseTicker)
    setEditName(stock.name || '')
    setEditExchange(exchangeCode)
    setEditValidationStatus('valid')
    setEditValidatedTickerInfo({
      valid: true,
      name: stock.name,
      currency: stock.currency,
    })
    setEditEntries(
      stock.position_entries && stock.position_entries.length > 0
        ? stock.position_entries
        : [{
            id: generateClientId(),
            quantity: stock.quantity,
            sold_quantity: null,
            purchase_price: stock.purchase_price,
            courtage: 0,
            courtage_currency: stock.currency !== displayCurrency ? displayCurrency : stock.currency,
            exchange_rate: null,
            exchange_rate_currency: null,
            platform: null,
            purchase_date: stock.purchase_date,
            sell_date: null,
          }]
    )
  }

  const handleSaveEdit = async () => {
    if (!editStock) return
    const normalizedTicker = editTicker.trim().toUpperCase()
    const normalizedName = editName.trim()
    const currentName = (editStock.name || '').trim()
    const nextTicker = getFullTicker(normalizedTicker, editExchange)
    const nextName = normalizedName
      ? (nextTicker !== editStock.ticker && normalizedName === currentName
        ? (editValidatedTickerInfo?.name || normalizedName)
        : normalizedName)
      : (nextTicker !== editStock.ticker ? (editValidatedTickerInfo?.name || editStock.name) : editStock.name)
    const validDateFormat = /^\d{4}-\d{2}-\d{2}$/

    if (!normalizedTicker || editValidationStatus === 'invalid') {
      setEditError(t(language, 'stocks.invalidTicker'))
      return
    }
    if (editValidationStatus === 'checking') {
      setEditError(t(language, 'stocks.validatingTicker'))
      return
    }

    const normalizedEntries = editEntries
      .map((entry) => ({
        ...entry,
        quantity: Number(entry.quantity),
        sold_quantity: entry.sold_quantity === null || entry.sold_quantity === undefined || entry.sold_quantity === 0 ? null : Number(entry.sold_quantity),
        purchase_price: entry.purchase_price === null || entry.purchase_price === undefined ? null : Number(entry.purchase_price),
        courtage: entry.courtage === null || entry.courtage === undefined ? 0 : Number(entry.courtage),
        courtage_currency: entry.courtage_currency || (editNeedsExchangeFields ? displayCurrency : editEffectiveTickerCurrency),
        exchange_rate: entry.exchange_rate === null || entry.exchange_rate === undefined ? null : Number(entry.exchange_rate),
        exchange_rate_currency: entry.exchange_rate ? (entry.exchange_rate_currency || displayCurrency) : null,
        platform: normalizePlatform(entry.platform),
        purchase_date: entry.purchase_date || null,
        sell_date: entry.sell_date || null,
      }))

    const hasInvalidEntry = normalizedEntries.some((entry) => {
      const quantityValid = Number.isFinite(entry.quantity) && entry.quantity > 0
      const soldQuantityValid = entry.sold_quantity === null || (Number.isFinite(entry.sold_quantity) && entry.sold_quantity > 0 && entry.sold_quantity <= entry.quantity)
      const purchaseDateValid = !entry.purchase_date || (validDateFormat.test(entry.purchase_date) && entry.purchase_date <= maxPurchaseDate)
      const sellDateValid = !entry.sell_date || (validDateFormat.test(entry.sell_date) && entry.sell_date <= maxPurchaseDate)
      const purchasePriceValid = entry.purchase_price === null || (Number.isFinite(entry.purchase_price) && entry.purchase_price >= 0)
      const courtageValid = Number.isFinite(entry.courtage) && entry.courtage >= 0
      const exchangeRateValid = entry.exchange_rate === null || (Number.isFinite(entry.exchange_rate) && entry.exchange_rate > 0)
      const platformValid = (entry.platform?.length || 0) <= MAX_PLATFORM_LENGTH
      const courtageHasPrice = entry.courtage === 0 || (entry.purchase_price !== null && entry.purchase_price > 0)
      const sellAfterPurchase = !entry.sell_date || !entry.purchase_date || entry.sell_date >= entry.purchase_date
      const exchangeRatePairValid = entry.exchange_rate === null || !!entry.exchange_rate_currency
      const soldQuantityHasSellDate = entry.sold_quantity === null || !!entry.sell_date
      return !quantityValid || !soldQuantityValid || !purchaseDateValid || !sellDateValid || !purchasePriceValid || !courtageValid || !exchangeRateValid || !platformValid || !courtageHasPrice || !sellAfterPurchase || !exchangeRatePairValid || !soldQuantityHasSellDate
    })

    if (hasInvalidEntry) {
      if (normalizedEntries.some((entry) => (entry.platform?.length || 0) > MAX_PLATFORM_LENGTH)) {
        setEditError(t(language, 'stocks.platformTooLong'))
      } else {
        setEditError(t(language, 'stocks.invalidEditValues'))
      }
      return
    }

    try {
      setEditError(null)
      setSaving(true)
      await api.stocks.update(editStock.ticker, {
        ticker: nextTicker,
        name: nextName,
        position_entries: normalizedEntries,
      })
      setEditStock(null)
      notifyPortfolioDataUpdated()
      await fetchStocks()
    } catch (err) {
      setEditError(err instanceof Error ? err.message : t(language, 'stocks.failedSave'))
    } finally {
      setSaving(false)
    }
  }

  const availablePlatforms = useMemo(() => (
    [...new Set(
      stocks.flatMap((stock) => getOpenPlatforms(stock.position_entries))
    )].sort((a, b) => a.localeCompare(b, locale))
  ), [locale, stocks])

  const filteredStocks = useMemo(() => (
    platformFilter === 'all'
      ? stocks
      : stocks.filter((stock) => {
          const platforms = getOpenPlatforms(stock.position_entries)
          if (platformFilter === '__unassigned__') {
            return platforms.length === 0
          }
          return platforms.includes(platformFilter)
        })
  ), [platformFilter, stocks])

  const sortedStocks = useMemo(() => (
    sortTableItems(
      filteredStocks,
      sortState,
      {
        ticker: (stock) => stock.ticker,
        name: (stock) => stock.name || stock.ticker,
        quantity: (stock) => stock.quantity,
        currency: (stock) => stock.currency,
        platform: (stock) => getPlatformSortValue(stock, unassignedPlatformLabel),
        purchasePrice: (stock) => stock.purchase_price,
        purchaseDate: (stock) => stock.purchase_date,
        currentPrice: (stock) => stock.current_price,
        dailyChangePercent: (stock) => {
          if (stock.current_price === null || stock.previous_close === null || stock.previous_close === 0) {
            return null
          }
          return ((stock.current_price - stock.previous_close) / stock.previous_close) * 100
        },
        dividendYield: (stock) => stock.dividend_yield,
      },
      locale,
      (stock) => stock.ticker
    )
  ), [filteredStocks, locale, sortState, unassignedPlatformLabel])

  if (loading) {
    return <div className="loading-state">{t(language, 'common.loading')}</div>
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
          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6 }}>
            {t(language, 'common.lastUpdated')}: {formatTimeInTimezone(lastUpdate, timezone, locale)} · {t(language, 'common.autoRefresh10m')}
          </div>
          <h2 style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em' }}>{t(language, 'stocks.title')}</h2>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <button className="btn btn-secondary" onClick={handleRefreshAllStocks} disabled={refreshingAll}>
            {refreshingAll ? t(language, 'common.refreshing') : t(language, 'common.refresh')}
          </button>
          <button className="btn btn-primary" onClick={() => setShowAddForm(!showAddForm)}>
            {showAddForm ? t(language, 'stocks.cancel') : t(language, 'stocks.addStock')}
          </button>
        </div>
      </div>

      <div style={{ padding: '0 28px 28px' }}>

        {error && (
          <div style={{ marginTop: 16, padding: '10px 16px', background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)', borderRadius: 6 }}>
            <p style={{ color: 'var(--red)', margin: 0, fontSize: 13 }}>{error}</p>
          </div>
        )}

        {/* ── ADD FORM ── */}
        <div style={{
          marginTop: 20,
          background: 'linear-gradient(135deg, rgba(17,24,39,0.86) 0%, rgba(15,23,42,0.96) 100%)',
          border: '1px solid rgba(148,163,184,0.18)',
          borderRadius: 12,
          padding: 18,
          boxShadow: '0 18px 40px rgba(2,6,23,0.22)',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 20, flexWrap: 'wrap', marginBottom: 14 }}>
            <div>
              <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--v2)', marginBottom: 6 }}>
                {t(language, 'stocks.searchTitle')}
              </div>
              <div style={{ color: 'var(--muted)', fontSize: 13, maxWidth: 560 }}>
                {t(language, 'stocks.searchDescription')}
              </div>
            </div>
            {existingSearchStock && (
              <div style={{
                alignSelf: 'flex-start',
                padding: '8px 10px',
                borderRadius: 999,
                border: '1px solid rgba(52,211,153,0.25)',
                background: 'rgba(52,211,153,0.12)',
                color: '#a7f3d0',
                fontSize: 12,
              }}>
                {t(language, 'stocks.searchInPortfolio', { ticker: existingSearchStock.ticker })}
              </div>
            )}
          </div>

          <form onSubmit={handleSearchStock}>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: 12,
              alignItems: 'end',
            }}>
              <div>
                <label style={{ display: 'block', marginBottom: 6, color: 'var(--muted)', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                  {t(language, 'stocks.exchange')}
                </label>
                <select value={searchExchange} onChange={(e) => handleSearchExchangeChange(e.target.value)}>
                  {EXCHANGES.map((exchange) => (
                    <option key={`search-${exchange.code}`} value={exchange.code}>{exchange.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: 6, color: 'var(--muted)', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                  {t(language, 'stocks.searchLabel')}
                </label>
                <input
                  type="text"
                  value={searchTicker}
                  onChange={(e) => handleSearchTickerChange(e.target.value)}
                  placeholder={t(language, 'stocks.searchPlaceholder')}
                />
                {searchTicker && (
                  <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6, fontFamily: "'Fira Code', monospace" }}>
                    {t(language, 'stocks.full')}: {searchFullTicker}
                  </p>
                )}
                {searchValidationStatus === 'checking' && (
                  <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>{t(language, 'stocks.validatingTicker')}</p>
                )}
                {searchValidationStatus === 'valid' && (
                  <p style={{ fontSize: 11, color: 'var(--green)', marginTop: 6 }}>
                    {searchTickerInfo?.name || searchFullTicker}
                    {searchTickerInfo?.currency ? ` · ${searchTickerInfo.currency}` : ''}
                  </p>
                )}
                {searchValidationStatus === 'invalid' && (
                  <p style={{ fontSize: 11, color: 'var(--red)', marginTop: 6 }}>{t(language, 'stocks.invalidTicker')}</p>
                )}
              </div>
              <button className="btn btn-primary" type="submit" disabled={searching}>
                {searching ? t(language, 'common.loading') : t(language, 'stocks.searchAction')}
              </button>
            </div>
            {searchError && (
              <p style={{ color: 'var(--red)', margin: '12px 0 0', fontSize: 12 }}>{searchError}</p>
            )}
          </form>
        </div>

        {showAddForm && (
          <div ref={addFormRef} style={{ marginTop: 20, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8 }}>
            <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--border)' }}>
              <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--v2)' }}>
                {t(language, 'stocks.addNewStock')}
              </span>
            </div>
            <form onSubmit={handleAddStock} style={{ padding: '18px' }}>
              <div className={`stocks-add-grid${needsExchangeFields ? ' stocks-add-grid--fx' : ''}`}>
                <div>
                  <label style={{ display: 'block', marginBottom: 6, color: 'var(--muted)', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                    {t(language, 'stocks.exchange')}
                  </label>
                  <select value={selectedExchange} onChange={(e) => handleExchangeChange(e.target.value)}>
                    {EXCHANGES.map((ex) => (
                      <option key={ex.code} value={ex.code}>{ex.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label style={{ display: 'block', marginBottom: 6, color: 'var(--muted)', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                    {t(language, 'stocks.tickerSymbol')}
                  </label>
                  <input
                    type="text"
                    value={newTicker}
                    onChange={(e) => handleTickerChange(e.target.value)}
                    placeholder={selectedExchange === 'US' ? 'AAPL' : 'INVE-B'}
                    style={{
                      borderColor: validationStatus === 'valid' ? 'var(--green)' :
                                   validationStatus === 'invalid' ? 'var(--red)' : undefined
                    }}
                    required
                  />
                  {newTicker && (
                    <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4, fontFamily: "'Fira Code', monospace" }}>
                      {t(language, 'stocks.full')}: {fullTicker}
                    </p>
                  )}
                  {validationStatus === 'checking' && (
                    <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>{t(language, 'stocks.validatingTicker')}</p>
                  )}
                  {validationStatus === 'valid' && validatedTickerInfo && (
                    <p style={{ fontSize: 11, color: 'var(--green)', marginTop: 4 }}>
                      {validatedTickerInfo.name || fullTicker} · {effectiveTickerCurrency}
                    </p>
                  )}
                  {validationStatus === 'invalid' && (
                    <p style={{ fontSize: 11, color: 'var(--red)', marginTop: 4 }}>{t(language, 'stocks.invalidTicker')}</p>
                  )}
                  {existingStock && (
                    <p style={{ fontSize: 11, color: 'var(--amber)', marginTop: 4 }}>
                      {t(language, 'stocks.addsExistingLot', { ticker: existingStock.ticker })}
                    </p>
                  )}
                </div>
                <div>
                  <label style={{ display: 'block', marginBottom: 6, color: 'var(--muted)', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                    {t(language, 'stocks.quantity')}
                  </label>
                  <input
                    type="number" step="0.01" min="0"
                    value={newQuantity}
                    onChange={(e) => setNewQuantity(e.target.value)}
                    placeholder={t(language, 'stocks.placeholderQuantity')}
                    required
                  />
                </div>
                <div>
                  <label style={{ display: 'block', marginBottom: 6, color: 'var(--muted)', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                    {t(language, 'stocks.purchasePrice')} ({effectiveTickerCurrency})
                  </label>
                  <input
                    type="number" step="0.01" min="0"
                    value={newPurchasePrice}
                    onChange={(e) => setNewPurchasePrice(e.target.value)}
                    placeholder={t(language, 'stocks.placeholderPrice')}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', marginBottom: 6, color: 'var(--muted)', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                    {t(language, 'stocks.courtage')} ({needsExchangeFields ? displayCurrency : effectiveTickerCurrency})
                  </label>
                  <input
                    type="number" step="0.01" min="0"
                    value={newCourtage}
                    onChange={(e) => setNewCourtage(e.target.value)}
                    placeholder="0.00"
                  />
                </div>
                {needsExchangeFields && (
                  <div>
                    <label style={{ display: 'block', marginBottom: 6, color: 'var(--muted)', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                      {t(language, 'stocks.exchangeRate')} (1 {effectiveTickerCurrency} = ? {displayCurrency})
                    </label>
                    <input
                      type="number" step="0.0001" min="0"
                      value={newExchangeRate}
                      onChange={(e) => setNewExchangeRate(e.target.value)}
                      placeholder="10.50"
                    />
                  </div>
                )}
                <div>
                  <label style={{ display: 'block', marginBottom: 6, color: 'var(--muted)', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                    {t(language, 'stocks.purchaseDate')}
                  </label>
                  <input
                    type="date"
                    value={newPurchaseDate}
                    onChange={(e) => setNewPurchaseDate(e.target.value)}
                    max={maxPurchaseDate}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', marginBottom: 6, color: 'var(--muted)', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                    {t(language, 'stocks.platform')}
                  </label>
                  <select value={newPlatform} onChange={(e) => setNewPlatform(e.target.value)}>
                    <option value="">{unassignedPlatformLabel}</option>
                    {normalizedPlatforms.map((platform) => (
                      <option key={platform} value={platform}>{platform}</option>
                    ))}
                  </select>
                </div>
                <div className="stocks-add-action">
                  <button type="submit" className="btn btn-primary" style={{ width: '100%' }} disabled={adding || validationStatus === 'checking' || validationStatus === 'invalid'}>
                    {adding ? t(language, 'stocks.adding') : t(language, 'stocks.add')}
                  </button>
                </div>
              </div>
            </form>
          </div>
        )}

        {/* ── HOLDINGS TABLE ── */}
        <div style={{ marginTop: 20, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8 }}>
          <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--muted)' }}>
              {t(language, 'stocks.title')}
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <label style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                {t(language, 'stocks.platformFilter')}
              </label>
              <select value={platformFilter} onChange={(e) => setPlatformFilter(e.target.value)} style={{ minWidth: 180 }}>
                <option value="all">{t(language, 'stocks.platformAll')}</option>
                <option value="__unassigned__">{unassignedPlatformLabel}</option>
                {availablePlatforms.map((platform) => (
                  <option key={platform} value={platform}>{platform}</option>
                ))}
              </select>
            </div>
          </div>
          {!stocks.length ? (
            <div className="empty-state" style={{ padding: '40px' }}>{t(language, 'stocks.noStocksMessage')}</div>
          ) : !sortedStocks.length ? (
            <div className="empty-state" style={{ padding: '40px' }}>{t(language, 'stocks.noPlatformMatch')}</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <SortableHeader field="ticker" label={t(language, 'stocks.tableTicker')} sortState={sortState} onSort={requestSort} />
                  <SortableHeader field="name" label={t(language, 'stocks.tableName')} sortState={sortState} onSort={requestSort} />
                  <SortableHeader field="quantity" label={t(language, 'stocks.tableQty')} sortState={sortState} onSort={requestSort} align="right" />
                  <SortableHeader field="currency" label={t(language, 'stocks.tableCurr')} sortState={sortState} onSort={requestSort} />
                  <SortableHeader field="platform" label={t(language, 'stocks.tablePlatform')} sortState={sortState} onSort={requestSort} />
                  <SortableHeader field="purchasePrice" label={t(language, 'stocks.tablePurchase')} sortState={sortState} onSort={requestSort} align="right" />
                  <SortableHeader field="purchaseDate" label={t(language, 'stocks.tablePurchaseDate')} sortState={sortState} onSort={requestSort} />
                  <SortableHeader field="currentPrice" label={t(language, 'stocks.tablePrice')} sortState={sortState} onSort={requestSort} align="right" />
                  <SortableHeader field="dailyChangePercent" label={t(language, 'stocks.tableChange')} sortState={sortState} onSort={requestSort} align="right" />
                  <SortableHeader field="dividendYield" label={t(language, 'stocks.tableDivYield')} sortState={sortState} onSort={requestSort} align="right" />
                  <th style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{t(language, 'stocks.tableActions')}</th>
                </tr>
              </thead>
              <tbody>
                {sortedStocks.map((stock) => {
                  const logoUrl = resolveBackendAssetUrl(stock.logo)
                  const platforms = getOpenPlatforms(stock.position_entries)
                  const hasSellableQuantity = (stock.position_entries || []).some((entry) => getRemainingEntryQuantity(entry) > 0)
                  const dailyChange = stock.current_price !== null && stock.previous_close !== null
                    ? stock.current_price - stock.previous_close
                    : null
                  const dailyChangePercent = dailyChange !== null && stock.previous_close !== null && stock.previous_close !== 0
                    ? (dailyChange / stock.previous_close) * 100
                    : null

                  return (
                    <tr key={stock.id}>
                      <td>
                        <Link
                          to={`/stocks/${encodeURIComponent(stock.ticker)}`}
                          style={{ color: 'var(--v2)', textDecoration: 'none', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}
                        >
                          {logoUrl && !failedLogos[stock.ticker] ? (
                            <img
                              src={logoUrl}
                              alt={stock.name || stock.ticker}
                              style={{ width: 22, height: 22, borderRadius: 4, objectFit: 'contain', padding: 2, ...logoTileStyle }}
                              onError={() => setFailedLogos((prev) => ({ ...prev, [stock.ticker]: true }))}
                            />
                          ) : (
                            <span style={{
                              width: 22, height: 22, borderRadius: 4,
                              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                              fontSize: 11, fontWeight: 700, color: '#4b5563', ...logoTileStyle,
                            }}>
                              {(stock.name || stock.ticker || '?').charAt(0).toUpperCase()}
                            </span>
                          )}
                          <span style={{ fontFamily: "'Fira Code', monospace" }}>{stock.ticker}</span>
                        </Link>
                      </td>
                      <td style={{ color: 'var(--text2)' }}>{stock.name || '-'}</td>
                      <td style={{ fontFamily: "'Fira Code', monospace" }}>{stock.quantity}</td>
                      <td><span className="badge badge-muted">{stock.currency}</span></td>
                      <td>
                        {platforms.length > 0 ? (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                            {platforms.map((platform) => (
                              <span key={`${stock.ticker}-${platform}`} className="badge badge-muted">{platform}</span>
                            ))}
                          </div>
                        ) : (
                          <span className="badge badge-muted">{unassignedPlatformLabel}</span>
                        )}
                      </td>
                      <td style={{ fontFamily: "'Fira Code', monospace", textAlign: 'right' }}>{formatCurrency(stock.purchase_price, locale, stock.currency)}</td>
                      <td style={{ fontFamily: "'Fira Code', monospace", color: 'var(--muted)' }}>{formatPurchaseDate(stock.purchase_date, locale)}</td>
                      <td style={{ fontFamily: "'Fira Code', monospace", textAlign: 'right' }}>{formatCurrency(stock.current_price, locale, stock.currency)}</td>
                      <td className={dailyChange !== null ? (dailyChange >= 0 ? 'positive' : 'negative') : ''} style={{ fontFamily: "'Fira Code', monospace", textAlign: 'right' }}>
                        {dailyChangePercent !== null ? `${dailyChangePercent >= 0 ? '+' : ''}${dailyChangePercent.toFixed(2)}%` : '-'}
                      </td>
                      <td style={{ fontFamily: "'Fira Code', monospace", textAlign: 'right' }}>
                        {stock.dividend_yield !== null ? `${stock.dividend_yield.toFixed(2)}%` : '-'}
                      </td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <div style={{ display: 'inline-flex', gap: 6, justifyContent: 'flex-end' }}>
                          <button
                            className="btn btn-secondary"
                            style={{ padding: '4px 10px', fontSize: 11 }}
                            onClick={() => openAddFormForStock(stock)}
                          >
                            {t(language, 'stocks.add')}
                          </button>
                          <button
                            className="btn btn-secondary"
                            style={{ padding: '4px 10px', fontSize: 11 }}
                            onClick={() => openEditModal(stock)}
                          >
                            {t(language, 'stocks.edit')}
                          </button>
                          <button
                            className="btn btn-secondary"
                            style={{ padding: '4px 10px', fontSize: 11 }}
                            onClick={() => openSplitModal(stock)}
                            disabled={!hasSellableQuantity}
                          >
                            {t(language, 'stocks.split')}
                          </button>
                          <button
                            className="btn btn-secondary"
                            style={{ padding: '4px 10px', fontSize: 11 }}
                            onClick={() => openSellModal(stock)}
                            disabled={!hasSellableQuantity}
                          >
                            {t(language, 'stocks.sell')}
                          </button>
                          <button
                            className="btn btn-danger"
                            style={{ padding: '4px 10px', fontSize: 11 }}
                            onClick={() => handleDeleteStock(stock.ticker)}
                          >
                            {t(language, 'stocks.delete')}
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* ── EDIT MODAL ── */}
      {editStock && (
        <div
          style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(5, 8, 15, 0.82)',
            display: 'flex', alignItems: 'flex-start', justifyContent: 'center', zIndex: 1000,
            padding: '16px',
            overflowY: 'auto',
          }}
          onClick={() => setEditStock(null)}
        >
          <div
            ref={editModalRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={editModalHeadingId}
            tabIndex={-1}
            style={{
              width: 420,
              maxWidth: '100%',
              maxHeight: 'calc(100vh - 32px)',
              background: 'var(--bg2)',
              border: '1px solid var(--border2)',
              borderRadius: 10,
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
              marginTop: 24,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span id={editModalHeadingId} style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--v2)' }}>
                {t(language, 'stocks.editTitle', { ticker: editStock.ticker })}
              </span>
              <button type="button" aria-label="Close" style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 18, lineHeight: 1 }} onClick={() => setEditStock(null)}>×</button>
            </div>
            <div style={{ padding: '20px', overflowY: 'auto' }}>
              <div style={{ marginBottom: 24, display: 'grid', gap: 12 }}>
                <div>
                  <label style={{ display: 'block', marginBottom: 6, color: 'var(--muted)', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                    {t(language, 'stocks.tableName')}
                  </label>
                  <input
                    type="text"
                    value={editName}
                    onChange={(e) => {
                      setEditName(e.target.value)
                      setEditError(null)
                    }}
                    placeholder={editValidatedTickerInfo?.name || editStock.name || editFullTicker}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', marginBottom: 6, color: 'var(--muted)', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                    {t(language, 'stocks.exchange')}
                  </label>
                  <select value={editExchange} onChange={(e) => setEditExchange(e.target.value)}>
                    {EXCHANGES.map((exchange) => (
                      <option key={exchange.code} value={exchange.code}>{exchange.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label style={{ display: 'block', marginBottom: 6, color: 'var(--muted)', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                    {t(language, 'stocks.tickerSymbol')}
                  </label>
                  <input
                    type="text"
                    value={editTicker}
                    onChange={(e) => {
                      setEditTicker(e.target.value.toUpperCase())
                      setEditError(null)
                    }}
                    placeholder={editExchange === 'US' ? 'AAPL' : 'SHEL'}
                  />
                  {editTicker && (
                    <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4, fontFamily: "'Fira Code', monospace" }}>
                      {t(language, 'stocks.full')}: {editFullTicker}
                    </p>
                  )}
                  {editValidationStatus === 'checking' && (
                    <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>{t(language, 'stocks.validatingTicker')}</p>
                  )}
                  {editValidationStatus === 'valid' && editValidatedTickerInfo && (
                    <p style={{ fontSize: 11, color: 'var(--green)', marginTop: 4 }}>
                      {editValidatedTickerInfo.name || editFullTicker} · {editEffectiveTickerCurrency}
                    </p>
                  )}
                  {editValidationStatus === 'invalid' && (
                    <p style={{ fontSize: 11, color: 'var(--red)', marginTop: 4 }}>{t(language, 'stocks.invalidTicker')}</p>
                  )}
                </div>
              </div>
              <div style={{ marginBottom: 24, display: 'grid', gap: 12 }}>
                {editEntries.map((entry, index) => {
                  const quantityInputId = index === 0 ? editQuantityInputId : `quantity-${entry.id}`
                  const purchasePriceInputId = index === 0 ? editPurchasePriceInputId : `purchasePrice-${entry.id}`
                  const courtageInputId = `courtage-${entry.id}`
                  const exchangeRateInputId = `exchange-rate-${entry.id}`
                  const platformInputId = `platform-${entry.id}`
                  const purchaseDateInputId = index === 0 ? editPurchaseDateInputId : `purchaseDate-${entry.id}`
                  const soldQuantityInputId = `soldQuantity-${entry.id}`
                  const sellDateInputId = `sellDate-${entry.id}`
                  const entryPlatforms = normalizePlatform(entry.platform) && !normalizedPlatforms.includes(entry.platform as string)
                    ? [...normalizedPlatforms, entry.platform as string].sort((a, b) => a.localeCompare(b, locale))
                    : normalizedPlatforms

                  return (
                  <div key={entry.id} style={{ padding: 12, border: '1px solid var(--border)', borderRadius: 8, background: 'rgba(255,255,255,0.02)', display: 'grid', gap: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                        {t(language, 'stocks.lot', { index: index + 1 })}
                      </span>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        style={{ padding: '4px 10px', fontSize: 11 }}
                        onClick={() => setEditEntries((current) => current.filter((candidate) => candidate.id !== entry.id))}
                        disabled={editEntries.length === 1}
                      >
                        {t(language, 'stocks.remove')}
                      </button>
                    </div>
                    <div>
                      <label htmlFor={quantityInputId} style={{ display: 'block', marginBottom: 6, color: 'var(--muted)', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                        {t(language, 'stocks.quantity')}
                      </label>
                      <input
                        id={quantityInputId}
                        ref={index === 0 ? editQuantityInputRef : undefined}
                        type="number"
                        step="0.01"
                        min="0"
                        value={entry.quantity}
                        onChange={(e) => setEditEntries((current) => current.map((candidate) => candidate.id === entry.id ? { ...candidate, quantity: Number(e.target.value) } : candidate))}
                        style={{ width: '100%' }}
                      />
                    </div>
                    <div>
                      <label htmlFor={purchasePriceInputId} style={{ display: 'block', marginBottom: 6, color: 'var(--muted)', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                        {t(language, 'stocks.purchasePrice')} ({editEffectiveTickerCurrency})
                      </label>
                      <input
                        id={purchasePriceInputId}
                        type="number"
                        step="0.01"
                        min="0"
                        value={entry.purchase_price ?? ''}
                        onChange={(e) => setEditEntries((current) => current.map((candidate) => candidate.id === entry.id ? { ...candidate, purchase_price: e.target.value === '' ? null : Number(e.target.value) } : candidate))}
                        placeholder={t(language, 'stocks.placeholderPrice')}
                        style={{ width: '100%' }}
                      />
                    </div>
                    <div>
                      <label htmlFor={courtageInputId} style={{ display: 'block', marginBottom: 6, color: 'var(--muted)', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                        {t(language, 'stocks.courtage')} ({entry.courtage_currency || (editNeedsExchangeFields ? displayCurrency : editEffectiveTickerCurrency)})
                      </label>
                      <input
                        id={courtageInputId}
                        type="number"
                        step="0.01"
                        min="0"
                        value={entry.courtage ?? 0}
                        onChange={(e) => setEditEntries((current) => current.map((candidate) => candidate.id === entry.id ? { ...candidate, courtage: e.target.value === '' ? 0 : Number(e.target.value) } : candidate))}
                        placeholder="0.00"
                        style={{ width: '100%' }}
                      />
                    </div>
                    {(editNeedsExchangeFields || entry.exchange_rate !== null) && (
                    <div>
                      <label htmlFor={exchangeRateInputId} style={{ display: 'block', marginBottom: 6, color: 'var(--muted)', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                        {t(language, 'stocks.exchangeRate')} (1 {editEffectiveTickerCurrency} = ? {entry.exchange_rate_currency || displayCurrency})
                      </label>
                      <input
                        id={exchangeRateInputId}
                        type="number"
                        step="0.0001"
                        min="0"
                        value={entry.exchange_rate ?? ''}
                        onChange={(e) => setEditEntries((current) => current.map((candidate) => candidate.id === entry.id ? {
                          ...candidate,
                          exchange_rate: e.target.value === '' ? null : Number(e.target.value),
                          exchange_rate_currency: e.target.value === '' ? null : (candidate.exchange_rate_currency || displayCurrency),
                        } : candidate))}
                        placeholder="10.50"
                        style={{ width: '100%' }}
                      />
                    </div>
                    )}
                    <div>
                      <label htmlFor={platformInputId} style={{ display: 'block', marginBottom: 6, color: 'var(--muted)', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                        {t(language, 'stocks.platform')}
                      </label>
                      <select
                        id={platformInputId}
                        value={entry.platform ?? ''}
                        onChange={(e) => setEditEntries((current) => current.map((candidate) => candidate.id === entry.id ? { ...candidate, platform: e.target.value || null } : candidate))}
                        style={{ width: '100%' }}
                      >
                        <option value="">{unassignedPlatformLabel}</option>
                        {entryPlatforms.map((platform) => (
                          <option key={`${entry.id}-${platform}`} value={platform}>{platform}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label htmlFor={purchaseDateInputId} style={{ display: 'block', marginBottom: 6, color: 'var(--muted)', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                        {t(language, 'stocks.purchaseDate')}
                      </label>
                      <input
                        id={purchaseDateInputId}
                        type="date"
                        value={entry.purchase_date || ''}
                        onChange={(e) => setEditEntries((current) => current.map((candidate) => candidate.id === entry.id ? { ...candidate, purchase_date: e.target.value || null } : candidate))}
                        max={maxPurchaseDate}
                        style={{ width: '100%' }}
                      />
                    </div>
                    <div>
                      <label htmlFor={soldQuantityInputId} style={{ display: 'block', marginBottom: 6, color: 'var(--muted)', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                        {t(language, 'stocks.soldQuantity')}
                      </label>
                      <input
                        id={soldQuantityInputId}
                        type="number"
                        step="0.01"
                        min="0"
                        max={entry.quantity}
                        value={entry.sold_quantity ?? ''}
                        onChange={(e) => setEditEntries((current) => current.map((candidate) => candidate.id === entry.id ? {
                          ...candidate,
                          sold_quantity: e.target.value === '' ? null : Number(e.target.value),
                        } : candidate))}
                        placeholder="0"
                        style={{ width: '100%' }}
                      />
                    </div>
                    <div>
                      <label htmlFor={sellDateInputId} style={{ display: 'block', marginBottom: 6, color: 'var(--muted)', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                        {t(language, 'stocks.sellDate')}
                      </label>
                      <input
                        id={sellDateInputId}
                        type="date"
                        value={entry.sell_date || ''}
                        onChange={(e) => setEditEntries((current) => current.map((candidate) => candidate.id === entry.id ? { ...candidate, sell_date: e.target.value || null } : candidate))}
                        max={maxPurchaseDate}
                        style={{ width: '100%' }}
                      />
                    </div>
                  </div>
                  )
                })}
                <button type="button" className="btn btn-secondary" onClick={() => setEditEntries((current) => [...current, createEmptyPositionEntry()])}>
                  {t(language, 'stocks.addLot')}
                </button>
              </div>
              {editError && (
                <p style={{ color: 'var(--red)', fontSize: 12, marginBottom: 16 }}>{editError}</p>
              )}
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                <button type="button" className="btn btn-secondary" onClick={() => setEditStock(null)}>
                  {t(language, 'stocks.cancel')}
                </button>
                <button type="button" className="btn btn-primary" onClick={handleSaveEdit} disabled={saving}>
                  {saving ? t(language, 'stocks.saving') : t(language, 'stocks.save')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {splitStock && (
        <div
          style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(5, 8, 15, 0.82)',
            display: 'flex', alignItems: 'flex-start', justifyContent: 'center', zIndex: 1000,
            padding: '16px',
            overflowY: 'auto',
          }}
          onClick={closeSplitModal}
        >
          <div
            ref={splitModalRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={splitModalHeadingId}
            tabIndex={-1}
            style={{
              width: 420,
              maxWidth: '100%',
              background: 'var(--bg2)',
              border: '1px solid var(--border2)',
              borderRadius: 10,
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
              marginTop: 24,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span id={splitModalHeadingId} style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--v2)' }}>
                {t(language, 'stocks.splitTitle', { ticker: splitStock.ticker })}
              </span>
              <button type="button" aria-label="Close" style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 18, lineHeight: 1 }} onClick={closeSplitModal}>x</button>
            </div>
            <div style={{ padding: '20px', display: 'grid', gap: 14 }}>
              <p style={{ margin: 0, color: 'var(--muted)', fontSize: 12 }}>
                {t(language, 'stocks.splitHint')}
              </p>
              <div>
                <label htmlFor={splitRatioInputId} style={{ display: 'block', marginBottom: 6, color: 'var(--muted)', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                  {t(language, 'stocks.splitRatio')}
                </label>
                <input
                  id={splitRatioInputId}
                  ref={splitRatioInputRef}
                  type="number"
                  step="0.0001"
                  min="0"
                  value={splitRatio}
                  onChange={(e) => setSplitRatio(e.target.value)}
                  placeholder="5"
                  style={{ width: '100%' }}
                />
              </div>
              <div>
                <label htmlFor={splitDateInputId} style={{ display: 'block', marginBottom: 6, color: 'var(--muted)', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                  {t(language, 'stocks.splitDate')}
                </label>
                <input
                  id={splitDateInputId}
                  type="date"
                  value={splitDate}
                  onChange={(e) => setSplitDate(e.target.value)}
                  max={maxPurchaseDate}
                  style={{ width: '100%' }}
                />
              </div>
              {splitError && (
                <p style={{ color: 'var(--red)', fontSize: 12 }}>{splitError}</p>
              )}
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                <button type="button" className="btn btn-secondary" onClick={closeSplitModal}>
                  {t(language, 'stocks.cancel')}
                </button>
                <button type="button" className="btn btn-primary" onClick={handleApplySplit} disabled={splitting}>
                  {splitting ? t(language, 'stocks.saving') : t(language, 'stocks.split')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {sellStock && (
        <div
          style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(5, 8, 15, 0.82)',
            display: 'flex', alignItems: 'flex-start', justifyContent: 'center', zIndex: 1000,
            padding: '16px',
            overflowY: 'auto',
          }}
          onClick={closeSellModal}
        >
          <div
            ref={sellModalRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={sellModalHeadingId}
            tabIndex={-1}
            style={{
              width: 420,
              maxWidth: '100%',
              background: 'var(--bg2)',
              border: '1px solid var(--border2)',
              borderRadius: 10,
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
              marginTop: 24,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span id={sellModalHeadingId} style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--v2)' }}>
                {t(language, 'stocks.sellTitle', { ticker: sellStock.ticker })}
              </span>
              <button type="button" aria-label="Close" style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 18, lineHeight: 1 }} onClick={closeSellModal}>x</button>
            </div>
            <div style={{ padding: '20px', display: 'grid', gap: 14 }}>
              <p style={{ margin: 0, color: 'var(--muted)', fontSize: 12 }}>
                {t(language, 'stocks.sellAvailable', { quantity: totalSellableQuantity })}
              </p>
              <div>
                <label htmlFor={sellQuantityInputId} style={{ display: 'block', marginBottom: 6, color: 'var(--muted)', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                  {t(language, 'stocks.sellQuantity')}
                </label>
                <input
                  id={sellQuantityInputId}
                  ref={sellQuantityInputRef}
                  type="number"
                  step="0.01"
                  min="0"
                  value={sellQuantity}
                  onChange={(e) => setSellQuantity(e.target.value)}
                  placeholder={t(language, 'stocks.placeholderQuantity')}
                  style={{ width: '100%' }}
                />
              </div>
              <div>
                <label htmlFor={sellDateInputId} style={{ display: 'block', marginBottom: 6, color: 'var(--muted)', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                  {t(language, 'stocks.sellDate')}
                </label>
                <input
                  id={sellDateInputId}
                  type="date"
                  value={sellDate}
                  onChange={(e) => setSellDate(e.target.value)}
                  max={maxPurchaseDate}
                  style={{ width: '100%' }}
                />
              </div>
              {sellError && (
                <p style={{ color: 'var(--red)', fontSize: 12 }}>{sellError}</p>
              )}
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                <button type="button" className="btn btn-secondary" onClick={closeSellModal}>
                  {t(language, 'stocks.cancel')}
                </button>
                <button type="button" className="btn btn-primary" onClick={handleSellStock} disabled={selling}>
                  {selling ? t(language, 'stocks.saving') : t(language, 'stocks.sell')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
