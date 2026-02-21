import { createContext, useContext, useState, ReactNode } from 'react'

interface SettingsContextType {
  timezone: string
  setTimezone: (tz: string) => void
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

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [timezone, setTimezoneState] = useState(() => {
    const saved = localStorage.getItem('userTimezone')
    return saved || 'Europe/Stockholm'
  })

  const setTimezone = (tz: string) => {
    setTimezoneState(tz)
    localStorage.setItem('userTimezone', tz)
  }

  return (
    <SettingsContext.Provider value={{ timezone, setTimezone }}>
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

export { TIMEZONES }
