import { CompanyProfile as CompanyProfileType } from '../services/api'

interface Props {
  profile: CompanyProfileType | null
  loading?: boolean
}

function formatMarketCap(value: number | null): string {
  if (value === null) return '-'
  if (value >= 1000) return `$${(value / 1000).toFixed(1)}B`
  return `$${value.toFixed(0)}M`
}

function formatWebsite(url: string | null): string {
  if (!url) return '-'
  return url.replace('https://', '').replace('http://', '').replace(/\/$/, '')
}

export default function CompanyProfile({ profile, loading }: Props) {
  if (loading) {
    return (
      <div className="card">
        <h3 style={{ marginBottom: '16px' }}>Företagsinformation</h3>
        <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '20px' }}>
          Laddar...
        </p>
      </div>
    )
  }

  if (!profile) {
    return null
  }

  return (
    <div className="card">
      <h3 style={{ marginBottom: '16px' }}>Företagsinformation</h3>
      
      <div style={{ display: 'flex', gap: '24px', alignItems: 'flex-start' }}>
        {profile.logo && (
          <div style={{ flexShrink: 0 }}>
            <img 
              src={profile.logo} 
              alt={profile.name || 'Company logo'}
              style={{ 
                width: 64, 
                height: 64, 
                borderRadius: 8, 
                objectFit: 'contain',
                background: 'var(--bg-secondary)',
                padding: 4
              }}
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = 'none'
              }}
            />
          </div>
        )}
        
        <div style={{ flex: 1 }}>
          <h4 style={{ fontSize: '18px', fontWeight: '600', marginBottom: '4px' }}>
            {profile.name}
            {profile.ticker && <span style={{ color: 'var(--text-secondary)', marginLeft: '8px' }}>({profile.ticker})</span>}
          </h4>
          
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px', marginTop: '16px' }}>
            <div>
              <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginBottom: '4px' }}>Industri</p>
              <p style={{ fontSize: '14px' }}>{profile.industry || '-'}</p>
            </div>
            <div>
              <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginBottom: '4px' }}>Land</p>
              <p style={{ fontSize: '14px' }}>{profile.country || '-'}</p>
            </div>
            <div>
              <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginBottom: '4px' }}>Börs</p>
              <p style={{ fontSize: '14px' }}>{profile.exchange || '-'}</p>
            </div>
            <div>
              <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginBottom: '4px' }}>IPO-datum</p>
              <p style={{ fontSize: '14px' }}>{profile.ipo_date || '-'}</p>
            </div>
            <div>
              <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginBottom: '4px' }}>Webbplats</p>
              {profile.website ? (
                <a 
                  href={profile.website} 
                  target="_blank" 
                  rel="noopener noreferrer"
                  style={{ color: 'var(--accent-blue)', fontSize: '14px', textDecoration: 'none' }}
                >
                  {formatWebsite(profile.website)}
                </a>
              ) : (
                <p style={{ fontSize: '14px' }}>-</p>
              )}
            </div>
            <div>
              <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginBottom: '4px' }}>Marknadsvärde</p>
              <p style={{ fontSize: '14px' }}>{formatMarketCap(profile.market_cap)}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
