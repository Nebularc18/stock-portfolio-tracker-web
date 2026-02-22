import { FinancialMetrics as FinancialMetricsType } from '../services/api'

interface Props {
  metrics: FinancialMetricsType | null
  loading?: boolean
}

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

export default function FinancialMetrics({ metrics, loading }: Props) {
  if (loading) {
    return (
      <div className="card">
        <h3 style={{ marginBottom: '16px' }}>Nyckeltal</h3>
        <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '20px' }}>
          Laddar...
        </p>
      </div>
    )
  }

  if (!metrics) {
    return null
  }

  return (
    <div className="card">
      <h3 style={{ marginBottom: '16px' }}>Nyckeltal</h3>
      
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px' }}>
        <MetricCard label="P/E (TTM)" value={metrics.pe_ttm} />
        <MetricCard label="P/S (TTM)" value={metrics.ps_ttm} />
        <MetricCard label="P/B" value={metrics.pb_annual} />
        <MetricCard label="P/E (Årlig)" value={metrics.pe_annual} />
        
        <MetricCard label="ROE" value={metrics.roe_ttm} format="percent" />
        <MetricCard label="ROA" value={metrics.roa_ttm} format="percent" />
        <MetricCard label="Nettomarginal" value={metrics.net_margin_ttm} format="percent" />
        <MetricCard label="Bruttomarginal" value={metrics.gross_margin_ttm} format="percent" />
        
        <MetricCard label="Rörelsemarginal" value={metrics.operating_margin_ttm} format="percent" />
        <MetricCard label="EPS (TTM)" value={metrics.eps_ttm} format="currency" />
        <MetricCard label="Bokvärde/aktie" value={metrics.book_value_per_share} format="currency" />
        <MetricCard label="Kassaflöde/aktie" value={metrics.cash_flow_per_share} format="currency" />
        
        <MetricCard label="Utdelning %" value={metrics.dividend_yield} format="percent" />
        <MetricCard label="Utdelning/aktie" value={metrics.dividend_per_share_annual} format="currency" />
        <MetricCard label="Utd. tillväxt 5Å" value={metrics.dividend_growth_5y} format="percent" />
        <MetricCard label="Utd. avk. TTM" value={metrics.dividend_yield_ttm} format="percent" />
        
        <MetricCard label="Oms. tillväxt TTM" value={metrics.revenue_growth_ttm} format="percent" />
        <MetricCard label="Oms. tillväxt 3Å" value={metrics.revenue_growth_3y} format="percent" />
        <MetricCard label="EPS tillväxt TTM" value={metrics.eps_growth_ttm} format="percent" />
        <MetricCard label="EPS tillväxt 3Å" value={metrics.eps_growth_3y} format="percent" />
        
        <MetricCard label="Beta" value={metrics.beta} />
        <MetricCard label="52V Hög" value={metrics['52_week_high']} format="currency" />
        <MetricCard label="52V Låg" value={metrics['52_week_low']} format="currency" />
        <MetricCard label="52V Hög datum" value={metrics['52_week_high_date']} format="date" />
        
        <MetricCard label="52V Låg datum" value={metrics['52_week_low_date']} format="date" />
        <MetricCard label="Volym 10d gen." value={metrics.avg_volume_10d} format="volume" />
        <MetricCard label="Volym 3m gen." value={metrics.avg_volume_3m} format="volume" />
        <div />
      </div>
    </div>
  )
}
