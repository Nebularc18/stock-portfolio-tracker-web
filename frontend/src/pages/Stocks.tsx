import { useState, useEffect, useCallback, useRef, useId } from 'react'
import { Link } from 'react-router-dom'
import { api, Stock } from '../services/api'
import { useSettings } from '../SettingsContext'
import { formatTimeInTimezone, getLatestTimestamp } from '../utils/time'
import { resolveBackendAssetUrl } from '../utils/assets'
import { getLocaleForLanguage, t } from '../i18n'
import supportedExchanges from '../config/supportedExchanges.json'
import { useModalFocusTrap } from '../hooks/useModalFocusTrap'

/**
 * Formats a numeric value as a localized currency string or returns "-" when the value is null.
 *
 * @param value - Numeric amount to format; pass `null` to indicate missing value
 * @param locale - BCP 47 language tag used for localization (e.g., `"en-US"`)
 * @param currency - ISO 4217 currency code to format with (defaults to `"USD"`)
 * @returns The formatted currency string for `value`, or `"-"` if `value` is `null`
 */
function formatCurrency(value: number | null, locale: string, currency: string = 'USD'): string {
  if (value === null) return '-'
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(value)
}

function formatPurchaseDate(value: string | null, locale: string): string {
  if (!value) return '-'
  const [year, month, day] = value.split('-').map(Number)
  if (!year || !month || !day) return value
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })
}

const EXCHANGES = [
  ...supportedExchanges,
]

