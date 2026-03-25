import React, { useState, useEffect } from 'react'
import { useSettings, TIMEZONES, SUPPORTED_CURRENCIES } from '../SettingsContext'
import { useTheme } from '../ThemeContext'
import { useHeaderData } from '../contexts/HeaderDataContext'
import { api, AvailableIndex } from '../services/api'
import AvanzaMappings from '../components/AvanzaMappings'
import { t } from '../i18n'

/**
 * Render the Settings page and provide controls for appearance, header indices, language, display currency, and timezone.
 *
 * Fetches available header indices on mount and refreshes header data when header index selections change.
 *
 * @returns The rendered Settings page as a JSX element
 */
export default function Settings() {
  const { timezone, setTimezone, displayCurrency, setDisplayCurrency, language, setLanguage, headerIndices, setHeaderIndices, platforms, setPlatforms } = useSettings()
  const { themeName, setTheme } = useTheme()
  const { refreshData } = useHeaderData()
  const [availableIndices, setAvailableIndices] = useState<AvailableIndex[]>([])
  const [loadingIndices, setLoadingIndices] = useState(true)
  const [indicesLoadFailed, setIndicesLoadFailed] = useState(false)
  const [newPlatform, setNewPlatform] = useState('')
  const [platformError, setPlatformError] = useState<string | null>(null)

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

  const handleAddPlatform = () => {
    const normalized = newPlatform.trim()
    if (!normalized) {
      setPlatformError(t(language, 'settings.platformMissing'))
      return
    }
    if (normalized.length > 100) {
      setPlatformError(t(language, 'settings.platformTooLong'))
      return
    }
    if (platforms.some((platform) => platform.localeCompare(normalized, undefined, { sensitivity: 'base' }) === 0)) {
      setPlatformError(t(language, 'settings.platformDuplicate'))
      return
    }
    setPlatforms([...platforms, normalized].sort((a, b) => a.localeCompare(b)))
    setNewPlatform('')
    setPlatformError(null)
  }

  const handleRemovePlatform = (platformToRemove: string) => {
    setPlatforms(platforms.filter((platform) => platform !== platformToRemove))
    setPlatformError(null)
  }

  const secLabel: React.CSSProperties = { fontSize: 9, fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--muted)' }
  const panelStyle: React.CSSProperties = { background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, marginBottom: 16 }

  return (
    <div>
      {/* Page header */}
      <div style={{
        background: 'linear-gradient(115deg, #12141c 0%, var(--bg) 55%)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: '22px 24px',
        marginBottom: 20,
      }}>
        <h2 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em' }}>{t(language, 'settings.title')}</h2>
      </div>

      {/* Appearance section */}
      <div style={panelStyle}>
        <div className="sec-row" style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <span className="sec-title">{t(language, 'settings.theme')}</span>
        </div>
        <div style={{ padding: '16px' }}>
          <p style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 16 }}>
            {t(language, 'settings.themeDescription')}
          </p>
          <button
            type="button"
            onClick={() => setTheme(themeName === 'dark' ? 'light' : 'dark')}
            aria-pressed={themeName === 'dark'}
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 16,
              padding: '16px 18px',
              borderRadius: 10,
              border: '1px solid var(--border)',
              background: 'var(--bg3)',
              color: 'var(--text)',
              cursor: 'pointer',
            }}
          >
            <div style={{ textAlign: 'left' }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
                {themeName === 'dark' ? t(language, 'settings.darkMode') : t(language, 'settings.lightMode')}
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                {t(language, 'settings.themeToggleDescription')}
              </div>
            </div>
            <div
              aria-hidden="true"
              style={{
                width: 56,
                height: 30,
                borderRadius: 999,
                background: themeName === 'dark' ? 'var(--v)' : 'var(--bg)',
                border: '1px solid var(--border2)',
                padding: 3,
                display: 'flex',
                justifyContent: themeName === 'dark' ? 'flex-end' : 'flex-start',
                transition: 'all 0.2s ease',
              }}
            >
              <div style={{ width: 22, height: 22, borderRadius: '50%', background: 'var(--text-on-accent)', boxShadow: '0 1px 3px rgba(0,0,0,0.25)' }} />
            </div>
          </button>
        </div>
      </div>

      {/* Header indices */}
      <div style={panelStyle}>
        <div className="sec-row" style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <span className="sec-title">{t(language, 'settings.headerIndices')}</span>
          {headerIndices.length > 0 && (
            <button onClick={clearSelection} style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 4, padding: '3px 10px', fontSize: 11, color: 'var(--muted)', cursor: 'pointer' }}>
              {t(language, 'settings.clearSelection')}
            </button>
          )}
        </div>
        <div style={{ padding: '16px' }}>
          <p style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 14 }}>
            {t(language, 'settings.headerIndicesDescription')}
          </p>
          {loadingIndices ? (
            <p style={{ color: 'var(--muted)', fontSize: 13 }}>{t(language, 'settings.loadingIndices')}</p>
          ) : indicesLoadFailed ? (
            <p style={{ color: 'var(--red)', fontSize: 13 }}>{t(language, 'settings.failedLoadIndices')}</p>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {availableIndices.map((idx) => {
                const active = headerIndices.includes(idx.symbol)
                return (
                  <label
                    key={idx.symbol}
                    className="indexChip"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 7,
                      padding: '7px 14px',
                      background: active ? 'rgba(129,140,248,0.15)' : 'var(--bg3)',
                      border: `1px solid ${active ? 'var(--v)' : 'var(--border)'}`,
                      borderRadius: 6,
                      cursor: 'pointer',
                      transition: 'all 0.15s',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={active}
                      onChange={() => toggleIndex(idx.symbol)}
                      aria-label={idx.name}
                      style={{ position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', border: 0 }}
                    />
                    <span style={{ fontSize: 13, color: active ? 'var(--v3)' : 'var(--text2)', fontWeight: active ? 600 : 400 }}>
                      {idx.name}
                    </span>
                  </label>
                )
              })}
            </div>
          )}
        </div>
      </div>

      <div style={panelStyle}>
        <div className="sec-row" style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <span className="sec-title">{t(language, 'settings.platforms')}</span>
        </div>
        <div style={{ padding: '16px' }}>
          <p style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 14 }}>
            {t(language, 'settings.platformsDescription')}
          </p>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
            <input
              type="text"
              value={newPlatform}
              onChange={(e) => {
                setNewPlatform(e.target.value)
                setPlatformError(null)
              }}
              placeholder={t(language, 'settings.platformInputPlaceholder')}
              style={{ flex: '1 1 240px' }}
            />
            <button type="button" className="btn btn-primary" onClick={handleAddPlatform}>
              {t(language, 'settings.platformAdd')}
            </button>
          </div>
          {platformError && (
            <p style={{ color: 'var(--red)', fontSize: 12, marginBottom: 12 }}>{platformError}</p>
          )}
          {platforms.length === 0 ? (
            <p style={{ color: 'var(--muted)', fontSize: 13 }}>{t(language, 'settings.platformEmpty')}</p>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {platforms.map((platform) => (
                <span
                  key={platform}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '7px 12px',
                    background: 'var(--bg3)',
                    border: '1px solid var(--border)',
                    borderRadius: 999,
                    fontSize: 13,
                  }}
                >
                  <span>{platform}</span>
                  <button
                    type="button"
                    onClick={() => handleRemovePlatform(platform)}
                    style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 14, lineHeight: 1 }}
                    aria-label={`${t(language, 'common.delete')} ${platform}`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Display preferences */}
      <div style={panelStyle}>
        <div className="sec-row" style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <span className="sec-title">{t(language, 'settings.displayPreferences')}</span>
        </div>
        <div style={{ padding: '16px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
          {/* Language */}
          <div style={{ background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6, padding: '14px 16px' }}>
            <label htmlFor="language-select" style={{ ...secLabel, display: 'block', marginBottom: 8 }}>
              {t(language, 'settings.language')}
            </label>
            <select
              id="language-select"
              value={language}
              onChange={(e) => setLanguage(e.target.value as 'en' | 'sv')}
              style={{ width: '100%', padding: '9px 12px', background: 'var(--bg2)', border: '1px solid var(--border2)', borderRadius: 5, color: 'var(--text)', fontSize: 13 }}
            >
              <option value="en">{t(language, 'language.english')}</option>
              <option value="sv">{t(language, 'language.swedish')}</option>
            </select>
            <p style={{ color: 'var(--muted)', fontSize: 11, lineHeight: 1.5, marginTop: 8 }}>
              {t(language, 'settings.languageDescription')}
            </p>
          </div>

          {/* Display currency */}
          <div style={{ background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6, padding: '14px 16px' }}>
            <label htmlFor="display-currency-select" style={{ ...secLabel, display: 'block', marginBottom: 8 }}>
              {t(language, 'settings.displayCurrency')}
            </label>
            <select
              id="display-currency-select"
              value={displayCurrency}
              onChange={(e) => setDisplayCurrency(e.target.value)}
              style={{ width: '100%', padding: '9px 12px', background: 'var(--bg2)', border: '1px solid var(--border2)', borderRadius: 5, color: 'var(--text)', fontSize: 13 }}
            >
              {SUPPORTED_CURRENCIES.map((c) => (
                <option key={c.code} value={c.code}>{c.code} - {c.label}</option>
              ))}
            </select>
            <p style={{ color: 'var(--muted)', fontSize: 11, lineHeight: 1.5, marginTop: 8 }}>
              {t(language, 'settings.displayCurrencyDescription')}
            </p>
          </div>

          {/* Timezone */}
          <div style={{ background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6, padding: '14px 16px' }}>
            <label htmlFor="timezone-select" style={{ ...secLabel, display: 'block', marginBottom: 8 }}>
              {t(language, 'settings.timezone')}
            </label>
            <select
              id="timezone-select"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              style={{ width: '100%', padding: '9px 12px', background: 'var(--bg2)', border: '1px solid var(--border2)', borderRadius: 5, color: 'var(--text)', fontSize: 13 }}
            >
              {TIMEZONES.map((tz) => (
                <option key={tz.id} value={tz.id}>{tz.label}</option>
              ))}
            </select>
            <p style={{ color: 'var(--muted)', fontSize: 11, lineHeight: 1.5, marginTop: 8 }}>
              {t(language, 'settings.timezoneDescription')}
            </p>
          </div>
        </div>
      </div>

      <AvanzaMappings />
    </div>
  )
}
