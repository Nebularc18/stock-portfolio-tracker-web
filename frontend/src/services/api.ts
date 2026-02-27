const API_BASE = '/api'

async function fetchAPI(endpoint: string, options?: RequestInit) {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  })
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Unknown error' }))
    throw new Error(error.detail || 'Request failed')
  }
  
  return response.json()
}

export interface Stock {
  id: number
  ticker: string
  name: string | null
  quantity: number
  currency: string
  sector: string | null
  purchase_price: number | null
  current_price: number | null
  previous_close: number | null
  dividend_yield: number | null
  dividend_per_share: number | null
  last_updated: string | null
  manual_dividends?: ManualDividend[]
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
  total_cost: number
  total_gain_loss: number
  total_gain_loss_percent: number
  display_currency: string
  stocks: Array<{
    ticker: string
    name: string | null
    quantity: number
    current_price: number
    current_value: number
    currency: string
    sector: string | null
    gain_loss: number | null
    gain_loss_percent: number | null
  }>
  stock_count: number
}

export interface Dividend {
  date: string
  amount: number
  currency?: string
  source?: string
  payment_date?: string
}

export interface UpcomingDividend {
  ticker: string
  name: string | null
  quantity: number
  ex_date: string
  payment_date?: string
  amount_per_share: number
  total_amount: number
  currency: string
  total_converted: number | null
  display_currency: string
  source: string
}

export interface UpcomingDividendsResponse {
  dividends: UpcomingDividend[]
  total_expected: number
  display_currency: string
  unmapped_stocks: Array<{
    ticker: string
    name: string | null
    reason: string
  }>
}

export interface TickerMapping {
  avanza_name: string
  yahoo_ticker: string
  instrument_id: string | null
  manually_added: boolean
  added_at?: string
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
  stocks: {
    list: () => fetchAPI('/stocks') as Promise<Stock[]>,
    get: (ticker: string) => fetchAPI(`/stocks/${ticker}`) as Promise<Stock>,
    create: (data: { ticker: string; quantity: number; purchase_price?: number }) => 
      fetchAPI('/stocks', { method: 'POST', body: JSON.stringify(data) }) as Promise<Stock>,
    update: (ticker: string, data: { quantity?: number; purchase_price?: number }) =>
      fetchAPI(`/stocks/${ticker}`, { method: 'PATCH', body: JSON.stringify(data) }) as Promise<Stock>,
    delete: (ticker: string) => fetchAPI(`/stocks/${ticker}`, { method: 'DELETE' }),
    refresh: (ticker: string) => fetchAPI(`/stocks/${ticker}/refresh`, { method: 'POST' }) as Promise<Stock>,
    dividends: (ticker: string, years: number = 5) => fetchAPI(`/stocks/${ticker}/dividends?years=${years}`) as Promise<Dividend[]>,
    upcomingDividends: (ticker: string) => fetchAPI(`/stocks/${ticker}/upcoming-dividends`) as Promise<Dividend[]>,
    analyst: (ticker: string) => fetchAPI(`/stocks/${ticker}/analyst`) as Promise<AnalystData>,
    validate: (ticker: string) => fetchAPI(`/stocks/validate/${ticker}`),
    addManualDividend: (ticker: string, data: { date: string; amount: number; currency?: string; note?: string }) =>
      fetchAPI(`/stocks/${ticker}/manual-dividends`, { method: 'POST', body: JSON.stringify(data) }) as Promise<Stock>,
    updateManualDividend: (ticker: string, dividendId: string, data: { date?: string; amount?: number; currency?: string; note?: string }) =>
      fetchAPI(`/stocks/${ticker}/manual-dividends/${dividendId}`, { method: 'PUT', body: JSON.stringify(data) }) as Promise<Stock>,
    deleteManualDividend: (ticker: string, dividendId: string) =>
      fetchAPI(`/stocks/${ticker}/manual-dividends/${dividendId}`, { method: 'DELETE' }),
    suppressDividend: (ticker: string, data: { date: string; amount?: number; currency?: string }) =>
      fetchAPI(`/stocks/${ticker}/suppress-dividend`, { method: 'POST', body: JSON.stringify(data) }),
    restoreDividend: (ticker: string, date: string) =>
      fetchAPI(`/stocks/${ticker}/suppress-dividend/${date}`, { method: 'DELETE' }),
    getSuppressedDividends: (ticker: string) =>
      fetchAPI(`/stocks/${ticker}/suppressed-dividends`) as Promise<ManualDividend[]>,
  },
  
