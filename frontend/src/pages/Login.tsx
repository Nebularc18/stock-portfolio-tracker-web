import { FormEvent, useState } from 'react'
import { useAuth } from '../AuthContext'

export default function Login() {
  const { login, register, loginAsGuest, loading } = useAuth()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [isRegisterMode, setIsRegisterMode] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)

    try {
      if (isRegisterMode) {
        await register(username.trim(), password)
      } else {
        await login(username.trim(), password)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed')
    }
  }

  const guestLogin = async () => {
    setError(null)
    try {
      await loginAsGuest()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Guest login failed')
    }
  }

  return (
    <div style={{
      minHeight: '100vh',
      display: 'grid',
      placeItems: 'center',
      background: 'radial-gradient(circle at 20% 0%, #214c7b 0%, #10203a 45%, #0a1220 100%)',
      padding: '20px',
    }}>
      <div style={{
        width: '100%',
        maxWidth: 460,
        background: 'rgba(11, 19, 33, 0.92)',
        border: '1px solid rgba(96, 133, 181, 0.4)',
        borderRadius: 18,
        boxShadow: '0 24px 55px rgba(0, 0, 0, 0.35)',
        padding: 28,
      }}>
        <p style={{ letterSpacing: 1.2, color: '#9bc7ff', fontSize: 12, marginBottom: 10 }}>PORTFOLIO TRACKER</p>
        <h1 style={{ fontSize: 28, marginBottom: 8 }}>Welcome back</h1>
        <p style={{ color: 'rgba(255,255,255,0.7)', marginBottom: 24 }}>
          Log in to your account or open the guest portfolio with sample holdings from Sweden, USA, and Germany.
        </p>

        <form onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
          <label htmlFor="username" style={{ fontSize: 13, color: 'rgba(255,255,255,0.85)' }}>Username</label>
          <input
            id="username"
            placeholder="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            autoComplete="username"
          />
          <label htmlFor="password" style={{ fontSize: 13, color: 'rgba(255,255,255,0.85)' }}>Password</label>
          <input
            id="password"
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete={isRegisterMode ? 'new-password' : 'current-password'}
          />
          {error && <div style={{ color: '#ff8f8f', fontSize: 13 }}>{error}</div>}
          <button className="btn btn-primary" type="submit" disabled={loading} style={{ width: '100%' }}>
            {loading ? 'Please wait...' : isRegisterMode ? 'Create account' : 'Log in'}
          </button>
        </form>

        <div style={{ display: 'grid', gap: 10, marginTop: 12 }}>
          <button className="btn btn-secondary" onClick={() => setIsRegisterMode((v) => !v)} disabled={loading}>
            {isRegisterMode ? 'Already have an account? Log in' : 'Need an account? Register'}
          </button>
          <button className="btn" onClick={guestLogin} disabled={loading} style={{ background: '#1f7a4f', color: '#fff' }}>
            Continue as guest demo user
          </button>
        </div>

        <div style={{ marginTop: 16, color: 'rgba(255,255,255,0.55)', fontSize: 12 }}>
          Use your account credentials or continue with the guest demo user.
        </div>
      </div>
    </div>
  )
}
