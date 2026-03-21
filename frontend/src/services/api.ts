const API_BASE = '/api'
export const AUTH_STORAGE_KEY = 'portfolioAuthUser'
export const AUTH_EXPIRED_EVENT = 'portfolio-auth-expired'
const SLOW_API_REQUEST_MS = 800
const API_REQUEST_TIMEOUT_MS = 15000
const encodePathSegment = (value: string) => encodeURIComponent(value)
// These caches only deduplicate in-flight exchange rate requests.
const exchangeRatesRequestCache = new Map<string, Promise<Record<string, number | null>>>()
const exchangeRatesBatchRequestCache = new Map<string, Promise<Record<string, Record<string, number | null>>>>()

function createTimeoutSignal(timeoutMs: number, externalSignal?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController()
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs)

  const abortFromExternal = () => controller.abort((externalSignal as AbortSignal & { reason?: unknown }).reason)
  if (externalSignal?.aborted) {
    abortFromExternal()
  } else if (externalSignal) {
    externalSignal.addEventListener('abort', abortFromExternal, { once: true })
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      window.clearTimeout(timeoutId)
      if (externalSignal) {
        externalSignal.removeEventListener('abort', abortFromExternal)
      }
    },
  }
}

export interface AuthUser {
  id: number
  username: string
  is_guest: boolean
  token: string
}

export interface AuthUserProfile {
  id: number
  username: string
  is_guest: boolean
}

function isAuthUser(value: unknown): value is AuthUser {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.id === 'number' &&
    Number.isFinite(candidate.id) &&
    candidate.id > 0 &&
    typeof candidate.username === 'string' &&
    candidate.username.trim().length > 0 &&
    typeof candidate.is_guest === 'boolean' &&
    typeof candidate.token === 'string' &&
    candidate.token.trim().length > 0
  )
}

export function getStoredAuthUser(): AuthUser | null {
  const raw = localStorage.getItem(AUTH_STORAGE_KEY)
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isAuthUser(parsed)) {
      localStorage.removeItem(AUTH_STORAGE_KEY)
      return null
    }
    return parsed
  } catch {
    localStorage.removeItem(AUTH_STORAGE_KEY)
    return null
  }
}

export function setStoredAuthUser(authUser: AuthUser) {
  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(authUser))
}

export function clearStoredAuthUser(notify: boolean = false) {
  localStorage.removeItem(AUTH_STORAGE_KEY)
  if (notify && typeof window !== 'undefined') {
    window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT))
  }
}

/**
 * Performs an HTTP request against the API and returns the parsed JSON response.
 *
 * The function automatically prefixes `endpoint` with the module's API_BASE and, when a stored
 * authenticated user exists, adds an `Authorization: Bearer <token>` header to the request.
 *
 * @param endpoint - The API path to request (appended to API_BASE), e.g. `/stocks` or `/auth/login`
 * @param options - Optional fetch RequestInit options (method, headers, body, etc.)
 * @returns The parsed JSON response from the API
 * @throws Error if the response has a non-OK status; the error message is taken from the response's `detail` field when available, otherwise `"Request failed"`
 */
async function fetchAPI(endpoint: string, options?: RequestInit) {
  const authUser = getStoredAuthUser()
  const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now()
  const externalSignal = options?.signal ?? undefined
  const { signal, cleanup } = createTimeoutSignal(API_REQUEST_TIMEOUT_MS, externalSignal)

  try {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      ...options,
      signal,
      headers: {
        'Content-Type': 'application/json',
        ...(authUser ? { Authorization: `Bearer ${authUser.token}` } : {}),
        ...options?.headers,
      },
    })
    const durationMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt
    const method = options?.method || 'GET'
    const logLabel = `[API timing] ${method} ${endpoint} ${Math.round(durationMs)}ms ${response.status}`

    if (durationMs >= SLOW_API_REQUEST_MS) {
      console.warn(logLabel)
    } else if (
      endpoint.includes('/finnhub/')
      || endpoint.includes('/marketstack/')
      || endpoint.includes('/dividends')
      || endpoint.includes('/analyst')
    ) {
      console.info(logLabel)
    }

    if (!response.ok) {
      if (response.status === 401 && authUser) {
        clearStoredAuthUser(true)
      }
      const error = await response.json().catch(() => ({ detail: 'Unknown error' }))
      const requestError = new Error(error.detail || 'Request failed') as Error & { status?: number }
      requestError.status = response.status
      throw requestError
    }

    return response.json()
  } finally {
    cleanup()
  }
}