  portfolio: {
    summary: () => fetchAPI('/portfolio/summary') as Promise<PortfolioSummary>,
    refreshAll: () => fetchAPI('/portfolio/refresh-all', { method: 'POST' }),
    distribution: () => fetchAPI('/portfolio/distribution'),
    history: (days: number = 30) => fetchAPI(`/portfolio/history?days=${days}`),
    upcomingDividends: () => fetchAPI('/portfolio/upcoming-dividends') as Promise<UpcomingDividendsResponse>,
  },
  
  market: {
    header: (force: boolean = false) => fetchAPI(`/market/header${force ? '?force=true' : ''}`) as Promise<HeaderMarketData>,
    indices: () => fetchAPI('/market/indices') as Promise<{ indices: MarketIndex[]; updated_at: string }>,
    exchangeRates: () => fetchAPI('/market/exchange-rates') as Promise<Record<string, number | null>>,
    convert: (amount: number, from: string, to: string) => 
      fetchAPI(`/market/convert?amount=${amount}&from_currency=${from}&to_currency=${to}`),
    hours: (timezone?: string) => fetchAPI(`/market/hours${timezone ? `?timezone=${encodeURIComponent(timezone)}` : ''}`) as Promise<MarketStatus[]>,
    marketHours: (market: string, timezone?: string) => fetchAPI(`/market/hours/${market}${timezone ? `?timezone=${encodeURIComponent(timezone)}` : ''}`) as Promise<MarketStatus>,
    openMarkets: () => fetchAPI('/market/open-markets') as Promise<{ open_markets: string[] }>,
    shouldRefresh: () => fetchAPI('/market/should-refresh') as Promise<{ should_refresh: boolean }>,
    sparklines: () => fetchAPI('/market/indices/sparklines') as Promise<{ sparklines: Record<string, SparklineData>; updated_at: string }>,
  },
  
  finnhub: {
    profile: (ticker: string) => fetchAPI(`/finnhub/profile/${ticker}`) as Promise<CompanyProfile>,
    metrics: (ticker: string) => fetchAPI(`/finnhub/metrics/${ticker}`) as Promise<FinancialMetrics>,
    peers: (ticker: string) => fetchAPI(`/finnhub/peers/${ticker}`) as Promise<string[]>,
    recommendations: (ticker: string) => fetchAPI(`/finnhub/recommendations/${ticker}`) as Promise<RecommendationTrend[]>,
  },
  
  marketstack: {
    status: () => fetchAPI('/marketstack/status') as Promise<MarketstackUsage>,
    dividends: (ticker: string, dateFrom?: string, dateTo?: string) => {
      const params = new URLSearchParams()
      if (dateFrom) params.append('date_from', dateFrom)
      if (dateTo) params.append('date_to', dateTo)
      const query = params.toString() ? `?${params.toString()}` : ''
      return fetchAPI(`/marketstack/dividends/${ticker}${query}`) as Promise<{
        ticker: string
        dividends: Dividend[]
        count: number
        usage: MarketstackUsage
      }>
    },
    verify: (ticker: string) => fetchAPI(`/marketstack/verify/${ticker}`, { method: 'POST' }) as Promise<VerificationResult>,
    clearCache: (ticker: string) => fetchAPI(`/marketstack/cache/${ticker}`, { method: 'DELETE' }) as Promise<{ message: string }>,
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
    addMapping: (data: { avanza_name: string; yahoo_ticker: string; instrument_id: string }) =>
      fetchAPI('/avanza/mappings', { method: 'POST', body: JSON.stringify(data) }) as Promise<TickerMapping>,
    deleteMapping: (avanzaName: string) =>
      fetchAPI(`/avanza/mappings/${encodeURIComponent(avanzaName)}`, { method: 'DELETE' }) as Promise<{ message: string }>,
    historical: (ticker: string, years: number = 5) =>
      fetchAPI(`/avanza/historical/${ticker}?years=${years}`) as Promise<Array<{
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
}
