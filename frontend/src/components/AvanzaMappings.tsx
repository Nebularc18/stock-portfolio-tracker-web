import { useState, useEffect, useMemo } from 'react'
import { api, TickerMapping, Stock } from '../services/api'
import { useSettings } from '../SettingsContext'
import { getLocaleForLanguage, t } from '../i18n'
import SortableHeader from './SortableHeader'
import { sortTableItems, useTableSort } from '../utils/tableSort'

type SortField = 'avanzaName' | 'yahooTicker' | 'instrumentId'

/**
 * Renders the Avanza-to-Yahoo ticker mappings management UI.
 *
 * @returns The React element for managing Avanza stock name to Yahoo ticker mappings, including listing, adding, and deleting mappings and showing loading/error states.
 */
export default function AvanzaMappings() {
  const { language } = useSettings()
  const locale = getLocaleForLanguage(language)
  const [mappings, setMappings] = useState<TickerMapping[]>([])
  const [stocks, setStocks] = useState<Stock[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  
  const [showAddForm, setShowAddForm] = useState(false)
  
  const [selectedTicker, setSelectedTicker] = useState('')
  const [newMapping, setNewMapping] = useState({
    avanza_name: '',
    yahoo_ticker: '',
    instrument_id: ''
  })
  const [saving, setSaving] = useState(false)
  const { sortState, requestSort } = useTableSort<SortField>({ field: 'yahooTicker', direction: 'asc' })

  const unmappedStocks = stocks
    .filter(s => !mappings.some(m => m.yahoo_ticker.toUpperCase() === s.ticker.toUpperCase()))
    .sort((a, b) => a.ticker.localeCompare(b.ticker))

  const sortedMappings = useMemo(() => (
    sortTableItems(
      mappings,
      sortState,
      {
        avanzaName: (mapping) => mapping.avanza_name,
        yahooTicker: (mapping) => mapping.yahoo_ticker,
        instrumentId: (mapping) => mapping.instrument_id,
      },
      locale,
      (mapping) => mapping.yahoo_ticker
    )
  ), [locale, mappings, sortState])

  useEffect(() => {
    fetchData()
  }, [])

  const fetchData = async () => {
    try {
      setLoading(true)
      const [mappingsData, stocksData] = await Promise.all([
        api.avanza.mappings(),
        api.stocks.list()
      ])
      setMappings(mappingsData)
      setStocks(stocksData)
      setError(null)
    } catch (err) {
      console.error('Failed to fetch data:', err)
      setError(t(language, 'avanzaMappings.failedLoad'))
    } finally {
      setLoading(false)
    }
  }

  const handleSelectStock = (ticker: string) => {
    setSelectedTicker(ticker)
    setNewMapping(prev => ({ ...prev, yahoo_ticker: ticker }))
    const stock = stocks.find(s => s.ticker === ticker)
    if (stock?.name) {
      const cleanName = stock.name.replace(/ AB(?: \(publ\))?/gi, '').trim()
      setNewMapping(prev => ({ ...prev, avanza_name: cleanName }))
    }
  }

  const handleAddMapping = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newMapping.avanza_name || !newMapping.yahoo_ticker || !newMapping.instrument_id) return
    
    try {
      setSaving(true)
      setError(null)
      await api.avanza.addMapping({
        avanza_name: newMapping.avanza_name,
        yahoo_ticker: newMapping.yahoo_ticker,
        instrument_id: newMapping.instrument_id
      })
      setNewMapping({ avanza_name: '', yahoo_ticker: '', instrument_id: '' })
      setSelectedTicker('')
      setShowAddForm(false)
      fetchData()
    } catch (err) {
      console.error('Failed to add mapping:', err)
      setError(t(language, 'avanzaMappings.failedAdd'))
    } finally {
      setSaving(false)
    }
  }

  const handleDeleteMapping = async (avanzaName: string) => {
    if (!confirm(t(language, 'avanzaMappings.deleteConfirm', { name: avanzaName }))) return
    
    try {
      await api.avanza.deleteMapping(avanzaName)
      fetchData()
    } catch (err) {
      console.error('Failed to delete mapping:', err)
      setError(t(language, 'avanzaMappings.failedDelete'))
    }
  }

  return (
    <div className="card" style={{ marginTop: '24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <div>
          <h3 style={{ marginBottom: '4px' }}>{t(language, 'avanzaMappings.title')}</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>
            {t(language, 'avanzaMappings.subtitle')}
          </p>
        </div>
        <button
          onClick={() => setShowAddForm(!showAddForm)}
          disabled={unmappedStocks.length === 0}
          style={{
            padding: '8px 16px',
            background: showAddForm ? 'var(--bg-tertiary)' : unmappedStocks.length === 0 ? 'var(--bg-tertiary)' : 'var(--accent-blue)',
            color: showAddForm ? 'var(--text-primary)' : unmappedStocks.length === 0 ? 'var(--text-secondary)' : 'white',
            border: 'none',
            borderRadius: '6px',
            cursor: unmappedStocks.length === 0 ? 'not-allowed' : 'pointer',
            fontSize: '14px'
          }}
        >
          {showAddForm ? t(language, 'stocks.cancel') : t(language, 'avanzaMappings.addMapping')}
        </button>
      </div>

      {error && (
        <div style={{ padding: '12px', background: 'rgba(255,82,82,0.1)', borderRadius: '6px', color: 'var(--accent-red)', marginBottom: '16px' }}>
          {error}
        </div>
      )}

      {unmappedStocks.length === 0 && !showAddForm && (
        <div style={{ padding: '16px', background: 'var(--bg-tertiary)', borderRadius: '6px', marginBottom: '16px' }}>
          <p style={{ color: 'var(--text-secondary)', fontSize: '13px', margin: 0 }}>
            {stocks.length === 0 
              ? t(language, 'avanzaMappings.noStocksYet')
              : t(language, 'avanzaMappings.allMapped')}
          </p>
        </div>
      )}

      {showAddForm && (
        <div style={{ 
          background: 'var(--bg-tertiary)', 
          borderRadius: '8px', 
          padding: '20px', 
          marginBottom: '20px',
          border: '1px solid var(--border-color)'
        }}>
          <h4 style={{ marginBottom: '16px', fontSize: '15px' }}>{t(language, 'avanzaMappings.addNew')}</h4>
          
          <form onSubmit={handleAddMapping}>
            <div style={{ marginBottom: '16px' }}>
              <label style={{ display: 'block', marginBottom: '6px', fontSize: '13px', color: 'var(--text-secondary)' }}>
                {t(language, 'avanzaMappings.selectStock')}
              </label>
              <select
                value={selectedTicker}
                onChange={(e) => handleSelectStock(e.target.value)}
                required
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  border: '1px solid var(--border-color)',
                  borderRadius: '6px',
                  background: 'var(--bg-secondary)',
                  color: 'var(--text-primary)',
                  fontSize: '14px',
                  boxSizing: 'border-box'
                }}
              >
                <option value="">{t(language, 'avanzaMappings.selectStockOption')}</option>
                {unmappedStocks.map((stock) => (
                  <option key={stock.ticker} value={stock.ticker}>
                    {stock.name || stock.ticker}
                  </option>
                ))}
              </select>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '16px' }}>
              <div>
                <label style={{ display: 'block', marginBottom: '6px', fontSize: '13px', color: 'var(--text-secondary)' }}>
                  {t(language, 'avanzaMappings.avanzaName')}
                </label>
                <input
                  type="text"
                  value={newMapping.avanza_name}
                  onChange={(e) => setNewMapping({ ...newMapping, avanza_name: e.target.value })}
                  placeholder={t(language, 'avanzaMappings.avanzaNamePlaceholder')}
                  required
                  style={{
                    width: '100%',
                    padding: '10px 12px',
                    border: '1px solid var(--border-color)',
                    borderRadius: '6px',
                    background: 'var(--bg-secondary)',
                    color: 'var(--text-primary)',
                    fontSize: '14px',
                    boxSizing: 'border-box'
                  }}
                />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: '6px', fontSize: '13px', color: 'var(--text-secondary)' }}>
                  {t(language, 'avanzaMappings.yahooTicker')}
                </label>
                <input
                  type="text"
                  value={newMapping.yahoo_ticker}
                  disabled
                  style={{
                    width: '100%',
                    padding: '10px 12px',
                    border: '1px solid var(--border-color)',
                    borderRadius: '6px',
                    background: 'var(--bg-tertiary)',
                    color: 'var(--text-secondary)',
                    fontSize: '14px',
                    boxSizing: 'border-box'
                  }}
                />
              </div>
            </div>
            
            <div style={{ marginBottom: '16px' }}>
              <label style={{ display: 'block', marginBottom: '6px', fontSize: '13px', color: 'var(--text-secondary)' }}>
                {t(language, 'avanzaMappings.instrumentId')}
              </label>
              <input
                type="text"
                value={newMapping.instrument_id}
                onChange={(e) => setNewMapping({ ...newMapping, instrument_id: e.target.value })}
                placeholder={t(language, 'avanzaMappings.instrumentIdPlaceholder')}
                required
                style={{
                  width: '100%',
                  maxWidth: '300px',
                  padding: '10px 12px',
                  border: '1px solid var(--border-color)',
                  borderRadius: '6px',
                  background: 'var(--bg-secondary)',
                  color: 'var(--text-primary)',
                  fontSize: '14px',
                  boxSizing: 'border-box'
                }}
              />
              <p style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                {t(language, 'avanzaMappings.instrumentIdHint')}
              </p>
            </div>
            
            <button
              type="submit"
              disabled={saving || !newMapping.avanza_name || !newMapping.instrument_id}
              style={{
                padding: '10px 20px',
                background: 'var(--accent-green)',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                cursor: saving ? 'wait' : 'pointer',
                fontSize: '14px',
                opacity: saving ? 0.7 : 1
              }}
            >
              {saving ? t(language, 'avanzaMappings.saving') : t(language, 'avanzaMappings.saveMapping')}
            </button>
          </form>
        </div>
      )}

      {loading ? (
        <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '20px' }}>
          {t(language, 'avanzaMappings.loading')}
        </p>
      ) : mappings.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '30px', color: 'var(--text-secondary)' }}>
          <p style={{ marginBottom: '8px' }}>{t(language, 'avanzaMappings.noneConfigured')}</p>
          <p style={{ fontSize: '13px' }}>{t(language, 'avanzaMappings.noneConfiguredHelp')}</p>
        </div>
      ) : (
        <table style={{ width: '100%' }}>
          <thead>
            <tr>
              <SortableHeader field="avanzaName" label={t(language, 'avanzaMappings.colAvanzaName')} sortState={sortState} onSort={requestSort} />
              <SortableHeader field="yahooTicker" label={t(language, 'avanzaMappings.colYahooTicker')} sortState={sortState} onSort={requestSort} />
              <SortableHeader field="instrumentId" label={t(language, 'avanzaMappings.colInstrumentId')} sortState={sortState} onSort={requestSort} />
              <th style={{ textAlign: 'right' }}>{t(language, 'common.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {sortedMappings.map((mapping) => (
              <tr key={mapping.avanza_name}>
                <td style={{ fontWeight: '600' }}>{mapping.avanza_name}</td>
                <td>
                  <code style={{ 
                    background: 'var(--bg-tertiary)', 
                    padding: '2px 6px', 
                    borderRadius: '4px',
                    fontSize: '13px'
                  }}>
                    {mapping.yahoo_ticker}
                  </code>
                </td>
                <td style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>
                  {mapping.instrument_id || '-'}
                </td>
                <td style={{ textAlign: 'right' }}>
                  <button
                    onClick={() => handleDeleteMapping(mapping.avanza_name)}
                    style={{
                      padding: '4px 12px',
                      background: 'transparent',
                      color: 'var(--accent-red)',
                      border: '1px solid var(--accent-red)',
                      borderRadius: '4px',
                      cursor: 'pointer',
                      fontSize: '12px'
                    }}
                  >
                    {t(language, 'common.delete')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div style={{ 
        marginTop: '20px', 
        padding: '12px', 
        background: 'var(--bg-tertiary)', 
        borderRadius: '6px',
        fontSize: '13px',
        color: 'var(--text-secondary)'
      }}>
        <strong style={{ color: 'var(--text-primary)' }}>{t(language, 'avanzaMappings.howToFind')}</strong> {t(language, 'avanzaMappings.visitStock')}{' '}
        {t(language, 'avanzaMappings.urlLooksLike')} <code style={{ background: 'var(--bg-secondary)', padding: '2px 4px', borderRadius: '3px' }}>
          avanza.se/aktier/om-aktien.html/5269/volvo-b
        </code> {t(language, 'avanzaMappings.where')} <code style={{ background: 'var(--bg-secondary)', padding: '2px 4px', borderRadius: '3px' }}>5269</code> {t(language, 'avanzaMappings.idSuffix')}
      </div>
    </div>
  )
}
