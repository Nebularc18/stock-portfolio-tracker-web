import { useState, useEffect, useRef, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { LineChart, Line, ResponsiveContainer, YAxis } from 'recharts'
import { api, MarketStatus, SparklineData } from '../services/api'
import { useHeaderData } from '../contexts/HeaderDataContext'
import { useSettings } from '../SettingsContext'
import { formatTimeInTimezone } from '../utils/time'
import { getLocaleForLanguage, t } from '../i18n'

/**
 * Format a number as a locale-aware string with a fixed number of decimal places.
 *
 * @param value - The numeric value to format
 * @param locale - BCP 47 language tag or locale identifier used for localization (e.g., "en-US")
 * @param decimals - Number of decimal places to include (defaults to 2)
 * @returns The number formatted according to `locale` with exactly `decimals` fraction digits
 */
function formatNumber(value: number, locale: string, decimals: number = 2): string {
  return value.toLocaleString(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  })
}

/**
 * Render a compact sparkline for a numeric series, using color to indicate positive or negative trend.
 *
 * @param data - Ordered numeric values to plot (earliest to latest)
 * @param isPositive - If `true`, use the positive color; otherwise use the negative color
 * @returns A small React element containing the rendered sparkline for the provided data
 */
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

/**
 * Renders the Markets page with indices, market hours, sparklines, and refresh controls.
 *
 * Fetches additional market data (market hours and sparklines), schedules backend-driven refreshes,
 * and combines shared header-provided market indices with locally loaded details. Respects user
 * settings for timezone and language to format times and numbers, exposes a manual refresh action,
 * and displays loading and error states.
 *
 * @returns The Markets page React element.
 */
export default function Markets() {
  // Use shared market data from context
  const { indices, lastUpdated, nextRefreshAt, loading: headerLoading, refreshData } = useHeaderData()
  const [marketHours, setMarketHours] = useState<MarketStatus[]>([])
  const [sparklines, setSparklines] = useState<Record<string, SparklineData>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const { timezone, language } = useSettings()
  const locale = getLocaleForLanguage(language)
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
      setError(t(language, 'markets.failedLoad'))
    } finally {
      if (isMountedRef.current) {
        setLoading(false)
      }
    }
  }, [timezone, language])

  // Schedule next refresh based on backend's next_refresh_at
  const scheduleNextRefresh = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
    }

    if (!nextRefreshAt) return

    const nextTime = new Date(nextRefreshAt)
    const msUntilNext = nextTime.getTime() - Date.now()

    if (msUntilNext > 0) {
      timeoutRef.current = setTimeout(() => {
        fetchAdditionalData()
      }, msUntilNext)
      return
    }

    fetchAdditionalData()
  }, [nextRefreshAt, fetchAdditionalData])

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
    return <div style={{ textAlign: 'center', padding: '40px' }}>{t(language, 'markets.loadingData')}</div>
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <div>
          <h2 style={{ fontSize: '24px', fontWeight: '600' }}>{t(language, 'markets.title')}</h2>
          {lastUpdated && (
            <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginTop: '4px' }}>
              {t(language, 'common.lastUpdated')}: {formatTimeInTimezone(lastUpdated, timezone, locale)}
              {nextRefreshAt && <span> · {t(language, 'common.next')}: {formatTimeInTimezone(nextRefreshAt, timezone, locale)}</span>}
            </p>
          )}
        </div>
        <button className="btn btn-primary" onClick={handleRefresh} disabled={isLoading}>
          {isLoading ? t(language, 'common.refreshing') : t(language, 'common.refresh')}
        </button>
      </div>

      {error && (
        <div className="card" style={{ background: 'rgba(248, 81, 73, 0.1)', marginBottom: '20px' }}>
          <p style={{ color: 'var(--accent-red)' }}>{error}</p>
        </div>
      )}

      <div className="card" style={{ marginBottom: '24px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <h3>{t(language, 'layout.marketHours')}</h3>
          <Link to="/settings" style={{ color: 'var(--accent-blue)', fontSize: '12px', textDecoration: 'none' }}>
            {t(language, 'layout.changeTimezone')}
          </Link>
        </div>
        <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginBottom: '12px' }}>
          {t(language, 'layout.timesInTimezone')} ({marketHours[0]?.timezone || 'CET'})
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
                  {t(language, 'layout.localTime')}: {market.local_time}
                </p>
              )}
            </div>
          ))}
        </div>
      </div>

      <h3 style={{ marginBottom: '16px' }}>{t(language, 'layout.marketIndices')}</h3>
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
                      {formatNumber(index.price, locale)}
                    </p>
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: '16px', marginTop: '12px' }}>
                <span className={changeClass}>
                  {isPositive ? '+' : ''}{formatNumber(index.change, locale)}
                </span>
                <span className={changeClass}>
                  {isPositive ? '+' : ''}{formatNumber(index.change_percent, locale)}%
                </span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
