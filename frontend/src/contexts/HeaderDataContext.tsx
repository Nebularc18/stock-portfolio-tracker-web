import { createContext, useContext, useState, useEffect, useRef, ReactNode, useCallback } from 'react'
import { api, MarketIndex, HeaderMarketData } from '../services/api'

interface HeaderDataContextType {
  indices: MarketIndex[]
  exchangeRates: Record<string, number | null>
  lastUpdated: string | null
  nextRefreshAt: string | null
  loading: boolean
  refreshData: (force?: boolean) => Promise<HeaderMarketData | null>
}

const HeaderDataContext = createContext<HeaderDataContextType | null>(null)
const MIN_REFRESH_MS = 5000

/**
 * Provides header market data and a refresh function to descendant components via context.
 *
 * The provider maintains live values for market indices, exchange rates,
 * and the last-updated timestamp, scheduling refreshes based on backend cache timing.
 *
 * @param children - React nodes to render within the provider
 * @returns The HeaderDataContext provider element wrapping `children`
 */
export function HeaderDataProvider({ children }: { children: ReactNode }) {
  const [indices, setIndices] = useState<MarketIndex[]>([])
  const [exchangeRates, setExchangeRates] = useState<Record<string, number | null>>({})
  const [lastUpdated, setLastUpdated] = useState<string | null>(null)
  const [nextRefreshAt, setNextRefreshAt] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isMountedRef = useRef(true)

  const fetchData = useCallback(async (forceRefresh = false) => {
    if (isMountedRef.current) {
      setLoading(true)
    }
    try {
      const data = await api.market.header(forceRefresh)
      if (!isMountedRef.current) return data
      
      setIndices(data.indices)
      setExchangeRates(data.exchange_rates)
      setLastUpdated(data.updated_at)
      setNextRefreshAt(data.next_refresh_at || null)
      setLoading(false)
      return data
    } catch (error) {
      console.error('Failed to fetch header data:', error)
      if (isMountedRef.current) {
        setNextRefreshAt(new Date(Date.now() + 60_000).toISOString())
        setLoading(false)
      }
      return null
    }
  }, [])

  const scheduleNextRefresh = useCallback(() => {
    if (!nextRefreshAt) return

    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
    }

    const nextTime = new Date(nextRefreshAt)
    const msUntilNext = nextTime.getTime() - Date.now()

    if (!Number.isFinite(msUntilNext) || msUntilNext <= 0) {
      timeoutRef.current = setTimeout(() => {
        fetchData()
      }, MIN_REFRESH_MS)
      return
    }

    if (msUntilNext > 0) {
      timeoutRef.current = setTimeout(() => {
        fetchData()
      }, msUntilNext)
    }
  }, [fetchData, nextRefreshAt])

  useEffect(() => {
    isMountedRef.current = true
    fetchData()
    
    return () => {
      isMountedRef.current = false
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
    }
  }, [fetchData])

  useEffect(() => {
    if (nextRefreshAt) {
      scheduleNextRefresh()
    }
  }, [nextRefreshAt, scheduleNextRefresh])

  return (
    <HeaderDataContext.Provider value={{ 
      indices, 
      exchangeRates, 
      lastUpdated, 
      nextRefreshAt,
      loading, 
      refreshData: fetchData 
    }}>
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
