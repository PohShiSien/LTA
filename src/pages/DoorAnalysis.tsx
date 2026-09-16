import { useMemo, useState, type CSSProperties } from 'react';
import { ArrowRight, Check, ChevronRight, Database, Fingerprint, History, Info, ScanLine, ShieldCheck, X } from 'lucide-react';
import { DOOR_IDS } from '../data/mockTelemetry';
import { getDoorTelemetry } from '../lib/replay';
import { getBaselineProvenance, getDoorHistory } from '../lib/diagnostics';
import type { DoorTelemetryPoint, RailWitnessPrediction, TelemetryCycle } from '../types/railwitness';
import { SignalChart } from '../components/telemetry/SignalChart';
import './DoorAnalysis.css';

export interface DoorAnalysisProps {
  visibleCycles: TelemetryCycle[];
  selectedDoor: string;
  onSelectDoor: (doorId: string) => void;
  predictions: RailWitnessPrediction[];
  onOpenVerification: (doorId: string) => void;
}

const formatNumber = (value: number | null, digits = 1) => value === null || !Number.isFinite(value) ? '—' : value.toFixed(digits);
const BINS = Array.from({ length: 20 }, (_, index) => index * 5);

function heatmapCells(points: readonly DoorTelemetryPoint[], sampleStepPct: number) {
  return BINS.map(start => {
    const isInBin = (travel: number) => travel >= start && (start === 95 ? travel <= 100 : travel < start + 5);
    const samples = points.filter(point => isInBin(point.travelPct));
    const expectedCount = Array.from({ length: Math.floor(100 / sampleStepPct) + 1 }, (_, index) => index * sampleStepPct).filter(isInBin).length;
    const observed = [...new Map(samples.map(point => [point.travelPct, point])).values()].filter((point): point is DoorTelemetryPoint & { current: number } => point.current !== null && Number.isFinite(point.current) && Number.isFinite(point.expectedUpper) && Number.isFinite(point.expectedLower) && point.expectedUpper >= point.expectedLower && point.travelPct % sampleStepPct === 0);
    const missing = observed.length < expectedCount;
    const excess = observed.length ? Math.max(0, ...observed.map(point => (point.current - point.expectedUpper) / Math.max(point.expectedUpper, 0.01))) : null;
    const below = observed.some(point => point.current < point.expectedLower);
    const tone = excess === null ? 'missing' : excess > 0.15 ? 'high' : excess > 0 ? 'excess' : below ? 'below' : 'within';
    const description = excess === null ? 'No usable samples' : excess > 0 ? `${(excess * 100).toFixed(1)}% maximum upper-envelope excess` : below ? 'Below lower envelope' : 'Within synthetic envelope';
    return { start, tone, missing, description: `${start}–${start + 5}% travel: ${description}${missing && excess !== null ? '; partial samples' : ''}` };
  });
}

function MiniTrend({ values, label, unit }: { values: (number | null)[]; label: string; unit: string }) {
  const usable = values.filter((value): value is number => value !== null && Number.isFinite(value));
  const maximum = Math.max(1, ...usable);
  const last = values.at(-1) ?? null;
  const x = (index: number) => values.length > 1 ? 5 + index / (values.length - 1) * 160 : 85;
  const y = (value: number) => 43 - value / maximum * 32;
  let inSegment = false;
  const path = values.map((value, index) => {
    if (value === null || !Number.isFinite(value)) { inSegment = false; return ''; }
    const segment = `${inSegment ? 'L' : 'M'}${x(index)},${y(value)}`;
    inSegment = true;
    return segment;
  }).join(' ');
  return <div className="da-trend">
    <div className="da-trend-label"><span>{label}</span><strong>{formatNumber(last)}<small>{unit}</small></strong></div>
    <svg viewBox="0 0 170 52" role="img" aria-label={`${label} by observed closing cycle, oldest to newest: ${values.map(value => value === null ? 'unavailable' : `${value.toFixed(1)} ${unit}`).join(', ')}`}>
      <path className="da-trend-guide" d="M5,43H165" /><path className="da-trend-line" d={path} />
      {values.map((value, index) => value === null ? <path key={index} className="da-trend-gap" d={`M${x(index) - 2},41l4,4m0,-4l-4,4`} /> : <circle key={index} cx={x(index)} cy={y(value)} r={index === values.length - 1 ? 3.2 : 2} />)}
    </svg>
  </div>;
}

