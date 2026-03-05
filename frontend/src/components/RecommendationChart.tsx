import { useId, useState } from 'react'
import { AnalystRecommendation, RecommendationTrend } from '../services/api'
import { useSettings } from '../SettingsContext'
import { getLocaleForLanguage, t } from '../i18n'

interface Props {
  recommendations: Array<RecommendationTrend | AnalystRecommendation> | null
  loading?: boolean
  labels?: Record<'strong_buy' | 'buy' | 'hold' | 'sell' | 'strong_sell', string>
  totalLabel?: string
  locale?: string
  title?: string
  withCard?: boolean
}

const COLORS = {
  strong_buy: '#22c55e',
  buy: '#86efac',
  hold: '#facc15',
  sell: '#fb923c',
  strong_sell: '#ef4444',
}


/**
 * Resolves a relative month period string (for example, "-3m") to the Date representing the first day of that month.
 *
 * @param period - A relative-month string in the form `[-]Nm` (e.g. `-3m` or `3m`); falsy or non-matching values are not interpreted.
 * @returns The Date set to the first day of the month N months before the current month, or `null` if `period` is falsy or not in the expected format.
 */
function getStartOfRelativeMonth(period: string): Date | null {
  if (!period) return null;
  const match = /^-?\d+m$/.exec(period);
  if (match) {
    const monthsAgo = Math.abs(parseInt(period.replace('m', ''), 10));
    const date = new Date();
    date.setDate(1);
    date.setMonth(date.getMonth() - monthsAgo);
    return date;
  }
  return null;
}

function parseDateOnlyPeriod(period: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(period)
  if (!match) return null

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (!year || !month || !day) return null

  return new Date(year, month - 1, day)
}

/**
 * Formats a period string as a locale-aware short month name.
 *
 * Accepts either an absolute date string or a relative month token like `-3m`. For relative tokens, the function computes the first day of the referenced month before formatting.
 *
 * @param period - The period to format; can be an ISO/parsable date string or a relative month token (e.g., `-1m`, `-3m`)
 * @param locale - BCP 47 locale identifier used for month name localization (e.g., `en-US`)
 * @returns The short month name for the resolved date in the given locale (e.g., `Jan`, `Feb`), or the original `period` string if it cannot be parsed into a date
 */
function formatPeriod(period: string, locale: string): string {
  const relDate = getStartOfRelativeMonth(period);
  if (relDate) {
    return relDate.toLocaleDateString(locale, { month: 'short' });
  }
  const date = parseDateOnlyPeriod(period) ?? new Date(period);
  if (Number.isNaN(date.getTime())) {
    return period;
  }
  return date.toLocaleDateString(locale, { month: 'short' });
}

/**
 * Converts a period identifier into a Date representing that period.
 *
 * Accepts relative month strings (e.g., "-3m") which resolve to the first day of the target month, or absolute date strings parseable by Date. Returns `null` when the input is falsy or cannot be converted to a valid Date.
 *
 * @param period - A period identifier: a relative month (like "-3m") or a date string.
 * @returns A Date for the period, or `null` if the period is invalid or unspecified.
 */
function parsePeriodToDate(period: string): Date | null {
  if (!period) return null;
  const relDate = getStartOfRelativeMonth(period);
  if (relDate) return relDate;
  const dateOnly = parseDateOnlyPeriod(period)
  if (dateOnly) return dateOnly
  const parsed = new Date(period);
  if (!Number.isNaN(parsed.getTime())) return parsed;
  return null;
}

/**
 * Compute the total number of analyst recommendations for a record.
 *
 * Uses `rec.total_analysts` when available; otherwise sums `strong_buy`, `buy`, `hold`, `sell`, and `strong_sell`. Returns 0 if no values are present.
 *
 * @param rec - The recommendation record to total
 * @returns The total number of recommendations (0 if none)
 */
function getRecTotal(rec: RecommendationTrend | AnalystRecommendation): number {
  const total = rec.total_analysts ?? ((rec.strong_buy ?? 0) + (rec.buy ?? 0) + (rec.hold ?? 0) + (rec.sell ?? 0) + (rec.strong_sell ?? 0))
  return total ?? 0
}

/**
 * Provide a positive scale total for a recommendation record.
 *
 * @param rec - A recommendation record (RecommendationTrend or AnalystRecommendation) to evaluate
 * @returns The record's total recommendations if that value is greater than or equal to 1, otherwise 1
 */
function getRecScaleTotal(rec: RecommendationTrend | AnalystRecommendation): number {
  return Math.max(getRecTotal(rec), 1)
}

