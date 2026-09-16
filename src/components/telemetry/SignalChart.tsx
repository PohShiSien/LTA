import { useId, useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { ChevronDown, ScanLine } from 'lucide-react'
import './SignalChart.css'

export type SignalPoint = {
  travelPct: number
  current: number | null
  expectedMedian: number
  expectedLower: number
  expectedUpper: number
}

export type SignalChartProps = {
  points: readonly SignalPoint[]
  comparisonPoints?: readonly SignalPoint[]
  comparisonLabel?: string
  doorId: string
  cycleId: string
  large?: boolean
  anomalyRegion?: { start: number; end: number }
  revealKey?: string
  syntheticEnvelope?: boolean
}

const WIDTH = 720
const LEFT = 41
const RIGHT = 15
const format = (value: number | null) => value === null ? '—' : value.toFixed(2)

function usablePoints(points: readonly SignalPoint[]) {
  return points
    .filter((point) => Object.values(point).every((value) => typeof value !== 'number' || Number.isFinite(value)))
    .filter((point) => point.travelPct >= 0 && point.travelPct <= 100)
    .slice()
    .sort((a, b) => a.travelPct - b.travelPct)
}

function closestIndex(points: readonly SignalPoint[], travel: number) {
  let index = 0
  for (let candidate = 1; candidate < points.length; candidate += 1) {
    if (Math.abs(points[candidate].travelPct - travel) < Math.abs(points[index].travelPct - travel)) index = candidate
  }
  return index
}

function observedSegments(points: readonly SignalPoint[]) {
  const segments: SignalPoint[][] = []
  let segment: SignalPoint[] = []
  for (const point of points) {
    if (point.current === null) {
      if (segment.length) segments.push(segment)
      segment = []
    } else {
      segment.push(point)
    }
  }
  if (segment.length) segments.push(segment)
  return segments
}

/** A data-driven current trace with explicitly labeled reference bounds. */
export function SignalChart({
  points,
  comparisonPoints,
  comparisonLabel = 'Prediction cycle',
  doorId,
  cycleId,
  large = false,
  anomalyRegion = { start: 60, end: 80 },
  revealKey,
  syntheticEnvelope = false,
}: SignalChartProps) {
  const id = useId().replace(/:/g, '')
  const [cursorTravel, setCursorTravel] = useState<number | null>(null)
  const [isFocused, setIsFocused] = useState(false)
  const samples = useMemo(() => usablePoints(points), [points])
  const comparison = useMemo(() => usablePoints(comparisonPoints ?? []), [comparisonPoints])
  const height = large ? 338 : 228
  const top = 25
  const bottom = height - 38
  const plotWidth = WIDTH - LEFT - RIGHT
  const plotHeight = bottom - top
  const regionStart = Math.max(0, Math.min(100, anomalyRegion.start))
  const regionEnd = Math.max(regionStart, Math.min(100, anomalyRegion.end))
  const regionSamples = samples.filter((point) => point.travelPct >= regionStart && point.travelPct <= regionEnd)
  const anomalousSamples = regionSamples.filter((point) => point.current !== null && point.current > point.expectedUpper)
  const hasAnomaly = anomalousSamples.length > 0
  const peakPoint = anomalousSamples.reduce<SignalPoint | undefined>(
    (peak, point) => !peak || (point.current ?? 0) > (peak.current ?? 0) ? point : peak,
    undefined,
  )
  const maxValue = Math.max(4, ...samples.flatMap((point) => [point.current ?? 0, point.expectedUpper]), ...comparison.map((point) => point.current ?? 0))
  const yStep = maxValue <= 5.65 ? 1 : 2
  const yMax = Math.ceil((maxValue + 0.35) / yStep) * yStep
  const yTicks = Array.from({ length: Math.floor(yMax / yStep) + 1 }, (_, index) => index * yStep)
  const x = (travel: number) => LEFT + (travel / 100) * plotWidth
  const y = (current: number) => bottom - (current / yMax) * plotHeight
  const path = (data: readonly SignalPoint[], property: keyof Pick<SignalPoint, 'current' | 'expectedMedian' | 'expectedLower' | 'expectedUpper'>) => {
    let drawing = false
    return data.map((point) => {
      const value = point[property]
      if (value === null) {
        drawing = false
        return ''
      }
      const instruction = `${drawing ? 'L' : 'M'} ${x(point.travelPct).toFixed(2)} ${y(value).toFixed(2)}`
      drawing = true
      return instruction
    }).join(' ')
  }
  const observedArea = observedSegments(samples).map((segment) => `${path(segment, 'current')} L ${x(segment[segment.length - 1].travelPct)} ${bottom} L ${x(segment[0].travelPct)} ${bottom} Z`).join(' ')
  const bandPath = samples.length
    ? `${path(samples, 'expectedUpper')} ${[...samples].reverse().map((point) => `L ${x(point.travelPct).toFixed(2)} ${y(point.expectedLower).toFixed(2)}`).join(' ')} Z`
    : ''
  const activeIndex = samples.length && cursorTravel !== null ? closestIndex(samples, cursorTravel) : -1
  const activePoint = activeIndex >= 0 ? samples[activeIndex] : undefined
  const comparisonPoint = activePoint && comparison.length ? comparison[closestIndex(comparison, activePoint.travelPct)] : undefined
  const tooltipWidth = comparisonPoint ? 180 : 168
  const tooltipHeight = comparisonPoint ? 80 : 65
  const tooltipX = activePoint ? Math.max(LEFT + 4, Math.min(WIDTH - tooltipWidth - RIGHT, x(activePoint.travelPct) + (activePoint.travelPct > 64 ? -tooltipWidth - 13 : 13))) : 0
  const tooltipY = activePoint ? Math.max(top + 2, Math.min(bottom - tooltipHeight - 5, y(activePoint.current ?? activePoint.expectedMedian) - tooltipHeight / 2)) : 0
  const missingSamples = regionSamples.filter((point) => point.current === null).length
  const summary = samples.length
    ? `${doorId}, cycle ${cycleId}. Motor current across ${samples[0].travelPct} to ${samples[samples.length - 1].travelPct} percent door travel. ${hasAnomaly ? `Observed current exceeds the healthy envelope in the ${regionStart} to ${regionEnd} percent inspection region.` : missingSamples ? `${missingSamples} current samples are missing in the inspection region; this trace is incomplete.` : 'Observed current does not exceed the healthy envelope in the inspection region.'}${comparison.length ? ` The dashed purple trace shows ${comparisonLabel}.` : ''}${comparison.some((point) => point.current === null) ? ' Missing comparison samples appear as gaps.' : ''}`
    : `${doorId}, cycle ${cycleId}. No usable current samples are available.`

  function moveCursor(event: PointerEvent<SVGSVGElement>) {
    if (!samples.length) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const chartX = ((event.clientX - bounds.left) / bounds.width) * WIDTH
    const travel = Math.max(0, Math.min(100, ((chartX - LEFT) / plotWidth) * 100))
    setCursorTravel(travel)
  }

  function handleKey(event: KeyboardEvent<HTMLDivElement>) {
    if (!samples.length) return
    const index = activeIndex >= 0 ? activeIndex : closestIndex(samples, 70)
    const increment = event.shiftKey ? 5 : 1
    let nextIndex = index
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowUp': nextIndex = Math.min(samples.length - 1, index + increment); break
      case 'ArrowLeft':
      case 'ArrowDown': nextIndex = Math.max(0, index - increment); break
      case 'Home': nextIndex = 0; break
      case 'End': nextIndex = samples.length - 1; break
      case 'Escape': setCursorTravel(null); return
      default: return
    }
    event.preventDefault()
    setCursorTravel(samples[nextIndex].travelPct)
  }

  return (
    <div className={`signal-chart${large ? ' signal-chart--large' : ''}`}>
      <div className="signal-chart__measure">
        <span>MOTOR CURRENT <span className="signal-chart__unit">/ A</span></span>
        <span className={hasAnomaly ? 'signal-chart__region signal-chart__region--active' : 'signal-chart__region'}>
          <ScanLine size={11} aria-hidden="true" />
          {regionStart}–{regionEnd}% {hasAnomaly ? 'DEVIATION REGION' : 'INSPECTION REGION'}
        </span>
      </div>

      <div
        className="signal-chart__interaction"
        tabIndex={samples.length ? 0 : undefined}
        role={samples.length ? 'slider' : 'group'}
        aria-label={`${doorId} waveform cursor`}
        aria-describedby={`${id}-summary ${id}-instructions`}
        aria-valuemin={samples.length ? samples[0].travelPct : undefined}
        aria-valuemax={samples.length ? samples[samples.length - 1].travelPct : undefined}
        aria-valuenow={samples.length ? (activePoint?.travelPct ?? samples[closestIndex(samples, 70)].travelPct) : undefined}
        aria-valuetext={activePoint ? `${activePoint.travelPct}% travel; ${activePoint.current === null ? 'current sample missing' : `observed ${format(activePoint.current)} amperes`}; expected ${format(activePoint.expectedLower)} to ${format(activePoint.expectedUpper)} amperes${comparisonPoint ? `; ${comparisonLabel} ${comparisonPoint.current === null ? 'sample missing' : `${format(comparisonPoint.current)} amperes`}` : ''}` : undefined}
        onKeyDown={handleKey}
        onFocus={() => { setIsFocused(true); setCursorTravel((current) => current ?? 70) }}
        onBlur={() => { setIsFocused(false); setCursorTravel(null) }}
      >
        <svg
          className="signal-chart__svg"
          viewBox={`0 0 ${WIDTH} ${height}`}
          role="img"
          aria-labelledby={`${id}-title`}
          onPointerMove={moveCursor}
          onPointerDown={moveCursor}
          onPointerLeave={() => { if (!isFocused) setCursorTravel(null) }}
        >
          <title id={`${id}-title`}>Observed and expected motor current for {doorId}, cycle {cycleId}</title>
          <defs>
            <linearGradient id={`${id}-envelope`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#537a93" stopOpacity="0.29" />
              <stop offset="100%" stopColor="#537a93" stopOpacity="0.10" />
            </linearGradient>
            <linearGradient id={`${id}-area`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#41e0c3" stopOpacity="0.055" />
              <stop offset="100%" stopColor="#41e0c3" stopOpacity="0" />
            </linearGradient>
            <clipPath id={`${id}-plot`}><rect x={LEFT} y={top} width={plotWidth} height={plotHeight} /></clipPath>
            <clipPath id={`${id}-deviation`}>
              {anomalousSamples.map((point, index) => {
                const pointIndex = samples.indexOf(point)
                const previous = samples[Math.max(0, pointIndex - 1)]
                const next = samples[Math.min(samples.length - 1, pointIndex + 1)]
                const left = Math.max(regionStart, (previous.travelPct + point.travelPct) / 2)
                const right = Math.min(regionEnd, (next.travelPct + point.travelPct) / 2)
                return <rect key={index} x={x(left)} y={top} width={Math.max(0.1, x(right) - x(left))} height={plotHeight} />
              })}
            </clipPath>
          </defs>

          {yTicks.map((tick) => (
            <g key={tick}>
              <line x1={LEFT} x2={WIDTH - RIGHT} y1={y(tick)} y2={y(tick)} className="signal-chart__grid" />
              <text x={LEFT - 13} y={y(tick) + 3.5} textAnchor="end" className="signal-chart__axis">{tick.toFixed(1)}</text>
            </g>
          ))}
          {[0, 20, 40, 60, 80, 100].map((tick) => (
            <g key={tick}>
              <line x1={x(tick)} x2={x(tick)} y1={top} y2={bottom} className="signal-chart__grid signal-chart__grid--vertical" />
              <text x={x(tick)} y={bottom + 20} textAnchor="middle" className="signal-chart__axis">{tick}{tick === 100 ? '%' : ''}</text>
            </g>
          ))}

          <g clipPath={`url(#${id}-plot)`}>
            <rect x={x(regionStart)} y={top} width={x(regionEnd) - x(regionStart)} height={plotHeight} fill={hasAnomaly ? '#f4b861' : '#537a93'} opacity={hasAnomaly ? 0.055 : 0.035} />
            <line x1={x(regionStart)} x2={x(regionStart)} y1={top} y2={bottom} className={`signal-chart__region-edge${hasAnomaly ? ' signal-chart__region-edge--active' : ''}`} />
            <line x1={x(regionEnd)} x2={x(regionEnd)} y1={top} y2={bottom} className={`signal-chart__region-edge${hasAnomaly ? ' signal-chart__region-edge--active' : ''}`} />
            <path d={bandPath} fill={`url(#${id}-envelope)`} />
            <path d={path(samples, 'expectedUpper')} className="signal-chart__envelope-edge" />
            <path d={path(samples, 'expectedLower')} className="signal-chart__envelope-edge" />
            <path d={path(samples, 'expectedMedian')} className="signal-chart__median" />
            {comparison.length > 0 && <path d={path(comparison, 'current')} className="signal-chart__comparison" />}
            <g key={`${doorId}-${cycleId}-${revealKey ?? ''}`} className="signal-chart__reveal">
              {samples.length > 0 && <path d={observedArea} fill={`url(#${id}-area)`} />}
              <path d={path(samples, 'current')} className="signal-chart__observed signal-chart__observed--glow" />
              <path d={path(samples, 'current')} className="signal-chart__observed" />
              {hasAnomaly && <path d={path(samples, 'current')} className="signal-chart__observed signal-chart__observed--anomaly" clipPath={`url(#${id}-deviation)`} />}
            </g>
          </g>

          {!activePoint && peakPoint && peakPoint.current !== null && (
            <g className="signal-chart__peak" aria-hidden="true">
              <circle cx={x(peakPoint.travelPct)} cy={y(peakPoint.current)} r="3.6" fill="#f4b861" stroke="#111b22" strokeWidth="2" />
              <text x={x(peakPoint.travelPct)} y={Math.max(14, y(peakPoint.current) - 13)} textAnchor="middle" className="signal-chart__peak-label">{format(peakPoint.current)} A</text>
            </g>
          )}

          {activePoint && (
            <g className="signal-chart__cursor" aria-hidden="true">
              <line x1={x(activePoint.travelPct)} x2={x(activePoint.travelPct)} y1={top} y2={bottom} stroke="#b1c5cb" strokeOpacity="0.5" strokeDasharray="3 4" />
              {activePoint.current !== null && <><circle cx={x(activePoint.travelPct)} cy={y(activePoint.current)} r="6" fill="#41e0c3" fillOpacity="0.14" /><circle cx={x(activePoint.travelPct)} cy={y(activePoint.current)} r="3.5" fill={activePoint.current > activePoint.expectedUpper ? '#f4b861' : '#41e0c3'} stroke="#102126" strokeWidth="1.5" /></>}
              <circle cx={x(activePoint.travelPct)} cy={y(activePoint.expectedMedian)} r="2.5" fill="#80939c" />
              {comparisonPoint && comparisonPoint.current !== null && <circle cx={x(comparisonPoint.travelPct)} cy={y(comparisonPoint.current)} r="3" fill="#ad9ddd" />}
              <g transform={`translate(${tooltipX},${tooltipY})`}>
                <rect width={tooltipWidth} height={tooltipHeight} rx="7" className="signal-chart__tooltip-bg" />
                <text x="11" y="17" className="signal-chart__tooltip-title">{activePoint.travelPct}% DOOR TRAVEL</text>
                <text x="11" y="35" className="signal-chart__tooltip-label">Observed</text>
                <text x={tooltipWidth - 11} y="35" textAnchor="end" className="signal-chart__tooltip-observed">{activePoint.current === null ? 'No sample' : `${format(activePoint.current)} A`}</text>
                <text x="11" y="51" className="signal-chart__tooltip-label">{syntheticEnvelope ? 'Reference range' : 'Healthy range'}</text>
                <text x={tooltipWidth - 11} y="51" textAnchor="end" className="signal-chart__tooltip-value">{format(activePoint.expectedLower)}–{format(activePoint.expectedUpper)} A</text>
                {comparisonPoint && <><text x="11" y="67" className="signal-chart__tooltip-label">{comparisonLabel}</text><text x={tooltipWidth - 11} y="67" textAnchor="end" className="signal-chart__tooltip-comparison">{comparisonPoint.current === null ? 'No sample' : `${format(comparisonPoint.current)} A`}</text></>}
              </g>
            </g>
          )}

          {missingSamples > 0 && !activePoint && <text x={x((regionStart + regionEnd) / 2)} y={top + 16} textAnchor="middle" className="signal-chart__empty">MISSING SAMPLES</text>}
          {!samples.length && <text x={WIDTH / 2} y={height / 2} textAnchor="middle" className="signal-chart__empty">No current samples available for this movement</text>}
        </svg>
        <span id={`${id}-instructions`} className="signal-chart__sr-only">Use arrow keys to inspect samples, Shift and an arrow to move five samples, Home or End to jump to an edge, and Escape to hide the cursor.</span>
      </div>

      <div className="signal-chart__footer">
        <div className="signal-chart__legend" aria-label="Chart legend">
          <span><i className="signal-chart__key signal-chart__key--observed" />Observed current</span>
          <span><i className="signal-chart__key signal-chart__key--median" />{syntheticEnvelope ? 'Reference median' : 'Expected median'}</span>
          <span><i className="signal-chart__key signal-chart__key--envelope" />{syntheticEnvelope ? 'Synthetic envelope' : '5th–95th percentile'}</span>
          {comparison.length > 0 && <span><i className="signal-chart__key signal-chart__key--comparison" />{comparisonLabel}</span>}
        </div>
        <span className="signal-chart__travel">DOOR TRAVEL</span>
      </div>

      <p id={`${id}-summary`} className="signal-chart__sr-only">{summary}</p>
      <details className="signal-chart__data">
        <summary><ChevronDown size={11} aria-hidden="true" />View signal data <span>· {samples.length} samples</span></summary>
        <div className="signal-chart__table-scroll" role="region" aria-label={`${doorId} signal samples`} tabIndex={0}>
          <table>
            <caption>{doorId} · {cycleId} · motor current in amperes</caption>
            <thead><tr><th scope="col">Travel</th><th scope="col">Observed</th><th scope="col">Reference</th><th scope="col">{syntheticEnvelope ? 'Lower bound' : '5th percentile'}</th><th scope="col">{syntheticEnvelope ? 'Upper bound' : '95th percentile'}</th>{comparison.length > 0 && <th scope="col">{comparisonLabel}</th>}</tr></thead>
            <tbody>{samples.map((point, index) => <tr key={`${point.travelPct}-${index}`}><th scope="row">{point.travelPct}%</th><td>{point.current === null ? 'No sample' : format(point.current)}</td><td>{format(point.expectedMedian)}</td><td>{format(point.expectedLower)}</td><td>{format(point.expectedUpper)}</td>{comparison.length > 0 && <td>{comparison[closestIndex(comparison, point.travelPct)].current === null ? 'No sample' : format(comparison[closestIndex(comparison, point.travelPct)].current)}</td>}</tr>)}</tbody>
          </table>
        </div>
      </details>
    </div>
  )
}

export default SignalChart
