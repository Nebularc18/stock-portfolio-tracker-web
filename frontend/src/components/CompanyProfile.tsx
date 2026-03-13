import { CompanyProfile as CompanyProfileType } from '../services/api'
import { useSettings } from '../SettingsContext'
import { t } from '../i18n'
import { resolveBackendAssetUrl } from '../utils/assets'

interface Props {
  profile: CompanyProfileType | null
  loading?: boolean
}

function formatMarketCap(value: number | null): string {
  if (value === null) return '-'
  if (value >= 1000) return `$${(value / 1000).toFixed(1)}B`
  return `$${value.toFixed(0)}M`
}

/**
 * Format a website URL for display by removing the leading protocol and any trailing slash, or return a placeholder when missing.
 *
 * @param url - The website URL to format; may be `null` or an empty string
 * @returns The URL without `https://` or `http://` and without a trailing slash, or `-` if `url` is `null` or empty
 */
function formatWebsite(url: string | null): string {
  if (!url) return '-'
  return url.replace('https://', '').replace('http://', '').replace(/\/$/, '')
}

/**
 * Renders a company profile card with translated labels, or a translated loading message when loading.
 *
 * @param props.profile - The company profile to display; when `null` the component returns `null`.
 * @param props.loading - If `true`, shows a translated loading state instead of the profile.
 * @returns The company profile card JSX element, or `null` when `profile` is `null`.
 */
export default function CompanyProfile({ profile, loading }: Props) {
  const { language } = useSettings()

  if (loading) {
    return (
      <div className="card">
        <h3 style={{ marginBottom: '16px' }}>{t(language, 'companyProfile.title')}</h3>
        <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '20px' }}>
          {t(language, 'common.loading')}
        </p>
      </div>
    )
  }

  if (!profile) {
    return null
  }

  const resolvedLogoUrl = resolveBackendAssetUrl(profile.logo)

  return (
    <div className="card">
      <h3 style={{ marginBottom: '16px' }}>{t(language, 'companyProfile.title')}</h3>
      
      <div style={{ display: 'flex', gap: '24px', alignItems: 'flex-start' }}>
        {resolvedLogoUrl && (
          <div style={{ flexShrink: 0 }}>
            <img 
              src={resolvedLogoUrl} 
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
              <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginBottom: '4px' }}>{t(language, 'companyProfile.industry')}</p>
              <p style={{ fontSize: '14px' }}>{profile.industry || '-'}</p>
            </div>
            <div>
              <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginBottom: '4px' }}>{t(language, 'companyProfile.country')}</p>
              <p style={{ fontSize: '14px' }}>{profile.country || '-'}</p>
            </div>
            <div>
              <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginBottom: '4px' }}>{t(language, 'companyProfile.exchange')}</p>
              <p style={{ fontSize: '14px' }}>{profile.exchange || '-'}</p>
            </div>
            <div>
              <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginBottom: '4px' }}>{t(language, 'companyProfile.ipoDate')}</p>
              <p style={{ fontSize: '14px' }}>{profile.ipo_date || '-'}</p>
            </div>
            <div>
              <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginBottom: '4px' }}>{t(language, 'companyProfile.website')}</p>
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
              <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginBottom: '4px' }}>{t(language, 'companyProfile.marketCap')}</p>
              <p style={{ fontSize: '14px' }}>{formatMarketCap(profile.market_cap)}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
