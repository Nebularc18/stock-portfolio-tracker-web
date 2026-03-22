const API_BASE = '/api'
export const AUTH_STORAGE_KEY = 'portfolioAuthUser'
export const AUTH_EXPIRED_EVENT = 'portfolio-auth-expired'
export const AUTH_CHANGED_EVENT = 'portfolio-auth-changed'
const SLOW_API_REQUEST_MS = 800
const API_REQUEST_TIMEOUT_MS = 15000
const encodePathSegment = (value: string) => encodeURIComponent(value)
// These caches only deduplicate in-flight requests.
const exchangeRatesRequestCache = new Map<string, Promise<Record<string, number | null>>>()
const exchangeRatesBatchRequestCache = new Map<string, Promise<Record<string, Record<string, number | null>>>>()
const portfolioUpcomingDividendsRequestCache = new Map<string, Promise<UpcomingDividendsResponse>>()
const portfolioSummaryRequestCache = new Map<string, Promise<PortfolioSummary>>()
const portfolioHistoryRequestCache = new Map<string, Promise<Array<{ date: string; value: number }>>>()

export function getRequestUserCacheScope(userId?: number | null): string {
  if (userId === null) return 'guest'
  if (userId !== undefined) return String(userId)
  return String(getStoredAuthUser()?.id ?? 'guest')
}

export function __resetPortfolioRequestCachesForTests(): void {
  portfolioSummaryRequestCache.clear()
  portfolioHistoryRequestCache.clear()
  portfolioUpcomingDividendsRequestCache.clear()
}

function getAuthStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null
  } catch {
    return null
  }
}

function emitAuthChanged(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(AUTH_CHANGED_EVENT))
  }
}

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

export class HttpError extends Error {
  status?: number
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
  const storage = getAuthStorage()
  const raw = storage?.getItem(AUTH_STORAGE_KEY)
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isAuthUser(parsed)) {
      storage?.removeItem(AUTH_STORAGE_KEY)
      return null
    }
    return parsed
  } catch {
    storage?.removeItem(AUTH_STORAGE_KEY)
    return null
  }
}

export function setStoredAuthUser(authUser: AuthUser) {
  const storage = getAuthStorage()
  storage?.setItem(AUTH_STORAGE_KEY, JSON.stringify(authUser))
  emitAuthChanged()
}

export function clearStoredAuthUser(notify: boolean = false) {
  const storage = getAuthStorage()
  storage?.removeItem(AUTH_STORAGE_KEY)
  emitAuthChanged()
  if (notify && typeof window !== 'undefined') {
    window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT))
  }
}

/**
 * Send an HTTP request to the API and return the parsed JSON response.
 *
 * Adds `Authorization: Bearer <token>` when a stored authenticated user exists and enforces
 * the module's request timeout (aborting the request when exceeded or when an external signal aborts).
 * If the server responds with 401 and an auth user was present, stored auth is cleared and an auth-expired
 * event is dispatched.
 *
 * @param endpoint - API path appended to the module's `API_BASE`, e.g. `/stocks` or `/auth/login`
 * @param options - Optional fetch `RequestInit` options (method, headers, body, signal, etc.)
 * @returns The parsed JSON body from the successful response
 * @throws Error when the response has a non-OK status; the error message is taken from the response's `detail`
 *   field when available, otherwise `"Request failed"`. The thrown error also has a `status` property set to
 *   the HTTP status code.
 */
async function fetchAPI<T = unknown>(endpoint: string, options?: RequestInit): Promise<T> {
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

    if (import.meta.env.DEV) {
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
    }

    if (!response.ok) {
      if (response.status === 401 && authUser) {
        clearStoredAuthUser(true)
      }
      const error = await response.json().catch(() => ({ detail: 'Unknown error' }))
      const detail = error != null && typeof error === 'object' && 'detail' in error
        ? (error as { detail?: unknown }).detail
        : undefined
      const requestError = new HttpError(typeof detail === 'string' && detail ? detail : 'Request failed')
      requestError.status = response.status
      throw requestError
    }

    return await response.json()
  } finally {
    cleanup()
  }
}

