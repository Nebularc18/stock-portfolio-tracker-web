import { createContext, useContext, useState, useEffect, ReactNode } from 'react'

type ThemeName = 'midnight' | 'light' | 'glass' | 'neo' | 'vibrant'

export type { ThemeName }

interface Theme {
  name: ThemeName
  displayName: string
  description: string
  preview: string
  vars: Record<string, string>
}

export const THEMES: Record<ThemeName, Theme> = {
  midnight: {
    name: 'midnight',
    displayName: 'Midnight Terminal',
    description: 'Dark Bloomberg-inspired professional trading look',
    preview: 'linear-gradient(135deg, #0d1117 0%, #161b22 100%)',
    vars: {
      '--bg-primary': '#0d1117',
      '--bg-secondary': '#161b22',
      '--bg-tertiary': '#21262d',
      '--bg-hover': '#30363d',
      '--text-primary': '#e6edf3',
      '--text-secondary': '#8b949e',
      '--text-muted': '#6e7681',
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
  },
  glass: {
    name: 'glass',
    displayName: 'Glassmorphic',
    description: 'Modern glass blur effects with purple accents',
    preview: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)',
    vars: {
      '--bg-primary': '#0f0f1a',
      '--bg-secondary': 'rgba(30, 30, 50, 0.6)',
      '--bg-tertiary': 'rgba(40, 40, 70, 0.5)',
      '--bg-hover': 'rgba(60, 60, 100, 0.4)',
      '--text-primary': '#f0f0f5',
      '--text-secondary': '#a0a0b0',
      '--text-muted': '#707080',
      '--border-color': 'rgba(100, 100, 150, 0.3)',
      '--border-light': 'rgba(80, 80, 130, 0.2)',
      '--accent-green': '#00d9a0',
      '--accent-red': '#ff6b8a',
      '--accent-blue': '#8b5cf6',
      '--accent-yellow': '#fbbf24',
      '--card-shadow': '0 8px 32px rgba(0, 0, 0, 0.3)',
      '--card-radius': '16px',
      '--glass-bg': 'rgba(30, 30, 50, 0.4)',
      '--glass-blur': 'blur(12px)',
    }
  },
  neo: {
    name: 'neo',
    displayName: 'Neomorphic',
    description: 'Soft shadows with raised tactile elements',
    preview: 'linear-gradient(135deg, #e0e5ec 0%, #d1d9e6 100%)',
    vars: {
      '--bg-primary': '#e0e5ec',
      '--bg-secondary': '#e0e5ec',
      '--bg-tertiary': '#e0e5ec',
      '--bg-hover': '#d1d9e6',
      '--text-primary': '#2d3748',
      '--text-secondary': '#4a5568',
      '--text-muted': '#718096',
      '--border-color': 'transparent',
      '--border-light': 'transparent',
      '--accent-green': '#48bb78',
      '--accent-red': '#fc8181',
      '--accent-blue': '#4299e1',
      '--accent-yellow': '#ecc94b',
      '--card-shadow': '8px 8px 16px #b8bec7, -8px -8px 16px #ffffff',
      '--card-radius': '20px',
      '--glass-bg': '#e0e5ec',
      '--glass-blur': 'blur(0px)',
    }
  },
  vibrant: {
    name: 'vibrant',
    displayName: 'Vibrant Gradient',
    description: 'Colorful modern SaaS with rounded elements',
    preview: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    vars: {
      '--bg-primary': '#0f0f23',
      '--bg-secondary': '#1a1a3e',
      '--bg-tertiary': '#252552',
      '--bg-hover': '#2f2f66',
      '--text-primary': '#ffffff',
      '--text-secondary': '#b8b8d0',
      '--text-muted': '#8888a0',
      '--border-color': 'rgba(102, 126, 234, 0.3)',
      '--border-light': 'rgba(102, 126, 234, 0.15)',
      '--accent-green': '#00e676',
      '--accent-red': '#ff5252',
      '--accent-blue': '#667eea',
      '--accent-yellow': '#ffab40',
      '--card-shadow': '0 4px 20px rgba(102, 126, 234, 0.15)',
      '--card-radius': '16px',
      '--glass-bg': 'rgba(26, 26, 62, 0.8)',
      '--glass-blur': 'blur(8px)',
    }
  }
}

interface ThemeContextType {
  theme: Theme
  setTheme: (name: ThemeName) => void
  themeName: ThemeName
}

const ThemeContext = createContext<ThemeContextType | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [themeName, setThemeName] = useState<ThemeName>(() => {
    const saved = localStorage.getItem('theme') as ThemeName
    return saved && THEMES[saved] ? saved : 'midnight'
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
