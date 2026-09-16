import { lazy, Suspense } from 'react';
import { Activity, ArrowRight, Fingerprint, Focus, Info, LoaderCircle, ListFilter } from 'lucide-react';
import { evaluateCycleTrace, formatDirection, formatDoorStatus, getDoorTelemetry } from '../lib/replay';
import type { DemoScenario, DoorStatus, RailWitnessPrediction, ReplaySnapshot } from '../types/railwitness';
import { SignalChart } from '../components/telemetry/SignalChart';
import { PredictionCard } from '../components/railwitness/PredictionCard';
import './Overview.css';
const TrainScene = lazy(() => import('../components/train/TrainScene'));
const statusTone = (status: DoorStatus) => status === 'corroborated' ? 'red' : ['candidate', 'awaiting_verification', 'insufficient_evidence'].includes(status) ? 'amber' : '';
interface Props {
  snapshot: ReplaySnapshot;
  prediction: RailWitnessPrediction | null;
  selectedDoor: string;
  scenario: DemoScenario;
  revealing: boolean;
  resetKey: number;
  canReveal: boolean;
  onSelectDoor: (id: string) => void;
  onResetView: () => void;
  onAnalyze: () => void;
  onVerification: () => void;
  revealNext: () => void;
}
export function Overview({snapshot,prediction,selectedDoor,scenario,revealing,resetKey,canReveal,onSelectDoor,onResetView,onAnalyze,onVerification,revealNext}: Props) {
  const currentDoor = snapshot.doors.find(door => door.id === selectedDoor)!;
  const points = getDoorTelemetry(snapshot.currentCycle, selectedDoor);
  const evaluation = evaluateCycleTrace(snapshot.currentCycle, selectedDoor);
  const doorStatuses = Object.fromEntries(snapshot.doors.map(door => [door.id, door.status]));
  const candidateCycle = prediction ? snapshot.visibleCycles.find(cycle => cycle.id === prediction.issuedCycleId) : undefined;
  const comparisonCycle = snapshot.currentCycle.direction === 'close' && prediction?.verification && candidateCycle?.id !== snapshot.currentCycle.id ? candidateCycle : undefined;
  const attention = snapshot.doors.filter(door => !['normal', 'not_corroborated'].includes(door.status)).sort((a,b) => Number(b.status === 'corroborated') - Number(a.status === 'corroborated'));
  const signalPanel = () => <section className="panel signal-panel">
    <div className="panel-heading"><div className="heading-copy"><h2>Observed vs. expected</h2><p>Motor current · synthetic reference envelope</p></div>{<button className="text-link" onClick={() => onAnalyze()}>Explore signal <ArrowRight size={12} /></button>}</div>
    <div className="door-meta"><span className="door-chip">{selectedDoor}</span><span className={`status-pill ${statusTone(currentDoor.status)}`}>{formatDoorStatus(currentDoor.status).toUpperCase()}</span><span className="meta-separator" /><span>{formatDirection(snapshot.currentCycle.direction)}</span><span className="meta-separator" /><time className="mono cycle-timestamp">{snapshot.currentCycle.timestampLabel}</time></div>
    
    <div className="chart-box"><SignalChart syntheticEnvelope points={points} comparisonPoints={comparisonCycle ? getDoorTelemetry(comparisonCycle, selectedDoor) : undefined} comparisonLabel="Prediction cycle" doorId={selectedDoor} cycleId={snapshot.currentCycle.id} revealKey={`${snapshot.currentCycle.id}-${scenario}-${selectedDoor}`} /></div>
    {comparisonCycle && <p className="comparison-caption">Comparison: recorded prediction cycle {comparisonCycle.id} · {comparisonCycle.timestampLabel} SGT</p>}
    <div className="signal-footer"><div className="signal-stat"><span>EXPECTED AT 60–80%</span><strong>{evaluation.expectedMinimum?.toFixed(1) ?? '—'}–{evaluation.expectedMaximum?.toFixed(1) ?? '—'}<small>A</small></strong></div><div className="signal-stat"><span>OBSERVED PEAK IN REGION</span><strong className={evaluation.signaturePresent ? 'warning' : ''}>{evaluation.peakCurrent?.toFixed(1) ?? '—'}<small>A</small></strong></div><div className="signal-stat"><span>{evaluation.sufficientEvidence ? 'ABOVE UPPER ENVELOPE' : 'INTERVAL COMPLETENESS'}</span><strong className={evaluation.signaturePresent || !evaluation.sufficientEvidence ? 'warning' : ''}>{evaluation.sufficientEvidence ? `+${evaluation.deviationPct?.toFixed(0) ?? '0'}%` : `${evaluation.coveragePct}%`}</strong></div></div>
  </section>;

  return <><section className="panel hero-panel" aria-label="Train digital twin"><div className="digital-twin"><div className="hero-heading"><div><div className="eyebrow">FLEET DIGITAL TWIN</div><h2>Train 017 <span style={{ color: '#4d6370', fontWeight: 400 }}> / </span><span style={{ color: '#a1b1bb', fontWeight: 400, fontSize: 14 }}> NSL</span></h2><p className="train-subtitle"><span className="line-tag">NS</span>North–South Line<span style={{ color: '#445c6a' }}>·</span>3-car demonstration model</p></div><span className="live-twin"><span className="status-dot" />DIGITAL TWIN</span></div><div className="scene-wrap"><Suspense fallback={<div className="loading-scene"><LoaderCircle className="spin" size={24} />Loading digital twin</div>}><TrainScene selectedDoor={selectedDoor} onSelectDoor={onSelectDoor} doorStatuses={doorStatuses} resetKey={resetKey} /></Suspense></div><div className="hero-bottom"><div className="legend"><span><i />Normal</span><span><i className="warning" />Candidate</span><span><i className="critical" />Corroborated</span></div><button className="icon-button scene-reset" aria-label="Reset train view" title="Reset view" onClick={() => onResetView()}><Focus size={14} /></button></div></div>
      <aside className="fleet-status"><div className="fleet-status-head"><span className="eyebrow">SYSTEM HEALTH</span><Activity size={14} color="#79b09c" /></div><div className="health-metric"><strong>{snapshot.healthPct}</strong><span>%</span></div><div className="health-track" aria-hidden="true">{Array.from({ length: 24 }, (_, index) => <i key={index} className={index < Math.round(snapshot.healthPct * .24) ? 'on' : ''} />)}</div><div className="health-caption"><span className={`status-dot ${snapshot.advisoryCount ? 'amber' : ''}`} />{snapshot.advisoryCount ? 'Attention recommended' : 'Within expected range'}</div><div className="fleet-metrics"><div className="fleet-row"><span>Active advisories</span><strong className={snapshot.advisoryCount ? 'warning' : ''}>{String(snapshot.advisoryCount).padStart(2, '0')} {snapshot.advisoryCount > 0 && <span style={{ fontSize: 8 }}>↗</span>}</strong></div><div className="fleet-row"><span>Doors monitored</span><strong>24 <span style={{ color: '#617c8b', fontSize: 9 }}>/ 24</span></strong></div><div className="fleet-row"><span>Last telemetry</span><time>{snapshot.currentCycle.timestampLabel}</time></div></div><div className="fleet-quick-action">{prediction?.status === "awaiting" && <button className="button primary" onClick={revealNext} disabled={revealing}><Fingerprint size={12} />{revealing ? "Revealing evidence…" : "Test this prediction"}<ArrowRight size={12} /></button>}{!prediction && attention[0] && <button className="button" onClick={() => onSelectDoor(attention[0].id)} disabled={revealing}>Review advisory<ArrowRight size={12} /></button>}</div><div className="fleet-note"><Info size={12} /><span>Illustrative health index<br />Synthetic data · SGT</span></div></aside></section>
    <section className="attention-strip" aria-label="Attention queue">
      <div className="attention-title"><ListFilter size={14}/><span>ATTENTION QUEUE</span><strong>{attention.length}</strong></div>
      <div className="attention-items">{attention.length ? attention.map(door => <button key={door.id} disabled={revealing} className={`attention-item ${selectedDoor === door.id ? 'is-selected' : ''}`} aria-label={`Review ${door.id} advisory`} onClick={() => onSelectDoor(door.id)}><span className={`status-dot ${statusTone(door.status)}`}/><strong>{door.id}</strong><span>{formatDoorStatus(door.status)}</span><ArrowRight size={12}/></button>) : <p>No active advisories in the observed movements.</p>}</div>
      <button className="text-link" onClick={onVerification}>View evidence <ArrowRight size={12}/></button>
    </section>
    <div className="section-grid">{signalPanel()}<PredictionCard prediction={prediction} doorId={selectedDoor} onReveal={revealNext} revealing={revealing} canReveal={canReveal} onOpenVerification={onVerification} dataSufficient={evaluation.sufficientEvidence}/></div>
    <div className="overview-cutoff"><span>Snapshot at <strong>{snapshot.currentCycle.timestampLabel} SGT</strong> · {snapshot.currentCycle.id} · {snapshot.visibleCycles.length} observed movements</span><button className="text-link" onClick={onVerification}>Open chronological replay <ArrowRight size={12}/></button></div>
  </>;
}
