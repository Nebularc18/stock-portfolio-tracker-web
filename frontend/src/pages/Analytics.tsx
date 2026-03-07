import { useState, useEffect, useCallback } from 'react'
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, BarChart, Bar, XAxis, YAxis, CartesianGrid, Legend } from 'recharts'
import { api, Stock } from '../services/api'
import { useSettings } from '../SettingsContext'
import { getLocaleForLanguage, t } from '../i18n'

const COLORS = ['#6366f1', '#ec4899', '#ef4444', '#f97316', '#22c55e', '#3b82f6', '#a855f7', '#f43f5e']

/**
 * Format a number as a currency string using the specified locale and currency.
 *
 * @param value - The numeric amount to format
 * @param locale - BCP 47 locale tag to use for formatting (e.g., "en-US")
 * @param currency - ISO 4217 currency code to display (defaults to 'USD')
 * @returns The formatted currency string (for example, "$1,234.56")
 */
function formatCurrency(value: number, locale: string, currency: string = 'USD'): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(value)
}

interface Distribution {
  display_currency: string
  by_sector: Record<string, number>
  by_country: Record<string, number>
  by_currency: Record<string, number>
  by_stock: Record<string, number>
}

/**
 * Render the Analytics page showing portfolio and sector distributions using pie charts.
 *
 * Displays locale- and currency-aware tooltips and manages loading, error (with retry), and empty-data states.
 *
 * @returns A React element that renders distribution charts, a centered loading indicator, an error card with a retry action, or an empty-data message.
 */
