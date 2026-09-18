import { useEffect, useId, useMemo, useRef, useState, type MouseEvent } from 'react';
import { Activity, AlertTriangle, ArrowRight, Info, LoaderCircle, RefreshCw } from 'lucide-react';
import type { DoorCycleDetail, DoorPoint } from '../../lib/railwitnessDoorClient';
import { clampDoorProgress } from '../../lib/doorReplay';
import './DoorCycleEvidence.css';

export interface DoorCycleEvidenceProps {
  detail: DoorCycleDetail | null;
  loading: boolean;
  error: string;
  sourceName: string;
  cycleNumber: number | null;
  onRetry: () => void;
  replayProgress?: number;
  concealResult?: boolean;
}

type Trace = 'current_A' | 'voltage_V' | 'position_raw';
type PlotPoint = { fraction: number; value: number | null };
const TRACES: Record<Trace, { label: string; unit: string }> = {
  current_A: { label: 'Motor current', unit: 'A' },
  voltage_V: { label: 'Motor voltage', unit: 'V' },
  position_raw: { label: 'Recorded position', unit: 'raw dataset units' },
};
const PLOT = { width: 760, height: 254, left: 56, right: 19, top: 18, bottom: 54 };
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const rawNumber = (value: unknown): string => finite(value) ? String(value) : 'Unavailable';
function tickNumber(value: number): string {
  if (value !== 0 && (Math.abs(value) < .001 || Math.abs(value) >= 10000)) return value.toExponential(1);
  return Number(value.toPrecision(4)).toString();
}
function linePath(points: PlotPoint[], x: (value: number) => number, y: (value: number) => number): string {
  let connected = false;
  return points.map(point => {
    if (!finite(point.fraction) || !finite(point.value) || point.fraction < 0 || point.fraction > 1) {
      connected = false;
      return '';
    }
    const command = connected ? 'L' : 'M';
    connected = true;
    return `${command}${x(point.fraction).toFixed(2)},${y(point.value).toFixed(2)}`;
  }).join(' ');
}

