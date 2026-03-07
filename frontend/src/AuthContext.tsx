import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
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
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') {
      localStorage.removeItem(AUTH_STORAGE_KEY)
      return null
    }

    const candidate = parsed as Record<string, unknown>
    const isValid =
      typeof candidate.id === 'number' &&
      Number.isFinite(candidate.id) &&
      candidate.id > 0 &&
      typeof candidate.username === 'string' &&
      candidate.username.trim().length > 0 &&
      typeof candidate.is_guest === 'boolean' &&
      typeof candidate.token === 'string' &&
      candidate.token.trim().length > 0

    if (!isValid) {
      localStorage.removeItem(AUTH_STORAGE_KEY)
      return null
    }

    return {
      id: candidate.id as number,
      username: candidate.username as string,
      is_guest: candidate.is_guest as boolean,
      token: candidate.token as string,
    }
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
    localStorage.removeItem(AUTH_STORAGE_KEY)
    setUser(null)
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