export default function Analytics() {
  const [distribution, setDistribution] = useState<Distribution | null>(null)
  const [stocks, setStocks] = useState<Stock[]>([])
  const [dividendComparisonData, setDividendComparisonData] = useState<Array<Record<string, number | string>>>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const { displayCurrency, language } = useSettings()
  const locale = getLocaleForLanguage(language)
  const chartCurrency = distribution?.display_currency || displayCurrency

  const fetchData = useCallback(async () => {
    try {
      setLoading(true)
      const [distributionData, stocksData] = await Promise.all([
        api.portfolio.distribution(),
        api.stocks.list(),
      ])
      setDistribution(distributionData)
      setStocks(stocksData)

      const now = new Date()
      const currentYear = now.getUTCFullYear()
      const previousYear = currentYear - 1
      const monthTotals = Array.from({ length: 12 }, (_, monthIndex) => ({
        month: new Date(Date.UTC(2000, monthIndex, 1)).toLocaleDateString(locale, { month: 'long', timeZone: 'UTC' }),
        [String(previousYear)]: 0,
        [String(currentYear)]: 0,
      }))

      const dividendResults = await Promise.all(
        stocksData.map(async (stock) => ({
          stock,
          dividends: await api.stocks.dividends(stock.ticker, 2).catch(() => []),
        }))
      )

      for (const { stock, dividends } of dividendResults) {
        for (const div of dividends) {
          if (stock.purchase_date && div.date < stock.purchase_date) continue
          const year = Number(div.date.slice(0, 4))
          const monthIndex = Number(div.date.slice(5, 7)) - 1
          if (!Number.isFinite(year) || monthIndex < 0 || monthIndex > 11) continue
          if (year !== previousYear && year !== currentYear) continue
          monthTotals[monthIndex][String(year)] = Number(monthTotals[monthIndex][String(year)] || 0) + ((div.amount || 0) * stock.quantity)
        }
      }

      setDividendComparisonData(monthTotals)
      setError(null)
    } catch (err) {
      console.error('Failed to load analytics data:', err)
      setError(t(language, 'analytics.failedLoad'))
    } finally {
      setLoading(false)
    }
  }, [language])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const sectorData = distribution?.by_sector 
    ? Object.entries(distribution.by_sector).map(([name, value]) => ({ name, value }))
    : []

  const countryData = distribution?.by_country
    ? Object.entries(distribution.by_country).map(([name, value]) => ({ name, value }))
    : []
  
  const stockData = distribution?.by_stock
    ? Object.entries(distribution.by_stock).map(([name, value]) => ({ name, value }))
    : []

  const renderPieLabel = ({ name, percent }: { name: string; percent: number }) => {
    if (percent < 0.05) return null
    return `${name} (${(percent * 100).toFixed(0)}%)`
  }

  if (loading) {
    return <div style={{ textAlign: 'center', padding: '40px' }}>{t(language, 'common.loading')}</div>
  }

  if (error) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: '40px' }}>
        <p style={{ color: 'var(--accent-red)', marginBottom: '16px' }}>{error}</p>
        <button className="btn btn-primary" onClick={fetchData}>{t(language, 'common.retry')}</button>
      </div>
    )
  }

  return (
    <div>
      <div style={{ marginBottom: '24px' }}>
        <h2 style={{ fontSize: '24px', fontWeight: '600' }}>{t(language, 'analytics.title')}</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginTop: '4px' }}>
          {t(language, 'analytics.overview')}
        </p>
      </div>

      {(sectorData.length > 0 || stockData.length > 0 || countryData.length > 0) ? (
        <div className="grid grid-2">
          {stockData.length > 0 && (
            <div className="card">
              <h3 style={{ marginBottom: '16px' }}>{t(language, 'analytics.portfolioDistribution')}</h3>
              <div style={{ height: 280 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={stockData}
                      cx="50%"
                      cy="50%"
                      labelLine={false}
                      label={renderPieLabel}
                      outerRadius={100}
                      fill="#8884d8"
                      dataKey="value"
                    >
                      {stockData.map((_, index) => (
                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip 
                      formatter={(value: number) => formatCurrency(value, locale, chartCurrency)}
                      contentStyle={{ 
                        background: '#2a2a2a', 
                        border: '1px solid #444', 
                        borderRadius: '8px',
                        color: '#fff'
                      }}
                      itemStyle={{ color: '#fff' }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
          
          {sectorData.length > 0 && (
            <div className="card">
              <h3 style={{ marginBottom: '16px' }}>{t(language, 'analytics.sectorDistribution')}</h3>
              <div style={{ height: 280 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={sectorData}
                      cx="50%"
                      cy="50%"
                      labelLine={false}
                      label={renderPieLabel}
                      outerRadius={100}
                      fill="#8884d8"
                      dataKey="value"
                    >
                      {sectorData.map((_, index) => (
                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip 
                      formatter={(value: number) => formatCurrency(value, locale, chartCurrency)}
                      contentStyle={{ 
                        background: '#2a2a2a', 
                        border: '1px solid #444', 
                        borderRadius: '8px',
                        color: '#fff'
                      }}
                      itemStyle={{ color: '#fff' }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {countryData.length > 0 && (
            <div className="card">
              <h3 style={{ marginBottom: '16px' }}>{t(language, 'analytics.countryDistribution')}</h3>
              <div style={{ height: 280 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={countryData}
                      cx="50%"
                      cy="50%"
                      labelLine={false}
                      label={renderPieLabel}
                      outerRadius={100}
                      fill="#8884d8"
                      dataKey="value"
                    >
                      {countryData.map((_, index) => (
                        <Cell key={`country-cell-${index}`} fill={COLORS[index % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip 
                      formatter={(value: number) => formatCurrency(value, locale, chartCurrency)}
                      contentStyle={{ 
                        background: '#2a2a2a', 
                        border: '1px solid #444', 
                        borderRadius: '8px',
                        color: '#fff'
                      }}
                      itemStyle={{ color: '#fff' }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {dividendComparisonData.length > 0 && (
            <div className="card" style={{ gridColumn: '1 / -1' }}>
              <h3 style={{ marginBottom: '16px' }}>{t(language, 'analytics.dividendComparison')}</h3>
              <div style={{ height: 320 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={dividendComparisonData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" vertical={true} />
                    <XAxis dataKey="month" stroke="#888" fontSize={12} />
                    <YAxis stroke="#888" fontSize={12} />
                    <Tooltip
                      formatter={(value: number) => formatCurrency(value, locale, chartCurrency)}
                      contentStyle={{
                        background: '#111827',
                        border: '1px solid #374151',
                        borderRadius: '10px',
                        color: '#fff'
                      }}
                      itemStyle={{ color: '#fff' }}
                    />
                    <Legend />
                    <Bar dataKey={String(new Date().getUTCFullYear() - 1)} fill="#8b5cf6" radius={[6, 6, 0, 0]} />
                    <Bar dataKey={String(new Date().getUTCFullYear())} fill="#c084fc" radius={[6, 6, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="card" style={{ textAlign: 'center', padding: '40px' }}>
          <p style={{ color: 'var(--text-secondary)' }}>{t(language, 'analytics.noData')}</p>
        </div>
      )}
    </div>
  )
}
