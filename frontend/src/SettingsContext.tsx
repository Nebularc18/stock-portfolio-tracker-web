import { createContext, useContext, useState, useEffect, ReactNode } from 'react'
import { Language } from './i18n'
import { api } from './services/api'

interface SettingsContextType {
  timezone: string
  setTimezone: (tz: string) => void
  displayCurrency: string
  setDisplayCurrency: (currency: string) => void
  language: Language
  setLanguage: (language: Language) => void
  headerIndices: string[]
  setHeaderIndices: (indices: string[]) => void
  platforms: string[]
  setPlatforms: (platforms: string[]) => void
  loading: boolean
}

const SettingsContext = createContext<SettingsContextType | null>(null)

const TIMEZONES = [
  { id: 'Europe/Stockholm', label: 'Stockholm (CET/CEST)' },
  { id: 'Europe/London', label: 'London (GMT/BST)' },
  { id: 'Europe/Berlin', label: 'Berlin (CET/CEST)' },
  { id: 'America/New_York', label: 'New York (EST/EDT)' },
  { id: 'America/Los_Angeles', label: 'Los Angeles (PST/PDT)' },
  { id: 'Asia/Tokyo', label: 'Tokyo (JST)' },
  { id: 'Asia/Hong_Kong', label: 'Hong Kong (HKT)' },
  { id: 'Australia/Sydney', label: 'Sydney (AEST/AEDT)' },
]

const SUPPORTED_CURRENCIES = [
  { code: 'SEK', label: 'Swedish Krona' },
  { code: 'EUR', label: 'Euro' },
  { code: 'USD', label: 'US Dollar' },
]

/**
 * Provides application settings and updater functions to descendant components through SettingsContext.
 *
 * The provider initializes state from localStorage, syncs certain settings with the server, and exposes:
 * `timezone`, `setTimezone`, `displayCurrency`, `setDisplayCurrency`, `language`, `setLanguage`, `headerIndices`, `setHeaderIndices`, and `loading`.
 *
 * @param children - React nodes that will receive the settings context
 * @returns A SettingsContext.Provider element that wraps `children`
 */
export function SettingsProvider({ children }: { children: ReactNode }) {
  const [timezone, setTimezoneState] = useState(() => {
    const saved = localStorage.getItem('userTimezone')
    return saved || 'Europe/Stockholm'
  })
  const [displayCurrency, setDisplayCurrencyState] = useState(() => {
    const saved = localStorage.getItem('displayCurrency')
    return saved || 'SEK'
  })
  const [language, setLanguageState] = useState<Language>(() => {
    const saved = localStorage.getItem('language')
    return saved === 'sv' ? 'sv' : 'en'
  })
  const [headerIndices, setHeaderIndicesState] = useState<string[]>(() => {
    const saved = localStorage.getItem('headerIndices')
    try {
      return saved ? JSON.parse(saved) : []
    } catch {
      return []
    }
  })
  const [platforms, setPlatformsState] = useState<string[]>(() => {
    const saved = localStorage.getItem('platforms')
    try {
      return saved ? JSON.parse(saved) : []
    } catch {
      return []
    }
  })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.settings.get()
      .then(data => {
        if (data.display_currency || data.display_currency === '') {
          setDisplayCurrencyState(data.display_currency)
          localStorage.setItem('displayCurrency', data.display_currency)
        }
        if (data.header_indices) {
          setHeaderIndicesState(data.header_indices)
          localStorage.setItem('headerIndices', JSON.stringify(data.header_indices))
        }
        if (data.platforms) {
          setPlatformsState(data.platforms)
          localStorage.setItem('platforms', JSON.stringify(data.platforms))
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const setTimezone = (tz: string) => {
    setTimezoneState(tz)
    localStorage.setItem('userTimezone', tz)
  }

  const setDisplayCurrency = (currency: string) => {
    setDisplayCurrencyState(currency)
    localStorage.setItem('displayCurrency', currency)
    
    api.settings.update({ display_currency: currency }).catch(() => {})
  }

  const setLanguage = (nextLanguage: Language) => {
    setLanguageState(nextLanguage)
    localStorage.setItem('language', nextLanguage)
  }

  const setHeaderIndices = (indices: string[]) => {
    setHeaderIndicesState(indices)
    localStorage.setItem('headerIndices', JSON.stringify(indices))
    
    api.settings.update({ header_indices: indices }).catch((err) => console.error('Failed to update header indices:', err))
  }

  const setPlatforms = (nextPlatforms: string[]) => {
    setPlatformsState(nextPlatforms)
    localStorage.setItem('platforms', JSON.stringify(nextPlatforms))
    api.settings.update({ platforms: nextPlatforms }).catch((err) => console.error('Failed to update platforms:', err))
  }

  return (
    <SettingsContext.Provider value={{ 
      timezone, setTimezone, displayCurrency, setDisplayCurrency, language, setLanguage,
      headerIndices, setHeaderIndices, platforms, setPlatforms, loading 
    }}>
      {children}
    </SettingsContext.Provider>
  )
}

export function useSettings() {
  const context = useContext(SettingsContext)
  if (!context) {
    throw new Error('useSettings must be used within a SettingsProvider')
  }
  return context
}

export { TIMEZONES, SUPPORTED_CURRENCIES }
