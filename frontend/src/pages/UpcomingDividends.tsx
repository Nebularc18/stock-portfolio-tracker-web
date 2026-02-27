import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { api, UpcomingDividend } from '../services/api'

function formatCurrency(value: number, currency: string = 'SEK'): string {
  return new Intl.NumberFormat('sv-SE', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(value)
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr)
  return date.toLocaleDateString('sv-SE', { year: 'numeric', month: 'short', day: 'numeric' })
}

function getDaysUntil(dateStr: string): number {
  const target = new Date(dateStr)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  target.setHours(0, 0, 0, 0)
  return Math.ceil((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
}

export default function UpcomingDividends() {
  const [dividends, setDividends] = useState<UpcomingDividend[]>([])
  const [totalExpected, setTotalExpected] = useState(0)
  const [displayCurrency, setDisplayCurrency] = useState('SEK')
  const [unmappedStocks, setUnmappedStocks] = useState<Array<{ ticker: string; name: string | null; reason: string }>>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchData()
  }, [])

  const fetchData = async () => {
    try {
      setLoading(true)
      setError(null)
      const data = await api.portfolio.upcomingDividends()
      setDividends(data.dividends)
      setTotalExpected(data.total_expected)
      setDisplayCurrency(data.display_currency)
      setUnmappedStocks(data.unmapped_stocks)
    } catch (err) {
      console.error('Failed to fetch upcoming dividends:', err)
      setError('Failed to load upcoming dividends')
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return <div style={{ textAlign: 'center', padding: '40px' }}>Loading upcoming dividends...</div>
  }

  if (error) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: '40px' }}>
        <p style={{ color: 'var(--text-secondary)' }}>{error}</p>
        <button onClick={fetchData} style={{ marginTop: '16px' }}>Retry</button>
      </div>
    )
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <h2 style={{ fontSize: '24px', fontWeight: '600' }}>Upcoming Dividends</h2>
        <button onClick={fetchData} style={{ padding: '8px 16px' }}>Refresh</button>
      </div>

      {unmappedStocks.length > 0 && (
        <div className="card" style={{ marginBottom: '24px', borderLeft: '4px solid var(--accent-orange)' }}>
          <h3 style={{ fontSize: '16px', marginBottom: '12px', color: 'var(--accent-orange)' }}>
            Unmapped Swedish Stocks ({unmappedStocks.length})
          </h3>
          <p style={{ fontSize: '14px', color: 'var(--text-secondary)', marginBottom: '12px' }}>
            These Swedish stocks are using Yahoo Finance instead of aktieutdelningar.se. Map them to get better dividend data.
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
            {unmappedStocks.slice(0, 5).map((stock) => (
              <span
                key={stock.ticker}
                style={{
                  padding: '6px 12px',
                  fontSize: '13px',
                  background: 'var(--bg-tertiary)',
                  border: '1px solid var(--border-color)',
                  borderRadius: '4px',
                }}
              >
                {stock.ticker}
              </span>
            ))}
            {unmappedStocks.length > 5 && (
              <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                +{unmappedStocks.length - 5} more
              </span>
            )}
            <Link 
              to="/settings" 
              style={{ 
                marginLeft: '8px',
                fontSize: '14px',
                color: 'var(--accent-blue)',
                textDecoration: 'underline'
              }}
            >
              Map in Settings
            </Link>
          </div>
        </div>
      )}

      {dividends.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '40px' }}>
          <p style={{ color: 'var(--text-secondary)' }}>No upcoming dividends found for your portfolio.</p>
        </div>
      ) : (
        <>
          <div className="card" style={{ marginBottom: '24px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <h3 style={{ fontSize: '16px', color: 'var(--text-secondary)' }}>Total Expected</h3>
                <span style={{ fontSize: '28px', fontWeight: '600', color: 'var(--accent-green)' }}>
                  {formatCurrency(totalExpected, displayCurrency)}
                </span>
              </div>
              <div style={{ textAlign: 'right' }}>
                <h3 style={{ fontSize: '16px', color: 'var(--text-secondary)' }}>Upcoming Payments</h3>
                <span style={{ fontSize: '28px', fontWeight: '600' }}>{dividends.length}</span>
              </div>
            </div>
          </div>

          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>Stock</th>
                  <th>Ex-Date</th>
                  <th>Per Share</th>
                  <th>Quantity</th>
                  <th>Total</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {dividends.map((div, i) => {
                  const daysUntil = getDaysUntil(div.ex_date)
                  const isSoon = daysUntil <= 7 && daysUntil >= 0
                  
                  return (
                    <tr key={`${div.ticker}-${i}`}>
                      <td>
                        <Link to={`/stocks/${div.ticker}`} style={{ color: 'var(--accent-blue)', textDecoration: 'none', fontWeight: '600' }}>
                          {div.ticker}
                        </Link>
                        <span style={{ color: 'var(--text-secondary)', marginLeft: '8px', fontSize: '12px' }}>
                          {div.name}
                        </span>
                      </td>
                      <td>
                        <span style={{ 
                          color: isSoon ? 'var(--accent-orange)' : 'inherit',
                          fontWeight: isSoon ? '600' : 'normal'
                        }}>
                          {formatDate(div.ex_date)}
                        </span>
                        {daysUntil >= 0 && daysUntil <= 30 && (
                          <span style={{ 
                            display: 'block', 
                            fontSize: '11px', 
                            color: 'var(--text-secondary)' 
                          }}>
                            {daysUntil === 0 ? 'Today!' : `In ${daysUntil} day${daysUntil > 1 ? 's' : ''}`}
                          </span>
                        )}
                      </td>
                      <td>{formatCurrency(div.amount_per_share, div.currency)}</td>
                      <td>{div.quantity}</td>
                      <td>
                        <span style={{ color: 'var(--accent-green)', fontWeight: '600' }}>
                          {formatCurrency(div.total_converted || div.total_amount, div.total_converted ? displayCurrency : div.currency)}
                        </span>
                        {div.total_converted && div.currency !== displayCurrency && (
                          <span style={{ display: 'block', fontSize: '11px', color: 'var(--text-secondary)' }}>
                            {formatCurrency(div.total_amount, div.currency)}
                          </span>
                        )}
                      </td>
                      <td>
                        <span style={{
                          padding: '2px 8px',
                          borderRadius: '4px',
                          fontSize: '11px',
                          fontWeight: '600',
                          background: div.source === 'avanza' ? 'var(--accent-green)' : 'var(--accent-blue)',
                          color: 'white'
                        }}>
                          {div.source === 'avanza' ? 'Avanza' : 'Yahoo'}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
