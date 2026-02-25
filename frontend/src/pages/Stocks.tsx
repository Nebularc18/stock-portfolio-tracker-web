import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { api, Stock } from '../services/api'
import { useSettings } from '../SettingsContext'
import { formatTimeInTimezone } from '../utils/time'

function formatCurrency(value: number | null, currency: string = 'USD'): string {
  if (value === null) return '-'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(value)
}

const EXCHANGES = [
  { code: 'ST', name: 'Sweden (Stockholm)', suffix: '.ST', currency: 'SEK' },
  { code: 'US', name: 'USA (NASDAQ/NYSE)', suffix: '', currency: 'USD' },
  { code: 'L', name: 'UK (London)', suffix: '.L', currency: 'GBP' },
  { code: 'DE', name: 'Germany (Xetra)', suffix: '.DE', currency: 'EUR' },
  { code: 'PA', name: 'France (Paris)', suffix: '.PA', currency: 'EUR' },
  { code: 'MI', name: 'Italy (Milan)', suffix: '.MI', currency: 'EUR' },
  { code: 'AM', name: 'Netherlands (Amsterdam)', suffix: '.AM', currency: 'EUR' },
  { code: 'BR', name: 'Belgium (Brussels)', suffix: '.BR', currency: 'EUR' },
  { code: 'TO', name: 'Canada (Toronto)', suffix: '.TO', currency: 'CAD' },
  { code: 'AX', name: 'Australia', suffix: '.AX', currency: 'AUD' },
  { code: 'HK', name: 'Hong Kong', suffix: '.HK', currency: 'HKD' },
  { code: 'T', name: 'Japan (Tokyo)', suffix: '.T', currency: 'JPY' },
  { code: 'KS', name: 'South Korea', suffix: '.KS', currency: 'KRW' },
  { code: 'SW', name: 'Switzerland', suffix: '.SW', currency: 'CHF' },
]

