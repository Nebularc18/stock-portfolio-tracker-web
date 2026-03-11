import { createContext, useContext, useState, useEffect, ReactNode } from 'react'

type ThemeName = 'dark' | 'light'

export type { ThemeName }

interface Theme {
  name: ThemeName
  displayName: string
  description: string
  preview: string
  vars: Record<string, string>
}

export const THEMES: Record<ThemeName, Theme> = {
  dark: {
    name: 'dark',
    displayName: 'Dark',
    description: 'Dark mode with Bloomberg-inspired contrast',
    preview: 'linear-gradient(135deg, #0d1117 0%, #161b22 100%)',
    vars: {
      '--bg-primary': '#0d1117',
      '--bg-secondary': '#161b22',
      '--bg-tertiary': '#21262d',
      '--bg-hover': '#30363d',
      '--text-primary': '#e6edf3',
      '--text-secondary': '#8b949e',
      '--text-muted': '#6e7681',
      '--text-on-accent': '#ffffff',
      '--border-color': '#30363d',
      '--border-light': '#21262d',
      '--accent-green': '#3fb950',
      '--accent-red': '#f85149',
      '--accent-blue': '#58a6ff',
      '--accent-yellow': '#d29922',
      '--card-shadow': '0 1px 3px rgba(0,0,0,0.3)',
      '--card-radius': '8px',
      '--glass-bg': 'rgba(22, 27, 34, 0.8)',
      '--glass-blur': 'blur(0px)',
    }
  },
  light: {
    name: 'light',
    displayName: 'Light Corporate',
    description: 'Clean white minimal corporate finance aesthetic',
    preview: 'linear-gradient(135deg, #ffffff 0%, #f6f8fa 100%)',
    vars: {
      '--bg-primary': '#f6f8fa',
      '--bg-secondary': '#ffffff',
      '--bg-tertiary': '#f3f4f6',
      '--bg-hover': '#e5e7eb',
      '--text-primary': '#1f2937',
      '--text-secondary': '#6b7280',
      '--text-muted': '#9ca3af',
      '--text-on-accent': '#ffffff',
      '--border-color': '#e5e7eb',
      '--border-light': '#f3f4f6',
      '--accent-green': '#059669',
      '--accent-red': '#dc2626',
      '--accent-blue': '#2563eb',
      '--accent-yellow': '#d97706',
      '--card-shadow': '0 1px 3px rgba(0,0,0,0.1), 0 1px 2px rgba(0,0,0,0.06)',
      '--card-radius': '12px',
      '--glass-bg': 'rgba(255, 255, 255, 0.9)',
      '--glass-blur': 'blur(0px)',
    }
  }
}

function normalizeStoredTheme(value: string | null): ThemeName {
  if (value === 'light') return 'light'
  return 'dark'
}

interface ThemeContextType {
  theme: Theme
  setTheme: (name: ThemeName) => void
  themeName: ThemeName
}

const ThemeContext = createContext<ThemeContextType | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [themeName, setThemeName] = useState<ThemeName>(() => {
    return normalizeStoredTheme(localStorage.getItem('theme'))
  })

  useEffect(() => {
    const theme = THEMES[themeName]
    Object.entries(theme.vars).forEach(([key, value]) => {
      document.documentElement.style.setProperty(key, value)
    })
    localStorage.setItem('theme', themeName)
  }, [themeName])

  const setTheme = (name: ThemeName) => {
    setThemeName(name)
  }

  return (
    <ThemeContext.Provider value={{ theme: THEMES[themeName], setTheme, themeName }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  const context = useContext(ThemeContext)
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider')
  }
  return context
}
