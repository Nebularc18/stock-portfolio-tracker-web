import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useLocation, Outlet } from 'react-router-dom'
import { useHeaderData } from '../contexts/HeaderDataContext'
import { useSettings } from '../SettingsContext'
import { getLocaleForLanguage, t } from '../i18n'
import { useAuth } from '../AuthContext'

/**
 * Graphite layout — sticky topbar with market indices + live clock,
 * sticky horizontal nav bar, full-width content area.
 */
export default function InfographicLayout() {
  const location = useLocation()
  const { indices: allIndices, exchangeRates } = useHeaderData()
  const { timezone, headerIndices, language } = useSettings()
  const { user, logout } = useAuth()
  const locale = getLocaleForLanguage(language)
  const currentYear = new Date().getUTCFullYear()
  const [logoutError, setLogoutError] = useState<string | null>(null)
  const [isLoggingOut, setIsLoggingOut] = useState(false)
  const [clock, setClock] = useState(() => new Date())
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Live clock tick
  useEffect(() => {
    intervalRef.current = setInterval(() => setClock(new Date()), 1000)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [])

  const formatClock = (d: Date) => {
    const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    return d.toLocaleTimeString(locale, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZone: tz,
    })
  }

  // Filter indices based on settings
  const hasValidHeaderIndices = Array.isArray(headerIndices) && headerIndices.length > 0
  const matched = hasValidHeaderIndices
    ? allIndices.filter(idx => headerIndices.includes(idx.symbol))
    : []
  const indices = matched.length > 0 ? matched : allIndices.slice(0, 5)

  const shortLabel = (symbol: string, name: string) => {
    switch (symbol) {
      case '^OMXS30':    return 'OMX30'
      case '^OMXS30GI':  return 'OMX30GI'
      case '^OMXSPI':    return 'OMXSPI'
      case '^GSPC':      return 'S&P500'
      case '^IXIC':      return 'NASDAQ'
      case '^DJI':       return 'DOW'
      case '^FTSE':      return 'FTSE100'
      case '^GDAXI':     return 'DAX'
      default:           return (name || symbol).replace(/^[\^]/, '').substring(0, 8)
    }
  }

  const links = [
    { to: '/',                  label: t(language, 'nav.dashboard') },
    { to: '/performance',       label: t(language, 'nav.performance') },
    { to: '/analytics',         label: t(language, 'nav.analytics') },
    { to: '/dividends/history', label: t(language, 'nav.dividendsHistory') },
    { to: '/dividends/upcoming', label: t(language, 'nav.upcomingDividendsYear', { year: currentYear }) },
    { to: '/stocks',            label: t(language, 'nav.stocks') },
    { to: '/markets',           label: t(language, 'nav.markets') },
    { to: '/settings',          label: t(language, 'nav.settings') },
  ]

  const isActive = (path: string) => {
    if (path === '/') return location.pathname === '/'
    return location.pathname === path || location.pathname.startsWith(`${path}/`)
  }

  const handleLogout = useCallback(async () => {
    setLogoutError(null)
    setIsLoggingOut(true)
    try {
      await Promise.resolve(logout())
    } catch {
      setLogoutError(t(language, 'layout.logoutError'))
    } finally {
      setIsLoggingOut(false)
    }
  }, [language, logout])

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', color: 'var(--text)' }}>

      {/* ── TOPBAR ── */}
      <div className="topbar">
        <div className="tb-logo">
          <img src="/logo.png" alt="Portfolio logo" className="tb-logo-mark" />
          <span className="tb-logo-word">PORTFOLIO</span>
        </div>

        {/* Market indices strip */}
        <div className="tb-indices">
          {indices.map(idx => {
            const safeChange = idx.change != null && Number.isFinite(Number(idx.change))
              ? Number(idx.change) : null
            const safeChangePct = idx.change_percent != null && Number.isFinite(Number(idx.change_percent))
              ? Number(idx.change_percent) : null
            const isPos = safeChange !== null && safeChange >= 0
            return (
              <div key={idx.symbol} className="tb-idx">
                <span className="ti-nm">{shortLabel(idx.symbol, idx.name)}</span>
                <span className="ti-vl">
                  {idx.price != null && Number.isFinite(Number(idx.price))
                    ? Number(idx.price).toLocaleString(locale, { maximumFractionDigits: 0 })
                    : '—'}
                </span>
                {safeChangePct !== null && (
                  <span className={`ti-ch ${isPos ? 'up' : 'dn'}`}>
                    {isPos ? '↑' : '↓'}{Math.abs(safeChangePct).toFixed(2)}%
                  </span>
                )}
              </div>
            )
          })}

          {/* FX rates */}
          {(exchangeRates.USD_SEK != null || exchangeRates.EUR_SEK != null) && (
            <div className="tb-idx" style={{ gap: 12 }}>
              {exchangeRates.USD_SEK != null && (
                <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span className="ti-nm">USD/SEK</span>
                  <span className="ti-vl">{Number(exchangeRates.USD_SEK).toFixed(4)}</span>
                </span>
              )}
              {exchangeRates.EUR_SEK != null && (
                <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span className="ti-nm">EUR/SEK</span>
                  <span className="ti-vl">{Number(exchangeRates.EUR_SEK).toFixed(4)}</span>
                </span>
              )}
            </div>
          )}
        </div>

        {/* Clock + user */}
        <div className="tb-time">
          <span className="live-dot" />
          {formatClock(clock)}
          <span style={{ borderLeft: '1px solid var(--border)', paddingLeft: 14, marginLeft: 8 }}>
            {user?.username || ''}
            {user?.is_guest ? (
              <span style={{ color: 'var(--amber)', marginLeft: 4, fontSize: 9 }}>GUEST</span>
            ) : null}
          </span>
          <button
            onClick={() => void handleLogout()}
            disabled={isLoggingOut}
            style={{
              background: 'transparent',
              border: '1px solid var(--border2)',
              borderRadius: 4,
              color: 'var(--muted)',
              fontSize: 10,
              padding: '2px 8px',
              cursor: 'pointer',
              marginLeft: 6,
              fontFamily: "'Plus Jakarta Sans', sans-serif",
              letterSpacing: '0.05em',
              transition: 'border-color 0.15s, color 0.15s',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--red)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--red)' }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border2)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--muted)' }}
          >
            {isLoggingOut ? '...' : t(language, 'layout.logout')}
          </button>
          {logoutError && (
            <span style={{ color: 'var(--red)', fontSize: 10, marginLeft: 6 }}>{logoutError}</span>
          )}
        </div>
      </div>

      {/* ── NAV BAR ── */}
      <nav className="appnav">
        {links.map(link => (
          <Link
            key={link.to}
            to={link.to}
            className={`nav-link${isActive(link.to) ? ' active' : ''}`}
          >
            {link.label}
          </Link>
        ))}
      </nav>

      {/* ── CONTENT ── */}
      <main>
        <Outlet />
      </main>
    </div>
  )
}
