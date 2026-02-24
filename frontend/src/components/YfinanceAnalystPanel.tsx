import { useState } from 'react'
import { AnalystRecommendation, AnalystData } from '../services/api'

interface Props {
  priceTargets: AnalystData['price_targets']
  recommendations: AnalystRecommendation[] | null
  finnhubRecommendations: AnalystRecommendation[] | null
  currency: string
  currentPrice: number | null
}

const COLORS = {
  strong_buy: '#22c55e',
  buy: '#86efac',
  hold: '#facc15',
  sell: '#fb923c',
  strong_sell: '#ef4444',
}

const LABELS = {
  strong_buy: 'Strong Buy',
  buy: 'Buy',
  hold: 'Hold',
  sell: 'Underperform',
  strong_sell: 'Sell',
}

function formatCurrency(value: number | null, currency: string): string {
  if (value === null || Number.isNaN(value)) return '-'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}

function parsePeriodToDate(period: string): Date | null {
  if (!period) return null

  if (/^-?\d+m$/.test(period)) {
    const monthsAgo = Math.abs(parseInt(period.replace('m', ''), 10))
    const date = new Date()
    date.setDate(1)
    date.setMonth(date.getMonth() - monthsAgo)
    return date
  }

  const parsed = new Date(period)
  if (!Number.isNaN(parsed.getTime())) return parsed

  return null
}

function formatPeriod(period: string): string {
  const date = parsePeriodToDate(period)
  if (date) {
    return date.toLocaleDateString('en-US', { month: 'short' })
  }

  return period
}

