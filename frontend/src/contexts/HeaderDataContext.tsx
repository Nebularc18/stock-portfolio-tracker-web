import { createContext, useContext, useState, useEffect, useRef, ReactNode } from 'react'
import { api, MarketIndex, HeaderMarketData } from '../services/api'

interface HeaderDataContextType {
  indices: MarketIndex[]
  exchangeRates: Record<string, number | null>
  lastUpdated: string | null
  loading: boolean
}

const HeaderDataContext = createContext<HeaderDataContextType | null>(null)

const CACHE_KEY = 'header_market_data'
const CACHE_TTL = 15 * 60 * 1000

interface CachedData {
  data: HeaderMarketData
  timestamp: number
}

function loadFromCache(): HeaderMarketData | null {
  try {
    const cached = localStorage.getItem(CACHE_KEY)
    if (!cached) return null
    
    const parsed: CachedData = JSON.parse(cached)
    if (Date.now() - parsed.timestamp > CACHE_TTL) {
      return null
    }
    return parsed.data
  } catch {
    return null
  }
}

function saveToCache(data: HeaderMarketData) {
  try {
    const cacheEntry: CachedData = {
      data,
      timestamp: Date.now(),
    }
    localStorage.setItem(CACHE_KEY, JSON.stringify(cacheEntry))
  } catch {
    // Ignore cache errors
  }
}

export function HeaderDataProvider({ children }: { children: ReactNode }) {
  const [indices, setIndices] = useState<MarketIndex[]>([])
  const [exchangeRates, setExchangeRates] = useState<Record<string, number | null>>({})
  const [lastUpdated, setLastUpdated] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchData = async (forceRefresh = false) => {
    try {
      const { should_refresh } = await api.market.shouldRefresh()
      if (!should_refresh && !forceRefresh) {
        return
      }
    } catch {
      return
    }

    if (!forceRefresh) {
      const cached = loadFromCache()
      if (cached) {
        setIndices(cached.indices)
        setExchangeRates(cached.exchange_rates)
        setLastUpdated(cached.updated_at)
        setLoading(false)
        return
      }
    }

    try {
      const data = await api.market.header(forceRefresh)
      setIndices(data.indices)
      setExchangeRates(data.exchange_rates)
      setLastUpdated(data.updated_at)
      saveToCache(data)
    } catch (error) {
      console.error('Failed to fetch header data:', error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
    
    intervalRef.current = setInterval(() => {
      fetchData()
    }, 15 * 60 * 1000)
    
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
      }
    }
  }, [])

  return (
    <HeaderDataContext.Provider value={{ indices, exchangeRates, lastUpdated, loading }}>
      {children}
    </HeaderDataContext.Provider>
  )
}

export function useHeaderData() {
  const context = useContext(HeaderDataContext)
  if (!context) {
    throw new Error('useHeaderData must be used within a HeaderDataProvider')
  }
  return context
}
