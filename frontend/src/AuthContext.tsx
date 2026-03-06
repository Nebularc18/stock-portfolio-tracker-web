import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import { api, AUTH_STORAGE_KEY, type AuthUser } from './services/api'

interface AuthContextType {
  user: AuthUser | null
  loading: boolean
  login: (username: string, password: string) => Promise<void>
  register: (username: string, password: string) => Promise<void>
  loginAsGuest: () => Promise<void>
  logout: () => void
}

const AuthContext = createContext<AuthContextType | null>(null)

function readStoredUser(): AuthUser | null {
  const raw = localStorage.getItem(AUTH_STORAGE_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as AuthUser
  } catch {
    localStorage.removeItem(AUTH_STORAGE_KEY)
    return null
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(() => readStoredUser())
  const [loading, setLoading] = useState(false)

  const persistUser = (nextUser: AuthUser) => {
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(nextUser))
    setUser(nextUser)
  }

  const login = async (username: string, password: string) => {
    setLoading(true)
    try {
      const authUser = await api.auth.login({ username, password })
      persistUser(authUser)
    } finally {
      setLoading(false)
    }
  }

  const register = async (username: string, password: string) => {
    setLoading(true)
    try {
      const authUser = await api.auth.register({ username, password })
      persistUser(authUser)
    } finally {
      setLoading(false)
    }
  }

  const loginAsGuest = async () => {
    setLoading(true)
    try {
      const authUser = await api.auth.guest()
      persistUser(authUser)
    } finally {
      setLoading(false)
    }
  }

  const logout = () => {
    localStorage.removeItem(AUTH_STORAGE_KEY)
    setUser(null)
  }

  const value = useMemo(
    () => ({ user, loading, login, register, loginAsGuest, logout }),
    [user, loading],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
