import { useState, useEffect, useCallback } from 'react'
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts'
import { api } from '../services/api'
import { useSettings } from '../SettingsContext'

const COLORS = ['#6366f1', '#ec4899', '#ef4444', '#f97316', '#22c55e', '#3b82f6', '#a855f7', '#f43f5e']

/**
 * Formats a numeric value as an en-US currency string with two decimal places.
 *
 * @param value - Numeric amount to format
 * @param currency - ISO 4217 currency code to use (defaults to 'USD')
 * @returns The formatted currency string (for example, "$1,234.56")
 */
function formatCurrency(value: number, currency: string = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(value)
}

interface Distribution {
  by_sector: Record<string, number>
  by_currency: Record<string, number>
  by_stock: Record<string, number>
}

/**
 * Render the Analytics page that visualizes portfolio and sector distributions with pie charts.
 *
 * Fetches portfolio distribution on mount and when the Retry button is used; shows a loading
 * indicator while fetching, an error card with a retry action on failure, and a fallback message
 * when no distribution data is available. Chart labels are omitted for slices smaller than 5%,
 * and tooltip values are formatted according to the current display currency.
 *
 * @returns The Analytics page UI as a React element containing charts, loading/error states, or an empty-data message.
 */
export default function Analytics() {
  const [distribution, setDistribution] = useState<Distribution | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const { displayCurrency } = useSettings()

  const fetchData = useCallback(async () => {
    try {
      setLoading(true)
      const distributionData = await api.portfolio.distribution()
      setDistribution(distributionData)
      setError(null)
    } catch (err) {
      setError('Failed to load analytics data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const sectorData = distribution?.by_sector 
    ? Object.entries(distribution.by_sector).map(([name, value]) => ({ name, value }))
    : []
  
  const stockData = distribution?.by_stock
    ? Object.entries(distribution.by_stock).map(([name, value]) => ({ name, value }))
    : []

  const currency = displayCurrency

  const renderPieLabel = ({ name, percent }: { name: string; percent: number }) => {
    if (percent < 0.05) return null
    return `${name} (${(percent * 100).toFixed(0)}%)`
  }

  if (loading) {
    return <div style={{ textAlign: 'center', padding: '40px' }}>Loading...</div>
  }

  if (error) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: '40px' }}>
        <p style={{ color: 'var(--accent-red)', marginBottom: '16px' }}>{error}</p>
        <button className="btn btn-primary" onClick={fetchData}>Retry</button>
      </div>
    )
  }

  return (
    <div>
      <div style={{ marginBottom: '24px' }}>
        <h2 style={{ fontSize: '24px', fontWeight: '600' }}>Analytics</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginTop: '4px' }}>
          Portfolio distribution Overview
        </p>
      </div>

      {(sectorData.length > 0 || stockData.length > 0) ? (
        <div className="grid grid-2">
          {stockData.length > 0 && (
            <div className="card">
              <h3 style={{ marginBottom: '16px' }}>Portfolio Distribution</h3>
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
                      formatter={(value: number) => formatCurrency(value, currency)}
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
              <h3 style={{ marginBottom: '16px' }}>Sector Distribution</h3>
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
                      formatter={(value: number) => formatCurrency(value, currency)}
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
        </div>
      ) : (
        <div className="card" style={{ textAlign: 'center', padding: '40px' }}>
          <p style={{ color: 'var(--text-secondary)' }}>No portfolio data available. Add stocks to see analytics.</p>
        </div>
      )}
    </div>
  )
}
