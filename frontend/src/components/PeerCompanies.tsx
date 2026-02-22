import { useNavigate } from 'react-router-dom'

interface Props {
  peers: string[] | null
  loading?: boolean
}

export default function PeerCompanies({ peers, loading }: Props) {
  const navigate = useNavigate()

  if (loading) {
    return (
      <div className="card">
        <h3 style={{ marginBottom: '16px' }}>Liknande bolag</h3>
        <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '20px' }}>
          Laddar...
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
      <h3 style={{ marginBottom: '16px' }}>Liknande bolag</h3>
      
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
            {ticker}
          </button>
        ))}
      </div>
    </div>
  )
}
