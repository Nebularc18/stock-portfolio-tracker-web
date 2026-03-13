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
  const fallbackTimezone = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

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
    scheduleNextRefresh()
  }, [nextRefreshAt, scheduleNextRefresh])

  // Combined loading state
  const isLoading = headerLoading || loading

  const handleRefresh = async () => {
    setLoading(true)
    try {
      await refreshData(true)
      await fetchAdditionalData()
      setError(null)
    } catch (err) {
      setError(t(language, 'markets.failedLoad'))
      console.error('Failed to refresh market data:', err)
    } finally {
      setLoading(false)
    }
  }

  if (isLoading && !indices.length) {
    return <div className="loading-state">{t(language, 'markets.loadingData')}</div>
  }

  const secLabel = { fontSize: 9, fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase' as const, color: 'var(--muted)' }

  return (
    <div>
      {/* Page header */}
      <div style={{
        background: 'linear-gradient(115deg, #12141c 0%, var(--bg) 55%)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: '22px 24px',
        marginBottom: 20,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        position: 'relative',
        overflow: 'hidden',
      }}>
        <div style={{ position: 'absolute', top: -50, right: -50, width: 220, height: 220, background: 'radial-gradient(circle, rgba(129,140,248,0.07) 0%, transparent 70%)', pointerEvents: 'none' }} />
        <div>
          <h2 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em', marginBottom: 4 }}>{t(language, 'markets.title')}</h2>
          {lastUpdated && (
            <p style={{ color: 'var(--muted)', fontSize: 11 }}>
              {t(language, 'common.lastUpdated')}: {formatTimeInTimezone(lastUpdated, timezone, locale)}
              {nextRefreshAt && <span> · {t(language, 'common.next')}: {formatTimeInTimezone(nextRefreshAt, timezone, locale)}</span>}
            </p>
          )}
        </div>
        <button className="btn btn-secondary" onClick={handleRefresh} disabled={isLoading} style={{ flexShrink: 0 }}>
          {isLoading ? t(language, 'common.refreshing') : t(language, 'common.refresh')}
        </button>
      </div>

      {error && (
        <div style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: 8, padding: '12px 16px', marginBottom: 16 }}>
          <p style={{ color: 'var(--red)', fontSize: 13 }}>{error}</p>
        </div>
      )}

      {/* Market hours */}
      <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, marginBottom: 20 }}>
        <div className="sec-row" style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <span className="sec-title">{t(language, 'layout.marketHours')}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <span style={{ color: 'var(--muted)', fontSize: 11 }}>
              {t(language, 'layout.timesInTimezone')} ({marketHours[0]?.timezone || fallbackTimezone})
            </span>
            <Link to="/settings" style={{ color: 'var(--v2)', fontSize: 11, textDecoration: 'none' }}>
              {t(language, 'layout.changeTimezone')}
            </Link>
          </div>
        </div>
        <div style={{ padding: '16px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
          {marketHours.map((market) => (
            <div
              key={market.market}
              style={{
                padding: '14px 16px',
                background: 'var(--bg3)',
                border: '1px solid var(--border)',
                borderLeft: `3px solid ${market.is_open ? 'var(--green2)' : 'var(--red)'}`,
                borderRadius: 6,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontWeight: 600, fontSize: 14 }}>{market.name}</span>
                <span className={`badge ${market.is_open ? 'badge-green' : 'badge-red'}`}>
                  {market.status}
                </span>
              </div>
              <div style={{ color: 'var(--muted)', fontSize: 11 }}>
                {market.open_time} – {market.close_time} ({market.timezone})
              </div>
              {market.local_time && (
                <div className="mono" style={{ color: 'var(--text2)', fontSize: 12, marginTop: 4 }}>
                  {t(language, 'layout.localTime')}: {market.local_time}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Indices grid */}
      <div style={{ ...secLabel, marginBottom: 12 }}>{t(language, 'layout.marketIndices')}</div>
      <div className="grid grid-2">
        {indices.map((index) => {
          const safePrice = Number.isFinite(index.price) ? index.price : null
          const safeChange = Number.isFinite(index.change) ? index.change : null
          const safeChangePercent = Number.isFinite(index.change_percent) ? index.change_percent : null
          const sparkline = sparklines[index.symbol]
          const sparklinePrices = Array.isArray(sparkline?.prices) ? sparkline.prices : null
          const isPositive = safeChange !== null ? safeChange >= 0 : false

          return (
            <div key={index.symbol} style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, padding: '16px 20px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
                <div>
                  <div style={{ ...secLabel, marginBottom: 4 }}>{index.symbol}</div>
                  <div style={{ fontSize: 15, fontWeight: 600 }}>{index.name}</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                  {sparklinePrices && (
                    <MiniSparkline data={sparklinePrices} isPositive={sparkline.is_positive} />
                  )}
                  <div className="mono" style={{ fontSize: 22, fontWeight: 700, textAlign: 'right' }}>
                    {safePrice !== null ? formatNumber(safePrice, locale) : '-'}
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 16 }}>
                <span className={`mono ${isPositive ? 'up' : 'dn'}`} style={{ fontSize: 13 }}>
                  {safeChange !== null ? `${isPositive ? '+' : ''}${formatNumber(safeChange, locale)}` : '-'}
                </span>
                <span className={`mono ${isPositive ? 'up' : 'dn'}`} style={{ fontSize: 13 }}>
                  {safeChangePercent !== null ? `${isPositive ? '+' : ''}${formatNumber(safeChangePercent, locale)}%` : '-'}
                </span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