async function fetchOptionalAPI<T>(endpoint: string, fallback: T, options?: RequestInit): Promise<T> {
  try {
    return await fetchAPI(endpoint, options) as T
  } catch (error) {
    const status = (error as { status?: number } | null)?.status
    if (status === 403 || status === 404) {
      return fallback
    }
    throw error
  }
}

export interface Stock {
  id: number
  ticker: string
  name: string | null
  quantity: number
  currency: string
  sector: string | null
  logo: string | null
  purchase_price: number | null
  purchase_date: string | null
  position_entries?: PositionEntry[]
  current_price: number | null
  previous_close: number | null
  dividend_yield: number | null
  dividend_per_share: number | null
  last_updated: string | null
  manual_dividends?: ManualDividend[]
}

export interface PositionEntry {
  id: string
  quantity: number
  purchase_price: number | null
  courtage?: number | null
  courtage_currency?: string | null
  exchange_rate?: number | null
  exchange_rate_currency?: string | null
  purchase_date: string | null
  sell_date: string | null
}

export interface TickerValidationResult {
  valid: boolean
  name: string | null
  currency: string | null
}

export interface ManualDividend {
  id: string
  date: string
  amount: number
  currency: string
  note?: string
  added_at?: string
  updated_at?: string
}

export interface MarketIndex {
  symbol: string
  name: string
  price: number
  change: number
  change_percent: number
}

export interface PortfolioSummary {
  total_value: number
  total_value_partial: boolean
  total_cost: number
  total_cost_partial: boolean
  total_gain_loss: number
  total_gain_loss_partial: boolean
  total_gain_loss_percent: number
  daily_change: number
  daily_change_partial: boolean
  dividend_yield: number
  dividend_yield_partial: boolean
  last_updated: string | null
  display_currency: string
  stocks: PortfolioSummaryStock[]
  stock_count: number
}

export interface PortfolioSummaryStock {
  ticker: string
  name: string | null
  quantity: number
  current_price: number
  display_price: number
  display_price_converted?: boolean
  current_value: number
  current_value_converted?: boolean
  total_cost: number | null
  total_cost_converted?: boolean
  currency: string
  sector: string | null
  logo: string | null
  gain_loss: number | null
  gain_loss_percent: number | null
  daily_change: number | null
  daily_change_converted?: boolean
}

export interface Dividend {
  date: string
  amount: number
  currency?: string
  source?: string
  payment_date: string | null
  dividend_type?: string | null
}

export type DividendsByTicker = Record<string, Dividend[]>

export interface UpcomingDividend {
  ticker: string
  name: string | null
  quantity: number
  ex_date: string
  payment_date: string | null
  status?: 'paid' | 'upcoming'
  dividend_type?: string | null
  amount_per_share: number
  total_amount: number
  currency: string
  total_converted: number | null
  display_currency: string
  source: string
}

export interface StockUpcomingDividend {
  ex_date: string
  amount: number | null
  currency?: string
  payment_date: string | null
  dividend_type?: string | null
  source?: string
}

export interface UpcomingDividendsResponse {
  dividends: UpcomingDividend[]
  total_expected: number
  total_received: number
  total_remaining: number
  totals_partial: boolean
  display_currency: string
  unmapped_stocks: Array<{
    ticker: string
    name: string | null
    reason: string
  }>
}

export interface DistributionResponse {
  display_currency: string
  by_sector: Record<string, number>
  by_country: Record<string, number>
  by_currency: Record<string, number>
  by_stock: Record<string, number>
}

export interface TickerMapping {
  avanza_name: string
  yahoo_ticker: string
  instrument_id: string | null
  manually_added: boolean
  added_at?: string | null
}

export interface AvailableIndex {
  symbol: string
  name: string
}

export interface SettingsData {
  display_currency: string
  header_indices: string[]
}

export interface AnalystData {
  recommendations: AnalystRecommendation[] | null
  finnhub_recommendations: AnalystRecommendation[] | null
  price_targets: {
    current: number | null
    targetAvg: number | null
    targetHigh: number | null
    targetLow: number | null
    numberOfAnalysts: number | null
    note?: string
  } | null
  latest_rating: {
    date: string
    analyst: string
    rating_action: string
    rating: string
    previous_rating?: string
    price_action?: string
    price_target?: string
  } | null
}

export interface AnalystRecommendation {
  period: string
  strong_buy: number
  buy: number
  hold: number
  sell: number
  strong_sell: number
  total_analysts?: number
}

export interface MarketStatus {
  market: string
  name: string
  is_open: boolean
  status: string
  open_time: string
  close_time: string
  timezone: string
  local_time?: string
}

export interface SparklineData {
  prices: number[]
  dates: string[]
  is_positive: boolean
  start_value: number
  end_value: number
  change_percent: number
}

