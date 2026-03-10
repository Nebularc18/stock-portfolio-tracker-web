import { useState, useEffect } from 'react'
import { useSettings, TIMEZONES, SUPPORTED_CURRENCIES } from '../SettingsContext'
import { useTheme, THEMES, ThemeName } from '../ThemeContext'
import { useHeaderData } from '../contexts/HeaderDataContext'
import { api, AvailableIndex } from '../services/api'
import AvanzaMappings from '../components/AvanzaMappings'
import { t, TranslationKey } from '../i18n'

const preferenceGridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
  gap: '16px',
  alignItems: 'stretch',
} as const

const preferencePanelStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: '10px',
  minHeight: '100%',
  padding: '18px',
  backgroundColor: 'var(--bg-tertiary)',
  background: 'linear-gradient(180deg, color-mix(in srgb, var(--bg-tertiary) 88%, transparent) 0%, color-mix(in srgb, var(--bg-secondary) 82%, transparent) 100%)',
  border: '1px solid var(--border-color)',
  borderRadius: '16px',
} as const

const preferenceLabelStyle = {
  display: 'block',
  marginBottom: '8px',
  color: 'var(--text-secondary)',
  fontSize: '13px',
  letterSpacing: '0.02em',
} as const

const preferenceSelectStyle = {
  width: '100%',
  padding: '12px 16px',
  border: '1px solid var(--border-color)',
  borderRadius: 'var(--card-radius)',
  background: 'var(--bg-tertiary)',
  color: 'var(--text-primary)',
  fontSize: '14px',
} as const

const preferenceDescriptionStyle = {
  color: 'var(--text-secondary)',
  fontSize: '12px',
  lineHeight: 1.5,
  margin: 0,
} as const

/**
 * Render the Settings page where users can select theme, choose header indices, and update display preferences.
 *
 * Loads available header indices on mount and exposes controls that update context-backed settings (theme, language, display currency, timezone, and selected header indices). Selection changes refresh header data as needed.
 *
 * @returns The rendered Settings component as a JSX element
 */
