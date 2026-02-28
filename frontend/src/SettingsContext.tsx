import { createContext, useContext, useState, useEffect, ReactNode } from 'react'

interface SettingsContextType {
  timezone: string
  setTimezone: (tz: string) => void
  displayCurrency: string
  setDisplayCurrency: (currency: string) => void
  headerIndices: string[]
  setHeaderIndices: (indices: string[]) => void
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
 * Provides application settings (timezone, display currency, header indices) and their setter functions
 * to descendant components via SettingsContext.Provider.
 *
 * The provider initializes values from localStorage (with safe JSON parsing for header indices),
 * attempts to reconcile with server settings from `/api/settings`, and persists subsequent changes
 * to localStorage and the server. Network errors are ignored and do not block rendering.
 *
 * @param children - The descendant React nodes that will receive the settings context
 * @returns A SettingsContext provider element supplying `timezone`, `setTimezone`, `displayCurrency`,
 * `setDisplayCurrency`, `headerIndices`, `setHeaderIndices`, and `loading`
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
  const [headerIndices, setHeaderIndicesState] = useState<string[]>(() => {
    const saved = localStorage.getItem('headerIndices')
    try {
      return saved ? JSON.parse(saved) : []
    } catch {
      return []
    }
  })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/settings')
      .then(res => res.json())
      .then(data => {
        if (data.display_currency) {
          setDisplayCurrencyState(data.display_currency)
          localStorage.setItem('displayCurrency', data.display_currency)
        }
        if (data.header_indices) {
          setHeaderIndicesState(data.header_indices)
          localStorage.setItem('headerIndices', JSON.stringify(data.header_indices))
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
    
    fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_currency: currency }),
    }).catch(() => {})
  }

  const setHeaderIndices = (indices: string[]) => {
    setHeaderIndicesState(indices)
    localStorage.setItem('headerIndices', JSON.stringify(indices))
    
    fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ header_indices: indices }),
    }).catch(() => {})
  }

  return (
    <SettingsContext.Provider value={{ 
      timezone, setTimezone, displayCurrency, setDisplayCurrency, 
      headerIndices, setHeaderIndices, loading 
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