export interface HeaderMarketData {
  indices: MarketIndex[]
  exchange_rates: Record<string, number | null>
  updated_at: string
  next_refresh_at: string
}

export interface CompanyProfile {
  name: string | null
  ticker: string | null
  industry: string | null
  country: string | null
  currency: string | null
  exchange: string | null
  logo: string | null
  website: string | null
  market_cap: number | null
  shares_outstanding: number | null
  ipo_date: string | null
  phone: string | null
}

export interface FinancialMetrics {
  pe_ttm: number | null
  pe_annual: number | null
  ps_ttm: number | null
  pb_annual: number | null
  dividend_yield: number | null
  dividend_per_share_annual: number | null
  dividend_per_share_ttm: number | null
  dividend_yield_ttm: number | null
  dividend_growth_5y: number | null
  roe_ttm: number | null
  roa_ttm: number | null
  net_margin_ttm: number | null
  gross_margin_ttm: number | null
  operating_margin_ttm: number | null
  eps_ttm: number | null
  book_value_per_share: number | null
  cash_flow_per_share: number | null
  revenue_growth_ttm: number | null
  revenue_growth_3y: number | null
  eps_growth_ttm: number | null
  eps_growth_3y: number | null
  beta: number | null
  '52_week_high': number | null
  '52_week_low': number | null
  '52_week_high_date': string | null
  '52_week_low_date': string | null
  avg_volume_10d: number | null
  avg_volume_3m: number | null
}

export interface RecommendationTrend {
  period: string
  strong_buy: number
  buy: number
  hold: number
  sell: number
  strong_sell: number
  total_analysts: number
}

export interface MarketstackUsage {
  month: string
  calls_used: number
  calls_limit: number
  calls_remaining: number
  api_configured: boolean
}

export interface DividendDiscrepancy {
  date: string
  type: 'amount_mismatch' | 'missing_from_yahoo' | 'missing_from_marketstack' | 'api_error'
  yahoo_amount: number | null
  marketstack_amount: number | null
  difference: number | null
  message?: string
}

export interface VerificationResult {
  ticker: string
  verified_at: string
  cached: boolean
  summary: {
    yahoo_count: number
    marketstack_count: number
    match_count: number
    discrepancy_count: number
  }
  yahoo_dividends: Dividend[]
  marketstack_dividends: Dividend[]
  discrepancies: DividendDiscrepancy[]
  usage: MarketstackUsage
}

