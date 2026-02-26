import { useState, useEffect, useRef, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { LineChart, Line, ResponsiveContainer, YAxis } from 'recharts'
import { api, MarketIndex, MarketStatus, SparklineData } from '../services/api'
import { useSettings } from '../SettingsContext'
import { formatTimeInTimezone, getTimeUntilNextInterval } from '../utils/time'

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
  const [indices, setIndices] = useState<MarketIndex[]>([])
  const [marketHours, setMarketHours] = useState<MarketStatus[]>([])
  const [sparklines, setSparklines] = useState<Record<string, SparklineData>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdate, setLastUpdate] = useState<string | null>(null)
  const [nextRefresh, setNextRefresh] = useState<Date | null>(null)
  const { timezone } = useSettings()
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const fetchData = useCallback(async () => {
    try {
      setLoading(true)
      const [indicesData, hoursData, sparklineData] = await Promise.all([
        api.market.indices(),
        api.market.hours(timezone),
        api.market.sparklines().catch(() => ({ sparklines: {}, updated_at: '' })),
      ])
      setIndices(indicesData.indices)
      setMarketHours(hoursData)
      setSparklines(sparklineData.sparklines || {})
      setLastUpdate(indicesData.updated_at || sparklineData.updated_at || null)
      setError(null)
    } catch (err) {
      setError('Failed to load market data')
    } finally {
      setLoading(false)
    }
  }, [timezone])

  const scheduleNextRefresh = useCallback(async () => {
    try {
      const { should_refresh } = await api.market.shouldRefresh()
      if (!should_refresh) {
        return
      }
    } catch {
      return
    }
    
    const msUntilNext = getTimeUntilNextInterval(15)
    const nextTime = new Date(Date.now() + msUntilNext)
    setNextRefresh(nextTime)
    
    timeoutRef.current = setTimeout(() => {
      fetchData()
      scheduleNextRefresh()
    }, msUntilNext)
  }, [fetchData])

  useEffect(() => {
    fetchData()
    scheduleNextRefresh()
    
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
    }
  }, [fetchData, scheduleNextRefresh])

  if (loading && !indices.length) {
    return <div style={{ textAlign: 'center', padding: '40px' }}>Loading market data...</div>
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <div>
          <h2 style={{ fontSize: '24px', fontWeight: '600' }}>Markets</h2>
          {lastUpdate && (
            <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginTop: '4px' }}>
              Last updated: {formatTimeInTimezone(lastUpdate, timezone)}
              {nextRefresh && <span> · Next: {formatTimeInTimezone(nextRefresh, timezone)}</span>}
            </p>
          )}
        </div>
        <button className="btn btn-primary" onClick={fetchData} disabled={loading}>
          {loading ? 'Refreshing...' : 'Refresh'}
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
