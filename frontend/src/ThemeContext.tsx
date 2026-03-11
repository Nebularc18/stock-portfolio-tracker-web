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
      '--bg': '#0c0d10',
      '--bg1': '#111318',
      '--bg2': '#16181e',
      '--bg3': '#1c1f27',
      '--bg4': '#222532',
      '--bg-primary': '#0d1117',
      '--bg-secondary': '#161b22',
      '--bg-tertiary': '#21262d',
      '--bg-hover': '#30363d',
      '--border': '#22242c',
      '--border2': '#2a2d38',
      '--text': '#e4e6ec',
      '--text2': '#b4b8c8',
      '--muted': '#7880a0',
      '--dim': '#282b38',
      '--v': '#818cf8',
      '--v2': '#a5b0fc',
      '--v3': '#c7cefe',
      '--green': '#4ade80',
      '--green2': '#22c55e',
      '--red': '#f87171',
      '--amber': '#fbbf24',
      '--teal': '#2dd4bf',
      '--sky': '#38bdf8',
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
      '--bg': '#f3f4f6',
      '--bg1': '#ffffff',
      '--bg2': '#f6f8fa',
      '--bg3': '#eef2f7',
      '--bg4': '#e5e7eb',
      '--bg-primary': '#f6f8fa',
      '--bg-secondary': '#ffffff',
      '--bg-tertiary': '#f3f4f6',
      '--bg-hover': '#e5e7eb',
      '--border': '#d5d9e0',
      '--border2': '#c7ced8',
      '--text': '#1f2937',
      '--text2': '#4b5563',
      '--muted': '#6b7280',
      '--dim': '#d1d5db',
      '--v': '#2563eb',
      '--v2': '#1d4ed8',
      '--v3': '#1e40af',
      '--green': '#059669',
      '--green2': '#047857',
      '--red': '#dc2626',
      '--amber': '#d97706',
      '--teal': '#0f766e',
      '--sky': '#0284c7',
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

/**
 * Map a stored theme value to a valid ThemeName, defaulting to 'dark'.
 *
 * @param value - The stored theme string (e.g., from localStorage); may be `null` or any string.
 * @returns `'light'` if `value` is `'light'`, `'dark'` otherwise.
 */
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

/**
 * Provides theme context to descendants, applies the active theme's CSS variables to the document, and persists the selected theme to localStorage.
 *
 * @param children - React nodes to render inside the provider
 * @returns A React element rendering ThemeContext.Provider that supplies `{ theme, setTheme, themeName }` to descendant components
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [themeName, setThemeName] = useState<ThemeName>(() => {
    try {
      return normalizeStoredTheme(localStorage.getItem('theme'))
    } catch {
      return normalizeStoredTheme(null)
    }
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