export const api = {
  auth: {
    login: (data: { username: string; password: string }) =>
      fetchAPI('/auth/login', { method: 'POST', body: JSON.stringify(data) }) as Promise<AuthUser>,
    register: (data: { username: string; password: string }) =>
      fetchAPI('/auth/register', { method: 'POST', body: JSON.stringify(data) }) as Promise<AuthUser>,
    guest: () => fetchAPI('/auth/guest', { method: 'POST' }) as Promise<AuthUser>,
    users: () => fetchAPI('/auth/users') as Promise<AuthUserProfile>,
  },

  stocks: {
    list: () => fetchAPI('/stocks') as Promise<Stock[]>,
    get: (ticker: string) => fetchAPI(`/stocks/${encodePathSegment(ticker)}`) as Promise<Stock>,
    create: (data: { ticker: string; quantity: number; purchase_price?: number; courtage?: number; courtage_currency?: string; exchange_rate?: number; exchange_rate_currency?: string; purchase_date?: string; position_entries?: PositionEntry[] }) => 
      fetchAPI('/stocks', { method: 'POST', body: JSON.stringify(data) }) as Promise<Stock>,
    update: (ticker: string, data: { quantity?: number; purchase_price?: number; courtage?: number | null; courtage_currency?: string | null; exchange_rate?: number | null; exchange_rate_currency?: string | null; purchase_date?: string | null; position_entries?: PositionEntry[] }) =>
      fetchAPI(`/stocks/${encodePathSegment(ticker)}`, { method: 'PATCH', body: JSON.stringify(data) }) as Promise<Stock>,
    delete: (ticker: string) => fetchAPI(`/stocks/${encodePathSegment(ticker)}`, { method: 'DELETE' }),
    refresh: (ticker: string) => fetchAPI(`/stocks/${encodePathSegment(ticker)}/refresh`, { method: 'POST' }) as Promise<Stock>,
    dividends: (ticker: string, years: number = 5) => fetchAPI(`/stocks/${encodePathSegment(ticker)}/dividends?years=${years}`) as Promise<Dividend[]>,
    dividendsForTickers: (tickers: string[], years: number = 5) => {
      const params = new URLSearchParams()
      for (const ticker of tickers) {
        params.append('tickers', ticker)
      }
      params.set('years', String(years))
      return fetchAPI(`/stocks/dividends/batch?${params.toString()}`) as Promise<DividendsByTicker>
    },
    upcomingDividends: (ticker: string) => fetchAPI(`/stocks/${encodePathSegment(ticker)}/upcoming-dividends`) as Promise<StockUpcomingDividend[]>,
    analyst: (ticker: string) => fetchAPI(`/stocks/${encodePathSegment(ticker)}/analyst`) as Promise<AnalystData>,
    validate: (ticker: string) => fetchAPI(`/stocks/validate/${encodePathSegment(ticker)}`) as Promise<TickerValidationResult>,
    addManualDividend: (ticker: string, data: { date: string; amount: number; currency?: string; note?: string }) =>
      fetchAPI(`/stocks/${encodePathSegment(ticker)}/manual-dividends`, { method: 'POST', body: JSON.stringify(data) }) as Promise<Stock>,
    updateManualDividend: (ticker: string, dividendId: string, data: { date?: string; amount?: number; currency?: string; note?: string }) =>
      fetchAPI(`/stocks/${encodePathSegment(ticker)}/manual-dividends/${encodePathSegment(dividendId)}`, { method: 'PUT', body: JSON.stringify(data) }) as Promise<Stock>,
    deleteManualDividend: (ticker: string, dividendId: string) =>
      fetchAPI(`/stocks/${encodePathSegment(ticker)}/manual-dividends/${encodePathSegment(dividendId)}`, { method: 'DELETE' }),
    suppressDividend: (ticker: string, data: { date: string; amount?: number; currency?: string }) =>
      fetchAPI(`/stocks/${encodePathSegment(ticker)}/suppress-dividend`, { method: 'POST', body: JSON.stringify(data) }),
    restoreDividend: (ticker: string, date: string) =>
      fetchAPI(`/stocks/${encodePathSegment(ticker)}/suppress-dividend/${encodePathSegment(date)}`, { method: 'DELETE' }),
    getSuppressedDividends: (ticker: string) =>
      fetchAPI(`/stocks/${encodePathSegment(ticker)}/suppressed-dividends`) as Promise<ManualDividend[]>,
  },
  
  portfolio: {
    summary: () => fetchAPI('/portfolio/summary') as Promise<PortfolioSummary>,
    refreshAll: () => fetchAPI('/portfolio/refresh-all', { method: 'POST' }),
    distribution: () => fetchAPI('/portfolio/distribution') as Promise<DistributionResponse>,
    history: (options: number | { days?: number; range?: string } = 30) => {
      const params = new URLSearchParams()
      if (typeof options === 'number') {
        params.set('days', String(options))
      } else {
        if (options.days !== undefined) {
          params.set('days', String(options.days))
        }
        if (options.range) {
          params.set('range', options.range)
        }
      }
      const query = params.toString()
      return fetchAPI(`/portfolio/history${query ? `?${query}` : ''}`)
    },
    upcomingDividends: () => fetchAPI('/portfolio/upcoming-dividends') as Promise<UpcomingDividendsResponse>,
  },
  
  market: {
    header: (force: boolean = false) => fetchAPI(`/market/header${force ? '?force=true' : ''}`) as Promise<HeaderMarketData>,
    indices: () => fetchAPI('/market/indices') as Promise<{ indices: MarketIndex[]; updated_at: string; next_refresh_at: string }>,
    exchangeRates: (date?: string) => {
      const key = date || '__latest__'
      const cached = exchangeRatesRequestCache.get(key)
      if (cached) return cached

      const request = fetchAPI(`/market/exchange-rates${date ? `?date=${encodeURIComponent(date)}` : ''}`)
        .finally(() => {
          exchangeRatesRequestCache.delete(key)
        }) as Promise<Record<string, number | null>>

      exchangeRatesRequestCache.set(key, request)
      return request
    },
    exchangeRatesBatch: (dates: string[]) => {
      const normalizedDates = [...new Set(dates)].sort()
      const key = normalizedDates.join('|')
      const cached = exchangeRatesBatchRequestCache.get(key)
      if (cached) return cached

      const request = fetchAPI('/market/exchange-rates/batch', {
        method: 'POST',
        body: JSON.stringify({ dates: normalizedDates }),
      }).finally(() => {
        exchangeRatesBatchRequestCache.delete(key)
      }) as Promise<Record<string, Record<string, number | null>>>

      exchangeRatesBatchRequestCache.set(key, request)
      return request
    },
    convert: (amount: number, from: string, to: string) => 
      fetchAPI(`/market/convert?amount=${amount}&from_currency=${from}&to_currency=${to}`),
    hours: (timezone?: string) => fetchAPI(`/market/hours${timezone ? `?timezone=${encodeURIComponent(timezone)}` : ''}`) as Promise<MarketStatus[]>,
    marketHours: (market: string, timezone?: string) => fetchAPI(`/market/hours/${market}${timezone ? `?timezone=${encodeURIComponent(timezone)}` : ''}`) as Promise<MarketStatus>,
    openMarkets: () => fetchAPI('/market/open-markets') as Promise<{ open_markets: string[] }>,
    shouldRefresh: () => fetchAPI('/market/should-refresh') as Promise<{ should_refresh: boolean }>,
    sparklines: () => fetchAPI('/market/indices/sparklines') as Promise<{ sparklines: Record<string, SparklineData>; updated_at: string }>,
  },
  
  finnhub: {
    profile: (ticker: string) => fetchOptionalAPI<CompanyProfile | null>(`/finnhub/profile/${encodePathSegment(ticker)}`, null),
    metrics: (ticker: string) => fetchOptionalAPI<FinancialMetrics | null>(`/finnhub/metrics/${encodePathSegment(ticker)}`, null),
    peers: (ticker: string) => fetchOptionalAPI<string[]>(`/finnhub/peers/${encodePathSegment(ticker)}`, []),
    recommendations: (ticker: string) => fetchOptionalAPI<RecommendationTrend[]>(`/finnhub/recommendations/${encodePathSegment(ticker)}`, []),
  },
  
  marketstack: {
    status: () => fetchAPI('/marketstack/status') as Promise<MarketstackUsage>,
    dividends: (ticker: string, dateFrom?: string, dateTo?: string) => {
      const params = new URLSearchParams()
      if (dateFrom) params.append('date_from', dateFrom)
      if (dateTo) params.append('date_to', dateTo)
      const query = params.toString() ? `?${params.toString()}` : ''
      return fetchAPI(`/marketstack/dividends/${encodePathSegment(ticker)}${query}`) as Promise<{
        ticker: string
        dividends: Dividend[]
        count: number
        usage: MarketstackUsage
      }>
    },
    verify: (ticker: string) => fetchAPI(`/marketstack/verify/${encodePathSegment(ticker)}`, { method: 'POST' }) as Promise<VerificationResult>,
    clearCache: (ticker: string) => fetchAPI(`/marketstack/cache/${encodePathSegment(ticker)}`, { method: 'DELETE' }) as Promise<{ message: string }>,
  },
  
  avanza: {
    dividends: () => fetchAPI('/avanza/dividends') as Promise<Array<{
      avanza_name: string
      ex_date: string
      amount: number
      currency: string
      payment_date: string | null
      dividend_type: string | null
      yahoo_ticker: string | null
      instrument_id: string | null
    }>>,
    mappings: () => fetchAPI('/avanza/mappings') as Promise<TickerMapping[]>,
    addMapping: (data: { avanza_name: string; yahoo_ticker: string; instrument_id?: string | null }) =>
      fetchAPI('/avanza/mappings', { method: 'POST', body: JSON.stringify(data) }) as Promise<TickerMapping>,
    deleteMapping: (avanzaName: string) =>
      fetchAPI(`/avanza/mappings/${encodeURIComponent(avanzaName)}`, { method: 'DELETE' }) as Promise<{ message: string }>,
    historical: (ticker: string, years: number = 5) =>
      fetchAPI(`/avanza/historical/${encodePathSegment(ticker)}?years=${years}`) as Promise<Array<{
        date: string
        amount: number
        currency: string
        payment_date: string | null
        dividend_type: string | null
      }>>,
    stockInfo: (instrumentId: string) =>
      fetchAPI(`/avanza/stock/${instrumentId}`) as Promise<{
        name: string
        ticker: string
        isin: string
        currency: string
        upcoming_dividends: Array<{
          exDate: string
          paymentDate: string
          amount: number
          currencyCode: string
          dividendType: string
        }>
        past_dividends: Array<{
          exDate: string
          paymentDate: string
          amount: number
          currencyCode: string
          dividendType: string
        }>
      }>,
  },

  settings: {
    get: () => fetchAPI('/settings') as Promise<SettingsData>,
    update: (data: { display_currency?: string; header_indices?: string[] }) =>
      fetchAPI('/settings', { method: 'PATCH', body: JSON.stringify(data) }) as Promise<SettingsData>,
    availableIndices: () => fetchAPI('/settings/available-indices') as Promise<AvailableIndex[]>,
  },
}