/**
 * Fetches a resource from the API and returns a provided fallback when the server responds with 403 or 404.
 *
 * @param endpoint - API endpoint path (appended to the module's base URL)
 * @param fallback - Value to return if the request fails with HTTP 403 or 404
 * @param options - Optional fetch options forwarded to the underlying request
 * @returns The parsed response as `T`, or `fallback` when the server returns `403` or `404`
 * @throws {Error} When the request fails with a status other than 403 or 404
 */
async function fetchOptionalAPI<T>(endpoint: string, fallback: T, options?: RequestInit): Promise<T> {
  try {
    return await fetchAPI<T>(endpoint, options)
  } catch (error) {
    const status = error instanceof HttpError ? error.status : undefined
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
  id?: string
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
  dividends_partial: boolean
  skipped_dividend_count: number
  skipped_dividend_ids: string[]
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
      fetchAPI<AuthUser>('/auth/login', { method: 'POST', body: JSON.stringify(data) }),
    register: (data: { username: string; password: string }) =>
      fetchAPI<AuthUser>('/auth/register', { method: 'POST', body: JSON.stringify(data) }),
    guest: () => fetchAPI<AuthUser>('/auth/guest', { method: 'POST' }),
    users: () => fetchAPI<AuthUserProfile>('/auth/users'),
  },

  stocks: {
    list: () => fetchAPI<Stock[]>('/stocks'),
    get: (ticker: string) => fetchAPI<Stock>(`/stocks/${encodePathSegment(ticker)}`),
    create: (data: { ticker: string; quantity: number; purchase_price?: number; courtage?: number; courtage_currency?: string; exchange_rate?: number; exchange_rate_currency?: string; purchase_date?: string; position_entries?: PositionEntry[] }) => 
      fetchAPI<Stock>('/stocks', { method: 'POST', body: JSON.stringify(data) }),
    update: (ticker: string, data: { quantity?: number; purchase_price?: number; courtage?: number | null; courtage_currency?: string | null; exchange_rate?: number | null; exchange_rate_currency?: string | null; purchase_date?: string | null; position_entries?: PositionEntry[] }) =>
      fetchAPI<Stock>(`/stocks/${encodePathSegment(ticker)}`, { method: 'PATCH', body: JSON.stringify(data) }),
    delete: (ticker: string) => fetchAPI(`/stocks/${encodePathSegment(ticker)}`, { method: 'DELETE' }),
    refresh: (ticker: string) => fetchAPI<Stock>(`/stocks/${encodePathSegment(ticker)}/refresh`, { method: 'POST' }),
    dividends: (ticker: string, years: number = 5) => fetchAPI<Dividend[]>(`/stocks/${encodePathSegment(ticker)}/dividends?years=${years}`),
    dividendsForTickers: (tickers: string[], years: number = 5) => {
      const params = new URLSearchParams()
      for (const ticker of tickers) {
        params.append('tickers', ticker)
      }
      params.set('years', String(years))
      return fetchAPI<DividendsByTicker>(`/stocks/dividends/batch?${params.toString()}`)
    },
    upcomingDividends: (ticker: string) => fetchAPI<StockUpcomingDividend[]>(`/stocks/${encodePathSegment(ticker)}/upcoming-dividends`),
    analyst: (ticker: string) => fetchAPI<AnalystData>(`/stocks/${encodePathSegment(ticker)}/analyst`),
    validate: (ticker: string) => fetchAPI<TickerValidationResult>(`/stocks/validate/${encodePathSegment(ticker)}`),
    addManualDividend: (ticker: string, data: { date: string; amount: number; currency?: string; note?: string }) =>
      fetchAPI<Stock>(`/stocks/${encodePathSegment(ticker)}/manual-dividends`, { method: 'POST', body: JSON.stringify(data) }),
    updateManualDividend: (ticker: string, dividendId: string, data: { date?: string; amount?: number; currency?: string; note?: string }) =>
      fetchAPI<Stock>(`/stocks/${encodePathSegment(ticker)}/manual-dividends/${encodePathSegment(dividendId)}`, { method: 'PUT', body: JSON.stringify(data) }),
    deleteManualDividend: (ticker: string, dividendId: string) =>
      fetchAPI(`/stocks/${encodePathSegment(ticker)}/manual-dividends/${encodePathSegment(dividendId)}`, { method: 'DELETE' }),
    suppressDividend: (ticker: string, data: { date: string; amount?: number; currency?: string }) =>
      fetchAPI(`/stocks/${encodePathSegment(ticker)}/suppress-dividend`, { method: 'POST', body: JSON.stringify(data) }),
    restoreDividend: (ticker: string, date: string) =>
      fetchAPI(`/stocks/${encodePathSegment(ticker)}/suppress-dividend/${encodePathSegment(date)}`, { method: 'DELETE' }),
    getSuppressedDividends: (ticker: string) =>
      fetchAPI<ManualDividend[]>(`/stocks/${encodePathSegment(ticker)}/suppressed-dividends`),
  },
  
  portfolio: {
    summary: (userId?: number | null, requestOptions?: RequestInit) => {
      const key = getRequestUserCacheScope(userId)
      if (requestOptions?.signal) {
        return fetchAPI<PortfolioSummary>('/portfolio/summary', requestOptions)
      }
      const cached = portfolioSummaryRequestCache.get(key)
      if (cached) return cached

      const request = fetchAPI<PortfolioSummary>('/portfolio/summary', requestOptions)
        .finally(() => {
          portfolioSummaryRequestCache.delete(key)
        })

      portfolioSummaryRequestCache.set(key, request)
      return request
    },
    refreshAll: () => fetchAPI('/portfolio/refresh-all', { method: 'POST' }),
    distribution: () => fetchAPI<DistributionResponse>('/portfolio/distribution'),
    history: (options: number | { days?: number; range?: string } = 30, userId?: number | null, requestOptions?: RequestInit) => {
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
      const key = `${getRequestUserCacheScope(userId)}:${query || '__default__'}`
      if (requestOptions?.signal) {
        return fetchAPI<Array<{ date: string; value: number }>>(`/portfolio/history${query ? `?${query}` : ''}`, requestOptions)
      }
      const cached = portfolioHistoryRequestCache.get(key)
      if (cached) return cached

      const request = fetchAPI<Array<{ date: string; value: number }>>(`/portfolio/history${query ? `?${query}` : ''}`, requestOptions)
        .finally(() => {
          portfolioHistoryRequestCache.delete(key)
        })

      portfolioHistoryRequestCache.set(key, request)
      return request
    },
    upcomingDividends: (userId?: number | null, requestOptions?: RequestInit) => {
      const key = getRequestUserCacheScope(userId)
      if (requestOptions?.signal) {
        return fetchAPI<UpcomingDividendsResponse>('/portfolio/upcoming-dividends', requestOptions)
      }
      const cached = portfolioUpcomingDividendsRequestCache.get(key)
      if (cached) return cached

      const request = fetchAPI<UpcomingDividendsResponse>('/portfolio/upcoming-dividends', requestOptions)
        .finally(() => {
          portfolioUpcomingDividendsRequestCache.delete(key)
        })

      portfolioUpcomingDividendsRequestCache.set(key, request)
      return request
    },
  },
  
  market: {
    header: (force: boolean = false) => fetchAPI<HeaderMarketData>(`/market/header${force ? '?force=true' : ''}`),
    indices: () => fetchAPI<{ indices: MarketIndex[]; updated_at: string; next_refresh_at: string }>('/market/indices'),
    exchangeRates: (date?: string) => {
      const key = date || '__latest__'
      const cached = exchangeRatesRequestCache.get(key)
      if (cached) return cached

      const request = fetchAPI<Record<string, number | null>>(`/market/exchange-rates${date ? `?date=${encodeURIComponent(date)}` : ''}`)
        .finally(() => {
          exchangeRatesRequestCache.delete(key)
        })

      exchangeRatesRequestCache.set(key, request)
      return request
    },
    exchangeRatesBatch: (dates: string[]) => {
      const normalizedDates = [...new Set(dates)].sort()
      const key = normalizedDates.join('|')
      const cached = exchangeRatesBatchRequestCache.get(key)
      if (cached) return cached

      const request = fetchAPI<Record<string, Record<string, number | null>>>('/market/exchange-rates/batch', {
        method: 'POST',
        body: JSON.stringify({ dates: normalizedDates }),
      }).finally(() => {
        exchangeRatesBatchRequestCache.delete(key)
      })

      exchangeRatesBatchRequestCache.set(key, request)
      return request
    },
    convert: (amount: number, from: string, to: string) => 
      fetchAPI(`/market/convert?amount=${amount}&from_currency=${encodeURIComponent(from)}&to_currency=${encodeURIComponent(to)}`),
    hours: (timezone?: string) => fetchAPI<MarketStatus[]>(`/market/hours${timezone ? `?timezone=${encodeURIComponent(timezone)}` : ''}`),
    marketHours: (market: string, timezone?: string) => fetchAPI<MarketStatus>(`/market/hours/${encodePathSegment(market)}${timezone ? `?timezone=${encodeURIComponent(timezone)}` : ''}`),
    openMarkets: () => fetchAPI<{ open_markets: string[] }>('/market/open-markets'),
    shouldRefresh: () => fetchAPI<{ should_refresh: boolean }>('/market/should-refresh'),
    sparklines: () => fetchAPI<{ sparklines: Record<string, SparklineData>; updated_at: string }>('/market/indices/sparklines'),
  },
  
  finnhub: {
    profile: (ticker: string) => fetchOptionalAPI<CompanyProfile | null>(`/finnhub/profile/${encodePathSegment(ticker)}`, null),
    metrics: (ticker: string) => fetchOptionalAPI<FinancialMetrics | null>(`/finnhub/metrics/${encodePathSegment(ticker)}`, null),
    peers: (ticker: string) => fetchOptionalAPI<string[]>(`/finnhub/peers/${encodePathSegment(ticker)}`, []),
    recommendations: (ticker: string) => fetchOptionalAPI<RecommendationTrend[]>(`/finnhub/recommendations/${encodePathSegment(ticker)}`, []),
  },
  
  marketstack: {
    status: () => fetchAPI<MarketstackUsage>('/marketstack/status'),
    dividends: (ticker: string, dateFrom?: string, dateTo?: string) => {
      const params = new URLSearchParams()
      if (dateFrom) params.append('date_from', dateFrom)
      if (dateTo) params.append('date_to', dateTo)
      const queryString = params.toString()
      const query = queryString ? `?${queryString}` : ''
      return fetchAPI<{
        ticker: string
        dividends: Dividend[]
        count: number
        usage: MarketstackUsage
      }>(`/marketstack/dividends/${encodePathSegment(ticker)}${query}`)
    },
    verify: (ticker: string) => fetchAPI<VerificationResult>(`/marketstack/verify/${encodePathSegment(ticker)}`, { method: 'POST' }),
    clearCache: (ticker: string) => fetchAPI<{ message: string }>(`/marketstack/cache/${encodePathSegment(ticker)}`, { method: 'DELETE' }),
  },
  
  avanza: {
    dividends: () => fetchAPI<Array<{
      avanza_name: string
      ex_date: string
      amount: number
      currency: string
      payment_date: string | null
      dividend_type: string | null
      yahoo_ticker: string | null
      instrument_id: string | null
    }>>('/avanza/dividends'),
    mappings: () => fetchAPI<TickerMapping[]>('/avanza/mappings'),
    addMapping: (data: { avanza_name: string; yahoo_ticker: string; instrument_id?: string | null }) =>
      fetchAPI<TickerMapping>('/avanza/mappings', { method: 'POST', body: JSON.stringify(data) }),
    deleteMapping: (avanzaName: string) =>
      fetchAPI<{ message: string }>(`/avanza/mappings/${encodeURIComponent(avanzaName)}`, { method: 'DELETE' }),
    historical: (ticker: string, years: number = 5) =>
      fetchAPI<Array<{
        date: string
        amount: number
        currency: string
        payment_date: string | null
        dividend_type: string | null
      }>>(`/avanza/historical/${encodePathSegment(ticker)}?years=${years}`),
    stockInfo: (instrumentId: string) =>
      fetchAPI<{
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
      }>(`/avanza/stock/${encodePathSegment(instrumentId)}`),
  },

  settings: {
    get: () => fetchAPI<SettingsData>('/settings'),
    update: (data: { display_currency?: string; header_indices?: string[] }) =>
      fetchAPI<SettingsData>('/settings', { method: 'PATCH', body: JSON.stringify(data) }),
    availableIndices: () => fetchAPI<AvailableIndex[]>('/settings/available-indices'),
  },
}
