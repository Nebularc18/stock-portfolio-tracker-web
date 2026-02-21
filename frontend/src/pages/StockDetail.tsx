import { useState, useEffect } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { api, Stock, Dividend, AnalystData, ManualDividend } from '../services/api'

function formatCurrency(value: number | null, currency: string = 'USD'): string {
  if (value === null) return '-'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(value)
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString()
}

export default function StockDetail() {
  const { ticker } = useParams<{ ticker: string }>()
  const navigate = useNavigate()
  const [stock, setStock] = useState<Stock | null>(null)
  const [dividends, setDividends] = useState<Dividend[]>([])
  const [upcomingDividends, setUpcomingDividends] = useState<Dividend[]>([])
  const [analystData, setAnalystData] = useState<AnalystData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'overview' | 'dividends' | 'analyst'>('overview')
  const [showEditModal, setShowEditModal] = useState(false)
  const [editQuantity, setEditQuantity] = useState('')
  const [editPurchasePrice, setEditPurchasePrice] = useState('')
  const [saving, setSaving] = useState(false)
  const [showDividendModal, setShowDividendModal] = useState(false)
  const [editingDividend, setEditingDividend] = useState<ManualDividend | null>(null)
  const [divDate, setDivDate] = useState('')
  const [divAmount, setDivAmount] = useState('')
  const [divNote, setDivNote] = useState('')

  useEffect(() => {
    if (!ticker) return
    
    const fetchData = async () => {
      try {
        setLoading(true)
        const [stockData, divData, upcomingData, analystInfo] = await Promise.all([
          api.stocks.get(ticker),
          api.stocks.dividends(ticker),
          api.stocks.upcomingDividends(ticker),
          api.stocks.analyst(ticker),
        ])
        setStock(stockData)
        setDividends(divData)
        setUpcomingDividends(upcomingData)
        setAnalystData(analystInfo)
        setError(null)
      } catch (err: any) {
        setError(err.message || 'Failed to load stock data')
      } finally {
        setLoading(false)
      }
    }
    
    fetchData()
  }, [ticker])

  const handleRefresh = async () => {
    if (!ticker) return
    try {
      const updated = await api.stocks.refresh(ticker)
      setStock(updated)
    } catch (err) {
      console.error('Failed to refresh', err)
    }
  }

  const openEditModal = () => {
    if (stock) {
      setEditQuantity(stock.quantity.toString())
      setEditPurchasePrice(stock.purchase_price?.toString() || '')
      setShowEditModal(true)
    }
  }

  const handleSaveEdit = async () => {
    if (!ticker || !stock) return
    try {
      setSaving(true)
      const updated = await api.stocks.update(ticker, {
        quantity: parseFloat(editQuantity) || undefined,
        purchase_price: editPurchasePrice ? parseFloat(editPurchasePrice) : undefined,
      })
      setStock(updated)
      setShowEditModal(false)
    } catch (err) {
      console.error('Failed to save', err)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!ticker || !confirm(`Delete ${ticker} from your portfolio?`)) return
    try {
      await api.stocks.delete(ticker)
      navigate('/stocks')
    } catch (err) {
      console.error('Failed to delete', err)
    }
  }

  const openAddDividendModal = () => {
    setEditingDividend(null)
    setDivDate('')
    setDivAmount('')
    setDivNote('')
    setShowDividendModal(true)
  }

  const openEditDividendModal = (div: ManualDividend) => {
    setEditingDividend(div)
    setDivDate(div.date)
    setDivAmount(div.amount.toString())
    setDivNote(div.note || '')
    setShowDividendModal(true)
  }

  const handleSaveDividend = async () => {
    if (!ticker || !divDate || !divAmount) return
    try {
      setSaving(true)
      if (editingDividend) {
        const updated = await api.stocks.updateManualDividend(ticker, editingDividend.id, {
          date: divDate,
          amount: parseFloat(divAmount),
          note: divNote || undefined,
        })
        setStock(updated)
      } else {
        const updated = await api.stocks.addManualDividend(ticker, {
          date: divDate,
          amount: parseFloat(divAmount),
          currency: stock?.currency,
          note: divNote || undefined,
        })
        setStock(updated)
      }
      setShowDividendModal(false)
    } catch (err) {
      console.error('Failed to save dividend', err)
    } finally {
      setSaving(false)
    }
  }

  const handleDeleteDividend = async (dividendId: string) => {
    if (!ticker || !confirm('Delete this dividend entry?')) return
    try {
      await api.stocks.deleteManualDividend(ticker, dividendId)
      if (stock) {
        setStock({
          ...stock,
          manual_dividends: stock.manual_dividends?.filter(d => d.id !== dividendId) || []
        })
      }
    } catch (err) {
      console.error('Failed to delete dividend', err)
    }
  }

  if (loading) {
    return <div style={{ textAlign: 'center', padding: '40px' }}>Loading...</div>
  }

  if (error || !stock) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: '40px' }}>
        <p style={{ color: 'var(--accent-red)', marginBottom: '16px' }}>{error || 'Stock not found'}</p>
        <Link to="/stocks" className="btn btn-primary">Back to Stocks</Link>
      </div>
    )
  }

  const dailyChange = stock.current_price && stock.previous_close 
    ? stock.current_price - stock.previous_close 
    : null
  const dailyChangePercent = dailyChange && stock.previous_close 
    ? (dailyChange / stock.previous_close) * 100 
    : null

  return (
    <div>
      <div style={{ marginBottom: '24px' }}>
        <Link to="/stocks" style={{ color: 'var(--accent-blue)', textDecoration: 'none' }}>
          ← Back to Stocks
        </Link>
      </div>

      <div className="card" style={{ marginBottom: '24px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h1 style={{ fontSize: '32px', fontWeight: '600', marginBottom: '8px' }}>
              {stock.ticker}
            </h1>
            <p style={{ color: 'var(--text-secondary)', fontSize: '18px' }}>
              {stock.name || 'Unknown Company'}
            </p>
            {stock.sector && (
              <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginTop: '4px' }}>
                {stock.sector}
              </p>
            )}
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button className="btn btn-secondary" onClick={openEditModal}>
              Edit
            </button>
            <button className="btn btn-danger" onClick={handleDelete}>
              Delete
            </button>
            <button className="btn btn-primary" onClick={handleRefresh}>
              Refresh
            </button>
          </div>
        </div>
        
        <div style={{ marginTop: '24px', display: 'flex', gap: '32px', alignItems: 'baseline' }}>
          <div>
            <p style={{ fontSize: '36px', fontWeight: '600' }}>
              {formatCurrency(stock.current_price, stock.currency)}
            </p>
            {dailyChange !== null && (
              <p style={{ 
                color: dailyChange >= 0 ? 'var(--accent-green)' : 'var(--accent-red)',
                fontSize: '16px'
              }}>
                {dailyChange >= 0 ? '+' : ''}{dailyChange.toFixed(2)} ({dailyChangePercent?.toFixed(2)}%)
              </p>
            )}
          </div>
          <p style={{ color: 'var(--text-secondary)' }}>
            {stock.currency}
          </p>
        </div>
      </div>

      <div style={{ marginBottom: '24px', borderBottom: '1px solid var(--border-color)' }}>
        <div style={{ display: 'flex', gap: '24px' }}>
          {(['overview', 'dividends', 'analyst'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              style={{
                padding: '12px 0',
                background: 'none',
                border: 'none',
                color: activeTab === tab ? 'var(--text-primary)' : 'var(--text-secondary)',
                borderBottom: activeTab === tab ? '2px solid var(--accent-blue)' : 'none',
                cursor: 'pointer',
                fontSize: '14px',
                fontWeight: 500,
              }}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {activeTab === 'overview' && (
        <div className="grid grid-2">
          <div className="card">
            <h3 style={{ marginBottom: '16px' }}>Position</h3>
            <table>
              <tbody>
                <tr>
                  <td style={{ color: 'var(--text-secondary)' }}>Quantity</td>
                  <td style={{ textAlign: 'right' }}>{stock.quantity}</td>
                </tr>
                <tr>
                  <td style={{ color: 'var(--text-secondary)' }}>Purchase Price</td>
                  <td style={{ textAlign: 'right' }}>{formatCurrency(stock.purchase_price, stock.currency)}</td>
                </tr>
                <tr>
                  <td style={{ color: 'var(--text-secondary)' }}>Current Value</td>
                  <td style={{ textAlign: 'right' }}>
                    {stock.current_price ? formatCurrency(stock.current_price * stock.quantity, stock.currency) : '-'}
                  </td>
                </tr>
                <tr>
                  <td style={{ color: 'var(--text-secondary)' }}>Total Cost</td>
                  <td style={{ textAlign: 'right' }}>
                    {stock.purchase_price ? formatCurrency(stock.purchase_price * stock.quantity, stock.currency) : '-'}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          
          <div className="card">
            <h3 style={{ marginBottom: '16px' }}>Dividend Info</h3>
            <table>
              <tbody>
                <tr>
                  <td style={{ color: 'var(--text-secondary)' }}>Dividend Yield</td>
                  <td style={{ textAlign: 'right' }}>
                    {stock.dividend_yield ? `${stock.dividend_yield.toFixed(2)}%` : '-'}
                  </td>
                </tr>
                <tr>
                  <td style={{ color: 'var(--text-secondary)' }}>Dividend/Share</td>
                  <td style={{ textAlign: 'right' }}>{formatCurrency(stock.dividend_per_share, stock.currency)}</td>
                </tr>
                <tr>
                  <td style={{ color: 'var(--text-secondary)' }}>Annual Income</td>
                  <td style={{ textAlign: 'right' }}>
                    {stock.dividend_per_share && stock.quantity
                      ? formatCurrency(stock.dividend_per_share * stock.quantity, stock.currency)
                      : '-'}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === 'dividends' && (
        <div>
          <div className="card" style={{ marginBottom: '20px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <h3>Manual Dividends</h3>
              <button className="btn btn-primary" onClick={openAddDividendModal}>
                Add Dividend
              </button>
            </div>
            {stock.manual_dividends && stock.manual_dividends.length > 0 ? (
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Amount</th>
                    <th>Note</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {stock.manual_dividends.map((div) => (
                    <tr key={div.id}>
                      <td>{formatDate(div.date)}</td>
                      <td style={{ color: 'var(--accent-green)' }}>{formatCurrency(div.amount, div.currency)}</td>
                      <td>{div.note || '-'}</td>
                      <td>
                        <div style={{ display: 'flex', gap: '8px' }}>
                          <button 
                            className="btn btn-secondary" 
                            style={{ padding: '4px 8px', fontSize: '12px' }}
                            onClick={() => openEditDividendModal(div)}
                          >
                            Edit
                          </button>
                          <button 
                            className="btn btn-danger" 
                            style={{ padding: '4px 8px', fontSize: '12px' }}
                            onClick={() => handleDeleteDividend(div.id)}
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '20px' }}>
                No manual dividends. Click "Add Dividend" to add one.
              </p>
            )}
          </div>
          
          {upcomingDividends.length > 0 && (
            <div className="card" style={{ marginBottom: '20px' }}>
              <h3 style={{ marginBottom: '16px' }}>Upcoming Dividends</h3>
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Amount</th>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {upcomingDividends.map((div, i) => (
                    <tr key={i}>
                      <td>{formatDate(div.date)}</td>
                      <td>{formatCurrency(div.amount, div.currency || stock.currency)}</td>
                      <td style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>
                        {div.source || 'historical'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          
          <div className="card">
            <h3 style={{ marginBottom: '16px' }}>Dividend History (Last 5 Years)</h3>
            {dividends.length === 0 ? (
              <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '20px' }}>
                No dividend history available
              </p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {dividends.slice(0, 20).map((div, i) => (
                    <tr key={i}>
                      <td>{formatDate(div.date)}</td>
                      <td>{formatCurrency(div.amount, div.currency || stock.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {activeTab === 'analyst' && (
        <div>
          {analystData?.latest_rating && (
            <div className="card" style={{ marginBottom: '20px' }}>
              <h3 style={{ marginBottom: '16px' }}>Latest Rating</h3>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '16px' }}>
                <div>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>Date</p>
                  <p>{analystData.latest_rating.date}</p>
                </div>
                <div>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>Analyst</p>
                  <p>{analystData.latest_rating.analyst}</p>
                </div>
                <div>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>Action</p>
                  <p>{analystData.latest_rating.rating_action}</p>
                </div>
                <div>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>Rating</p>
                  <p style={{ fontWeight: '600' }}>{analystData.latest_rating.rating || '-'}</p>
                </div>
              </div>
            </div>
          )}
          
          {analystData?.price_targets && (
            <div className="card">
              <h3 style={{ marginBottom: '16px' }}>
                {analystData.price_targets.note ? '52-Week Range' : 'Price Targets'}
              </h3>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '16px' }}>
                <div>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>Current</p>
                  <p style={{ fontSize: '20px', fontWeight: '600' }}>
                    {formatCurrency(stock.current_price, stock.currency)}
                  </p>
                </div>
                <div>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>Target (Avg)</p>
                  <p style={{ fontSize: '20px', fontWeight: '600', color: 'var(--accent-green)' }}>
                    {formatCurrency(analystData.price_targets.targetAvg, stock.currency) || '-'}
                  </p>
                </div>
                <div>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>
                    {analystData.price_targets.note ? '52W High' : 'High'}
                  </p>
                  <p style={{ color: analystData.price_targets.note ? 'var(--accent-green)' : undefined }}>
                    {formatCurrency(analystData.price_targets.targetHigh, stock.currency)}
                  </p>
                </div>
                <div>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>
                    {analystData.price_targets.note ? '52W Low' : 'Low'}
                  </p>
                  <p style={{ color: analystData.price_targets.note ? 'var(--accent-red)' : undefined }}>
                    {formatCurrency(analystData.price_targets.targetLow, stock.currency)}
                  </p>
                </div>
              </div>
              {analystData.price_targets.note && (
                <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginTop: '16px' }}>
                  {analystData.price_targets.note}
                </p>
              )}
              {analystData.price_targets.numberOfAnalysts && (
                <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginTop: '16px' }}>
                  Based on {analystData.price_targets.numberOfAnalysts} analysts
                </p>
              )}
            </div>
          )}
          
          {!analystData?.price_targets && (
            <div className="card">
              <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '40px' }}>
                No price data available
              </p>
            </div>
          )}
        </div>
      )}

      {showEditModal && (
        <div 
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0, 0, 0, 0.7)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
          onClick={() => setShowEditModal(false)}
        >
          <div 
            className="card" 
            style={{ width: '400px', maxWidth: '90%' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ marginBottom: '20px' }}>Edit Position</h3>
            <div style={{ marginBottom: '16px' }}>
              <label style={{ display: 'block', marginBottom: '8px', color: 'var(--text-secondary)', fontSize: '14px' }}>
                Quantity
              </label>
              <input
                type="number"
                step="0.01"
                value={editQuantity}
                onChange={(e) => setEditQuantity(e.target.value)}
                style={{ width: '100%' }}
              />
            </div>
            <div style={{ marginBottom: '24px' }}>
              <label style={{ display: 'block', marginBottom: '8px', color: 'var(--text-secondary)', fontSize: '14px' }}>
                Purchase Price ({stock?.currency})
              </label>
              <input
                type="number"
                step="0.01"
                value={editPurchasePrice}
                onChange={(e) => setEditPurchasePrice(e.target.value)}
                style={{ width: '100%' }}
                placeholder="e.g. 150.00"
              />
            </div>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => setShowEditModal(false)}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={handleSaveEdit} disabled={saving}>
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showDividendModal && (
        <div 
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0, 0, 0, 0.7)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
          onClick={() => setShowDividendModal(false)}
        >
          <div 
            className="card" 
            style={{ width: '400px', maxWidth: '90%' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ marginBottom: '20px' }}>
              {editingDividend ? 'Edit Dividend' : 'Add Dividend'}
            </h3>
            <div style={{ marginBottom: '16px' }}>
              <label style={{ display: 'block', marginBottom: '8px', color: 'var(--text-secondary)', fontSize: '14px' }}>
                Date
              </label>
              <input
                type="date"
                value={divDate}
                onChange={(e) => setDivDate(e.target.value)}
                style={{ width: '100%' }}
              />
            </div>
            <div style={{ marginBottom: '16px' }}>
              <label style={{ display: 'block', marginBottom: '8px', color: 'var(--text-secondary)', fontSize: '14px' }}>
                Amount ({stock?.currency})
              </label>
              <input
                type="number"
                step="0.01"
                value={divAmount}
                onChange={(e) => setDivAmount(e.target.value)}
                style={{ width: '100%' }}
                placeholder="e.g. 1.50"
              />
            </div>
            <div style={{ marginBottom: '24px' }}>
              <label style={{ display: 'block', marginBottom: '8px', color: 'var(--text-secondary)', fontSize: '14px' }}>
                Note (optional)
              </label>
              <input
                type="text"
                value={divNote}
                onChange={(e) => setDivNote(e.target.value)}
                style={{ width: '100%' }}
                placeholder="e.g. Q1 2024 dividend"
              />
            </div>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
              <button className="btn btn-secondary" onClick={() => setShowDividendModal(false)}>
                Cancel
              </button>
              <button 
                className="btn btn-primary" 
                onClick={handleSaveDividend} 
                disabled={saving || !divDate || !divAmount}
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
