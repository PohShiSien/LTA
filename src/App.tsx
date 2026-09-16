import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, ArrowDownToLine, ArrowRight, Box, Check, ChevronRight, CircleHelp, Database, FlaskConical, Globe2, LayoutDashboard, LoaderCircle, MousePointer2, ShieldCheck, X } from 'lucide-react';
import { ANOMALY_DOOR_ID, createDemoCycles, DOOR_IDS } from './data/mockTelemetry';
import { createReplayState, derivePrediction, getDoorTelemetry, getReplaySnapshot, reduceReplay } from './lib/replay';
import { parseReviewHistory, REVIEW_STORAGE_KEY, visibleReviews, type InspectionOutcome, type ReviewEvent } from './lib/reviewStore';
import type { DemoScenario, ReplayAction } from './types/railwitness';
import { Overview } from './pages/Overview';
import { DoorAnalysis } from './pages/DoorAnalysis';
import { Verification } from './pages/Verification';
import { EngineerReview } from './components/railwitness/EngineerReview';

type Page = 'overview' | 'analysis' | 'verification';
const pageFromHash = (): Page => location.hash === '#analysis' ? 'analysis' : ['#replay', '#verification'].includes(location.hash) ? 'verification' : 'overview';
const pageLabels: Record<Page, string> = { overview: 'Fleet overview', analysis: 'Door analysis', verification: 'Verification & replay' };
const pageDescriptions: Record<Page, string> = {
  overview: 'Current advisories. Evidence that helps you decide where to look.',
  analysis: 'Investigate the history, compare movements, and understand each assessment.',
  verification: 'An original prediction. An accountable record of the evidence that followed.',
};

function BrandMark() {
  return <svg className="brand-mark" viewBox="0 0 32 36" fill="none" aria-hidden="true"><path d="M7 29V7h12c6 0 9 3.2 9 8s-3.5 8-9 8H12m8-1 9 11" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" /><path d="m2 17 10-5v10Z" fill="currentColor" /></svg>;
}

function loadReviews() {
  try { return { events: parseReviewHistory(localStorage.getItem(REVIEW_STORAGE_KEY)), persistent: true }; }
  catch { return { events: [] as ReviewEvent[], persistent: false }; }
}