function CycleChart({ detail, trace, cursor, onCursor, replayProgress = 1, replaying = false }: {
  detail: DoorCycleDetail; trace: Trace; cursor: number; onCursor: (value: number) => void;
  replayProgress?: number; replaying?: boolean;
}) {
  const titleId = useId();
  const clipId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const [chartWidth, setChartWidth] = useState(PLOT.width);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const resize = () => setChartWidth(Math.max(280, Math.round(container.getBoundingClientRect().width)));
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);
  const { label, unit } = TRACES[trace];
  const reference = trace === 'current_A' ? detail.reference : null;
  const chart = useMemo(() => {
    const observed: PlotPoint[] = detail.points.map(point => ({ fraction: point.elapsed_fraction, value: point[trace] }));
    const lower: PlotPoint[] = reference?.elapsed_fraction.map((fraction, index) => ({ fraction, value: reference.lower_A[index] ?? null })) ?? [];
    const median: PlotPoint[] = reference?.elapsed_fraction.map((fraction, index) => ({ fraction, value: reference.median_A[index] ?? null })) ?? [];
    const upper: PlotPoint[] = reference?.elapsed_fraction.map((fraction, index) => ({ fraction, value: reference.upper_A[index] ?? null })) ?? [];
    const all = [...observed, ...lower, ...median, ...upper].filter(point => finite(point.fraction) && point.fraction >= 0 && point.fraction <= 1 && finite(point.value));
    let minimum = all.length ? Math.min(...all.map(point => point.value as number)) : 0;
    let maximum = all.length ? Math.max(...all.map(point => point.value as number)) : 1;
    const padding = (maximum - minimum || Math.abs(maximum) || 1) * .12;
    minimum -= padding;
    maximum += padding;
    const x = (fraction: number) => PLOT.left + fraction * (chartWidth - PLOT.left - PLOT.right);
    const y = (value: number) => PLOT.top + (maximum - value) / (maximum - minimum) * (PLOT.height - PLOT.top - PLOT.bottom);
    // A missing reference point breaks the band, rather than filling a gap with invented data.
    const bands: string[] = [];
    let run: number[] = [];
    const closeBand = () => {
      if (run.length > 1) {
        bands.push(`${run.map((index, offset) => `${offset ? 'L' : 'M'}${x(lower[index].fraction)},${y(lower[index].value!)}`).join(' ')} ${[...run].reverse().map(index => `L${x(upper[index].fraction)},${y(upper[index].value!)}`).join(' ')} Z`);
      }
      run = [];
    };
    lower.forEach((point, index) => {
      if (finite(point.fraction) && point.fraction >= 0 && point.fraction <= 1 && finite(point.value) && finite(upper[index]?.value)) run.push(index);
      else closeBand();
    });
    closeBand();
    return { x, y, minimum, maximum, observed: linePath(observed, x, y), lower: linePath(lower, x, y), median: linePath(median, x, y), upper: linePath(upper, x, y), bands };
  }, [chartWidth, detail.points, reference, trace]);
  const selected = detail.points[cursor];
  const selectPoint = (event: MouseEvent<SVGSVGElement>) => {
    if (!detail.points.length || replaying) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const fraction = ((event.clientX - bounds.left) / bounds.width * chartWidth - PLOT.left) / (chartWidth - PLOT.left - PLOT.right);
    let nearest = -1;
    let distance = Infinity;
    detail.points.forEach((point, index) => {
      if (finite(point.elapsed_fraction) && Math.abs(point.elapsed_fraction - fraction) < distance) {
        nearest = index;
        distance = Math.abs(point.elapsed_fraction - fraction);
      }
    });
    if (nearest >= 0) onCursor(nearest);
  };
  return <div className="door-evidence-chart" ref={containerRef}>
    <div className="door-evidence-chart-heading"><strong>{label} <span>· {unit}</span></strong><span>Recorded</span></div>
    {chart.observed ? <svg viewBox={`0 0 ${chartWidth} ${PLOT.height}`} role="img" aria-labelledby={titleId} onClick={selectPoint}>
      <title id={titleId}>{`${label} in ${unit} against elapsed cycle time (%).${replaying ? ' Recorded signals are revealed in sync with the illustrative movement.' : ' Use the sample slider below to inspect recorded values.'}${reference ? ' Lower, median and upper lines show descriptive 5th, 50th and 95th percentiles of Normal training cycles.' : ''}`}</title>
      <defs><clipPath id={clipId}><rect x={PLOT.left - 2} y={PLOT.top - 3} width={(chartWidth - PLOT.left - PLOT.right) * clampDoorProgress(replayProgress) + 2} height={PLOT.height - PLOT.top - PLOT.bottom + 6} /></clipPath></defs>
      {[0, .25, .5, .75, 1].map(fraction => <g key={`y${fraction}`}>
        <line className="door-chart-grid" x1={PLOT.left} x2={chartWidth - PLOT.right} y1={chart.y(chart.minimum + fraction * (chart.maximum - chart.minimum))} y2={chart.y(chart.minimum + fraction * (chart.maximum - chart.minimum))} />
        <text x={PLOT.left - 9} y={chart.y(chart.minimum + fraction * (chart.maximum - chart.minimum)) + 3} textAnchor="end">{tickNumber(chart.minimum + fraction * (chart.maximum - chart.minimum))}</text>
      </g>)}
      {[0, .25, .5, .75, 1].map(fraction => <g key={`x${fraction}`}>
        <line className="door-chart-grid vertical" x1={chart.x(fraction)} x2={chart.x(fraction)} y1={PLOT.top} y2={PLOT.height - PLOT.bottom} />
        <text x={chart.x(fraction)} y={PLOT.height - PLOT.bottom + 20} textAnchor="middle">{fraction * 100}</text>
      </g>)}
      {chart.bands.map((path, index) => <path className="door-chart-reference-band" d={path} key={index} />)}
      {chart.lower && <path className="door-chart-reference-bound lower" d={chart.lower} />}
      {chart.median && <path className="door-chart-reference-median" d={chart.median} />}
      {chart.upper && <path className="door-chart-reference-bound upper" d={chart.upper} />}
      <path className="door-chart-observed" d={chart.observed} clipPath={`url(#${clipId})`} />
      {selected && finite(selected.elapsed_fraction) && selected.elapsed_fraction >= 0 && selected.elapsed_fraction <= clampDoorProgress(replayProgress) && <g className="door-chart-cursor">
        <line x1={chart.x(replaying ? replayProgress : selected.elapsed_fraction)} x2={chart.x(replaying ? replayProgress : selected.elapsed_fraction)} y1={PLOT.top} y2={PLOT.height - PLOT.bottom} />
        {finite(selected[trace]) && <circle cx={chart.x(selected.elapsed_fraction)} cy={chart.y(selected[trace])} r="3.5" />}
      </g>}
      <text className="door-chart-axis-label" x={(PLOT.left + chartWidth - PLOT.right) / 2} y={PLOT.height - 8} textAnchor="middle">Elapsed cycle time (%)</text>
    </svg> : <div className="door-evidence-chart-empty">No finite recorded {label.toLowerCase()} points available.</div>}
    <div className="door-evidence-legend"><span><i className="observed" />Recorded {label.toLowerCase()}</span>{reference && <><span><i className="lower" />Normal lower · 5th</span><span><i className="median" />Normal median</span><span><i className="upper" />Normal upper · 95th</span></>}</div>
  </div>;
}

