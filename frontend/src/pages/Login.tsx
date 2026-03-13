import { FormEvent, useState } from 'react'
import { useAuth } from '../AuthContext'
import { Language, t } from '../i18n'

/**
 * Renders the authentication form allowing users to sign in, register, or log in as a guest.
 *
 * Validates that the username is not empty, displays localized error messages, and delegates
 * authentication actions (login, register, guest login) to the authentication context.
 *
 * @returns The login/register UI as a JSX element
 */
export default function Login() {
  const { login, register, loginAsGuest, loading } = useAuth()
  const language: Language = localStorage.getItem('language') === 'sv' ? 'sv' : 'en'
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [isRegisterMode, setIsRegisterMode] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    const trimmed = username.trim()
    if (trimmed.length === 0) {
      setError(t(language, 'login.errorEmptyUsername'))
      return
    }
    try {
      if (isRegisterMode) {
        await register(trimmed, password)
      } else {
        await login(trimmed, password)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t(language, 'login.errorAuthFailed'))
    }
  }

  const guestLogin = async () => {
    setError(null)
    try {
      await loginAsGuest()
    } catch (err) {
      setError(err instanceof Error ? err.message : t(language, 'login.errorGuestFailed'))
    }
  }

  return (
    <div style={{
      minHeight: '100vh',
      display: 'grid',
      placeItems: 'center',
      background: 'var(--bg)',
      padding: '20px',
      position: 'relative',
      overflow: 'hidden',
    }}>
      {/* Subtle background glow */}
      <div style={{
        position: 'absolute',
        top: '15%', left: '50%',
        transform: 'translateX(-50%)',
        width: 600, height: 400,
        background: 'radial-gradient(ellipse, rgba(129,140,248,0.07) 0%, transparent 65%)',
        pointerEvents: 'none',
      }} />

      <div style={{
        width: '100%',
        maxWidth: 400,
        position: 'relative',
      }}>
        {/* Logo mark */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 32 }}>
          <div style={{
            width: 32, height: 32,
            borderRadius: 8,
            background: 'linear-gradient(135deg, var(--v) 0%, var(--v2) 100%)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 0 16px rgba(129,140,248,0.4)',
          }}>
            <span style={{ fontSize: 14, fontWeight: 800, color: '#fff' }}>P</span>
          </div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--text)' }}>
              {t(language, 'login.productName')}
            </div>
            <div style={{ fontSize: 9, color: 'var(--muted)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
              {t(language, 'login.productLabel')}
            </div>
          </div>
        </div>

        {/* Card */}
        <div style={{
          background: 'var(--bg2)',
          border: '1px solid var(--border2)',
          borderRadius: 12,
          padding: 28,
          boxShadow: '0 24px 48px rgba(0,0,0,0.5)',
        }}>
          <h1 style={{ fontSize: 22, fontWeight: 800, marginBottom: 6, letterSpacing: '-0.02em' }}>
            {isRegisterMode ? t(language, 'login.submitRegister') : t(language, 'login.title')}
          </h1>
          <p style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 24, lineHeight: 1.6 }}>
            {t(language, 'login.description')}
          </p>

          <form onSubmit={submit} style={{ display: 'grid', gap: 14 }}>
            <div>
              <label htmlFor="username">{t(language, 'login.usernameLabel')}</label>
              <input
                id="username"
                placeholder={t(language, 'login.usernamePlaceholder')}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                autoComplete="username"
              />
            </div>
            <div>
              <label htmlFor="password">{t(language, 'login.passwordLabel')}</label>
              <input
                id="password"
                type="password"
                placeholder={t(language, 'login.passwordPlaceholder')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete={isRegisterMode ? 'new-password' : 'current-password'}
              />
            </div>

            {error && (
              <div role="alert" aria-live="assertive" aria-atomic="true" style={{
                color: 'var(--red)', fontSize: 12, padding: '8px 12px',
                background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)',
                borderRadius: 6,
              }}>
                {error}
              </div>
            )}

            <button
              className="btn btn-primary"
              type="submit"
              disabled={loading}
              style={{ width: '100%', justifyContent: 'center', padding: '10px', fontSize: 13 }}
            >
              {loading ? t(language, 'login.loading') : isRegisterMode ? t(language, 'login.submitRegister') : t(language, 'login.submitLogin')}
            </button>
          </form>

          <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
            <button
              className="btn btn-secondary"
              onClick={() => setIsRegisterMode((v) => !v)}
              disabled={loading}
              style={{ width: '100%', justifyContent: 'center' }}
            >
              {isRegisterMode ? t(language, 'login.toggleToLogin') : t(language, 'login.toggleToRegister')}
            </button>
            <button
              className="btn"
              onClick={guestLogin}
              disabled={loading}
              style={{
                width: '100%', justifyContent: 'center',
                background: 'rgba(45,212,191,0.08)',
                color: 'var(--teal)',
                borderColor: 'rgba(45,212,191,0.25)',
              }}
            >
              {t(language, 'login.guestButton')}
            </button>
          </div>

          <p style={{ marginTop: 16, color: 'var(--muted)', fontSize: 11, lineHeight: 1.6 }}>
            {t(language, 'login.helper')}
          </p>
        </div>
      </div>
    </div>
  )
}
