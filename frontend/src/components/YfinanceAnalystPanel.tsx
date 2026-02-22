import { AnalystRecommendation, AnalystData } from '../services/api'

interface Props {
  priceTargets: AnalystData['price_targets']
  recommendations: AnalystRecommendation[] | null
  currency: string
  currentPrice: number | null
}

const COLORS = {
  strong_buy: '#10b981',
  buy: '#a3b18a',
  hold: '#eab308',
  sell: '#f59e0b',
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

  if (/^\d+m$/.test(period)) {
    const monthsAgo = parseInt(period.replace('m', ''), 10)
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

export default function YfinanceAnalystPanel({
  priceTargets,
  recommendations,
  currency,
  currentPrice,
}: Props) {
  const hasAnalystTargets = Boolean(
    priceTargets?.targetLow || priceTargets?.targetHigh || priceTargets?.targetAvg
  )
  const hasPriceTargets = Boolean(hasAnalystTargets || currentPrice)
  const hasRecommendations = Boolean(recommendations && recommendations.length > 0)

  if (!hasPriceTargets && !hasRecommendations) {
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

  const sortedRecommendations = (recommendations || [])
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
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '16px' }}>
      <div className="card" style={{ marginBottom: 0 }}>
        <h3 style={{ marginBottom: '18px' }}>Analyst Price Targets</h3>

        {hasPriceTargets ? (
          <div style={{ position: 'relative', paddingTop: '36px', paddingBottom: '32px' }}>
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
                  left: `${valueToPercent(targetAvg)}%`,
                  top: '50%',
                  width: 12,
                  height: 12,
                  borderRadius: '50%',
                  background: 'var(--accent-blue)',
                  transform: 'translate(-50%, -50%)',
                  boxShadow: '0 0 0 3px rgba(88, 166, 255, 0.2)'
                }} />
              )}

              {currentPrice !== null && hasAnalystTargets && (
                <div style={{
                  position: 'absolute',
                  left: `${valueToPercent(currentPrice)}%`,
                  top: '50%',
                  width: 14,
                  height: 14,
                  borderRadius: '50%',
                  background: 'var(--text-primary)',
                  transform: 'translate(-50%, -50%)',
                  border: '2px solid var(--bg-primary)'
                }} />
              )}
            </div>

            {targetAvg !== null && (
              <div style={{
                position: 'absolute',
                left: `${valueToPercent(targetAvg)}%`,
                top: 0,
                transform: 'translate(-50%, 0)'
              }}>
                <div style={{
                  background: 'rgba(88, 166, 255, 0.08)',
                  border: '1px solid rgba(88, 166, 255, 0.6)',
                  borderRadius: 8,
                  padding: '6px 10px',
                  textAlign: 'center'
                }}>
                  <div style={{ fontWeight: 700 }}>{avgLabel}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Average</div>
                </div>
                <div style={{ width: 2, height: 16, background: 'rgba(88, 166, 255, 0.6)', margin: '4px auto 0' }} />
              </div>
            )}

            {currentPrice !== null && hasAnalystTargets && (
              <div style={{
                position: 'absolute',
                left: `${valueToPercent(currentPrice)}%`,
                bottom: -6,
                transform: 'translate(-50%, 100%)'
              }}>
                <div style={{ width: 2, height: 16, background: 'var(--text-primary)', margin: '0 auto 4px' }} />
                <div style={{
                  background: 'var(--bg-tertiary)',
                  border: '1px solid var(--border-color)',
                  borderRadius: 8,
                  padding: '6px 10px',
                  textAlign: 'center'
                }}>
                  <div style={{ fontWeight: 700 }}>{formatCurrency(currentPrice, currency)}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Current</div>
                </div>
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '18px' }}>
              <div>
                <div style={{ fontSize: 20, fontWeight: 600 }}>{formatCurrency(targetLow, currency)}</div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Low</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 20, fontWeight: 600 }}>{formatCurrency(targetHigh, currency)}</div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>High</div>
              </div>
            </div>

            {priceTargets?.note && (
              <div style={{ marginTop: '14px', fontSize: 12, color: 'var(--text-secondary)' }}>
                {priceTargets.note}
              </div>
            )}
          </div>
        ) : (
          <div style={{ color: 'var(--text-secondary)' }}>No price target data.</div>
        )}
      </div>

      <div className="card" style={{ marginBottom: 0 }}>
        <h3 style={{ marginBottom: '18px' }}>Analyst Recommendations</h3>

        {hasRecommendations ? (
          <div style={{ display: 'flex', gap: '16px' }}>
            <div style={{ display: 'flex', gap: '16px', flex: 1, alignItems: 'flex-end' }}>
              {sortedRecommendations.map(rec => {
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
                  <div key={rec.period} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
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
                      {segments.map((seg, index) => {
                        const height = total > 0 ? (seg.value / total) * barHeight : 0
                        const radiusTop = index === segments.length - 1 ? 10 : 0
                        const radiusBottom = index === 0 ? 10 : 0

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
        ) : (
          <div style={{ color: 'var(--text-secondary)' }}>No analyst recommendations.</div>
        )}
      </div>
    </div>
  )
}
