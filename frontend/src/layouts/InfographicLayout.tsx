import { Link, useLocation, Outlet } from 'react-router-dom'
import { useHeaderData } from '../contexts/HeaderDataContext'
import { useSettings } from '../SettingsContext'
import { formatTimeInTimezone } from '../utils/time'

/**
 * Render the main infographic layout for the portfolio dashboard.
 *
 * The layout includes a compact sidebar with primary navigation (and an inline submenu for dividends),
 * a header showing indices, FX rates and last-updated time, and a main content area that hosts routed children.
 *
 * @returns The React node containing the dashboard layout with sidebar, header (indices and FX), and an Outlet for child routes.
 */
export default function InfographicLayout() {
  const location = useLocation()
  const { indices, exchangeRates, lastUpdated } = useHeaderData()
  const { timezone } = useSettings()

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
    { to: '/', label: 'Dashboard', icon: '📊' },
    { to: '/performance', label: 'Performance', icon: '📈' },
    { to: '/dividends', label: 'Dividends', icon: '💰', children: [
      { to: '/dividends', label: 'Historical' },
      { to: '/dividends/upcoming', label: 'Upcoming' },
    ]},
    { to: '/stocks', label: 'Stocks', icon: '🏢' },
    { to: '/markets', label: 'Markets', icon: '🌍' },
    { to: '/settings', label: 'Settings', icon: '⚙️' },
  ]
  
  const isActive = (path: string) => {
    if (path === '/dividends' && location.pathname.startsWith('/dividends')) return true
    return location.pathname === path
  }
  
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
          width: 80,
          background: 'rgba(255,255,255,0.03)',
          borderRight: '1px solid rgba(255,255,255,0.08)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          padding: '24px 0',
          gap: 8,
        }}>
          <div style={{
            width: 48,
            height: 48,
            borderRadius: '50%',
            background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 24,
            fontSize: 20,
          }}>
            P
          </div>
          
          {links.map(link => (
            <div key={link.to} style={{ position: 'relative' }}>
              <Link
                to={link.to}
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: 16,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 4,
                  color: isActive(link.to) ? '#fff' : 'rgba(255,255,255,0.5)',
                  textDecoration: 'none',
                  background: isActive(link.to) ? 'rgba(102, 126, 234, 0.3)' : 'transparent',
                  border: isActive(link.to) ? '1px solid rgba(102, 126, 234, 0.5)' : '1px solid transparent',
                  fontSize: 10,
                  transition: 'all 0.2s',
                }}
                title={link.label}
              >
                <span style={{ fontSize: 18 }}>{link.icon}</span>
                <span>{link.label}</span>
              </Link>
              {link.children && isActive(link.to) && (
                <div style={{
                  position: 'absolute',
                  left: '100%',
                  top: 0,
                  marginLeft: 8,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  zIndex: 10,
                }}>
                  {link.children.map(child => (
                    <Link
                      key={child.to}
                      to={child.to}
                      style={{
                        padding: '8px 16px',
                        borderRadius: 8,
                        color: location.pathname === child.to ? '#fff' : 'rgba(255,255,255,0.6)',
                        textDecoration: 'none',
                        background: location.pathname === child.to ? 'rgba(102, 126, 234, 0.4)' : 'rgba(255,255,255,0.05)',
                        border: '1px solid rgba(255,255,255,0.1)',
                        fontSize: 12,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {child.label}
                    </Link>
                  ))}
                </div>
              )}
            </div>
          ))}
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
                Portfolio Dashboard
              </h1>
              <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.5)', marginTop: 4 }}>
                Real-time investment analytics
              </p>
              <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)', marginTop: 6 }}>
                Header updated: {formatTimeInTimezone(lastUpdated, timezone)}
              </p>
            </div>
            
            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
              {indices.map(idx => (
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
                    {idx.price.toLocaleString('en-US', { maximumFractionDigits: 0 })}
                  </div>
                  <div style={{
                    fontSize: 14,
                    marginTop: 4,
                    padding: '4px 12px',
                    borderRadius: 20,
                    background: idx.change >= 0 ? 'rgba(0, 230, 118, 0.2)' : 'rgba(255, 82, 82, 0.2)',
                    color: idx.change >= 0 ? '#00e676' : '#ff5252',
                    display: 'inline-block',
                  }}>
                    {idx.change >= 0 ? '↑' : '↓'} {Math.abs(idx.change_percent).toFixed(2)}%
                  </div>
                </div>
              ))}

              <div style={{
                background: 'rgba(255,255,255,0.05)',
                borderRadius: 16,
                padding: '16px 24px',
                textAlign: 'center',
                minWidth: 180,
              }}>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginBottom: 6 }}>
                  FX SEK
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
          </header>
          
          <div style={{ padding: '0 32px 32px' }}>
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  )
}
