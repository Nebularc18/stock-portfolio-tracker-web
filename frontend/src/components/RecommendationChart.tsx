import { useState } from 'react'
import { RecommendationTrend } from '../services/api'

interface Props {
  recommendations: RecommendationTrend[] | null
  loading?: boolean
}

const COLORS = {
  strong_buy: '#22c55e',
  buy: '#86efac',
  hold: '#facc15',
  sell: '#fb923c',
  strong_sell: '#ef4444',
}

const LABELS = {
  strong_buy: 'Stark Köp',
  buy: 'Köp',
  hold: 'Behåll',
  sell: 'Sälj',
  strong_sell: 'Stark Sälj',
}

function formatPeriod(period: string): string {
  try {
    const date = new Date(period)
    return date.toLocaleDateString('sv-SE', { month: 'short' })
  } catch {
    return period
  }
}

export default function RecommendationChart({ recommendations, loading }: Props) {
  const [hoveredBar, setHoveredBar] = useState<number | null>(null)

  if (loading) {
    return (
      <div className="card">
        <h3 style={{ marginBottom: '16px' }}>Analytikerrekommendationer</h3>
        <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '20px' }}>
          Laddar...
        </p>
      </div>
    )
  }

  if (!recommendations || recommendations.length === 0) {
    return null
  }

  const displayData = recommendations.slice(0, 4)
  const maxTotal = Math.max(...displayData.map(d => d.total_analysts || 1))

  return (
    <div className="card">
      <h3 style={{ marginBottom: '16px' }}>Analytikerrekommendationer</h3>
      
      <div style={{ display: 'flex', gap: '16px', marginBottom: '24px' }}>
        {displayData.map((rec, index) => {
          const total = rec.total_analysts || 0
          const barHeight = Math.max(4, (total / maxTotal) * 150)
          
          const segments = [
            { key: 'strong_buy', value: rec.strong_buy || 0, color: COLORS.strong_buy },
            { key: 'buy', value: rec.buy || 0, color: COLORS.buy },
            { key: 'hold', value: rec.hold || 0, color: COLORS.hold },
            { key: 'sell', value: rec.sell || 0, color: COLORS.sell },
            { key: 'strong_sell', value: rec.strong_sell || 0, color: COLORS.strong_sell },
          ].filter(s => s.value > 0)
          
          return (
            <div 
              key={rec.period}
              style={{ 
                flex: 1, 
                display: 'flex', 
                flexDirection: 'column', 
                alignItems: 'center',
                position: 'relative'
              }}
              onMouseEnter={() => setHoveredBar(index)}
              onMouseLeave={() => setHoveredBar(null)}
            >
              <div style={{ 
                display: 'flex', 
                flexDirection: 'column', 
                width: '100%', 
                maxWidth: 60,
                borderRadius: 4,
                overflow: 'hidden',
                background: 'var(--bg-tertiary)'
              }}>
                {segments.map((seg, segIndex) => {
                  const height = total > 0 ? (seg.value / total) * barHeight : 0
                  return (
                    <div
                      key={seg.key}
                      style={{
                        height: height,
                        minHeight: segIndex === 0 && height === 0 ? 0 : (height > 0 ? height : 0),
                        background: seg.color,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '10px',
                        fontWeight: 600,
                        color: '#000',
                      }}
                    >
                      {height > 15 && seg.value}
                    </div>
                  )
                })}
              </div>
              
              {total > 0 && (
                <p style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '8px', marginBottom: '4px' }}>
                  Tot: {total}
                </p>
              )}
              
              <p style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                {formatPeriod(rec.period)}
              </p>
              
              {hoveredBar === index && (
                <div style={{
                  position: 'absolute',
                  bottom: '100%',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  background: 'rgba(0, 0, 0, 0.9)',
                  border: '1px solid var(--accent-blue)',
                  borderRadius: 6,
                  padding: '8px 12px',
                  marginBottom: 8,
                  whiteSpace: 'nowrap',
                  zIndex: 10
                }}>
                  <p style={{ fontWeight: 600, marginBottom: 4 }}>{formatPeriod(rec.period)}</p>
                  <p style={{ color: COLORS.strong_buy, fontSize: '12px' }}>■ {LABELS.strong_buy}: {rec.strong_buy}</p>
                  <p style={{ color: COLORS.buy, fontSize: '12px' }}>■ {LABELS.buy}: {rec.buy}</p>
                  <p style={{ color: COLORS.hold, fontSize: '12px' }}>■ {LABELS.hold}: {rec.hold}</p>
                  <p style={{ color: COLORS.sell, fontSize: '12px' }}>■ {LABELS.sell}: {rec.sell}</p>
                  <p style={{ color: COLORS.strong_sell, fontSize: '12px' }}>■ {LABELS.strong_sell}: {rec.strong_sell}</p>
                  <p style={{ fontWeight: 600, marginTop: 4 }}>Total: {total}</p>
                </div>
              )}
            </div>
          )
        })}
      </div>
      
      <div style={{ display: 'flex', justifyContent: 'center', gap: '20px', flexWrap: 'wrap' }}>
        {Object.entries(COLORS).map(([key, color]) => (
          <div key={key} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <div style={{ width: 12, height: 12, background: color, borderRadius: 2 }} />
            <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{LABELS[key as keyof typeof LABELS]}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
