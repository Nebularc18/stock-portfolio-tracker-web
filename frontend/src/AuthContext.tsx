import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, AUTH_CHANGED_EVENT, AUTH_EXPIRED_EVENT, clearStoredAuthUser, getStoredAuthUser, setStoredAuthUser, type AuthUser } from './services/api'

interface AuthContextType {
  user: AuthUser | null
  loading: boolean
  login: (username: string, password: string) => Promise<void>
  register: (username: string, password: string) => Promise<void>
  loginAsGuest: () => Promise<void>
  logout: () => void
}

const AuthContext = createContext<AuthContextType | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(() => getStoredAuthUser())
  const [loading, setLoading] = useState(false)

  const persistUser = (nextUser: AuthUser) => {
    setStoredAuthUser(nextUser)
    setUser(nextUser)
  }

  const login = useCallback(async (username: string, password: string) => {
    setLoading(true)
    try {
      const authUser = await api.auth.login({ username, password })
      persistUser(authUser)
    } finally {
      setLoading(false)
    }
  }, [])

  const register = useCallback(async (username: string, password: string) => {
    setLoading(true)
    try {
      const authUser = await api.auth.register({ username, password })
      persistUser(authUser)
    } finally {
      setLoading(false)
    }
  }, [])

  const loginAsGuest = useCallback(async () => {
    setLoading(true)
    try {
      const authUser = await api.auth.guest()
      persistUser(authUser)
    } finally {
      setLoading(false)
    }
  }, [])

  const logout = useCallback(() => {
    clearStoredAuthUser(false)
    setUser(null)
  }, [])

  useEffect(() => {
    const handleAuthExpired = () => {
      setUser(null)
    }
    const handleAuthChanged = () => {
      setUser(getStoredAuthUser())
    }

    window.addEventListener(AUTH_EXPIRED_EVENT, handleAuthExpired)
    window.addEventListener(AUTH_CHANGED_EVENT, handleAuthChanged)
    return () => {
      window.removeEventListener(AUTH_EXPIRED_EVENT, handleAuthExpired)
      window.removeEventListener(AUTH_CHANGED_EVENT, handleAuthChanged)
    }
  }, [])

  const value = useMemo(
    () => ({ user, loading, login, register, loginAsGuest, logout }),
    [user, loading, login, register, loginAsGuest, logout],
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