export default function Settings() {
  const { timezone, setTimezone, displayCurrency, setDisplayCurrency, language, setLanguage, headerIndices, setHeaderIndices } = useSettings()
  const { themeName, setTheme } = useTheme()
  const { refreshData } = useHeaderData()
  const [availableIndices, setAvailableIndices] = useState<AvailableIndex[]>([])
  const [loadingIndices, setLoadingIndices] = useState(true)
  const [indicesLoadFailed, setIndicesLoadFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoadingIndices(true)
    setIndicesLoadFailed(false)
    api.settings.availableIndices()
      .then((indices) => {
        if (cancelled) return
        setAvailableIndices(indices)
      })
      .catch((err) => {
        if (cancelled) return
        console.error('Failed to load available indices:', err)
        setIndicesLoadFailed(true)
      })
      .finally(() => {
        if (cancelled) return
        setLoadingIndices(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  const invalidateHeaderCache = () => {
    refreshData(true)
  }

  const toggleIndex = (symbol: string) => {
    let newIndices: string[]
    if (headerIndices.includes(symbol)) {
      newIndices = headerIndices.filter(s => s !== symbol)
    } else {
      newIndices = [...headerIndices, symbol]
    }
    setHeaderIndices(newIndices)
    invalidateHeaderCache()
  }

  const clearSelection = () => {
    setHeaderIndices([])
    invalidateHeaderCache()
  }

  const getThemeText = (theme: (typeof THEMES)[ThemeName], field: 'title' | 'description') => {
    const key = `settings.theme.${theme.name}.${field}` as TranslationKey
    const translated = t(language, key)
    return translated !== key ? translated : (field === 'title' ? theme.displayName : theme.description)
  }

  return (
    <div>
      <h2 style={{ fontSize: '24px', fontWeight: '600', marginBottom: '24px' }}>{t(language, 'settings.title')}</h2>
      
      <div className="card" style={{ marginBottom: '24px' }}>
        <h3 style={{ marginBottom: '20px' }}>{t(language, 'settings.theme')}</h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginBottom: '24px' }}>
          {t(language, 'settings.themeDescription')}
        </p>
        
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '16px' }}>
          {Object.values(THEMES).map((theme) => (
            <button
              type="button"
              key={theme.name}
              className={`theme-card ${themeName === theme.name ? 'active' : ''}`}
              onClick={() => setTheme(theme.name as ThemeName)}
              aria-pressed={themeName === theme.name}
              style={{
                background: theme.vars['--bg-secondary'],
                border: `2px solid ${themeName === theme.name ? theme.vars['--accent-blue'] : theme.vars['--border-color']}`,
                borderRadius: '12px',
                padding: '16px',
                cursor: 'pointer',
                transition: 'all 0.3s ease',
                textAlign: 'left',
              }}
            >
              <div 
                style={{ 
                  height: 80, 
                  borderRadius: 8, 
                  background: theme.preview,
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
                  background: theme.vars['--bg-secondary'],
                  border: `1px solid ${theme.vars['--border-color']}`,
                }} />
                <div style={{ flex: 1 }}>
                  <div style={{ 
                    height: 8, 
                    width: '60%', 
                    borderRadius: 4, 
                    background: theme.vars['--text-primary'],
                    marginBottom: 6,
                    opacity: 0.8,
                  }} />
                  <div style={{ 
                    height: 6, 
                    width: '80%', 
                    borderRadius: 3, 
                    background: theme.vars['--text-secondary'],
                    opacity: 0.6,
                  }} />
                </div>
              </div>
              
              <h4 style={{ 
                fontSize: '16px', 
                fontWeight: 600, 
                marginBottom: 4,
                color: theme.vars['--text-primary'],
              }}>
                {getThemeText(theme, 'title')}
              </h4>
              <p style={{ 
                fontSize: '13px', 
                color: theme.vars['--text-secondary'],
                lineHeight: 1.4,
              }}>
                {getThemeText(theme, 'description')}
              </p>
              
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <div style={{ 
                  width: 16, 
                  height: 16, 
                  borderRadius: '50%', 
                  background: theme.vars['--accent-green'],
                }} />
                <div style={{ 
                  width: 16, 
                  height: 16, 
                  borderRadius: '50%', 
                  background: theme.vars['--accent-red'],
                }} />
                <div style={{ 
                  width: 16, 
                  height: 16, 
                  borderRadius: '50%', 
                  background: theme.vars['--accent-blue'],
                }} />
                <div style={{ 
                  width: 16, 
                  height: 16, 
                  borderRadius: '50%', 
                  background: theme.vars['--accent-yellow'],
                }} />
              </div>
            </button>
          ))}
        </div>
      </div>
      
      <div className="card" style={{ marginBottom: '24px' }}>
        <h3 style={{ marginBottom: '16px' }}>{t(language, 'settings.headerIndices')}</h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginBottom: '16px' }}>
          {t(language, 'settings.headerIndicesDescription')}
        </p>
        
        {loadingIndices ? (
          <p style={{ color: 'var(--text-secondary)' }}>{t(language, 'settings.loadingIndices')}</p>
        ) : indicesLoadFailed ? (
          <p style={{ color: 'var(--accent-red)' }}>{t(language, 'settings.failedLoadIndices')}</p>
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
                  color: headerIndices.includes(idx.symbol) ? 'var(--text-on-accent)' : 'var(--text-primary)',
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
            {t(language, 'settings.clearSelection')}
          </button>
        )}
      </div>
      
      <div className="card">
        <h3 style={{ marginBottom: '16px' }}>{t(language, 'settings.displayPreferences')}</h3>
        <div style={preferenceGridStyle}>
          <div style={preferencePanelStyle}>
            <div>
              <label
                htmlFor="language-select"
                style={preferenceLabelStyle}
              >
                {t(language, 'settings.language')}
              </label>
              <select
                id="language-select"
                value={language}
                onChange={(e) => setLanguage(e.target.value as 'en' | 'sv')}
                style={preferenceSelectStyle}
              >
                <option value="en">{t(language, 'language.english')}</option>
                <option value="sv">{t(language, 'language.swedish')}</option>
              </select>
            </div>
            <p style={preferenceDescriptionStyle}>
              {t(language, 'settings.languageDescription')}
            </p>
          </div>

          <div style={preferencePanelStyle}>
            <div>
              <label
                htmlFor="display-currency-select"
                style={preferenceLabelStyle}
              >
                {t(language, 'settings.displayCurrency')}
              </label>
              <select
                id="display-currency-select"
                value={displayCurrency}
                onChange={(e) => setDisplayCurrency(e.target.value)}
                style={preferenceSelectStyle}
              >
                {SUPPORTED_CURRENCIES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.code} - {c.label}
                  </option>
                ))}
              </select>
            </div>
            <p style={preferenceDescriptionStyle}>
              {t(language, 'settings.displayCurrencyDescription')}
            </p>
          </div>

          <div style={preferencePanelStyle}>
            <div>
              <label
                htmlFor="timezone-select"
                style={preferenceLabelStyle}
              >
                {t(language, 'settings.timezone')}
              </label>
              <select
                id="timezone-select"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                style={preferenceSelectStyle}
              >
                {TIMEZONES.map((tz) => (
                  <option key={tz.id} value={tz.id}>
                    {tz.label}
                  </option>
                ))}
              </select>
            </div>
            <p style={preferenceDescriptionStyle}>
              {t(language, 'settings.timezoneDescription')}
            </p>
          </div>
        </div>
      </div>
      
      <AvanzaMappings />
    </div>
  )
}
