import { useCallback, useState } from 'react'
import { Link, useLocation, Outlet } from 'react-router-dom'
import { useHeaderData } from '../contexts/HeaderDataContext'
import { useSettings } from '../SettingsContext'
import { formatTimeInTimezone } from '../utils/time'
import { getLocaleForLanguage, t } from '../i18n'
import { useAuth } from '../AuthContext'

/**
 * Render the main infographic layout for the portfolio dashboard.
 *
 * The layout contains a compact sidebar with primary navigation, a header that displays market indices,
 * FX rates and the last-updated time, and a main content area that hosts routed child components via an Outlet.
 *
 * @returns The dashboard layout React node containing the sidebar, header (indices and FX), and routed content area
 */
export default function InfographicLayout() {
  const location = useLocation()
  const { indices: allIndices, exchangeRates, lastUpdated } = useHeaderData()
  const { timezone, headerIndices, language } = useSettings()
  const { user, logout } = useAuth()
  const locale = getLocaleForLanguage(language)
  const currentYear = new Date().getUTCFullYear()
  const [logoutError, setLogoutError] = useState<string | null>(null)
  const [isLoggingOut, setIsLoggingOut] = useState(false)
  
  // Filter indices based on user settings, or show first 5 if no settings
  const hasValidHeaderIndices = Array.isArray(headerIndices) && headerIndices.length > 0
  const matched = hasValidHeaderIndices
    ? allIndices.filter(idx => headerIndices.includes(idx.symbol))
    : []
  const indices = matched.length > 0 ? matched : allIndices.slice(0, 5)

  const indexLabel = (symbol: string, name: string) => {
    switch (symbol) {
      case '^OMXS30':
        return 'OMX STOCKHOLM 30'
      case '^OMXS30GI':
        return 'OMX STOCKHOLM 30 GI'
      case '^OMXSPI':
        return 'OMX STOCKHOLM PI'
      case '^GSPC':
        return 'S&P 500'
      case '^IXIC':
        return 'NASDAQ'
      default:
        return name || symbol
    }
  }

  const formatFx = (value: number | null | undefined) => {
    if (value === null || value === undefined || Number.isNaN(value)) return '-'
    return value.toFixed(4)
  }
  
  const links = [
    { to: '/', label: t(language, 'nav.dashboard'), icon: '📊' },
    { to: '/performance', label: t(language, 'nav.performance'), icon: '📈' },
    { to: '/analytics', label: t(language, 'nav.analytics'), icon: '📉' },
    { to: '/dividends/history', label: t(language, 'nav.dividendsHistory'), icon: '💰' },
    { to: '/dividends/upcoming', label: t(language, 'nav.upcomingDividendsYear', { year: currentYear }), icon: '📅' },
    { to: '/stocks', label: t(language, 'nav.stocks'), icon: '🏢' },
    { to: '/markets', label: t(language, 'nav.markets'), icon: '🌍' },
    { to: '/settings', label: t(language, 'nav.settings'), icon: '⚙️' },
  ]
  
  const isActive = (path: string) => {
    if (path === '/') {
      return location.pathname === '/'
    }
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

  const avatarLetter = (user?.username?.trim().charAt(0) || 'P').toUpperCase()
  
  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #0a0a1a 0%, #1a1a3a 50%, #0a1a2a 100%)',
      color: '#ffffff',
    }}>
      <div style={{
        display: 'flex',
        minHeight: '100vh',
      }}>
        <aside style={{
          width: 88,
          background: 'rgba(255,255,255,0.03)',
          borderRight: '1px solid rgba(255,255,255,0.08)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          padding: '24px 0',
          gap: 18,
        }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
            <div style={{
              width: 48,
              height: 48,
              borderRadius: '50%',
              background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 20,
            }}>
              {avatarLetter}
            </div>
            <button
              className="btn btn-secondary"
              style={{ width: 56, padding: '8px 6px', fontSize: 11 }}
              onClick={() => void handleLogout()}
              disabled={isLoggingOut}
              title={t(language, 'layout.logout')}
            >
              {isLoggingOut ? '...' : t(language, 'layout.logout')}
            </button>
            {logoutError && (
              <p style={{ color: '#ffb4b4', fontSize: 10, margin: 0, textAlign: 'center', padding: '0 8px' }}>{logoutError}</p>
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, marginTop: '12px' }}>
            {links.map(link => (
              <Link
                key={link.to}
                to={link.to}
                style={{
                  width: 64,
                  minHeight: 58,
                  borderRadius: 16,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 5,
                  color: isActive(link.to) ? '#fff' : 'rgba(255,255,255,0.5)',
                  textDecoration: 'none',
                  background: isActive(link.to) ? 'rgba(102, 126, 234, 0.3)' : 'transparent',
                  border: isActive(link.to) ? '1px solid rgba(102, 126, 234, 0.5)' : '1px solid transparent',
                  fontSize: 10,
                  textAlign: 'center',
                  padding: '6px 4px',
                  transition: 'all 0.2s',
                }}
                title={link.label}
              >
                <span style={{ fontSize: 18 }}>{link.icon}</span>
                <span style={{ display: 'block', lineHeight: 1.15, width: '100%' }}>{link.label}</span>
              </Link>
            ))}
          </div>
        </aside>
        
        <main style={{ flex: 1, overflow: 'auto' }}>
          <header style={{
            padding: '24px 32px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}>
            <div>
              <h1 style={{ fontSize: 28, fontWeight: 300, opacity: 0.9 }}>
                {t(language, 'layout.title')}
              </h1>
              <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.5)', marginTop: 4 }}>
                {t(language, 'layout.subtitle')}
              </p>
              <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)', marginTop: 6 }}>
                {t(language, 'layout.headerUpdated')}: {formatTimeInTimezone(lastUpdated, timezone, locale)}
              </p>
              <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.65)', marginTop: 6 }}>
                {t(language, 'layout.signedInAs', { username: user?.username || '-' })}
                {user?.is_guest ? ` ${t(language, 'layout.guestDemo')}` : ''}
              </p>
            </div>
            
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
              <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'flex-end' }}>
                {indices.map(idx => {
                const safeChange = idx.change != null && Number.isFinite(Number(idx.change))
                  ? Number(idx.change)
                  : null
                const safeChangePercent = idx.change_percent != null && Number.isFinite(Number(idx.change_percent))
                  ? Number(idx.change_percent)
                  : null
                const isPositive = safeChange !== null && safeChange >= 0
                const changeBackground = safeChange === null
                  ? 'rgba(255,255,255,0.12)'
                  : (isPositive ? 'rgba(0, 230, 118, 0.2)' : 'rgba(255, 82, 82, 0.2)')
                const changeColor = safeChange === null
                  ? 'rgba(255,255,255,0.7)'
                  : (isPositive ? '#00e676' : '#ff5252')
                const changeArrow = safeChange === null ? '' : (isPositive ? '↑' : '↓')
                const changePercentLabel = safeChangePercent === null
                  ? '—'
                  : `${Math.abs(safeChangePercent).toFixed(2)}%`

                return (
                <div key={idx.symbol} style={{
                  background: 'rgba(255,255,255,0.05)',
                  borderRadius: 16,
                  padding: '16px 24px',
                  textAlign: 'center',
                }}>
                  <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginBottom: 4 }}>
                    {indexLabel(idx.symbol, idx.name)}
                  </div>
                  <div style={{ fontSize: 28, fontWeight: 300 }}>
                    {idx.price == null
                      ? '-'
                      : (Number.isFinite(Number(idx.price))
                        ? Number(idx.price).toLocaleString(locale, { maximumFractionDigits: 0 })
                        : '-')}
                  </div>
                   <div style={{
                     fontSize: 14,
                     marginTop: 4,
                     padding: '4px 12px',
                     borderRadius: 20,
                     background: changeBackground,
                     color: changeColor,
                     display: 'inline-block',
                   }}>
                     {changeArrow ? `${changeArrow} ${changePercentLabel}` : changePercentLabel}
                   </div>
                  </div>
                 )
                })}

                <div style={{
                  background: 'rgba(255,255,255,0.05)',
                  borderRadius: 16,
                  padding: '16px 24px',
                  textAlign: 'center',
                  minWidth: 180,
                }}>
                  <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginBottom: 6 }}>
                    {t(language, 'layout.fxSek')}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, fontSize: 18 }}>
                      <span style={{ color: 'rgba(255,255,255,0.6)' }}>USD/SEK</span>
                      <span>{formatFx(exchangeRates.USD_SEK)}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, fontSize: 18 }}>
                      <span style={{ color: 'rgba(255,255,255,0.6)' }}>EUR/SEK</span>
                      <span>{formatFx(exchangeRates.EUR_SEK)}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </header>
          
          <div style={{ padding: '0 32px 32px' }}>
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  )
}
