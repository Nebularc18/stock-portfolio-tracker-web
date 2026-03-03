import { useState, useEffect, useRef, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { LineChart, Line, ResponsiveContainer, YAxis } from 'recharts'
import { api, MarketStatus, SparklineData } from '../services/api'
import { useHeaderData } from '../contexts/HeaderDataContext'
import { useSettings } from '../SettingsContext'
import { formatTimeInTimezone } from '../utils/time'

function formatNumber(value: number, decimals: number = 2): string {
  return value.toLocaleString('en-US', { 
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals 
  })
}

function MiniSparkline({ data, isPositive }: { data: number[]; isPositive: boolean }) {
  const chartData = data.map((value, index) => ({ value, index }))
  const color = isPositive ? '#22c55e' : '#ef4444'
  
  return (
    <div style={{ width: 80, height: 30 }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={chartData}>
          <YAxis domain={['dataMin', 'dataMax']} hide />
          <Line 
            type="monotone" 
            dataKey="value" 
            stroke={color} 
            strokeWidth={1.5} 
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

export default function Markets() {
  // Use shared market data from context
  const { indices, lastUpdated, nextRefreshAt, loading: headerLoading, refreshData } = useHeaderData()
  const [marketHours, setMarketHours] = useState<MarketStatus[]>([])
  const [sparklines, setSparklines] = useState<Record<string, SparklineData>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const { timezone } = useSettings()
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isMountedRef = useRef(true)

  // Fetch additional data (market hours and sparklines) separately
  const fetchAdditionalData = useCallback(async () => {
    try {
      const [sparklineData, hoursData] = await Promise.all([
        api.market.sparklines().catch(() => ({ sparklines: {}, updated_at: '' })),
        api.market.hours(timezone),
      ])
      if (!isMountedRef.current) return
      setSparklines(sparklineData.sparklines || {})
      setMarketHours(hoursData)
      setError(null)
    } catch (err) {
      if (!isMountedRef.current) return
      setError('Failed to load market data')
    } finally {
      if (isMountedRef.current) {
        setLoading(false)
      }
    }
  }, [timezone])

  // Schedule next refresh based on backend's next_refresh_at
  const scheduleNextRefresh = useCallback(() => {
    if (!nextRefreshAt) return
    
    const nextTime = new Date(nextRefreshAt)
    const msUntilNext = nextTime.getTime() - Date.now()
    
    if (msUntilNext > 0) {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
      timeoutRef.current = setTimeout(() => {
        refreshData()
        fetchAdditionalData()
      }, msUntilNext)
    }
  }, [nextRefreshAt, refreshData, fetchAdditionalData])

  useEffect(() => {
    isMountedRef.current = true
    fetchAdditionalData()
    
    return () => {
      isMountedRef.current = false
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
    }
  }, [fetchAdditionalData])

  // Schedule next refresh when nextRefreshAt changes
  useEffect(() => {
    if (nextRefreshAt) {
      scheduleNextRefresh()
    }
  }, [nextRefreshAt, scheduleNextRefresh])

  // Combined loading state
  const isLoading = headerLoading || loading

  const handleRefresh = async () => {
    setLoading(true)
    await refreshData(true)
    await fetchAdditionalData()
  }

  if (isLoading && !indices.length) {
    return <div style={{ textAlign: 'center', padding: '40px' }}>Loading market data...</div>
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <div>
          <h2 style={{ fontSize: '24px', fontWeight: '600' }}>Markets</h2>
          {lastUpdated && (
            <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginTop: '4px' }}>
              Last updated: {formatTimeInTimezone(lastUpdated, timezone)}
              {nextRefreshAt && <span> · Next: {formatTimeInTimezone(nextRefreshAt, timezone)}</span>}
            </p>
          )}
        </div>
        <button className="btn btn-primary" onClick={handleRefresh} disabled={isLoading}>
          {isLoading ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {error && (
        <div className="card" style={{ background: 'rgba(248, 81, 73, 0.1)', marginBottom: '20px' }}>
          <p style={{ color: 'var(--accent-red)' }}>{error}</p>
        </div>
      )}

      <div className="card" style={{ marginBottom: '24px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <h3>Market Hours</h3>
          <Link to="/settings" style={{ color: 'var(--accent-blue)', fontSize: '12px', textDecoration: 'none' }}>
            Change timezone
          </Link>
        </div>
        <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginBottom: '12px' }}>
          Times shown in your timezone ({marketHours[0]?.timezone || 'CET'})
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '16px' }}>
          {marketHours.map((market) => (
            <div 
              key={market.market} 
              style={{ 
                padding: '16px',
                background: 'var(--bg-tertiary)',
                borderRadius: '8px',
                borderLeft: `4px solid ${market.is_open ? 'var(--accent-green)' : 'var(--accent-red)'}`
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <p style={{ fontWeight: '600' }}>{market.name}</p>
                <span 
                  style={{ 
                    fontSize: '12px',
                    padding: '4px 8px',
                    borderRadius: '4px',
                    background: market.is_open ? 'rgba(63, 185, 80, 0.2)' : 'rgba(139, 148, 158, 0.2)',
                    color: market.is_open ? 'var(--accent-green)' : 'var(--text-secondary)'
                  }}
                >
                  {market.status}
                </span>
              </div>
              <p style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>
                {market.open_time} - {market.close_time} ({market.timezone})
              </p>
              {market.local_time && (
                <p style={{ color: 'var(--text-primary)', fontSize: '12px', marginTop: '4px' }}>
                  Local time: {market.local_time}
                </p>
              )}
            </div>
          ))}
        </div>
      </div>

      <h3 style={{ marginBottom: '16px' }}>Market Indices</h3>
      <div className="grid grid-2">
        {indices.map((index) => {
          const isPositive = index.change >= 0
          const changeClass = isPositive ? 'positive' : 'negative'
          const sparkline = sparklines[index.symbol]
          
          return (
            <div key={index.symbol} className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginBottom: '4px' }}>
                    {index.symbol}
                  </p>
                  <p style={{ fontSize: '16px', fontWeight: '600', marginBottom: '8px' }}>
                    {index.name}
                  </p>
                </div>
                <div style={{ textAlign: 'right', display: 'flex', alignItems: 'center', gap: '12px' }}>
                  {sparkline && (
                    <MiniSparkline data={sparkline.prices} isPositive={sparkline.is_positive} />
                  )}
                  <div>
                    <p style={{ fontSize: '24px', fontWeight: '600' }}>
                      {formatNumber(index.price)}
                    </p>
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: '16px', marginTop: '12px' }}>
                <span className={changeClass}>
                  {isPositive ? '+' : ''}{formatNumber(index.change)}
                </span>
                <span className={changeClass}>
                  {isPositive ? '+' : ''}{formatNumber(index.change_percent)}%
                </span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