export default function Stocks() {
  const [stocks, setStocks] = useState<Stock[]>([])
  const [loading, setLoading] = useState(true)
  const [showAddForm, setShowAddForm] = useState(false)
  const [newTicker, setNewTicker] = useState('')
  const [newQuantity, setNewQuantity] = useState('')
  const [newPurchasePrice, setNewPurchasePrice] = useState('')
  const [selectedExchange, setSelectedExchange] = useState('ST')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [validationStatus, setValidationStatus] = useState<'idle' | 'checking' | 'valid' | 'invalid'>('idle')
  const [editStock, setEditStock] = useState<Stock | null>(null)
  const [editQuantity, setEditQuantity] = useState('')
  const [editPurchasePrice, setEditPurchasePrice] = useState('')
  const [saving, setSaving] = useState(false)
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)
  const { timezone } = useSettings()

  const fetchStocks = useCallback(async () => {
    try {
      setLoading(true)
      const data = await api.stocks.list()
      setStocks(data)
      setLastUpdate(new Date())
      setError(null)
    } catch (err) {
      setError('Failed to load stocks')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchStocks()
  }, [fetchStocks])

  const getFullTicker = (ticker: string, exchange: string) => {
    const ex = EXCHANGES.find(e => e.code === exchange)
    const suffix = ex?.suffix || ''
    return ticker.toUpperCase() + suffix
  }

  const handleTickerChange = (value: string) => {
    setNewTicker(value.toUpperCase())
    setValidationStatus('idle')
  }

  const handleExchangeChange = (exchange: string) => {
    setSelectedExchange(exchange)
    setValidationStatus('idle')
  }

  const handleAddStock = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newTicker || !newQuantity) return

    const fullTicker = getFullTicker(newTicker, selectedExchange)

    try {
      setAdding(true)
      setError(null)
      await api.stocks.create({
        ticker: fullTicker,
        quantity: parseFloat(newQuantity),
        purchase_price: newPurchasePrice ? parseFloat(newPurchasePrice) : undefined,
      })
      setNewTicker('')
      setNewQuantity('')
      setNewPurchasePrice('')
      setValidationStatus('idle')
      setShowAddForm(false)
      await fetchStocks()
    } catch (err: any) {
      setError(err.message || 'Failed to add stock')
    } finally {
      setAdding(false)
    }
  }

  const handleDeleteStock = async (ticker: string) => {
    if (!confirm(`Remove ${ticker} from portfolio?`)) return
    
    try {
      await api.stocks.delete(ticker)
      await fetchStocks()
    } catch (err) {
      setError('Failed to delete stock')
    }
  }

  const openEditModal = (stock: Stock) => {
    setEditStock(stock)
    setEditQuantity(stock.quantity.toString())
    setEditPurchasePrice(stock.purchase_price?.toString() || '')
  }

  const handleSaveEdit = async () => {
    if (!editStock) return
    try {
      setSaving(true)
      await api.stocks.update(editStock.ticker, {
        quantity: parseFloat(editQuantity) || undefined,
        purchase_price: editPurchasePrice ? parseFloat(editPurchasePrice) : undefined,
      })
      setEditStock(null)
      await fetchStocks()
    } catch (err) {
      setError('Failed to save changes')
    } finally {
      setSaving(false)
    }
  }

  const selectedExchangeData = EXCHANGES.find(e => e.code === selectedExchange)

  if (loading) {
    return <div style={{ textAlign: 'center', padding: '40px' }}>Loading...</div>
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
        <div>
          <h2 style={{ fontSize: '24px', fontWeight: '600' }}>Stocks</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginTop: '4px' }}>
            Last updated: {formatTimeInTimezone(lastUpdate, timezone)} · Auto-refresh every 10 min
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowAddForm(!showAddForm)}>
          {showAddForm ? 'Cancel' : 'Add Stock'}
        </button>
      </div>

      {error && (
        <div className="card" style={{ background: 'rgba(248, 81, 73, 0.1)', marginBottom: '20px' }}>
          <p style={{ color: 'var(--accent-red)' }}>{error}</p>
        </div>
      )}

      {showAddForm && (
        <div className="card" style={{ marginBottom: '20px' }}>
          <h3 style={{ marginBottom: '16px' }}>Add New Stock</h3>
          <form onSubmit={handleAddStock}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '16px' }}>
              <div>
                <label style={{ display: 'block', marginBottom: '8px', color: 'var(--text-secondary)', fontSize: '12px' }}>
                  Exchange
                </label>
                <select
                  value={selectedExchange}
                  onChange={(e) => handleExchangeChange(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '10px 14px',
                    border: '1px solid var(--border-color)',
                    borderRadius: '6px',
                    background: 'var(--bg-tertiary)',
                    color: 'var(--text-primary)',
                    fontSize: '14px',
                  }}
                >
                  {EXCHANGES.map((ex) => (
                    <option key={ex.code} value={ex.code}>
                      {ex.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: '8px', color: 'var(--text-secondary)', fontSize: '12px' }}>
                  Ticker Symbol
                </label>
                <input
                  type="text"
                  value={newTicker}
                  onChange={(e) => handleTickerChange(e.target.value)}
                  placeholder={selectedExchange === 'US' ? 'AAPL' : 'INVE-B'}
                  style={{ 
                    width: '100%',
                    borderColor: validationStatus === 'valid' ? 'var(--accent-green)' : 
                                 validationStatus === 'invalid' ? 'var(--accent-red)' : undefined
                  }}
                  required
                />
                {newTicker && (
                  <p style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                    Full: {getFullTicker(newTicker, selectedExchange)}
                  </p>
                )}
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: '8px', color: 'var(--text-secondary)', fontSize: '12px' }}>
                  Quantity
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={newQuantity}
                  onChange={(e) => setNewQuantity(e.target.value)}
                  placeholder="10"
                  style={{ width: '100%' }}
                  required
                />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: '8px', color: 'var(--text-secondary)', fontSize: '12px' }}>
                  Purchase Price ({selectedExchangeData?.currency})
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={newPurchasePrice}
                  onChange={(e) => setNewPurchasePrice(e.target.value)}
                  placeholder="150.00"
                  style={{ width: '100%' }}
                />
              </div>
              <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                <button 
                  type="submit" 
                  className="btn btn-primary" 
                  style={{ width: '100%' }} 
                  disabled={adding}
                >
                  {adding ? 'Adding...' : 'Add'}
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      <div className="card">
        {!stocks.length ? (
          <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '40px' }}>
            No stocks in portfolio. Click "Add Stock" to get started.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Ticker</th>
                <th>Name</th>
                <th>Qty</th>
                <th>Curr</th>
                <th>Purchase</th>
                <th>Price</th>
                <th>Change</th>
                <th>Div Yield</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {stocks.map((stock) => {
                const dailyChange = stock.current_price && stock.previous_close 
                  ? stock.current_price - stock.previous_close 
                  : null
                const dailyChangePercent = dailyChange && stock.previous_close 
                  ? (dailyChange / stock.previous_close) * 100 
                  : null
                
                return (
                  <tr key={stock.id}>
                    <td>
                      <Link 
                        to={`/stocks/${stock.ticker}`} 
                        style={{ color: 'var(--accent-blue)', textDecoration: 'none', fontWeight: '600' }}
                      >
                        {stock.ticker}
                      </Link>
                    </td>
                    <td>{stock.name || '-'}</td>
                    <td>{stock.quantity}</td>
                    <td>{stock.currency}</td>
                    <td>{formatCurrency(stock.purchase_price, stock.currency)}</td>
                    <td>{formatCurrency(stock.current_price, stock.currency)}</td>
                    <td className={dailyChange && dailyChange >= 0 ? 'positive' : 'negative'}>
                      {dailyChangePercent !== null ? `${dailyChangePercent >= 0 ? '+' : ''}${dailyChangePercent.toFixed(2)}%` : '-'}
                    </td>
                    <td>{stock.dividend_yield ? `${stock.dividend_yield.toFixed(2)}%` : '-'}</td>
                    <td>
                       <div style={{ display: 'flex', gap: '8px' }}>
                         <button 
                           className="btn btn-secondary" 
                           style={{ padding: '6px 12px', fontSize: '12px' }}
                           onClick={() => openEditModal(stock)}
                         >
                           Edit
                         </button>
                         <button 
                           className="btn btn-danger" 
                           style={{ padding: '6px 12px', fontSize: '12px' }}
                           onClick={() => handleDeleteStock(stock.ticker)}
                         >
                           Delete
                         </button>
                       </div>
                     </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
         )}
       </div>

       {editStock && (
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
           onClick={() => setEditStock(null)}
         >
           <div 
             className="card" 
             style={{ width: '400px', maxWidth: '90%' }}
             onClick={(e) => e.stopPropagation()}
           >
             <h3 style={{ marginBottom: '20px' }}>Edit {editStock.ticker}</h3>
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
                 Purchase Price ({editStock.currency})
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
               <button className="btn btn-secondary" onClick={() => setEditStock(null)}>
                 Cancel
               </button>
               <button className="btn btn-primary" onClick={handleSaveEdit} disabled={saving}>
                 {saving ? 'Saving...' : 'Save'}
               </button>
             </div>
           </div>
         </div>
       )}
     </div>
   )
 }
