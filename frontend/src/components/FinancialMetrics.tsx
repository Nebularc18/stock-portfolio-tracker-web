import { FinancialMetrics as FinancialMetricsType } from '../services/api'
import { useSettings } from '../SettingsContext'
import { getLocaleForLanguage, t } from '../i18n'

interface Props {
  metrics: FinancialMetricsType | null
  loading?: boolean
}

function MetricCard({ label, value, format = 'number', locale }: { label: string; value: string | number | null; format?: 'number' | 'percent' | 'currency' | 'date' | 'volume'; locale: string }) {
  const formattedValue = () => {
    if (value === null || value === undefined) return '-'

    if (format === 'date') {
      const rawValue = String(value)
      const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(rawValue)
      const date = dateOnlyMatch
        ? new Date(Number(dateOnlyMatch[1]), Number(dateOnlyMatch[2]) - 1, Number(dateOnlyMatch[3]))
        : new Date(rawValue)
      if (Number.isNaN(date.getTime())) return '-'
      return new Intl.DateTimeFormat(locale, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      }).format(date)
    }
    
    const numValue = typeof value === 'number' ? value : parseFloat(value)
    if (isNaN(numValue)) return '-'
    
    switch (format) {
      case 'percent':
        const pct = Math.abs(numValue) > 1 ? numValue : numValue * 100
        return `${pct.toFixed(1)}%`
      case 'currency':
        return `$${numValue.toFixed(2)}`
      case 'volume':
        if (numValue >= 1_000_000_000) return `${(numValue / 1_000_000_000).toFixed(1)}B`
        if (numValue >= 1_000_000) return `${(numValue / 1_000_000).toFixed(1)}M`
        if (numValue >= 1_000) return `${(numValue / 1_000).toFixed(1)}K`
        return numValue.toFixed(0)
      default:
        return numValue.toFixed(2)
    }
  }
  
  return (
    <div style={{ 
      background: 'var(--bg-secondary)', 
      border: '1px solid var(--border-color)', 
      borderRadius: 8, 
      padding: '12px',
      minHeight: 70
    }}>
      <p style={{ color: 'var(--text-secondary)', fontSize: '11px', marginBottom: '4px' }}>{label}</p>
      <p style={{ fontSize: '16px', fontWeight: '600' }}>{formattedValue()}</p>
    </div>
  )
}

export default function FinancialMetrics({ metrics, loading }: Props) {
  const { language } = useSettings()
  const locale = getLocaleForLanguage(language)

  if (loading) {
    return (
      <div className="card">
        <h3 style={{ marginBottom: '16px' }}>{t(language, 'financialMetrics.title')}</h3>
        <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '20px' }}>
          {t(language, 'common.loading')}
        </p>
      </div>
    )
  }

  if (!metrics) {
    return null
  }

  return (
    <div className="card">
      <h3 style={{ marginBottom: '16px' }}>{t(language, 'financialMetrics.title')}</h3>
      
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px' }}>
        <MetricCard label={t(language, 'financialMetrics.peTtm')} value={metrics.pe_ttm} locale={locale} />
        <MetricCard label={t(language, 'financialMetrics.psTtm')} value={metrics.ps_ttm} locale={locale} />
        <MetricCard label={t(language, 'financialMetrics.pb')} value={metrics.pb_annual} locale={locale} />
        <MetricCard label={t(language, 'financialMetrics.peAnnual')} value={metrics.pe_annual} locale={locale} />
        
        <MetricCard label={t(language, 'financialMetrics.roe')} value={metrics.roe_ttm} format="percent" locale={locale} />
        <MetricCard label={t(language, 'financialMetrics.roa')} value={metrics.roa_ttm} format="percent" locale={locale} />
        <MetricCard label={t(language, 'financialMetrics.netMargin')} value={metrics.net_margin_ttm} format="percent" locale={locale} />
        <MetricCard label={t(language, 'financialMetrics.grossMargin')} value={metrics.gross_margin_ttm} format="percent" locale={locale} />
        
        <MetricCard label={t(language, 'financialMetrics.operatingMargin')} value={metrics.operating_margin_ttm} format="percent" locale={locale} />
        <MetricCard label={t(language, 'financialMetrics.epsTtm')} value={metrics.eps_ttm} format="currency" locale={locale} />
        <MetricCard label={t(language, 'financialMetrics.bookValuePerShare')} value={metrics.book_value_per_share} format="currency" locale={locale} />
        <MetricCard label={t(language, 'financialMetrics.cashFlowPerShare')} value={metrics.cash_flow_per_share} format="currency" locale={locale} />
        
        <MetricCard label={t(language, 'financialMetrics.dividendPercent')} value={metrics.dividend_yield} format="percent" locale={locale} />
        <MetricCard label={t(language, 'financialMetrics.dividendPerShare')} value={metrics.dividend_per_share_annual} format="currency" locale={locale} />
        <MetricCard label={t(language, 'financialMetrics.divGrowth5y')} value={metrics.dividend_growth_5y} format="percent" locale={locale} />
        <MetricCard label={t(language, 'financialMetrics.divYieldTtm')} value={metrics.dividend_yield_ttm} format="percent" locale={locale} />
        
        <MetricCard label={t(language, 'financialMetrics.revenueGrowthTtm')} value={metrics.revenue_growth_ttm} format="percent" locale={locale} />
        <MetricCard label={t(language, 'financialMetrics.revenueGrowth3y')} value={metrics.revenue_growth_3y} format="percent" locale={locale} />
        <MetricCard label={t(language, 'financialMetrics.epsGrowthTtm')} value={metrics.eps_growth_ttm} format="percent" locale={locale} />
        <MetricCard label={t(language, 'financialMetrics.epsGrowth3y')} value={metrics.eps_growth_3y} format="percent" locale={locale} />
        
        <MetricCard label={t(language, 'financialMetrics.beta')} value={metrics.beta} locale={locale} />
        <MetricCard label={t(language, 'financialMetrics.high52w')} value={metrics['52_week_high']} format="currency" locale={locale} />
        <MetricCard label={t(language, 'financialMetrics.low52w')} value={metrics['52_week_low']} format="currency" locale={locale} />
        <MetricCard label={t(language, 'financialMetrics.high52wDate')} value={metrics['52_week_high_date']} format="date" locale={locale} />
        
        <MetricCard label={t(language, 'financialMetrics.low52wDate')} value={metrics['52_week_low_date']} format="date" locale={locale} />
        <MetricCard label={t(language, 'financialMetrics.avgVol10d')} value={metrics.avg_volume_10d} format="volume" locale={locale} />
        <MetricCard label={t(language, 'financialMetrics.avgVol3m')} value={metrics.avg_volume_3m} format="volume" locale={locale} />
        <div />
      </div>
    </div>
  )
}
