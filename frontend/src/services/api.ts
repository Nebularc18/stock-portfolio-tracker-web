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
}

export interface AnalystData {
  recommendations: Record<string, unknown> | null
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
  } | null
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
  },
  
  portfolio: {
    summary: () => fetchAPI('/portfolio/summary') as Promise<PortfolioSummary>,
    refreshAll: () => fetchAPI('/portfolio/refresh-all', { method: 'POST' }),
    distribution: () => fetchAPI('/portfolio/distribution'),
    history: (days: number = 30) => fetchAPI(`/portfolio/history?days=${days}`),
  },
  
  market: {
    indices: () => fetchAPI('/market/indices') as Promise<MarketIndex[]>,
    exchangeRates: () => fetchAPI('/market/exchange-rates') as Promise<Record<string, number | null>>,
    convert: (amount: number, from: string, to: string) => 
      fetchAPI(`/market/convert?amount=${amount}&from_currency=${from}&to_currency=${to}`),
    hours: (timezone?: string) => fetchAPI(`/market/hours${timezone ? `?timezone=${encodeURIComponent(timezone)}` : ''}`) as Promise<MarketStatus[]>,
    marketHours: (market: string, timezone?: string) => fetchAPI(`/market/hours/${market}${timezone ? `?timezone=${encodeURIComponent(timezone)}` : ''}`) as Promise<MarketStatus>,
    openMarkets: () => fetchAPI('/market/open-markets') as Promise<{ open_markets: string[] }>,
    shouldRefresh: () => fetchAPI('/market/should-refresh') as Promise<{ should_refresh: boolean }>,
  },
}