export default function App() {
  const [page, setPage] = useState<Page>(pageFromHash);
  const [selectedDoor, setSelectedDoor] = useState(ANOMALY_DOOR_ID);
  const [scenario, setScenario] = useState<DemoScenario>('corroborated');
  const [state, setState] = useState(createReplayState);
  const [resetKey, setResetKey] = useState(0);
  const [revealing, setRevealing] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [notice, setNotice] = useState('');
  const [reviews, setReviews] = useState(loadReviews);
  const revealTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const cycles = useMemo(() => createDemoCycles(scenario), [scenario]);
  const snapshot = useMemo(() => getReplaySnapshot(cycles, state.currentIndex), [cycles, state.currentIndex]);
  const prediction = snapshot.predictions.find(item => item.doorId === selectedDoor) ?? null;
  const caseKey = `${scenario}:${prediction?.predictionId ?? selectedDoor}`;
  const currentReviews = visibleReviews(reviews.events, caseKey, snapshot.currentCycle.timestamp);
  const dispatch = useCallback((action: ReplayAction) => setState(previous => reduceReplay(previous, action, cycles)), [cycles]);
  const goTo = (next: Page) => { location.hash = next; setPage(next); };
  const selectDoor = (id: string) => { if (!revealing) setSelectedDoor(id); };

  useEffect(() => {
    const handler = () => setPage(pageFromHash());
    addEventListener('hashchange', handler);
    return () => removeEventListener('hashchange', handler);
  }, []);
  useEffect(() => {
    if (page !== 'verification') {
      if (state.playing) dispatch({ type: 'pause' });
      return;
    }
    if (!state.playing || revealing) return;
    const timer = setInterval(() => dispatch({ type: 'step' }), 700);
    return () => clearInterval(timer);
  }, [state.playing, revealing, dispatch, page]);
  useEffect(() => () => { if (revealTimer.current) clearTimeout(revealTimer.current); }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 4400);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!showHelp) return;
    previousFocus.current = document.activeElement as HTMLElement;
    dialogRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowHelp(false);
      if (event.key === 'Tab') {
        const items = dialogRef.current?.querySelectorAll<HTMLElement>('button, a, [tabindex="0"]');
        if (!items?.length) return;
        const first = items[0], last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = previousOverflow; previousFocus.current?.focus(); };
  }, [showHelp]);

  const recordReview = (kind: ReviewEvent['kind'], text: string, outcome?: InspectionOutcome) => {
    const event: ReviewEvent = {
      id: crypto.randomUUID(), caseKey, kind, text, outcome, createdAt: new Date().toISOString(),
      evidenceThrough: snapshot.currentCycle.timestamp, cycleId: snapshot.currentCycle.id,
    };
    setReviews(previous => {
      const events = [...previous.events, event].slice(-500);
      try { localStorage.setItem(REVIEW_STORAGE_KEY, JSON.stringify(events)); return { events, persistent: true }; }
      catch { return { events, persistent: false }; }
    });
  };

  const revealNext = () => {
    if (revealing || state.currentIndex >= cycles.length - 1) return;
    dispatch({ type: 'pause' });
    const nextEligible = prediction ? cycles.findIndex((cycle, index) => index > state.currentIndex && cycle.direction === prediction.targetDirection) : state.currentIndex + 1;
    const target = nextEligible < 0 ? Math.min(state.currentIndex + 1, cycles.length - 1) : nextEligible;
    setRevealing(true);
    setNotice(target > state.currentIndex + 1 ? 'Opening movement excluded. Revealing the next eligible closing cycle…' : 'Revealing the next recorded movement…');
    revealTimer.current = setTimeout(() => {
      dispatch({ type: 'seek', index: target });
      setRevealing(false);
      const nextPrediction = derivePrediction(cycles.slice(0, target + 1), selectedDoor);
      const outcome = nextPrediction?.latestAttempt?.status ?? nextPrediction?.status;
      setNotice(outcome === 'corroborated' ? `${selectedDoor}: signature corroborated by the newly observed movement.` : outcome === 'not_corroborated' ? `${selectedDoor}: the persistent signature did not recur in this movement.` : outcome === 'insufficient_evidence' ? `${selectedDoor}: insufficient evidence in this movement.` : 'Movement revealed. Monitoring continues.');
    }, 900);
  };
  const changeScenario = (value: DemoScenario) => {
    setScenario(value); setState(createReplayState()); setSelectedDoor(ANOMALY_DOOR_ID);
    setNotice('Synthetic session reset. Later evidence remains withheld.');
  };
  const exportEvidence = () => {
    const data = {
      schemaVersion: 2, product: 'RailWitness', dataSource: 'Synthetic demonstration — advisory only',
      scenario, trainId: '017', doorId: selectedDoor, observedThrough: snapshot.currentCycle.timestampLabel,
      prediction, reviews: currentReviews,
      observedCycles: snapshot.visibleCycles.map(cycle => ({ id: cycle.id, timestamp: cycle.timestamp, direction: cycle.direction, points: getDoorTelemetry(cycle, selectedDoor) })),
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url; link.download = `railwitness-${selectedDoor}-${snapshot.currentCycle.id}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice('Evidence exported with only the observed movements and eligible review records.');
  };

  return <div className={`app-shell ${revealing ? 'revealing' : ''}`}>
    <a className="skip-link" href="#main-content" onClick={event => { event.preventDefault(); document.getElementById('main-content')?.focus(); }}>Skip to dashboard</a>
    <aside className="sidebar">
      <div className="brand"><BrandMark /><span className="brand-word">RailWitness</span></div>
      <p className="brand-sub">EVIDENCE IN MOTION</p><p className="nav-label">WORKSPACE</p>
      <nav className="main-nav" aria-label="Main navigation">
        {([{ id: 'overview', label: 'Overview', icon: LayoutDashboard }, { id: 'analysis', label: 'Door analysis', icon: Activity }, { id: 'verification', label: 'Verification', icon: ShieldCheck }] as const).map(item => <button key={item.id} className={`nav-item ${page === item.id ? 'active' : ''}`} onClick={() => goTo(item.id)} aria-current={page === item.id ? 'page' : undefined} title={item.label}><item.icon /><span>{item.label}</span></button>)}
      </nav>
      <div className="sidebar-bottom">
        <button className="nav-item" onClick={() => setShowHelp(true)}><CircleHelp /><span>How it works</span></button>
        <div className="system-label"><span className="status-dot" />Demo engine ready</div>
        <div className="simulation-tag"><FlaskConical size={16} /><span>DEMONSTRATION<br /><span style={{ color: '#5f7786' }}>Synthetic telemetry</span></span></div>
        <div className="sidebar-version"><span>RAILWITNESS</span><span>v2.0.0</span></div>
      </div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb"><Box size={13} /><span>Workspace</span><ChevronRight size={12} /><span>{pageLabels[page]}</span></div><div className="topbar-tools"><span className="timezone"><Globe2 size={12} />Singapore <span className="mono">UTC+08:00</span></span><button className="icon-button" aria-label="About RailWitness" onClick={() => setShowHelp(true)}><CircleHelp size={15} /></button><div className="avatar" title="Maintenance engineer workspace">ME</div></div></header>
      <main className={`workspace workspace--${page}`} id="main-content" tabIndex={-1}>
        <div className="page-heading">
          <div><h1>{pageLabels[page]}</h1><p>{pageDescriptions[page]}</p></div>
          <div className="page-actions">
            {page !== 'overview' && <label className="analysis-select">Door<select aria-label="Selected door" disabled={revealing} className="select-input" value={selectedDoor} onChange={event => selectDoor(event.target.value)}>{DOOR_IDS.map(id => <option key={id}>{id}</option>)}</select></label>}
            <button className="button ghost" onClick={exportEvidence}><ArrowDownToLine size={13} />Export evidence</button>
            {page === 'overview' && <button className="button" onClick={() => goTo('verification')}><ShieldCheck size={13} />Verify & replay</button>}
          </div>
        </div>
        {page === 'overview' && <Overview snapshot={snapshot} prediction={prediction} selectedDoor={selectedDoor} scenario={scenario} revealing={revealing} resetKey={resetKey} canReveal={state.currentIndex < cycles.length - 1} onSelectDoor={selectDoor} onResetView={() => setResetKey(value => value + 1)} onAnalyze={() => goTo('analysis')} onVerification={() => goTo('verification')} revealNext={revealNext} />}
        {page === 'analysis' && <>
          <DoorAnalysis visibleCycles={snapshot.visibleCycles} selectedDoor={selectedDoor} onSelectDoor={selectDoor} predictions={snapshot.predictions} onOpenVerification={id => { selectDoor(id); goTo('verification'); }} />
          {prediction && <EngineerReview key={caseKey} doorId={selectedDoor} events={currentReviews} persistent={reviews.persistent} onRecord={recordReview} />}
        </>}
        {page === 'verification' && <Verification visibleCycles={snapshot.visibleCycles} prediction={prediction} selectedDoor={selectedDoor} state={state} cycles={cycles} dispatch={dispatch} onReveal={revealNext} revealing={revealing} scenario={scenario} onScenarioChange={changeScenario} />}
        <footer className="footer"><span><ShieldCheck size={10} />Advisory intelligence only. Maintenance decisions follow the applicable procedure.</span><span><Database size={10} />Synthetic telemetry<span style={{ padding: '0 5px' }}>·</span>16 SEP 2026</span></footer>
      </main>
    </div>
    {notice && <div className="reveal-announcement" role="status">{revealing ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}{notice}</div>}
    {showHelp && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setShowHelp(false); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="help-title" ref={dialogRef}>
        <div className="modal-header"><h2 id="help-title">From attention to evidence.</h2><button className="icon-button" aria-label="Close help" onClick={() => setShowHelp(false)}><X size={16} /></button></div>
        <p>Overview identifies the doors that need attention. Door Analysis investigates their history. Verification preserves the original prediction and audits the evidence that followed.</p>
        <ol><li>Select a door on the train or in the attention queue.</li><li>Use Door Analysis to compare observed movements and inspect decision criteria.</li><li>Open Verification to reveal evidence and review eligible and excluded cycles.</li><li>Run the separate synthetic validation suite to exercise all six scenarios.</li></ol>
        <p style={{ marginTop: 15 }}><MousePointer2 size={13} />Drag the train to orbit; scroll to zoom. Analysis inspects only observed history. Chronological replay controls live in Verification.</p>
        <p className="modal-note">This demonstration uses synthetic telemetry and an original MRT-inspired model. It has no live LTA connection or trained fault model. Engineer reviews are saved in this browser and do not change automated assessments. Future-data hiding is enforced within the demo interface; it is not a server-backed access boundary.</p>
        <button className="button primary" onClick={() => { setShowHelp(false); goTo('verification'); }}>Open verification <ArrowRight size={13} /></button>
      </div>
    </div>}
  </div>;
}
