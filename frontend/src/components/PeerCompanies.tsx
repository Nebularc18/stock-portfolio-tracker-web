import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSettings } from '../SettingsContext'
import { t } from '../i18n'
import { api } from '../services/api'

interface Props {
  peers: string[] | null
  loading?: boolean
}

const PROFILE_BATCH_SIZE = 4

/**
 * Renders a localized card of peer company tickers as clickable buttons that navigate to each stock page.
 *
 * @param peers - Array of peer ticker symbols; when `null` or empty, nothing is rendered
 * @param loading - When `true`, shows a localized loading state instead of the peers list
 * @returns The rendered peers card, or `null` if `peers` is `null` or empty
 */
export default function PeerCompanies({ peers, loading }: Props) {
  const navigate = useNavigate()
  const { language } = useSettings()
  const [peerNames, setPeerNames] = useState<Record<string, string>>({})

  useEffect(() => {
    let isCurrent = true

    if (!peers || peers.length === 0) {
      setPeerNames({})
      return
    }

    const loadPeerNames = async () => {
      const entries: Array<readonly [string, string]> = []

      for (let index = 0; index < peers.length; index += PROFILE_BATCH_SIZE) {
        const batch = peers.slice(index, index + PROFILE_BATCH_SIZE)
        const batchEntries = await Promise.all(
          batch.map(async (ticker) => {
            const profile = await api.finnhub.profile(ticker).catch(() => null)
            return [ticker, profile?.name || ticker] as const
          })
        )

        if (!isCurrent) return
        entries.push(...batchEntries)
      }

      if (!isCurrent) return
      setPeerNames(Object.fromEntries(entries))
    }

    void loadPeerNames()

    return () => {
      isCurrent = false
    }
  }, [peers])

  if (loading) {
    return (
      <div className="card">
        <h3 style={{ marginBottom: '16px' }}>{t(language, 'peers.title')}</h3>
        <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '20px' }}>
          {t(language, 'common.loading')}
        </p>
      </div>
    )
  }

  if (!peers || peers.length === 0) {
    return null
  }

  const handlePeerClick = (ticker: string) => {
    navigate(`/stocks/${ticker}`)
  }

  return (
    <div className="card">
      <h3 style={{ marginBottom: '16px' }}>{t(language, 'peers.title')}</h3>
      
      <div style={{ 
        display: 'flex', 
        flexWrap: 'wrap', 
        gap: '8px',
        background: 'var(--bg-secondary)',
        padding: '12px',
        borderRadius: 8,
        border: '1px solid var(--border-color)'
      }}>
        {peers.map((ticker) => (
          <button
            key={ticker}
            onClick={() => handlePeerClick(ticker)}
            style={{
              background: 'var(--bg-tertiary)',
              color: 'var(--accent-blue)',
              border: '1px solid var(--border-color)',
              borderRadius: 6,
              padding: '6px 12px',
              fontSize: '13px',
              fontWeight: 500,
              cursor: 'pointer',
              transition: 'all 0.2s ease'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = 'var(--accent-blue)'
              e.currentTarget.style.background = 'var(--bg-hover)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = 'var(--border-color)'
              e.currentTarget.style.background = 'var(--bg-tertiary)'
            }}
          >
            {peerNames[ticker] || ticker}
          </button>
        ))}
      </div>
    </div>
  )
}