function PointReadout({ point }: { point: DoorPoint | undefined }) {
  return <dl className="door-evidence-point-values">
    <div><dt>Elapsed time</dt><dd>{rawNumber(point?.elapsed_s)} <small>s</small></dd></div>
    <div><dt>Current</dt><dd>{rawNumber(point?.current_A)} <small>A</small></dd></div>
    <div><dt>Voltage</dt><dd>{rawNumber(point?.voltage_V)} <small>V</small></dd></div>
    <div><dt>Position</dt><dd>{rawNumber(point?.position_raw)} <small>raw dataset units</small></dd></div>
  </dl>;
}

function LoadedEvidence({ detail, sourceName, cycleNumber, replayProgress = 1, concealResult = false }: { detail: DoorCycleDetail; sourceName: string; cycleNumber: number | null; replayProgress?: number; concealResult?: boolean }) {
  const [trace, setTrace] = useState<Trace>('current_A');
  const [manualCursor, setCursor] = useState(0);
  const cursorId = useId();
  const { segment } = detail;
  const fraction = clampDoorProgress(replayProgress);
  const previousFraction = useRef(fraction);
  useEffect(() => {
    if (previousFraction.current < 1 && fraction >= 1) setCursor(Math.max(0, detail.points.length - 1));
    previousFraction.current = fraction;
  }, [fraction, detail.points.length]);
  const hidden = concealResult || fraction < 1;
  const replayCursor = detail.points.reduce((found, point, index) => point.elapsed_fraction <= fraction ? index : found, -1);
  const cursor = hidden ? replayCursor : manualCursor;
  const point = detail.points[cursor];
  const strongest = [...detail.explanations].filter(item => finite(item.log_odds_contribution)).sort((a, b) => Math.abs(b.log_odds_contribution) - Math.abs(a.log_odds_contribution)).slice(0, 6);
  const contributionMaximum = Math.max(...strongest.map(item => Math.abs(item.log_odds_contribution)), 1e-12);
  const abnormal = segment.prediction === 'Abnormal resistance';
  return <>
    <header className="door-evidence-heading">
      <div><div className="door-evidence-eyebrow"><Activity size={12} aria-hidden="true" />Recorded cycle evidence</div><h2>Cycle {cycleNumber ?? segment.cycle_index + 1}</h2><p className="door-evidence-source">{sourceName}</p></div>
      <div className={`door-evidence-classification${hidden ? ' pending' : abnormal ? ' abnormal' : ''}`}><span>{hidden ? 'Recorded replay' : 'Classification'}</span><strong>{hidden ? 'Awaiting cycle completion' : segment.prediction}</strong></div>
    </header>
    <div className="door-evidence-location"><Info size={13} aria-hidden="true" /><span>Illustrative location; physical asset metadata unavailable. Cycle numbers identify recorded segments only.</span></div>
    <dl className="door-evidence-metrics">
      <div><dt>Operation · inferred</dt><dd>{segment.operation_inferred}</dd></div>
      <div><dt>Duration · recorded</dt><dd>{rawNumber(segment.duration_s)} <small>s</small></dd></div>
      <div><dt>Source rows</dt><dd>{segment.n_rows.toLocaleString()}</dd></div>
      <div><dt>Uncalibrated model score</dt><dd className="door-evidence-score" title={hidden ? undefined : rawNumber(segment.abnormal_model_score)}>{hidden ? 'Available after replay' : rawNumber(segment.abnormal_model_score)}</dd></div>
    </dl>
    <p className="door-evidence-score-note">{hidden ? 'The frozen model classifies completed recorded cycles. The result is revealed at the end of this movement.' : segment.score_description}</p>
    <div className="door-evidence-time"><span>Start <time>{segment.start_time}</time></span><ArrowRight size={12} aria-hidden="true" /><span>End <time>{segment.end_time}</time></span></div>
    <div className="door-evidence-body">
      <div className="door-evidence-signals">
        <div className="door-evidence-section-heading"><h3>Recorded signal evidence</h3><div className="door-evidence-traces" role="group" aria-label="Cycle evidence signal">{(Object.keys(TRACES) as Trace[]).map(key => <button key={key} className={trace === key ? 'active' : ''} aria-pressed={trace === key} onClick={() => setTrace(key)}>{key === 'current_A' ? 'Current' : key === 'voltage_V' ? 'Voltage' : 'Position'}</button>)}</div></div>
        <CycleChart detail={detail} trace={trace} cursor={cursor} onCursor={setCursor} replayProgress={fraction} replaying={hidden} />
        {detail.points.length > 0 && <>
          <div className="door-evidence-cursor"><label htmlFor={cursorId}>Displayed sample <strong>{cursor + 1} / {detail.points.length}</strong></label><input id={cursorId} type="range" min="0" max={Math.max(0, detail.points.length - 1)} value={Math.max(0, cursor)} onChange={event => setCursor(Number(event.target.value))} aria-label="Cycle evidence sample" aria-valuetext={`Sample ${cursor + 1}; ${rawNumber(point?.elapsed_s)} seconds elapsed`} disabled={hidden || detail.points.length < 2} /><span>{hidden ? tickNumber(fraction * 100) : finite(point?.elapsed_fraction) ? tickNumber(point.elapsed_fraction * 100) : '—'}%</span></div>
          <PointReadout point={point} />
        </>}
        <p className="door-evidence-caption">{detail.display_downsampled ? 'The backend downsampled these display points. Prediction uses the complete recorded cycle.' : 'The backend returned every recorded point in this cycle.'} Current is already in amperes; voltage is already in volts. Position retains raw dataset units.</p>
        <div className="door-evidence-reference">
          <h4>Empirical Normal reference · inferred {segment.operation_inferred}</h4>
          <p>{detail.reference ? `5th, 50th and 95th current percentiles from ${detail.reference.n_normal_training_cycles} Normal training cycles, grouped by inferred Open/Close operation.` : 'No Normal training reference is available for this inferred operation.'}</p>
          <p>Descriptive comparison only; the band is not a calibrated prediction interval or the classifier threshold.</p>
          <details><summary>Reference method and limitations</summary><p>{detail.reference_method}</p><p>{detail.reference_limitation}</p></details>
          {detail.reference && <details><summary>Inspect returned reference values</summary><div className="door-evidence-table-scroll" tabIndex={0} role="region" aria-label="Empirical Normal training reference values"><table><caption>Empirical current percentiles at each normalized elapsed-time coordinate.</caption><thead><tr><th scope="col">Elapsed fraction</th><th scope="col">5th (A)</th><th scope="col">Median (A)</th><th scope="col">95th (A)</th></tr></thead><tbody>{detail.reference.elapsed_fraction.map((fraction, index) => <tr key={index}><td>{rawNumber(fraction)}</td><td>{rawNumber(detail.reference!.lower_A[index])}</td><td>{rawNumber(detail.reference!.median_A[index])}</td><td>{rawNumber(detail.reference!.upper_A[index])}</td></tr>)}</tbody></table></div></details>}
        </div>
        <details className="door-evidence-raw"><summary>Inspect returned signal values ({hidden ? cursor + 1 : detail.points.length})</summary><div className="door-evidence-table-scroll" tabIndex={0} role="region" aria-label="Returned cycle signal values"><table><caption>{hidden ? 'Samples revealed so far in the recorded replay.' : 'Returned display points; units are supplied by the backend.'}</caption><thead><tr><th scope="col">Elapsed (s)</th><th scope="col">Elapsed fraction</th><th scope="col">Current (A)</th><th scope="col">Voltage (V)</th><th scope="col">Position (raw)</th></tr></thead><tbody>{detail.points.slice(0, hidden ? cursor + 1 : undefined).map((item, index) => <tr key={index} className={index === cursor ? 'selected' : ''}><td>{rawNumber(item.elapsed_s)}</td><td>{rawNumber(item.elapsed_fraction)}</td><td>{rawNumber(item.current_A)}</td><td>{rawNumber(item.voltage_V)}</td><td>{rawNumber(item.position_raw)}</td></tr>)}</tbody></table></div></details>
      </div>
      <aside className="door-evidence-reasoning">
        {hidden ? <div className="door-evidence-reveal-pending" role="status"><Activity size={20} aria-hidden="true" /><h3>Complete the recorded movement</h3><p>Classification, model contributions and recommendation appear when the cycle replay finishes.</p></div> : <>
        <div className="door-evidence-section-heading"><h3>Strongest feature contributions</h3><span>Model explanation</span></div>
        <p className="door-evidence-explanation-note">Positive contributions push toward Abnormal resistance. Negative contributions push toward Normal.</p>
        {strongest.length ? <ol className="door-evidence-contributions">{strongest.map(item => {
          const positive = item.log_odds_contribution > 0;
          const negative = item.log_odds_contribution < 0;
          return <li key={item.feature} className={positive ? 'positive' : negative ? 'negative' : 'neutral'}>
            <div><span title={item.feature}>{item.feature.replaceAll('_', ' ')}</span><strong title={String(item.log_odds_contribution)}>{positive ? '+' : ''}{rawNumber(item.log_odds_contribution)}</strong></div>
            <div className="door-contribution-track" aria-hidden="true"><i style={{ width: `${Math.abs(item.log_odds_contribution) / contributionMaximum * 50}%`, left: positive ? '50%' : `${50 - Math.abs(item.log_odds_contribution) / contributionMaximum * 50}%` }} /></div>
            <p>{positive ? 'Toward Abnormal resistance' : negative ? 'Toward Normal' : 'No directional contribution'} <span>· feature value {rawNumber(item.value)}</span></p>
          </li>;
        })}</ol> : <p className="door-evidence-caption">Signed contributions are unavailable for this cycle.</p>}
        <p className="door-evidence-caption">Contributions are in logistic log-odds units. {detail.explanation_method}</p>
        <details className="door-evidence-features"><summary>Full feature vector and model intercept</summary><dl>{Object.entries(detail.features).map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{rawNumber(value)}</dd></div>)}<div><dt>Model intercept · log-odds</dt><dd>{rawNumber(detail.model_intercept)}</dd></div></dl></details>
        </>}
        <section className={`door-evidence-quality${segment.data_quality_warnings.length ? ' has-warnings' : ''}`} aria-label="Cycle data quality"><h3>{segment.data_quality_warnings.length ? <AlertTriangle size={13} aria-hidden="true" /> : <Info size={13} aria-hidden="true" />}Data quality</h3>{segment.data_quality_warnings.length ? <ul>{segment.data_quality_warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul> : <p>No data-quality warnings reported by the backend.</p>}</section>
        {!hidden && <section className="door-evidence-advisory" aria-label="Advisory recommendation"><div className="door-evidence-eyebrow">Advisory recommendation</div><p>{segment.recommendation}</p><span>The classification does not identify a faulty mechanical component.</span></section>}
      </aside>
    </div>
  </>;
}