/**
 * Render a stacked recommendation bar chart showing up to the four most recent periods, optionally wrapped in a card.
 *
 * @param recommendations - Array of recommendation records (each a `RecommendationTrend` or `AnalystRecommendation`) or `null`. Each record's `period` is parsed to determine ordering; records with unparseable periods are ignored.
 * @param loading - When true, show a localized loading state instead of the chart.
 * @param labels - Optional overrides for the recommendation labels. Expected keys: `strong_buy`, `buy`, `hold`, `sell`, `strong_sell`.
 * @param totalLabel - Optional override for the translated "total" label shown in tooltips and totals.
 * @param locale - Optional locale string used for period formatting; when omitted the locale is derived from app settings.
 * @param title - Optional override for the chart title displayed when the component is rendered inside a card.
 * @param withCard - When true (default), wrap the chart and legend in a card with a title; when false, render only the chart content.
 * @returns A React element containing the chart and legend, or `null` when there is no displayable data.
 */
export default function RecommendationChart({
  recommendations,
  loading,
  labels: labelsOverride,
  totalLabel,
  locale: localeOverride,
  title,
  withCard = true,
}: Props) {
  const [hoveredBar, setHoveredBar] = useState<number | null>(null)
  const tooltipIdPrefix = `recommendation-tooltip-${useId().replace(/:/g, '')}`
  const { language } = useSettings()
  const locale = localeOverride ?? getLocaleForLanguage(language)
  const labels = labelsOverride ?? {
    strong_buy: t(language, 'recommendation.strongBuy'),
    buy: t(language, 'recommendation.buy'),
    hold: t(language, 'recommendation.hold'),
    sell: t(language, 'recommendation.sell'),
    strong_sell: t(language, 'recommendation.strongSell'),
  }
  const totalLabelText = totalLabel ?? t(language, 'recommendation.total')
  const titleText = title ?? t(language, 'recommendation.title')

  if (loading) {
    if (!withCard) {
      return (
        <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '20px' }}>
          {t(language, 'common.loading')}
        </p>
      )
    }

    return (
      <div className="card">
        <h3 style={{ marginBottom: '16px' }}>{titleText}</h3>
        <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '20px' }}>
          {t(language, 'common.loading')}
        </p>
      </div>
    )
  }

  if (!recommendations || recommendations.length === 0) {
    return null
  }

  const displayData = [...recommendations]
    .map(rec => ({ rec, _date: parsePeriodToDate(rec.period) }))
    .filter(({ _date }) => _date !== null)
    .sort((a, b) => a._date!.getTime() - b._date!.getTime())
    .slice(-4)

  if (displayData.length === 0) {
    return null
  }

  const maxScaleTotal = Math.max(
    ...displayData.map(({ rec }) => getRecScaleTotal(rec))
  );

  const content = (
    <>
      <div style={{ display: 'flex', gap: '16px', marginBottom: '24px' }}>
        {displayData.map(({ rec }, index) => {
          const total = getRecTotal(rec)
          const scaleTotal = getRecScaleTotal(rec)
          const barHeight = Math.max(4, (scaleTotal / maxScaleTotal) * 150)
          const tooltipId = `${tooltipIdPrefix}-${index}`
          
          const segments = [
            { key: 'strong_buy', value: rec.strong_buy ?? 0, color: COLORS.strong_buy },
            { key: 'buy', value: rec.buy ?? 0, color: COLORS.buy },
            { key: 'hold', value: rec.hold ?? 0, color: COLORS.hold },
            { key: 'sell', value: rec.sell ?? 0, color: COLORS.sell },
            { key: 'strong_sell', value: rec.strong_sell ?? 0, color: COLORS.strong_sell },
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
              onFocus={() => setHoveredBar(index)}
              onBlur={() => setHoveredBar(null)}
              tabIndex={0}
              aria-describedby={hoveredBar === index ? tooltipId : undefined}
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
                  const height = (seg.value / scaleTotal) * barHeight
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
                  {t(language, 'recommendation.totalShort')} {total}
                </p>
              )}
              
              <p style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                {formatPeriod(rec.period, locale)}
              </p>
              
              {hoveredBar === index && (
                <div id={tooltipId} style={{
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
                  <p style={{ fontWeight: 600, marginBottom: 4 }}>{formatPeriod(rec.period, locale)}</p>
                  <p style={{ color: COLORS.strong_buy, fontSize: '12px' }}>■ {labels.strong_buy}: {rec.strong_buy ?? 0}</p>
                  <p style={{ color: COLORS.buy, fontSize: '12px' }}>■ {labels.buy}: {rec.buy ?? 0}</p>
                  <p style={{ color: COLORS.hold, fontSize: '12px' }}>■ {labels.hold}: {rec.hold ?? 0}</p>
                  <p style={{ color: COLORS.sell, fontSize: '12px' }}>■ {labels.sell}: {rec.sell ?? 0}</p>
                  <p style={{ color: COLORS.strong_sell, fontSize: '12px' }}>■ {labels.strong_sell}: {rec.strong_sell ?? 0}</p>
                  <p style={{ fontWeight: 600, marginTop: 4 }}>{totalLabelText}: {total}</p>
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
            <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{labels[key as keyof typeof labels]}</span>
          </div>
        ))}
      </div>
    </>
  )

  if (!withCard) return content

  return (
    <div className="card">
      <h3 style={{ marginBottom: '16px' }}>{titleText}</h3>
      {content}
    </div>
  )
}
