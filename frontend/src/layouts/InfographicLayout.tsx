import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, Outlet, useLocation } from 'react-router-dom'
import { useHeaderData } from '../contexts/HeaderDataContext'
import { useSettings } from '../SettingsContext'
import { getLocaleForLanguage, t } from '../i18n'
import { useAuth } from '../AuthContext'

function formatClock(d: Date, locale: string, timezone?: string) {
  const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  try {
    return d.toLocaleTimeString(locale, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZone: tz,
    })
  } catch {
    return d.toLocaleTimeString(locale, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZone: 'UTC',
    })
  }
}

function LiveClock({ locale, timezone }: { locale: string; timezone?: string }) {
  const [clock, setClock] = useState(() => new Date())

  useEffect(() => {
    const intervalId = setInterval(() => setClock(new Date()), 1000)
    return () => {
      clearInterval(intervalId)
    }
  }, [])

  return <span>{formatClock(clock, locale, timezone)}</span>
}

export default function InfographicLayout() {
  const location = useLocation()
  const { indices: allIndices, exchangeRates } = useHeaderData()
  const { timezone, headerIndices, language } = useSettings()
  const { user, logout } = useAuth()
  const locale = getLocaleForLanguage(language)
  const currentYear = Number((() => {
    const resolvedTimeZone = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    try {
      return new Intl.DateTimeFormat(locale, { year: 'numeric', timeZone: resolvedTimeZone }).format(new Date())
    } catch {
      return new Intl.DateTimeFormat(locale, { year: 'numeric', timeZone: 'UTC' }).format(new Date())
    }
  })())
  const [logoutError, setLogoutError] = useState<string | null>(null)
  const [isLoggingOut, setIsLoggingOut] = useState(false)
  const indicesScrollerRef = useRef<HTMLDivElement | null>(null)
  const [canScrollIndicesLeft, setCanScrollIndicesLeft] = useState(false)
  const [canScrollIndicesRight, setCanScrollIndicesRight] = useState(false)

  const hasValidHeaderIndices = Array.isArray(headerIndices) && headerIndices.length > 0
  const matched = hasValidHeaderIndices
    ? headerIndices
      .map((symbol) => allIndices.find((idx) => idx.symbol === symbol))
      .filter((idx): idx is (typeof allIndices)[number] => idx !== undefined)
    : []
  const indices = matched.length > 0 ? matched : allIndices.slice(0, 5)

  const shortLabel = (symbol: string, name: string) => {
    switch (symbol) {
      case '^OMXS30': return 'OMX30'
      case '^OMXS30GI': return 'OMX30GI'
      case '^OMXSPI': return 'OMXSPI'
      case '^GSPC': return 'S&P500'
      case '^IXIC': return 'NASDAQ'
      case '^DJI': return 'DOW'
      case '^FTSE': return 'FTSE100'
      case '^GDAXI': return 'DAX'
      default: return (name || symbol).replace(/^[\^]/, '').substring(0, 8)
    }
  }

  const links = [
    { to: '/', label: t(language, 'nav.dashboard') },
    { to: '/performance', label: t(language, 'nav.performance') },
    { to: '/analytics', label: t(language, 'nav.analytics') },
    { to: '/dividends/history', label: t(language, 'nav.dividendsHistory') },
    { to: '/dividends/upcoming', label: t(language, 'nav.upcomingDividendsYear', { year: currentYear }) },
    { to: '/stocks', label: t(language, 'nav.stocks') },
    { to: '/markets', label: t(language, 'nav.markets') },
    { to: '/settings', label: t(language, 'nav.settings') },
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

  const updateIndicesScrollState = useCallback(() => {
    const element = indicesScrollerRef.current
    if (!element) {
      setCanScrollIndicesLeft(false)
      setCanScrollIndicesRight(false)
      return
    }

    const maxScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth)
    setCanScrollIndicesLeft(element.scrollLeft > 2)
    setCanScrollIndicesRight(element.scrollLeft < maxScrollLeft - 2)
  }, [])

  const scrollIndicesByPage = useCallback((direction: 'left' | 'right') => {
    const element = indicesScrollerRef.current
    if (!element) return

    const scrollAmount = Math.max(240, Math.floor(element.clientWidth * 0.75))
    const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
    element.scrollBy({
      left: direction === 'left' ? -scrollAmount : scrollAmount,
      behavior,
    })
  }, [])

  const handleIndicesWheel = useCallback((event: WheelEvent, element: HTMLDivElement) => {
    if (!element || element.scrollWidth <= element.clientWidth) return

    const deltaModeFactor = event.deltaMode === 1
      ? 16
      : event.deltaMode === 2
        ? element.clientHeight
        : 1
    const normalizedDeltaX = event.deltaX * deltaModeFactor
    const normalizedDeltaY = event.deltaY * deltaModeFactor
    const delta = Math.abs(normalizedDeltaX) > Math.abs(normalizedDeltaY) ? normalizedDeltaX : normalizedDeltaY
    if (delta === 0) return

    const maxScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth)
    const canScrollForward = delta > 0 && element.scrollLeft < maxScrollLeft - 1
    const canScrollBackward = delta < 0 && element.scrollLeft > 1
    if (!canScrollForward && !canScrollBackward) return

    event.preventDefault()
    element.scrollBy({ left: delta, behavior: 'auto' })
  }, [])

  useEffect(() => {
    updateIndicesScrollState()
    const element = indicesScrollerRef.current
    if (!element) return

    const handleScroll = () => updateIndicesScrollState()
    const handleResize = () => updateIndicesScrollState()
    const handleWheel = (event: WheelEvent) => handleIndicesWheel(event, element)
    const resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => updateIndicesScrollState())
      : null
    const stripElement = element.firstElementChild instanceof HTMLElement
      ? element.firstElementChild
      : null

    element.addEventListener('scroll', handleScroll, { passive: true })
    element.addEventListener('wheel', handleWheel, { passive: false })
    window.addEventListener('resize', handleResize)
    resizeObserver?.observe(element)
    if (stripElement) {
      resizeObserver?.observe(stripElement)
    }

    return () => {
      element.removeEventListener('scroll', handleScroll)
      element.removeEventListener('wheel', handleWheel)
      window.removeEventListener('resize', handleResize)
      resizeObserver?.disconnect()
    }
  }, [handleIndicesWheel, indices, updateIndicesScrollState])

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', color: 'var(--text)' }}>
      <div className="topbar">
        <div className="tb-logo">
          <img src="/logo.png" alt="Portfolio logo" className="tb-logo-mark" />
          <span className="tb-logo-word">PORTFOLIO</span>
        </div>

        <div className="tb-indices-wrap">
          <button
            type="button"
            className={`tb-scroll-btn left${canScrollIndicesLeft ? ' visible' : ''}`}
            onClick={() => scrollIndicesByPage('left')}
            aria-label={t(language, 'layout.scrollIndicesLeft')}
            aria-hidden={!canScrollIndicesLeft}
            disabled={!canScrollIndicesLeft}
            tabIndex={canScrollIndicesLeft ? 0 : -1}
          >
            &lsaquo;
          </button>
          <div
            ref={indicesScrollerRef}
            className="tb-indices"
          >
            {indices.map((idx) => {
              const safeChange = idx.change != null && Number.isFinite(Number(idx.change))
                ? Number(idx.change)
                : null
              const safeChangePct = idx.change_percent != null && Number.isFinite(Number(idx.change_percent))
                ? Number(idx.change_percent)
                : null
              const isPos = safeChange !== null
                ? safeChange > 0
                : safeChangePct !== null
                  ? safeChangePct > 0
                  : false
              const isNeg = safeChange !== null
                ? safeChange < 0
                : safeChangePct !== null
                  ? safeChangePct < 0
                  : false

              return (
                <div key={idx.symbol} className="tb-idx">
                  <span className="ti-nm">{shortLabel(idx.symbol, idx.name)}</span>
                  <span className="ti-vl">
                    {idx.price != null && Number.isFinite(Number(idx.price))
                      ? Number(idx.price).toLocaleString(locale, { maximumFractionDigits: 0 })
                      : '-'}
                  </span>
                  {safeChangePct !== null && (
                    <span className={`ti-ch ${isPos ? 'up' : isNeg ? 'dn' : ''}`}>
                      {isPos ? '↑' : isNeg ? '↓' : ''}
                      {Math.abs(safeChangePct).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%
                    </span>
                  )}
                </div>
              )
            })}

            {(() => {
              const usdSek = Number.isFinite(Number(exchangeRates.USD_SEK)) ? Number(exchangeRates.USD_SEK) : null
              const eurSek = Number.isFinite(Number(exchangeRates.EUR_SEK)) ? Number(exchangeRates.EUR_SEK) : null
              if (usdSek === null && eurSek === null) return null

              return (
                <div className="tb-idx" style={{ gap: 12 }}>
                  {usdSek !== null && (
                    <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <span className="ti-nm">USD/SEK</span>
                      <span className="ti-vl">{usdSek.toLocaleString(locale, { minimumFractionDigits: 4, maximumFractionDigits: 4 })}</span>
                    </span>
                  )}
                  {eurSek !== null && (
                    <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <span className="ti-nm">EUR/SEK</span>
                      <span className="ti-vl">{eurSek.toLocaleString(locale, { minimumFractionDigits: 4, maximumFractionDigits: 4 })}</span>
                    </span>
                  )}
                </div>
              )
            })()}
          </div>
          <button
            type="button"
            className={`tb-scroll-btn right${canScrollIndicesRight ? ' visible' : ''}`}
            onClick={() => scrollIndicesByPage('right')}
            aria-label={t(language, 'layout.scrollIndicesRight')}
            aria-hidden={!canScrollIndicesRight}
            disabled={!canScrollIndicesRight}
            tabIndex={canScrollIndicesRight ? 0 : -1}
          >
            &rsaquo;
          </button>
          <div className={`tb-indices-fade left${canScrollIndicesLeft ? ' visible' : ''}`} aria-hidden="true" />
          <div className={`tb-indices-fade right${canScrollIndicesRight ? ' visible' : ''}`} aria-hidden="true" />
        </div>

        <div className="tb-time">
          <span className="live-dot" />
          <LiveClock locale={locale} timezone={timezone} />
          <span style={{ borderLeft: '1px solid var(--border)', paddingLeft: 14, marginLeft: 8 }}>
            {user?.username || ''}
            {user?.is_guest ? (
              <span style={{ color: 'var(--amber)', marginLeft: 4, fontSize: 9 }}>{t(language, 'guest')}</span>
            ) : null}
          </span>
          <button
            onClick={() => void handleLogout()}
            disabled={isLoggingOut}
            className="logout-btn"
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
          >
            {isLoggingOut ? '...' : t(language, 'layout.logout')}
          </button>
          {logoutError && (
            <span style={{ color: 'var(--red)', fontSize: 10, marginLeft: 6 }}>{logoutError}</span>
          )}
        </div>
      </div>

      <nav className="appnav">
        {links.map((link) => (
          <Link
            key={link.to}
            to={link.to}
            className={`nav-link${isActive(link.to) ? ' active' : ''}`}
          >
            {link.label}
          </Link>
        ))}
      </nav>

      <main>
        <Outlet />
      </main>
    </div>
  )
}