export default function DoorCycleEvidence({ detail, loading, error, sourceName, cycleNumber, onRetry, replayProgress, concealResult }: DoorCycleEvidenceProps) {
  return <section className="door-cycle-evidence" aria-label="Door cycle evidence" aria-busy={loading}>
    {loading ? <div className="door-evidence-placeholder" role="status"><LoaderCircle size={23} className="spin" aria-hidden="true" /><h2>Loading cycle {cycleNumber ?? ''} evidence</h2><p>Fetching the recorded signals and frozen-model explanation.</p></div>
      : error ? <div className="door-evidence-placeholder is-error" role="alert"><AlertTriangle size={23} aria-hidden="true" /><h2>Cycle evidence unavailable</h2><p>{error}</p><button className="ms-button small" onClick={onRetry}><RefreshCw size={12} aria-hidden="true" />Retry cycle details</button></div>
        : detail ? <LoadedEvidence key={`${sourceName}:${detail.segment.cycle_index}:${detail.segment.start_time}`} detail={detail} sourceName={sourceName} cycleNumber={cycleNumber} replayProgress={replayProgress} concealResult={concealResult} />
          : <div className="door-evidence-placeholder"><Activity size={23} aria-hidden="true" /><h2>Inspect a recorded cycle</h2><p>Select any Normal or Abnormal resistance cycle above to examine its signals and model explanation.</p></div>}
  </section>;
}
