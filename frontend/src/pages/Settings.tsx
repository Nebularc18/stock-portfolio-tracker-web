import { useState, useEffect } from 'react'
import { useSettings, TIMEZONES, SUPPORTED_CURRENCIES } from '../SettingsContext'
import { useTheme, THEMES, ThemeName } from '../ThemeContext'
import { useHeaderData } from '../contexts/HeaderDataContext'
import { api, AvailableIndex } from '../services/api'
import AvanzaMappings from '../components/AvanzaMappings'

export default function Settings() {
  const { timezone, setTimezone, displayCurrency, setDisplayCurrency, headerIndices, setHeaderIndices } = useSettings()
  const { themeName, setTheme } = useTheme()
  const { refreshData } = useHeaderData()
  const [availableIndices, setAvailableIndices] = useState<AvailableIndex[]>([])
  const [loadingIndices, setLoadingIndices] = useState(true)
  const [indicesError, setIndicesError] = useState<string | null>(null)

  useEffect(() => {
    api.settings.availableIndices()
      .then(setAvailableIndices)
      .catch((err) => {
        console.error('Failed to load available indices:', err)
        setIndicesError('Failed to load available indices. Please try again.')
      })
      .finally(() => setLoadingIndices(false))
  }, [])

  const toggleIndex = (symbol: string) => {
    let newIndices: string[]
    if (headerIndices.includes(symbol)) {
      newIndices = headerIndices.filter(s => s !== symbol)
    } else {
      newIndices = [...headerIndices, symbol]
    }
    setHeaderIndices(newIndices)
    localStorage.removeItem('header_market_data')
    refreshData(true)
  }

  const clearSelection = () => {
    setHeaderIndices([])
    localStorage.removeItem('header_market_data')
    refreshData(true)
  }

  return (
    <div>
      <h2 style={{ fontSize: '24px', fontWeight: '600', marginBottom: '24px' }}>Settings</h2>
      
      <div className="card" style={{ marginBottom: '24px' }}>
        <h3 style={{ marginBottom: '20px' }}>Theme</h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginBottom: '24px' }}>
          Choose your preferred visual style. Changes are applied instantly.
        </p>
        
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '16px' }}>
          {Object.values(THEMES).map((t) => (
            <div
              key={t.name}
              className={`theme-card ${themeName === t.name ? 'active' : ''}`}
              onClick={() => setTheme(t.name as ThemeName)}
              style={{
                background: t.vars['--bg-secondary'],
                border: `2px solid ${themeName === t.name ? t.vars['--accent-blue'] : t.vars['--border-color']}`,
                borderRadius: '12px',
                padding: '16px',
                cursor: 'pointer',
                transition: 'all 0.3s ease',
              }}
            >
              <div 
                style={{ 
                  height: 80, 
                  borderRadius: 8, 
                  background: t.preview,
                  marginBottom: 12,
                  display: 'flex',
                  alignItems: 'flex-end',
                  padding: 12,
                  gap: 8,
                }}
              >
                <div style={{ 
                  width: 40, 
                  height: 40, 
                  borderRadius: 8, 
                  background: t.vars['--bg-secondary'],
                  border: `1px solid ${t.vars['--border-color']}`,
                }} />
                <div style={{ flex: 1 }}>
                  <div style={{ 
                    height: 8, 
                    width: '60%', 
                    borderRadius: 4, 
                    background: t.vars['--text-primary'],
                    marginBottom: 6,
                    opacity: 0.8,
                  }} />
                  <div style={{ 
                    height: 6, 
                    width: '80%', 
                    borderRadius: 3, 
                    background: t.vars['--text-secondary'],
                    opacity: 0.6,
                  }} />
                </div>
              </div>
              
              <h4 style={{ 
                fontSize: '16px', 
                fontWeight: 600, 
                marginBottom: 4,
                color: t.vars['--text-primary'],
              }}>
                {t.displayName}
              </h4>
              <p style={{ 
                fontSize: '13px', 
                color: t.vars['--text-secondary'],
                lineHeight: 1.4,
              }}>
                {t.description}
              </p>
              
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <div style={{ 
                  width: 16, 
                  height: 16, 
                  borderRadius: '50%', 
                  background: t.vars['--accent-green'],
                }} />
                <div style={{ 
                  width: 16, 
                  height: 16, 
                  borderRadius: '50%', 
                  background: t.vars['--accent-red'],
                }} />
                <div style={{ 
                  width: 16, 
                  height: 16, 
                  borderRadius: '50%', 
                  background: t.vars['--accent-blue'],
                }} />
                <div style={{ 
                  width: 16, 
                  height: 16, 
                  borderRadius: '50%', 
                  background: t.vars['--accent-yellow'],
                }} />
              </div>
            </div>
          ))}
        </div>
      </div>
      
      <div className="card" style={{ marginBottom: '24px' }}>
        <h3 style={{ marginBottom: '16px' }}>Header Market Indices</h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginBottom: '16px' }}>
          Select which market indices to display in the header. If none selected, all will be shown.
        </p>
        
        {loadingIndices ? (
          <p style={{ color: 'var(--text-secondary)' }}>Loading available indices...</p>
        ) : indicesError ? (
          <p style={{ color: 'var(--accent-red)' }}>{indicesError}</p>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
            {availableIndices.map((idx) => (
              <label 
                key={idx.symbol}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '10px 16px',
                  background: headerIndices.includes(idx.symbol) ? 'var(--accent-blue)' : 'var(--bg-tertiary)',
                  border: `1px solid ${headerIndices.includes(idx.symbol) ? 'var(--accent-blue)' : 'var(--border-color)'}`,
                  borderRadius: '8px',
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                }}
              >
                <input
                  type="checkbox"
                  checked={headerIndices.includes(idx.symbol)}
                  onChange={() => toggleIndex(idx.symbol)}
                  aria-label={idx.name}
                  style={{
                    position: 'absolute',
                    width: '1px',
                    height: '1px',
                    padding: 0,
                    margin: -1,
                    overflow: 'hidden',
                    clip: 'rect(0, 0, 0, 0)',
                    whiteSpace: 'nowrap',
                    border: 0,
                  }}
                />
                <span style={{ 
                  fontSize: '14px',
                  color: headerIndices.includes(idx.symbol) ? '#fff' : 'var(--text-primary)',
                  fontWeight: headerIndices.includes(idx.symbol) ? 600 : 400,
                }}>
                  {idx.name}
                </span>
              </label>
            ))}
          </div>
        )}
        
        {headerIndices.length > 0 && (
          <button
            onClick={clearSelection}
            style={{
              marginTop: '16px',
              padding: '8px 16px',
              fontSize: '13px',
              background: 'transparent',
              border: '1px solid var(--border-color)',
              borderRadius: '6px',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
            }}
          >
            Clear selection (show all)
          </button>
        )}
      </div>
      
      <div className="card">
        <h3 style={{ marginBottom: '16px' }}>Display Preferences</h3>
        
        <div style={{ marginBottom: '24px' }}>
          <label style={{ display: 'block', marginBottom: '8px', color: 'var(--text-secondary)', fontSize: '14px' }}>
            Display Currency
          </label>
          <select
            value={displayCurrency}
            onChange={(e) => setDisplayCurrency(e.target.value)}
            style={{
              width: '100%',
              maxWidth: '400px',
              padding: '12px 16px',
              border: '1px solid var(--border-color)',
              borderRadius: 'var(--card-radius)',
              background: 'var(--bg-tertiary)',
              color: 'var(--text-primary)',
              fontSize: '14px',
            }}
          >
            {SUPPORTED_CURRENCIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code} - {c.label}
              </option>
            ))}
          </select>
          <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginTop: '8px' }}>
            Portfolio totals and stock values will be converted to this currency.
          </p>
        </div>
        
        <div style={{ marginBottom: '24px' }}>
          <label style={{ display: 'block', marginBottom: '8px', color: 'var(--text-secondary)', fontSize: '14px' }}>
            Timezone for Market Hours
          </label>
          <select
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            style={{
              width: '100%',
              maxWidth: '400px',
              padding: '12px 16px',
              border: '1px solid var(--border-color)',
              borderRadius: 'var(--card-radius)',
              background: 'var(--bg-tertiary)',
              color: 'var(--text-primary)',
              fontSize: '14px',
            }}
          >
            {TIMEZONES.map((tz) => (
              <option key={tz.id} value={tz.id}>
                {tz.label}
              </option>
            ))}
          </select>
          <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginTop: '8px' }}>
            Market opening and closing times will be displayed in your selected timezone.
          </p>
        </div>
      </div>
      
      <AvanzaMappings />
    </div>
  )
}