function RecommendationChart({
  recommendations,
}: {
  recommendations: AnalystRecommendation[]
}) {
  const [hoveredBar, setHoveredBar] = useState<number | null>(null)

  const sortedRecommendations = recommendations
    .map(rec => ({
      ...rec,
      _date: parsePeriodToDate(rec.period),
    }))
    .sort((a, b) => {
      if (a._date && b._date) return a._date.getTime() - b._date.getTime()
      if (a._date) return -1
      if (b._date) return 1
      return 0
    })
    .slice(-4)

  return (
    <div style={{ display: 'flex', gap: '16px' }}>
      <div style={{ display: 'flex', gap: '16px', flex: 1, alignItems: 'flex-end' }}>
        {sortedRecommendations.map((rec, index) => {
          const total = rec.total_analysts ??
            (rec.strong_buy + rec.buy + rec.hold + rec.sell + rec.strong_sell)

          const segments = [
            { key: 'strong_buy', value: rec.strong_buy, color: COLORS.strong_buy },
            { key: 'buy', value: rec.buy, color: COLORS.buy },
            { key: 'hold', value: rec.hold, color: COLORS.hold },
            { key: 'sell', value: rec.sell, color: COLORS.sell },
            { key: 'strong_sell', value: rec.strong_sell, color: COLORS.strong_sell },
          ].filter(seg => seg.value > 0)

          const barHeight = 180

          return (
            <div
              key={rec.period}
              style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', position: 'relative' }}
              onMouseEnter={() => setHoveredBar(index)}
              onMouseLeave={() => setHoveredBar(null)}
            >
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{total}</div>
              <div style={{
                width: 46,
                height: barHeight,
                display: 'flex',
                flexDirection: 'column-reverse',
                borderRadius: 10,
                overflow: 'hidden',
                background: 'var(--bg-tertiary)',
              }}>
                {segments.map((seg, segIndex) => {
                  const height = total > 0 ? (seg.value / total) * barHeight : 0
                  const radiusTop = segIndex === segments.length - 1 ? 10 : 0
                  const radiusBottom = segIndex === 0 ? 10 : 0

                  return (
                    <div
                      key={seg.key}
                      style={{
                        height,
                        minHeight: seg.value > 0 ? 16 : 0,
                        background: seg.color,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 12,
                        fontWeight: 700,
                        color: '#0a0a0a',
                        borderTopLeftRadius: radiusTop,
                        borderTopRightRadius: radiusTop,
                        borderBottomLeftRadius: radiusBottom,
                        borderBottomRightRadius: radiusBottom,
                      }}
                    >
                      {seg.value}
                    </div>
                  )
                })}
              </div>
              <div style={{ marginTop: 8, fontSize: 14 }}>{formatPeriod(rec.period)}</div>
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
                  zIndex: 10,
                }}>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>{formatPeriod(rec.period)}</div>
                  <div style={{ color: COLORS.strong_buy, fontSize: 12 }}>■ {LABELS.strong_buy}: {rec.strong_buy}</div>
                  <div style={{ color: COLORS.buy, fontSize: 12 }}>■ {LABELS.buy}: {rec.buy}</div>
                  <div style={{ color: COLORS.hold, fontSize: 12 }}>■ {LABELS.hold}: {rec.hold}</div>
                  <div style={{ color: COLORS.sell, fontSize: 12 }}>■ {LABELS.sell}: {rec.sell}</div>
                  <div style={{ color: COLORS.strong_sell, fontSize: 12 }}>■ {LABELS.strong_sell}: {rec.strong_sell}</div>
                  <div style={{ fontWeight: 600, marginTop: 4 }}>Total: {total}</div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', justifyContent: 'center' }}>
        {Object.entries(LABELS).map(([key, label]) => (
          <div key={key} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: COLORS[key as keyof typeof COLORS] }} />
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function YfinanceAnalystPanel({
  priceTargets,
  recommendations,
  finnhubRecommendations,
  currency,
  currentPrice,
}: Props) {
  const hasAnalystTargets = Boolean(
    (priceTargets?.targetLow || priceTargets?.targetHigh || priceTargets?.targetAvg) && !priceTargets?.note
  )
  const hasPriceTargets = Boolean(hasAnalystTargets || currentPrice)
  const hasYfinanceRecs = Boolean(recommendations && recommendations.length > 0)
  const hasFinnhubRecs = Boolean(finnhubRecommendations && finnhubRecommendations.length > 0)

  if (!hasPriceTargets && !hasYfinanceRecs && !hasFinnhubRecs) {
    return null
  }

  const targetLow = priceTargets?.targetLow ?? null
  const targetHigh = priceTargets?.targetHigh ?? null
  const targetAvg = priceTargets?.targetAvg ?? null
  const avgLabel = targetAvg !== null ? formatCurrency(targetAvg, currency) : '-'

  const rangeValues = [targetLow, targetHigh, targetAvg, currentPrice]
    .filter((value): value is number => value !== null)
  const rangeMin = rangeValues.length ? Math.min(...rangeValues) : 0
  const rangeMax = rangeValues.length ? Math.max(...rangeValues) : 1
  const range = rangeMax - rangeMin || 1

  const valueToPercent = (value: number | null) => {
    if (value === null) return null
    return ((value - rangeMin) / range) * 100
  }
  const clampPercent = (value: number | null, min = 6, max = 94) => {
    if (value === null) return null
    return Math.min(max, Math.max(min, value))
  }
  const currentPercent = valueToPercent(currentPrice)
  const avgPercent = valueToPercent(targetAvg)
  const clampedCurrentPercent = clampPercent(currentPercent)
  const clampedAvgPercent = clampPercent(avgPercent)
  const showCurrent = currentPrice !== null && hasAnalystTargets && currentPercent !== null
  const currentLabelMarginTop = targetAvg !== null ? 26 : 14
  const lowHighMarginTop = showCurrent ? 28 : 20

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '16px', marginBottom: '20px' }}>
      <div className="card" style={{ marginBottom: 0 }}>
        <h3 style={{ marginBottom: '18px' }}>{hasAnalystTargets ? 'Analyst Price Targets' : '52-Week Range'}</h3>

        {hasPriceTargets ? (
          <div style={{ position: 'relative', paddingTop: targetAvg !== null ? '96px' : '46px', paddingBottom: '44px' }}>
            {targetAvg !== null && (
              <div style={{
                position: 'absolute',
                left: `clamp(72px, ${clampedAvgPercent}%, calc(100% - 72px))`,
                top: 0,
                transform: 'translateX(-50%)'
              }}>
                <div style={{
                  background: 'rgba(88, 166, 255, 0.08)',
                  border: '1px solid rgba(88, 166, 255, 0.6)',
                  borderRadius: 8,
                  padding: '6px 10px',
                  textAlign: 'center',
                  width: 144
                }}>
                  <div style={{ fontWeight: 700 }}>{avgLabel}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Average</div>
                </div>
                <div style={{ width: 2, height: 14, background: 'rgba(88, 166, 255, 0.6)', margin: '4px auto 0' }} />
              </div>
            )}

            <div style={{
              height: 6,
              background: 'var(--bg-tertiary)',
              borderRadius: 999,
              position: 'relative',
            }}>
              {targetLow !== null && (
                <div style={{
                  position: 'absolute',
                  left: '0%',
                  top: '50%',
                  width: 10,
                  height: 10,
                  borderRadius: '50%',
                  background: 'var(--text-secondary)',
                  transform: 'translate(-20%, -50%)',
                }} />
              )}
              {targetHigh !== null && (
                <div style={{
                  position: 'absolute',
                  left: '100%',
                  top: '50%',
                  width: 10,
                  height: 10,
                  borderRadius: '50%',
                  background: 'var(--text-secondary)',
                  transform: 'translate(-80%, -50%)',
                }} />
              )}

              {targetAvg !== null && (
                <div style={{
                  position: 'absolute',
                  left: `${avgPercent}%`,
                  top: '50%',
                  width: 12,
                  height: 12,
                  borderRadius: '50%',
                  background: 'rgba(88, 166, 255, 0.9)',
                  transform: 'translate(-50%, -50%)',
                  border: '2px solid var(--bg-primary)'
                }} />
              )}

              {showCurrent && (
                <div style={{
                  position: 'absolute',
                  left: `${currentPercent}%`,
                  top: '50%',
                  width: 12,
                  height: 12,
                  background: '#f59e0b',
                  transform: 'translate(-50%, -50%) rotate(45deg)',
                  borderRadius: 2,
                  border: '2px solid var(--bg-primary)'
                }} />
              )}
            </div>

            {showCurrent && (
              <div style={{ position: 'relative', height: 36, marginTop: currentLabelMarginTop }}>
                <div style={{
                  position: 'absolute',
                  left: `clamp(72px, ${clampedCurrentPercent}%, calc(100% - 72px))`,
                  transform: 'translateX(-50%)',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center'
                }}>
                  <div style={{ width: 2, height: 14, background: '#f59e0b', marginBottom: 4 }} />
                  <div style={{
                    background: 'var(--bg-tertiary)',
                    border: '1px solid var(--border-color)',
                    borderRadius: 8,
                    padding: '6px 10px',
                    textAlign: 'center',
                    width: 144
                  }}>
                    <div style={{ fontWeight: 700 }}>{formatCurrency(currentPrice, currency)}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Current</div>
                  </div>
                </div>
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: lowHighMarginTop }}>
              <div>
                <div style={{ fontSize: 20, fontWeight: 600 }}>{formatCurrency(targetLow, currency)}</div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Low</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 20, fontWeight: 600 }}>{formatCurrency(targetHigh, currency)}</div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>High</div>
              </div>
            </div>
          </div>
        ) : (
          <div style={{ color: 'var(--text-secondary)' }}>No price target data.</div>
        )}
      </div>

      <div className="card" style={{ marginBottom: 0 }}>
        <h3 style={{ marginBottom: '18px' }}>Analyst Recommendations</h3>

        {hasYfinanceRecs ? (
          <RecommendationChart recommendations={recommendations!} />
        ) : (
          <div style={{ color: 'var(--text-secondary)' }}>No analyst recommendations.</div>
        )}
      </div>

      {hasFinnhubRecs && (
        <div className="card" style={{ marginBottom: 0 }}>
          <h3 style={{ marginBottom: '18px' }}>
            Finnhub Recommendations
            <span style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 400, marginLeft: 8 }}>
              (US Market)
            </span>
          </h3>
          <RecommendationChart recommendations={finnhubRecommendations!} />
        </div>
      )}
    </div>
  )
}
