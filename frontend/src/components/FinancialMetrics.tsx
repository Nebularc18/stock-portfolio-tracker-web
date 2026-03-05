import { FinancialMetrics as FinancialMetricsType } from '../services/api'
import { useSettings } from '../SettingsContext'
import { t } from '../i18n'

interface Props {
  metrics: FinancialMetricsType | null
  loading?: boolean
}

/**
 * Render a compact card showing a metric label and its formatted value.
 *
 * @param label - Text label displayed above the metric value
 * @param value - Metric value to display; if `null` or `undefined` a dash (`-`) is shown
 * @param format - Display format: 'number', 'percent', 'currency', 'date', or 'volume'
 * @returns A JSX element containing the styled label and the formatted value
 */
function MetricCard({ label, value, format = 'number' }: { label: string; value: string | number | null; format?: 'number' | 'percent' | 'currency' | 'date' | 'volume' }) {
  const formattedValue = () => {
    if (value === null || value === undefined) return '-'
    
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
      case 'date':
        return String(value)
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

/**
 * Renders a localized card containing a 4x4 grid of formatted financial metric tiles.
 *
 * Displays a localized loading message when `loading` is true, renders nothing when `metrics` is null,
 * and otherwise shows metric values formatted (percent, currency, date, volume, or number) with localized labels.
 *
 * @param props.metrics - Financial metrics object or `null`. When present, individual fields (e.g., `pe_ttm`, `roe_ttm`, `52_week_high`, `avg_volume_10d`) are displayed in the grid.
 * @param props.loading - Optional flag that, when true, shows a localized loading state instead of the metrics.
 * @returns The rendered financial metrics card element, or `null` if `metrics` is falsy.
 */
export default function FinancialMetrics({ metrics, loading }: Props) {
  const { language } = useSettings()

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
        <MetricCard label={t(language, 'financialMetrics.peTtm')} value={metrics.pe_ttm} />
        <MetricCard label={t(language, 'financialMetrics.psTtm')} value={metrics.ps_ttm} />
        <MetricCard label={t(language, 'financialMetrics.pb')} value={metrics.pb_annual} />
        <MetricCard label={t(language, 'financialMetrics.peAnnual')} value={metrics.pe_annual} />
        
        <MetricCard label={t(language, 'financialMetrics.roe')} value={metrics.roe_ttm} format="percent" />
        <MetricCard label={t(language, 'financialMetrics.roa')} value={metrics.roa_ttm} format="percent" />
        <MetricCard label={t(language, 'financialMetrics.netMargin')} value={metrics.net_margin_ttm} format="percent" />
        <MetricCard label={t(language, 'financialMetrics.grossMargin')} value={metrics.gross_margin_ttm} format="percent" />
        
        <MetricCard label={t(language, 'financialMetrics.operatingMargin')} value={metrics.operating_margin_ttm} format="percent" />
        <MetricCard label={t(language, 'financialMetrics.epsTtm')} value={metrics.eps_ttm} format="currency" />
        <MetricCard label={t(language, 'financialMetrics.bookValuePerShare')} value={metrics.book_value_per_share} format="currency" />
        <MetricCard label={t(language, 'financialMetrics.cashFlowPerShare')} value={metrics.cash_flow_per_share} format="currency" />
        
        <MetricCard label={t(language, 'financialMetrics.dividendPercent')} value={metrics.dividend_yield} format="percent" />
        <MetricCard label={t(language, 'financialMetrics.dividendPerShare')} value={metrics.dividend_per_share_annual} format="currency" />
        <MetricCard label={t(language, 'financialMetrics.divGrowth5y')} value={metrics.dividend_growth_5y} format="percent" />
        <MetricCard label={t(language, 'financialMetrics.divYieldTtm')} value={metrics.dividend_yield_ttm} format="percent" />
        
        <MetricCard label={t(language, 'financialMetrics.revenueGrowthTtm')} value={metrics.revenue_growth_ttm} format="percent" />
        <MetricCard label={t(language, 'financialMetrics.revenueGrowth3y')} value={metrics.revenue_growth_3y} format="percent" />
        <MetricCard label={t(language, 'financialMetrics.epsGrowthTtm')} value={metrics.eps_growth_ttm} format="percent" />
        <MetricCard label={t(language, 'financialMetrics.epsGrowth3y')} value={metrics.eps_growth_3y} format="percent" />
        
        <MetricCard label={t(language, 'financialMetrics.beta')} value={metrics.beta} />
        <MetricCard label={t(language, 'financialMetrics.high52w')} value={metrics['52_week_high']} format="currency" />
        <MetricCard label={t(language, 'financialMetrics.low52w')} value={metrics['52_week_low']} format="currency" />
        <MetricCard label={t(language, 'financialMetrics.high52wDate')} value={metrics['52_week_high_date']} format="date" />
        
        <MetricCard label={t(language, 'financialMetrics.low52wDate')} value={metrics['52_week_low_date']} format="date" />
        <MetricCard label={t(language, 'financialMetrics.avgVol10d')} value={metrics.avg_volume_10d} format="volume" />
        <MetricCard label={t(language, 'financialMetrics.avgVol3m')} value={metrics.avg_volume_3m} format="volume" />
        <div />
      </div>
    </div>
  )
}