function Criterion({ label, requirement, actual, passed }: { label: string; requirement: string; actual: string; passed: boolean | null }) {
  return <li className="da-criterion">
    <span className={`da-criterion-icon ${passed === null ? 'unknown' : passed ? 'pass' : 'fail'}`} aria-label={passed === null ? 'Unavailable' : passed ? 'Passed' : 'Not met'}>{passed === null ? <span>—</span> : passed ? <Check size={13} /> : <X size={13} />}</span>
    <div><strong>{label}</strong><span>{requirement}</span></div><b>{actual}</b>
  </li>;
}

/** Investigation is restricted to received cycles; selecting a row never seeks the session. */
export function DoorAnalysis({ visibleCycles, selectedDoor, onSelectDoor, predictions, onOpenVerification }: DoorAnalysisProps) {
  const [inspectedCycleId, setInspectedCycleId] = useState<string | null>(null);
  const [comparison, setComparison] = useState('prior');
  const baseline = getBaselineProvenance();
  const history = useMemo(() => getDoorHistory(visibleCycles, selectedDoor).filter(entry => entry.cycle.direction === 'close'), [visibleCycles, selectedDoor]);
  const selected = history.find(entry => entry.cycle.id === inspectedCycleId) ?? history.at(-1);
  const selectedIndex = selected ? history.indexOf(selected) : -1;
  const previous = selectedIndex > 0 ? history[selectedIndex - 1] : undefined;
  const points = selected ? getDoorTelemetry(selected.cycle, selectedDoor) : [];
  const evaluation = selected?.evaluation;
  const validHistory = history.filter(entry => entry.evaluation.sufficientEvidence);
  const recurring = validHistory.filter(entry => entry.evaluation.signaturePresent).length;
  const recurrence = validHistory.length ? Math.round(recurring / validHistory.length * 100) : null;
  const car = Math.floor(DOOR_IDS.indexOf(selectedDoor) / 8) + 1;
  const peers = DOOR_IDS.filter(id => id !== selectedDoor && Math.floor(DOOR_IDS.indexOf(id) / 8) + 1 === car);
  const peerDoor = comparison.startsWith('peer:') && peers.includes(comparison.slice(5)) ? comparison.slice(5) : null;
  const comparisonPoints = peerDoor && selected ? getDoorTelemetry(selected.cycle, peerDoor) : comparison === 'prior' && previous ? getDoorTelemetry(previous.cycle, selectedDoor) : undefined;
  const comparisonLabel = peerDoor && selected ? `${peerDoor} · ${selected.cycle.id} closing` : previous ? `${selectedDoor} · ${previous.cycle.id} prior closing` : 'Prior closing';
  const prediction = predictions.find(item => item.doorId === selectedDoor);
  const newest = visibleCycles.at(-1);
  const outcome = !evaluation?.sufficientEvidence ? 'Cannot assess' : evaluation.signaturePresent ? 'Persistent excess' : 'No persistent excess';
  const outcomeTone = !evaluation?.sufficientEvidence ? 'unknown' : evaluation.signaturePresent ? 'alert' : 'clear';

  return <div className="door-investigation">
    <section className="da-context" aria-label="Door investigation context">
      <div className="da-identity"><span className="da-door-mark"><ScanLine size={22} /></span><div><div className="eyebrow">Investigation workspace</div><h2>Door {selectedDoor}<span>CAR {String(car).padStart(2, '0')}</span></h2><p>Closing movements · Train 017</p></div></div>
      <div className="da-summary-metric"><span>Observed closings</span><strong>{history.length}<small>movements</small></strong><p>{history.length - validHistory.length} cannot be assessed</p></div>
      <div className="da-summary-metric"><span>Signature recurrence</span><strong className={recurring ? 'da-amber' : ''}>{recurrence === null ? '—' : `${recurrence}%`}<small>{recurring} / {validHistory.length}</small></strong><p>Among assessable closing movements</p></div>
      <div className="da-session-boundary"><span className="status-dot" /><div><span>Session observed through</span><strong>{newest?.id ?? '—'} · {newest?.timestampLabel ?? '—'}</strong><p>History includes received movements only</p></div></div>
    </section>

    <div className="da-history-layout">
      <section className="panel da-history-panel" aria-labelledby="da-history-title">
        <div className="da-panel-heading"><div><div className="eyebrow">01 / Pattern over time</div><h2 id="da-history-title">Cycle history</h2><p>Newest first. Select a movement to inspect its signal and criteria.</p></div><History size={18} /></div>
        <div className="da-heatmap-scroll" tabIndex={0} role="region" aria-label="Closing cycle history, horizontally scrollable on small screens">
          <div className="da-history-table">
            <div className="da-history-header"><span>Movement / time</span><span>DOOR TRAVEL <i>0%<b>60–80% interval</b>100%</i></span><span>Peak¹</span><span>Coverage¹</span></div>
            <div className="da-history-rows">
              {[...history].reverse().map(entry => <button type="button" key={entry.cycle.id} className={`da-history-row ${entry.cycle.id === selected?.cycle.id ? 'selected' : ''}`} aria-pressed={entry.cycle.id === selected?.cycle.id} aria-label={`Inspect ${entry.cycle.id}, ${entry.cycle.timestampLabel}, ${!entry.evaluation.sufficientEvidence ? 'cannot assess' : entry.evaluation.signaturePresent ? 'persistent excess' : 'no persistent excess'}, interval coverage ${entry.evaluation.coveragePct}%`} onClick={() => setInspectedCycleId(entry.cycle.id)}>
                <span className="da-row-id"><strong>{entry.cycle.id}<ChevronRight size={11} /></strong><time>{entry.cycle.timestampLabel}</time></span>
                <span className="da-heatmap" aria-hidden="true">{heatmapCells(getDoorTelemetry(entry.cycle, selectedDoor), baseline.sampleStepPct).map(cell => <span key={cell.start} title={cell.description} className={`da-heat-cell ${cell.tone}${cell.missing ? ' partial' : ''}${cell.start >= 60 && cell.start < 80 ? ' target' : ''}`} />)}</span>
                <span className={entry.evaluation.signaturePresent ? 'da-amber' : ''}>{formatNumber(entry.evaluation.peakCurrent, 2)}<small>A</small></span><span className={!entry.evaluation.sufficientEvidence ? 'da-amber' : ''}>{entry.evaluation.coveragePct}%</span>
              </button>)}
              {!history.length && <p className="da-empty">No closing movement has been received for this session yet.</p>}
            </div>
          </div>
        </div>
        <div className="da-heatmap-legend"><span><i className="within" />Within envelope</span><span><i className="below" />Below</span><span><i className="excess" />0–15% above</span><span><i className="high" />&gt;15% above</span><span><i className="missing" />Missing / partial</span></div>
        <p className="da-panel-note">Each cell summarizes 5% travel. Color shows maximum upper-envelope excess; hatching marks incomplete samples. ¹ Measured at {baseline.regionStartPct}–{baseline.regionEndPct}% travel.</p>
      </section>

      <aside className="panel da-trends-panel" aria-labelledby="da-trends-title">
        <div className="da-panel-heading"><div><div className="eyebrow">Observed trend</div><h2 id="da-trends-title">Is the pattern changing?</h2></div></div>
        <MiniTrend values={history.map(entry => entry.evaluation.sufficientEvidence ? entry.evaluation.deviationPct : null)} label="Maximum excess¹" unit="%" />
        <MiniTrend values={history.map(entry => entry.evaluation.peakCurrent)} label="Observed peak¹" unit="A" />
        <MiniTrend values={history.map(entry => entry.durationMs === null ? null : entry.durationMs / 1000)} label="Closing duration" unit="s" />
        <p className="da-panel-note">Oldest → newest. Crosses are unavailable values. Duration uses the first and last telemetry timestamps. ¹ Predicted interval.</p>
      </aside>
    </div>

    {selected && evaluation && <>
      <div className="da-inspection-divider"><span className="eyebrow">02 / Inspect one movement</span><p>Selected <strong>{selected.cycle.id}</strong> at {selected.cycle.timestampLabel} · Session remains at {newest?.id}</p></div>
      <div className="da-detail-layout">
        <section className="panel da-trace-panel" aria-labelledby="da-trace-title">
          <div className="da-panel-heading"><div><h2 id="da-trace-title">Compare the observed signal</h2><p>{selectedDoor} · {selected.cycle.id} · closing movement</p></div><span className={`da-outcome ${outcomeTone}`}>{outcome}</span></div>
          <div className="da-comparison-controls"><label htmlFor="da-comparison">Overlay<select id="da-comparison" className="select-input" value={peerDoor ? comparison : comparison.startsWith('peer:') || (comparison === 'prior' && !previous) ? 'none' : comparison} onChange={event => setComparison(event.target.value)}><option value="none">Synthetic baseline only</option><option value="prior" disabled={!previous}>Previous closing{previous ? ` · ${previous.cycle.id}` : ' · unavailable'}</option><optgroup label={`Peer door · car ${car}, same closing movement`}>{peers.map(id => <option key={id} value={`peer:${id}`}>{id} · same movement</option>)}</optgroup></select></label>{peerDoor && <button className="text-link" onClick={() => onSelectDoor(peerDoor)}>Inspect {peerDoor}<ArrowRight size={12} /></button>}</div>
          <div className="da-chart-wrap"><SignalChart syntheticEnvelope points={points} comparisonPoints={comparisonPoints} comparisonLabel={comparisonLabel} doorId={selectedDoor} cycleId={selected.cycle.id} anomalyRegion={{ start: baseline.regionStartPct, end: baseline.regionEndPct }} large /></div>
          <p className="da-comparison-note">{peerDoor ? `Peer ${peerDoor} is from the same car and observed closing movement. Operating load and environment are not recorded.` : comparison === 'prior' && previous ? `Dashed overlay: ${selectedDoor}, ${previous.cycle.id} at ${previous.cycle.timestampLabel}. Both traces use normalized door travel.` : 'The shaded band is the synthetic reference envelope. No additional observed trace is overlaid.'}</p>
          <div className="da-cycle-stats"><div><span>Deviation index¹</span><strong>{evaluation.sufficientEvidence ? evaluation.anomalyScore : '—'}<small>/100</small></strong></div><div><span>Interval peak</span><strong>{formatNumber(evaluation.peakCurrent, 2)}<small>A</small></strong></div><div><span>Closing duration</span><strong>{formatNumber(selected.durationMs === null ? null : selected.durationMs / 1000, 2)}<small>s</small></strong></div></div>
          <p className="da-panel-note">¹ Descriptive departure from the envelope, not a fault probability. A missing score means the evidence cannot support an assessment.</p>
        </section>

        <section className="panel da-criteria-panel" aria-labelledby="da-criteria-title">
          <div className="da-panel-heading"><div><div className="eyebrow">Explain the assessment</div><h2 id="da-criteria-title">Signature criteria</h2><p>{baseline.regionStartPct}–{baseline.regionEndPct}% closing travel</p></div><Fingerprint size={18} /></div>
          <div className={`da-verdict ${outcomeTone}`}><strong>{outcome}</strong><p>{!evaluation.sufficientEvidence ? 'Insufficient coverage or a data integrity issue prevents assessment.' : evaluation.signaturePresent ? 'The received signal meets all persistence thresholds in this movement.' : 'The received signal does not meet every persistence threshold.'}</p></div>
          <ul className="da-criteria-list">
            <Criterion label="Sample coverage" requirement={`At least ${baseline.minimumCoveragePct}% of the interval grid`} actual={`${evaluation.sampleCount}/${evaluation.requiredSampleCount} · ${evaluation.coveragePct}%`} passed={evaluation.coveragePct >= baseline.minimumCoveragePct} />
            <Criterion label="Consecutive excess" requirement={`At least ${baseline.minimumConsecutiveExcess} adjacent samples above envelope`} actual={`${evaluation.maxConsecutiveExcess} samples`} passed={evaluation.sufficientEvidence ? evaluation.maxConsecutiveExcess >= baseline.minimumConsecutiveExcess : null} />
            <Criterion label="Interval persistence" requirement={`At least ${Math.round(baseline.minimumExcessFraction * 100)}% of observed samples above envelope`} actual={evaluation.sampleCount ? `${Math.round(evaluation.excessFraction * 100)}%` : '—'} passed={evaluation.sufficientEvidence ? evaluation.excessFraction >= baseline.minimumExcessFraction : null} />
          </ul>
          <p className="da-criteria-explanation"><Info size={13} />A high peak alone cannot establish a persistent signature. Coverage and data integrity must be adequate before the persistence checks can be interpreted.</p>
          <div className="da-verification-link"><div><strong>{prediction ? 'Prediction record available' : 'No prediction issued for this door'}</strong><p>{prediction ? 'Review the original claim and subsequent assessment attempts.' : 'This observed history has not triggered a persistent closing signature.'}</p></div><button className="button small" onClick={() => onOpenVerification(selectedDoor)}>Evidence record<ArrowRight size={12} /></button></div>
        </section>
      </div>

      <div className="da-trust-layout">
        <section className="panel da-quality-panel" aria-labelledby="da-quality-title">
          <div className="da-panel-heading"><div><h2 id="da-quality-title"><ShieldCheck size={15} />Data quality · {selected.cycle.id}</h2><p>Integrity checks for the selected movement</p></div><span className={`da-outcome ${evaluation.sufficientEvidence ? 'clear' : 'unknown'}`}>{evaluation.sufficientEvidence ? 'Assessable' : 'Cannot assess'}</span></div>
          <div className="da-quality-coverage"><div><span>Interval sample coverage</span><strong>{evaluation.coveragePct}%</strong></div><div className="da-coverage-track" role="meter" aria-label="Interval sample coverage" aria-valuemin={0} aria-valuemax={100} aria-valuenow={evaluation.coveragePct} style={{ '--coverage': `${evaluation.coveragePct}%`, '--threshold': `${baseline.minimumCoveragePct}%` } as CSSProperties}><span /><i /></div><p>{evaluation.sampleCount} of {evaluation.requiredSampleCount} grid positions observed · threshold {baseline.minimumCoveragePct}%</p></div>
          <ul className="da-quality-issues">{evaluation.qualityIssues.length ? evaluation.qualityIssues.map(issue => <li key={issue}><Info size={12} />{issue}</li>) : <li><Check size={13} />No sample, timestamp, or envelope integrity issues detected.</li>}</ul>
          <p className="da-panel-note">Freshness is relative to this recorded session. Live sensor latency and connectivity are not available.</p>
        </section>
        <section className="panel da-baseline-panel" aria-labelledby="da-baseline-title">
          <div className="da-panel-heading"><div><h2 id="da-baseline-title"><Database size={15} />Baseline provenance</h2><p>Reference used by every comparison and criterion</p></div><span className="da-source-tag">SYNTHETIC</span></div>
          <dl className="da-provenance"><div><dt>Reference version</dt><dd>{baseline.version}</dd></div><div><dt>Source</dt><dd>{baseline.source}</dd></div><div><dt>Method</dt><dd>{baseline.method}</dd></div><div><dt>Units / grid</dt><dd>{baseline.sampleStepPct}% travel spacing · {baseline.units}</dd></div></dl>
          <p className="da-panel-note">Reference envelopes are fixture values. Operational validation and independently labelled inspection outcomes are still required.</p>
        </section>
      </div>
    </>}
  </div>;
}
