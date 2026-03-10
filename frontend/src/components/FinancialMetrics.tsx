import { FinancialMetrics as FinancialMetricsType } from '../services/api'
import { useSettings } from '../SettingsContext'
import { getLocaleForLanguage, t } from '../i18n'

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
 * @param locale - Locale used for date formatting
 * @returns A JSX element containing the styled label and the formatted value
 */
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
        return new Intl.NumberFormat(locale, {
          style: 'percent',
          minimumFractionDigits: 1,
          maximumFractionDigits: 1,
        }).format(Math.abs(numValue) > 1 ? numValue / 100 : numValue)
      case 'currency':
        return new Intl.NumberFormat(locale, {
          style: 'currency',
          currency: 'USD',
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }).format(numValue)
      case 'volume':
        return new Intl.NumberFormat(locale, {
          notation: 'compact',
          maximumFractionDigits: 1,
        }).format(numValue)
      default:
        return new Intl.NumberFormat(locale, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }).format(numValue)
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
 * Render a localized card showing financial metric tiles in a 4x4 grid.
 *
 * When `loading` is true displays a localized loading message; when `metrics` is null renders nothing.
 *
 * @param metrics - Financial metrics object whose fields (for example `pe_ttm`, `roe_ttm`, `52_week_high`, `avg_volume_10d`) are displayed in the grid.
 * @param loading - Optional flag that, when true, shows a localized loading state instead of the metrics.
 * @returns The rendered financial metrics card element, or `null` if `metrics` is falsy.
 */
export default function FinancialMetrics({ metrics, loading }: Props) {
  const { language } = useSettings()
  const locale = getLocaleForLanguage(language)

  const tiles: Array<{ id: string; labelKey: Parameters<typeof t>[1]; valueKey: keyof FinancialMetricsType; format?: 'number' | 'percent' | 'currency' | 'date' | 'volume' }> = [
    { id: 'peTtm', labelKey: 'financialMetrics.peTtm', valueKey: 'pe_ttm' },
    { id: 'psTtm', labelKey: 'financialMetrics.psTtm', valueKey: 'ps_ttm' },
    { id: 'pb', labelKey: 'financialMetrics.pb', valueKey: 'pb_annual' },
    { id: 'peAnnual', labelKey: 'financialMetrics.peAnnual', valueKey: 'pe_annual' },
    { id: 'roe', labelKey: 'financialMetrics.roe', valueKey: 'roe_ttm', format: 'percent' },
    { id: 'roa', labelKey: 'financialMetrics.roa', valueKey: 'roa_ttm', format: 'percent' },
    { id: 'netMargin', labelKey: 'financialMetrics.netMargin', valueKey: 'net_margin_ttm', format: 'percent' },
    { id: 'grossMargin', labelKey: 'financialMetrics.grossMargin', valueKey: 'gross_margin_ttm', format: 'percent' },
    { id: 'operatingMargin', labelKey: 'financialMetrics.operatingMargin', valueKey: 'operating_margin_ttm', format: 'percent' },
    { id: 'epsTtm', labelKey: 'financialMetrics.epsTtm', valueKey: 'eps_ttm', format: 'currency' },
    { id: 'bookValuePerShare', labelKey: 'financialMetrics.bookValuePerShare', valueKey: 'book_value_per_share', format: 'currency' },
    { id: 'cashFlowPerShare', labelKey: 'financialMetrics.cashFlowPerShare', valueKey: 'cash_flow_per_share', format: 'currency' },
    { id: 'dividendPercent', labelKey: 'financialMetrics.dividendPercent', valueKey: 'dividend_yield', format: 'percent' },
    { id: 'dividendPerShare', labelKey: 'financialMetrics.dividendPerShare', valueKey: 'dividend_per_share_annual', format: 'currency' },
    { id: 'divGrowth5y', labelKey: 'financialMetrics.divGrowth5y', valueKey: 'dividend_growth_5y', format: 'percent' },
    { id: 'divYieldTtm', labelKey: 'financialMetrics.divYieldTtm', valueKey: 'dividend_yield_ttm', format: 'percent' },
    { id: 'revenueGrowthTtm', labelKey: 'financialMetrics.revenueGrowthTtm', valueKey: 'revenue_growth_ttm', format: 'percent' },
    { id: 'revenueGrowth3y', labelKey: 'financialMetrics.revenueGrowth3y', valueKey: 'revenue_growth_3y', format: 'percent' },
    { id: 'epsGrowthTtm', labelKey: 'financialMetrics.epsGrowthTtm', valueKey: 'eps_growth_ttm', format: 'percent' },
    { id: 'epsGrowth3y', labelKey: 'financialMetrics.epsGrowth3y', valueKey: 'eps_growth_3y', format: 'percent' },
    { id: 'beta', labelKey: 'financialMetrics.beta', valueKey: 'beta' },
    { id: 'high52w', labelKey: 'financialMetrics.high52w', valueKey: '52_week_high', format: 'currency' },
    { id: 'low52w', labelKey: 'financialMetrics.low52w', valueKey: '52_week_low', format: 'currency' },
    { id: 'high52wDate', labelKey: 'financialMetrics.high52wDate', valueKey: '52_week_high_date', format: 'date' },
    { id: 'low52wDate', labelKey: 'financialMetrics.low52wDate', valueKey: '52_week_low_date', format: 'date' },
    { id: 'avgVol10d', labelKey: 'financialMetrics.avgVol10d', valueKey: 'avg_volume_10d', format: 'volume' },
    { id: 'avgVol3m', labelKey: 'financialMetrics.avgVol3m', valueKey: 'avg_volume_3m', format: 'volume' },
  ]

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
        {tiles.map((tile) => (
          <MetricCard
            key={tile.id}
            label={t(language, tile.labelKey)}
            value={metrics[tile.valueKey]}
            format={tile.format}
            locale={locale}
          />
        ))}
        <div />
      </div>
    </div>
  )
}