function getLocalDateInputValue(value: Date = new Date()): string {
  const year = value.getFullYear()
  const month = `${value.getMonth() + 1}`.padStart(2, '0')
  const day = `${value.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Display and manage the user's stock positions with controls to view, add, edit, and remove entries localized to the current language and timezone.
 *
 * Loads the user's stocks on mount, shows current prices and daily changes, and allows recording or updating a purchase price and purchase date for each position.
 *
 * @returns A React element containing the Stocks management user interface.
 */
 export default function Stocks() {
  const [stocks, setStocks] = useState<Stock[]>([])
  const [loading, setLoading] = useState(true)
  const [showAddForm, setShowAddForm] = useState(false)
  const [newTicker, setNewTicker] = useState('')
  const [newQuantity, setNewQuantity] = useState('')
  const [newPurchasePrice, setNewPurchasePrice] = useState('')
  const [newPurchaseDate, setNewPurchaseDate] = useState('')
  const [selectedExchange, setSelectedExchange] = useState('ST')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [validationStatus, setValidationStatus] = useState<'idle' | 'checking' | 'valid' | 'invalid'>('idle')
  const [editStock, setEditStock] = useState<Stock | null>(null)
  const [editQuantity, setEditQuantity] = useState('')
  const [editPurchasePrice, setEditPurchasePrice] = useState('')
  const [editPurchaseDate, setEditPurchaseDate] = useState('')
  const [saving, setSaving] = useState(false)
  const [lastUpdate, setLastUpdate] = useState<string | null>(null)
  const [failedLogos, setFailedLogos] = useState<Record<string, boolean>>({})
  const editModalRef = useRef<HTMLDivElement | null>(null)
  const editQuantityInputRef = useRef<HTMLInputElement | null>(null)
  const editModalHeadingId = useId()
  const editQuantityInputId = useId()
  const editPurchasePriceInputId = useId()
  const editPurchaseDateInputId = useId()
  const { timezone, language } = useSettings()
  const locale = getLocaleForLanguage(language)
  const maxPurchaseDate = getLocalDateInputValue()

  const closeEditModal = useCallback(() => setEditStock(null), [])

  useModalFocusTrap({
    modalRef: editModalRef,
    open: editStock !== null,
    onClose: closeEditModal,
    initialFocusRef: editQuantityInputRef,
  })

  const fetchStocks = useCallback(async () => {
    try {
      setLoading(true)
      const data = await api.stocks.list()
      setStocks(data)
      setFailedLogos({})
      setLastUpdate(getLatestTimestamp(data))
      setError(null)
    } catch (err) {
      setError(t(language, 'stocks.failedLoad'))
    } finally {
      setLoading(false)
    }
  }, [language])

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
        purchase_date: newPurchaseDate || undefined,
      })
      setNewTicker('')
      setNewQuantity('')
      setNewPurchasePrice('')
      setNewPurchaseDate('')
      setValidationStatus('idle')
      setShowAddForm(false)
      await fetchStocks()
    } catch (err: any) {
      setError(err.message || t(language, 'stocks.failedAdd'))
    } finally {
      setAdding(false)
    }
  }

  const handleDeleteStock = async (ticker: string) => {
    if (!confirm(t(language, 'stocks.removeConfirm', { ticker }))) return
    
    try {
      await api.stocks.delete(ticker)
      await fetchStocks()
    } catch (err) {
      setError(t(language, 'stocks.failedDelete'))
    }
  }

  const openEditModal = (stock: Stock) => {
    setEditStock(stock)
    setEditQuantity(stock.quantity.toString())
    setEditPurchasePrice(stock.purchase_price?.toString() || '')
    setEditPurchaseDate(stock.purchase_date || '')
  }

  const handleSaveEdit = async () => {
    if (!editStock) return
    try {
      setSaving(true)
      const parsedQuantity = parseFloat(editQuantity)
      const quantity = editQuantity.trim() === '' || Number.isNaN(parsedQuantity)
        ? undefined
        : parsedQuantity

      await api.stocks.update(editStock.ticker, {
        quantity,
        purchase_price: editPurchasePrice ? parseFloat(editPurchasePrice) : undefined,
        purchase_date: editPurchaseDate === '' ? null : editPurchaseDate,
      })
      setEditStock(null)
      await fetchStocks()
    } catch (err) {
      setError(t(language, 'stocks.failedSave'))
    } finally {
      setSaving(false)
    }
  }

  const selectedExchangeData = EXCHANGES.find(e => e.code === selectedExchange)

  if (loading) {
    return <div className="loading-state">{t(language, 'common.loading')}</div>
  }

  return (
    <div>
      {/* ── HERO HEADER ── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr auto',
        alignItems: 'center',
        borderBottom: '1px solid var(--border)',
        padding: '26px 28px',
        background: 'linear-gradient(115deg, #12141c 0%, var(--bg) 55%)',
        gap: 20,
      }}>
        <div>
          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6 }}>
            {t(language, 'common.lastUpdated')}: {formatTimeInTimezone(lastUpdate, timezone, locale)} · {t(language, 'common.autoRefresh10m')}
          </div>
          <h2 style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em' }}>{t(language, 'stocks.title')}</h2>
        </div>
        <button className="btn btn-primary" onClick={() => setShowAddForm(!showAddForm)}>
          {showAddForm ? t(language, 'stocks.cancel') : t(language, 'stocks.addStock')}
        </button>
      </div>

      <div style={{ padding: '0 28px 28px' }}>

        {error && (
          <div style={{ marginTop: 16, padding: '10px 16px', background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)', borderRadius: 6 }}>
            <p style={{ color: 'var(--red)', margin: 0, fontSize: 13 }}>{error}</p>
          </div>
        )}

        {/* ── ADD FORM ── */}
        {showAddForm && (
          <div style={{ marginTop: 20, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8 }}>
            <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--border)' }}>
              <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--v2)' }}>
                {t(language, 'stocks.addNewStock')}
              </span>
            </div>
            <form onSubmit={handleAddStock} style={{ padding: '18px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 16 }}>
                <div>
                  <label style={{ display: 'block', marginBottom: 6, color: 'var(--muted)', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                    {t(language, 'stocks.exchange')}
                  </label>
                  <select value={selectedExchange} onChange={(e) => handleExchangeChange(e.target.value)}>
                    {EXCHANGES.map((ex) => (
                      <option key={ex.code} value={ex.code}>{ex.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label style={{ display: 'block', marginBottom: 6, color: 'var(--muted)', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                    {t(language, 'stocks.tickerSymbol')}
                  </label>
                  <input
                    type="text"
                    value={newTicker}
                    onChange={(e) => handleTickerChange(e.target.value)}
                    placeholder={selectedExchange === 'US' ? 'AAPL' : 'INVE-B'}
                    style={{
                      borderColor: validationStatus === 'valid' ? 'var(--green)' :
                                   validationStatus === 'invalid' ? 'var(--red)' : undefined
                    }}
                    required
                  />
                  {newTicker && (
                    <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4, fontFamily: "'Fira Code', monospace" }}>
                      {t(language, 'stocks.full')}: {getFullTicker(newTicker, selectedExchange)}
                    </p>
                  )}
                </div>
                <div>
                  <label style={{ display: 'block', marginBottom: 6, color: 'var(--muted)', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                    {t(language, 'stocks.quantity')}
                  </label>
                  <input
                    type="number" step="0.01" min="0"
                    value={newQuantity}
                    onChange={(e) => setNewQuantity(e.target.value)}
                    placeholder={t(language, 'stocks.placeholderQuantity')}
                    required
                  />
                </div>
                <div>
                  <label style={{ display: 'block', marginBottom: 6, color: 'var(--muted)', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                    {t(language, 'stocks.purchasePrice')} ({selectedExchangeData?.currency})
                  </label>
                  <input
                    type="number" step="0.01" min="0"
                    value={newPurchasePrice}
                    onChange={(e) => setNewPurchasePrice(e.target.value)}
                    placeholder={t(language, 'stocks.placeholderPrice')}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', marginBottom: 6, color: 'var(--muted)', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                    {t(language, 'stocks.purchaseDate')}
                  </label>
                  <input
                    type="date"
                    value={newPurchaseDate}
                    onChange={(e) => setNewPurchaseDate(e.target.value)}
                    max={maxPurchaseDate}
                  />
                </div>
                <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                  <button type="submit" className="btn btn-primary" style={{ width: '100%' }} disabled={adding}>
                    {adding ? t(language, 'stocks.adding') : t(language, 'stocks.add')}
                  </button>
                </div>
              </div>
            </form>
          </div>
        )}

        {/* ── HOLDINGS TABLE ── */}
        <div style={{ marginTop: 20, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8 }}>
          <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--border)' }}>
            <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--muted)' }}>
              {t(language, 'stocks.title')}
            </span>
          </div>
          {!stocks.length ? (
            <div className="empty-state" style={{ padding: '40px' }}>{t(language, 'stocks.noStocksMessage')}</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>{t(language, 'stocks.tableTicker')}</th>
                  <th>{t(language, 'stocks.tableName')}</th>
                  <th>{t(language, 'stocks.tableQty')}</th>
                  <th>{t(language, 'stocks.tableCurr')}</th>
                  <th style={{ textAlign: 'right' }}>{t(language, 'stocks.tablePurchase')}</th>
                  <th>{t(language, 'stocks.purchaseDate')}</th>
                  <th style={{ textAlign: 'right' }}>{t(language, 'stocks.tablePrice')}</th>
                  <th style={{ textAlign: 'right' }}>{t(language, 'stocks.tableChange')}</th>
                  <th style={{ textAlign: 'right' }}>{t(language, 'stocks.tableDivYield')}</th>
                  <th>{t(language, 'stocks.tableActions')}</th>
                </tr>
              </thead>
              <tbody>
                {stocks.map((stock) => {
                  const logoUrl = resolveBackendAssetUrl(stock.logo)
                  const dailyChange = stock.current_price !== null && stock.previous_close !== null
                    ? stock.current_price - stock.previous_close
                    : null
                  const dailyChangePercent = dailyChange !== null && stock.previous_close !== null && stock.previous_close !== 0
                    ? (dailyChange / stock.previous_close) * 100
                    : null

                  return (
                    <tr key={stock.id}>
                      <td>
                        <Link
                          to={`/stocks/${encodeURIComponent(stock.ticker)}`}
                          style={{ color: 'var(--v2)', textDecoration: 'none', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}
                        >
                          {logoUrl && !failedLogos[stock.ticker] ? (
                            <img
                              src={logoUrl}
                              alt={stock.name || stock.ticker}
                              style={{ width: 22, height: 22, borderRadius: 4, objectFit: 'contain', background: 'var(--bg3)', padding: 2 }}
                              onError={() => setFailedLogos((prev) => ({ ...prev, [stock.ticker]: true }))}
                            />
                          ) : (
                            <span style={{
                              width: 22, height: 22, borderRadius: 4,
                              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                              fontSize: 11, fontWeight: 700, color: 'var(--muted)', background: 'var(--bg3)',
                            }}>
                              {(stock.name || stock.ticker || '?').charAt(0).toUpperCase()}
                            </span>
                          )}
                          <span style={{ fontFamily: "'Fira Code', monospace" }}>{stock.ticker}</span>
                        </Link>
                      </td>
                      <td style={{ color: 'var(--text2)' }}>{stock.name || '-'}</td>
                      <td style={{ fontFamily: "'Fira Code', monospace" }}>{stock.quantity}</td>
                      <td><span className="badge badge-muted">{stock.currency}</span></td>
                      <td style={{ fontFamily: "'Fira Code', monospace", textAlign: 'right' }}>{formatCurrency(stock.purchase_price, locale, stock.currency)}</td>
                      <td style={{ fontFamily: "'Fira Code', monospace", color: 'var(--muted)' }}>{formatPurchaseDate(stock.purchase_date, locale)}</td>
                      <td style={{ fontFamily: "'Fira Code', monospace", textAlign: 'right' }}>{formatCurrency(stock.current_price, locale, stock.currency)}</td>
                      <td className={dailyChange !== null ? (dailyChange >= 0 ? 'positive' : 'negative') : ''} style={{ fontFamily: "'Fira Code', monospace", textAlign: 'right' }}>
                        {dailyChangePercent !== null ? `${dailyChangePercent >= 0 ? '+' : ''}${dailyChangePercent.toFixed(2)}%` : '-'}
                      </td>
                      <td style={{ fontFamily: "'Fira Code', monospace", textAlign: 'right' }}>
                        {stock.dividend_yield !== null ? `${stock.dividend_yield.toFixed(2)}%` : '-'}
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button
                            className="btn btn-secondary"
                            style={{ padding: '4px 10px', fontSize: 11 }}
                            onClick={() => openEditModal(stock)}
                          >
                            {t(language, 'stocks.edit')}
                          </button>
                          <button
                            className="btn btn-danger"
                            style={{ padding: '4px 10px', fontSize: 11 }}
                            onClick={() => handleDeleteStock(stock.ticker)}
                          >
                            {t(language, 'stocks.delete')}
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
      </div>

      {/* ── EDIT MODAL ── */}
      {editStock && (
        <div
          style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
          }}
          onClick={() => setEditStock(null)}
        >
          <div
            ref={editModalRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={editModalHeadingId}
            tabIndex={-1}
            style={{ width: 420, maxWidth: '90%', background: 'var(--bg2)', border: '1px solid var(--border2)', borderRadius: 10, overflow: 'hidden' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span id={editModalHeadingId} style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--v2)' }}>
                {t(language, 'stocks.editTitle', { ticker: editStock.ticker })}
              </span>
              <button type="button" aria-label="Close" style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 18, lineHeight: 1 }} onClick={() => setEditStock(null)}>×</button>
            </div>
            <div style={{ padding: '20px' }}>
              <div style={{ marginBottom: 16 }}>
                <label htmlFor={editQuantityInputId} style={{ display: 'block', marginBottom: 6, color: 'var(--muted)', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                  {t(language, 'stocks.quantity')}
                </label>
                <input id={editQuantityInputId} ref={editQuantityInputRef} type="number" step="0.01" min="0" value={editQuantity} onChange={(e) => setEditQuantity(e.target.value)} style={{ width: '100%' }} />
              </div>
              <div style={{ marginBottom: 16 }}>
                <label htmlFor={editPurchasePriceInputId} style={{ display: 'block', marginBottom: 6, color: 'var(--muted)', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                  {t(language, 'stocks.purchasePrice')} ({editStock.currency})
                </label>
                <input id={editPurchasePriceInputId} type="number" step="0.01" min="0" value={editPurchasePrice} onChange={(e) => setEditPurchasePrice(e.target.value)} placeholder={t(language, 'stocks.placeholderPrice')} style={{ width: '100%' }} />
              </div>
              <div style={{ marginBottom: 24 }}>
                <label htmlFor={editPurchaseDateInputId} style={{ display: 'block', marginBottom: 6, color: 'var(--muted)', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                  {t(language, 'stocks.purchaseDate')}
                </label>
                <input id={editPurchaseDateInputId} type="date" value={editPurchaseDate} onChange={(e) => setEditPurchaseDate(e.target.value)} max={maxPurchaseDate} style={{ width: '100%' }} />
              </div>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                <button type="button" className="btn btn-secondary" onClick={() => setEditStock(null)}>
                  {t(language, 'stocks.cancel')}
                </button>
                <button type="button" className="btn btn-primary" onClick={handleSaveEdit} disabled={saving}>
                  {saving ? t(language, 'stocks.saving') : t(language, 'stocks.save')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
