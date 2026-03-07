import { useEffect, useRef, useState } from 'react'
import { AnalystRecommendation, AnalystData } from '../services/api'
import { useSettings } from '../SettingsContext'
import { getLocaleForLanguage, t } from '../i18n'
import RecommendationChart from './RecommendationChart'

interface Props {
  priceTargets: AnalystData['price_targets']
  recommendations: AnalystRecommendation[] | null
  finnhubRecommendations: AnalystRecommendation[] | null
  currency: string
  currentPrice: number | null
}

/**
 * Format a numeric value as a localized currency string.
 *
 * @param value - The numeric amount to format; if `null` or `NaN`, the function returns `-`
 * @param locale - BCP 47 locale identifier used for formatting (e.g., `en-US`, `fr-FR`)
 * @param currency - ISO 4217 currency code (e.g., `USD`, `EUR`)
 * @returns A localized currency string with two decimal places, or `-` if `value` is `null` or `NaN`
 */
function formatCurrency(value: number | null, locale: string, currency: string): string {
  if (value === null || Number.isNaN(value)) return '-'
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}

/**
 * Render analyst price targets alongside recommendation charts when any relevant data exists.
 *
 * Displays a price-range visualization (low/high/average targets and optional current price)
 * and one or two recommendation charts (YFinance and optional Finnhub). Handles missing values
 * gracefully and returns `null` when there are no price targets or recommendations to show.
 *
 * @param priceTargets - Analyst-provided target values and optional note (may be null)
 * @param recommendations - YFinance recommendation history (may be null)
 * @param finnhubRecommendations - Finnhub recommendation history (may be null)
 * @param currency - Currency code used for formatting displayed monetary values
 * @param currentPrice - Current market price (may be null)
 * @returns A React element containing the analyst panel UI, or `null` if there is no data to render
 */
export default function YfinanceAnalystPanel({
  priceTargets,
  recommendations,
  finnhubRecommendations,
  currency,
  currentPrice,
}: Props) {
  const { language } = useSettings()
  const locale = getLocaleForLanguage(language)
  const labels = {
    strong_buy: t(language, 'analystRec.strongBuy'),
    buy: t(language, 'analystRec.buy'),
    hold: t(language, 'analystRec.hold'),
    sell: t(language, 'analystRec.sell'),
    strong_sell: t(language, 'analystRec.strongSell'),
  }
  const targetsContainerRef = useRef<HTMLDivElement | null>(null)
  const [targetsContainerWidth, setTargetsContainerWidth] = useState(0)

  useEffect(() => {
    const node = targetsContainerRef.current
    if (!node) return

    const updateWidth = () => setTargetsContainerWidth(node.clientWidth)
    updateWidth()

    const observer = new ResizeObserver(updateWidth)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

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
  const avgLabel = targetAvg !== null ? formatCurrency(targetAvg, locale, currency) : '-'

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
  const lowHighMarginTop = showCurrent ? 44 : 20
  const labelWidth = 144
  const labelHalf = labelWidth / 2

  const getLabelLayout = (percent: number | null) => {
    if (percent === null || targetsContainerWidth <= 0) {
      return { centerPx: null as number | null, pointerPx: labelHalf }
    }

    const markerPx = (percent / 100) * targetsContainerWidth
    const centerPx = Math.min(
      Math.max(markerPx, labelHalf),
      Math.max(labelHalf, targetsContainerWidth - labelHalf)
    )
    const pointerPx = Math.min(
      labelWidth - 10,
      Math.max(10, labelHalf + (markerPx - centerPx))
    )

    return { centerPx, pointerPx }
  }

  const avgLayout = getLabelLayout(avgPercent)
  const currentLayout = getLabelLayout(currentPercent)

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '16px', marginBottom: '20px' }}>
      <div className="card" style={{ marginBottom: 0 }}>
        <h3 style={{ marginBottom: '18px' }}>{hasAnalystTargets ? t(language, 'analyst.priceTargets') : t(language, 'analyst.range52w')}</h3>

        {hasPriceTargets ? (
          <div ref={targetsContainerRef} style={{ position: 'relative', paddingTop: targetAvg !== null ? '96px' : '46px', paddingBottom: '44px' }}>
            {targetAvg !== null && (
              <div style={{
                position: 'absolute',
                left: avgLayout.centerPx !== null ? `${avgLayout.centerPx}px` : `clamp(72px, ${clampedAvgPercent}%, calc(100% - 72px))`,
                top: 0,
                transform: 'translateX(-50%)',
                width: labelWidth,
              }}>
                <div style={{
                  background: 'rgba(88, 166, 255, 0.08)',
                  border: '1px solid rgba(88, 166, 255, 0.6)',
                  borderRadius: 8,
                  padding: '6px 10px',
                  textAlign: 'center',
                  width: labelWidth,
                }}>
                  <div style={{ fontWeight: 700 }}>{avgLabel}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t(language, 'analyst.average')}</div>
                </div>
                <div style={{ width: 2, height: 14, background: 'rgba(88, 166, 255, 0.6)', marginTop: 4, marginLeft: avgLayout.pointerPx }} />
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
                  left: currentLayout.centerPx !== null ? `${currentLayout.centerPx}px` : `clamp(72px, ${clampedCurrentPercent}%, calc(100% - 72px))`,
                  transform: 'translateX(-50%)',
                  display: 'flex',
                  flexDirection: 'column',
                  width: labelWidth,
                }}>
                  <div style={{ width: 2, height: 14, background: '#f59e0b', marginBottom: 4, marginLeft: currentLayout.pointerPx }} />
                  <div style={{
                    background: 'var(--bg-tertiary)',
                    border: '1px solid var(--border-color)',
                    borderRadius: 8,
                    padding: '6px 10px',
                    textAlign: 'center',
                    width: labelWidth,
                  }}>
                    <div style={{ fontWeight: 700 }}>{formatCurrency(currentPrice, locale, currency)}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t(language, 'analyst.current')}</div>
                  </div>
                </div>
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: lowHighMarginTop }}>
              <div>
                <div style={{ fontSize: 20, fontWeight: 600 }}>{formatCurrency(targetLow, locale, currency)}</div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t(language, 'analyst.low')}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 20, fontWeight: 600 }}>{formatCurrency(targetHigh, locale, currency)}</div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t(language, 'analyst.high')}</div>
              </div>
            </div>
          </div>
        ) : (
          <div style={{ color: 'var(--text-secondary)' }}>{t(language, 'analyst.noPriceTarget')}</div>
        )}
      </div>

      <div className="card" style={{ marginBottom: 0 }}>
        <h3 style={{ marginBottom: '18px' }}>{t(language, 'analyst.recommendations')}</h3>

        {hasYfinanceRecs ? (
          <RecommendationChart
            recommendations={recommendations}
            labels={labels}
            totalLabel={t(language, 'recommendation.total')}
            locale={locale}
            withCard={false}
          />
        ) : (
          <div style={{ color: 'var(--text-secondary)' }}>{t(language, 'analyst.noRecommendations')}</div>
        )}
      </div>

      {hasFinnhubRecs && (
        <div className="card" style={{ marginBottom: 0 }}>
          <h3 style={{ marginBottom: '18px' }}>
            {t(language, 'analyst.finnhubRecommendations')}
            <span style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 400, marginLeft: 8 }}>
              {t(language, 'analyst.usMarket')}
            </span>
          </h3>
          <RecommendationChart
            recommendations={finnhubRecommendations}
            labels={labels}
            totalLabel={t(language, 'recommendation.total')}
            locale={locale}
            withCard={false}
          />
        </div>
      )}
    </div>
  )
}
