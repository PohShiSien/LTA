import { useState } from 'react';
import { ArrowRight, Check, CircleDashed, ClipboardCheck, Clock3, FileCheck2, FlaskConical, LockKeyhole, ShieldCheck } from 'lucide-react';
import { ReplayTimeline } from '../components/replay/ReplayTimeline';
import { ANOMALY_DOOR_ID, CANDIDATE_CYCLE_INDEX, SCENARIOS } from '../data/mockTelemetry';
import { runValidationSuite } from '../lib/diagnostics';
import { evaluateTrace, formatDirection, getDoorTelemetry } from '../lib/replay';
import type { DemoScenario, PredictionStatus, RailWitnessPrediction, ReplayAction, ReplayState, TelemetryCycle, TraceEvaluation, VerificationEvidence } from '../types/railwitness';
import './Verification.css';

export interface VerificationProps {
  visibleCycles: TelemetryCycle[];
  prediction: RailWitnessPrediction | null;
  selectedDoor: string;
  state: ReplayState;
  cycles: TelemetryCycle[];
  dispatch: (action: ReplayAction) => void;
  onReveal: () => void;
  revealing: boolean;
  scenario: DemoScenario;
  onScenarioChange: (scenario: DemoScenario) => void;
}

const outcomeLabels: Record<PredictionStatus, string> = {
  awaiting: 'Awaiting evidence',
  corroborated: 'Corroborated',
  not_corroborated: 'Not corroborated',
  insufficient_evidence: 'Insufficient evidence',
};

function Outcome({ status }: { status: PredictionStatus }) {
  return <span className={`verification-outcome verification-outcome--${status}`}>{status === 'awaiting' ? <CircleDashed size={11} /> : <span aria-hidden="true" />}{outcomeLabels[status]}</span>;
}

function EvaluationSummary({ evaluation }: { evaluation: TraceEvaluation }) {
  const excessPct = evaluation.sampleCount ? Math.round(evaluation.excessSampleCount / evaluation.sampleCount * 100) : 0;
  return <div className="verification-evaluation">
    <div><span>Interval coverage</span><strong>{evaluation.coveragePct}<small>%</small></strong><p>{evaluation.sampleCount} / {evaluation.requiredSampleCount} samples · ≥80% required</p></div>
    <div><span>Above envelope</span><strong>{evaluation.sampleCount ? excessPct : '—'}<small>{evaluation.sampleCount ? '%' : ''}</small></strong><p>{evaluation.excessSampleCount} samples · ≥60% required</p></div>
    <div><span>Observed peak</span><strong>{evaluation.peakCurrent?.toFixed(2) ?? '—'}<small>A</small></strong><p>Envelope max {evaluation.expectedMaximum?.toFixed(2) ?? '—'} A</p></div>
  </div>;
}

function Assessment({ evidence, first }: { evidence: VerificationEvidence; first: boolean }) {
  return <details className="verification-assessment" open={first}>
    <summary><span>Assessment details</span><span>{evidence.evaluation.sampleCount} / {evidence.evaluation.requiredSampleCount} interval samples</span></summary>
    <EvaluationSummary evaluation={evidence.evaluation} />
    <div className="verification-consecutive"><span>Longest consecutive run</span><strong>{evidence.evaluation.maxConsecutiveExcess} samples</strong><span>≥3 required</span></div>
    <p className="verification-reason">{evidence.summary}</p>
    {evidence.evaluation.qualityIssues.length > 0 && <ul className="verification-quality-issues">{evidence.evaluation.qualityIssues.map(issue => <li key={issue}>{issue}</li>)}</ul>}
    <p className="verification-rule">A recurring signature requires sufficient coverage, at least 3 consecutive exceedances, and ≥60% of observed interval samples above the envelope.</p>
  </details>;
}

function PredictionRecord({ prediction, selectedDoor }: { prediction: RailWitnessPrediction | null; selectedDoor: string }) {
  return <aside className="panel verification-record" aria-label="Prediction as issued">
    <div className="verification-section-heading"><div><span className="eyebrow">01 / ORIGINAL RECORD</span><h2>Prediction as issued</h2></div><LockKeyhole size={17} /></div>
    {prediction ? <>
      <div className="verification-record-main">
        <span className="verification-document-id">{prediction.predictionId}</span>
        <h3>{prediction.description}</h3>
        <dl className="verification-record-fields">
          <div><dt>Issued at</dt><dd>{prediction.issuedAtLabel} <span>SGT</span></dd></div>
          <div><dt>Source movement</dt><dd>{prediction.issuedCycleId}</dd></div>
          <div><dt>Subject</dt><dd>Door {prediction.doorId}</dd></div>
          <div><dt>Eligible movement</dt><dd>Next {prediction.targetDirection === 'close' ? 'closing' : 'opening'}</dd></div>
          <div><dt>Predicted interval</dt><dd>{prediction.regionStartPct}–{prediction.regionEndPct}% travel</dd></div>
        </dl>
        <div className="verification-claim"><span>EXPECTED OBSERVATION</span><p>{prediction.expectedCondition}</p></div>
        <div className="verification-record-note"><LockKeyhole size={12} /><p>This original claim stays fixed as subsequent evidence arrives.</p></div>
      </div>
      <div className="verification-first-result"><span className="eyebrow">FIRST ASSESSMENT</span><Outcome status={prediction.status} /><p>{prediction.verification ? `${prediction.verification.cycleId} · ${prediction.verification.timestampLabel} SGT` : 'Waiting for the first eligible movement after issue.'}</p>{prediction.attempts.length > 1 && <p className="verification-followup-note">{prediction.attempts.length - 1} follow-up assessment{prediction.attempts.length > 2 ? 's' : ''} retained in the ledger. The first result is preserved.</p>}</div>
    </> : <div className="verification-empty-record"><FileCheck2 size={31} /><h3>No prediction issued for {selectedDoor}</h3><p>Advance through the recording. A qualifying closing signature creates a timestamped prediction here.</p><span>Only revealed movements can issue an advisory.</span></div>}
  </aside>;
}

function EvidenceLedger({ visibleCycles, prediction, selectedDoor }: Pick<VerificationProps, 'visibleCycles' | 'prediction' | 'selectedDoor'>) {
  const attempts = prediction?.attempts ?? [];
  const issuedIndex = prediction ? visibleCycles.findIndex(cycle => cycle.id === prediction.issuedCycleId) : -1;
  const historyLength = issuedIndex >= 0 ? issuedIndex : Math.max(0, visibleCycles.length - 3);
  const renderMovement = (cycle: TelemetryCycle, index: number) => {
        const isIssue = cycle.id === prediction?.issuedCycleId;
        const attemptIndex = attempts.findIndex(attempt => attempt.cycleId === cycle.id);
        const attempt = attemptIndex >= 0 ? attempts[attemptIndex] : undefined;
        const label = isIssue ? 'Prediction issued' : attempt ? attemptIndex === 0 ? 'First assessment' : `Follow-up ${attemptIndex}` : 'Excluded';
        const reason = isIssue ? 'Detection source only. This movement cannot verify its own prediction.'
          : attempt ? attemptIndex === 0 ? 'First eligible closing movement after the prediction was issued.' : 'Later eligible movement. Retained as follow-up evidence; original result preserved.'
            : prediction && index > issuedIndex ? `${formatDirection(cycle.direction)} movement does not match the predicted ${prediction.targetDirection === 'close' ? 'closing' : 'opening'} direction.`
              : prediction ? 'Observed before the prediction was issued; not verification evidence.' : 'Monitoring only. No prediction had been issued for this door.';
        const detectionEvaluation = isIssue ? evaluateTrace(getDoorTelemetry(cycle, selectedDoor), prediction?.regionStartPct, prediction?.regionEndPct) : null;
        return <li key={cycle.id} className={`verification-ledger-item ${isIssue ? 'is-issue' : attempt ? 'is-assessed' : 'is-excluded'}`}>
          <div className="verification-ledger-marker" aria-hidden="true">{isIssue ? <LockKeyhole size={12} /> : attempt ? <Check size={13} /> : <span />}</div>
          <div className="verification-ledger-content">
            <div className="verification-ledger-row"><div className="verification-movement"><strong>{cycle.id}</strong><span>{formatDirection(cycle.direction)}</span><time>{cycle.timestampLabel}</time></div><span className={`verification-ledger-role ${isIssue ? 'issued' : ''}`}>{!prediction ? 'Monitoring' : label}</span></div>
            <p>{reason}</p>
            {isIssue && detectionEvaluation && <div className="verification-detection"><span>60–80% travel</span><span>{detectionEvaluation.peakCurrent?.toFixed(2)} A peak</span><span>{detectionEvaluation.coveragePct}% coverage</span></div>}
            {attempt && <><Outcome status={attempt.status} /><Assessment evidence={attempt} first={attemptIndex === 0} /></>}
          </div>
        </li>;
  };
  return <section className="panel verification-ledger" aria-label="Chronological evidence ledger">
    <div className="verification-section-heading"><div><span className="eyebrow">02 / OBSERVED EVIDENCE</span><h2>Every movement accounted for</h2></div><span className="verification-ledger-count">{visibleCycles.length} revealed</span></div>
    <div className="verification-ledger-intro"><span className="verification-ledger-key"><i />Assessed</span><span className="verification-ledger-key"><i className="issued" />Prediction issued</span><span className="verification-ledger-key"><i className="excluded" />Excluded / monitoring</span></div>
    {historyLength > 0 && <details className="verification-prehistory"><summary><strong>{historyLength} earlier movements</strong><span>{prediction ? 'Before prediction · excluded from assessment' : 'Monitoring history · no prediction issued'}</span></summary><ol className="verification-ledger-list">{visibleCycles.slice(0, historyLength).map(renderMovement)}</ol></details>}
    <ol className="verification-ledger-list">{visibleCycles.slice(historyLength).map((cycle, index) => renderMovement(cycle, index + historyLength))}</ol>
    {!visibleCycles.length && <div className="verification-no-movements">No movements revealed. Load a recording to start the evidence ledger.</div>}
    <div className="verification-ledger-end"><LockKeyhole size={12} /><span>End of revealed evidence. Later movements are outside this ledger’s cutoff.</span></div>
  </section>;
}

function FuturePreview({ cycle, selectedDoor }: { cycle: TelemetryCycle | undefined; selectedDoor: string }) {
  const evaluation = cycle ? evaluateTrace(getDoorTelemetry(cycle, selectedDoor)) : null;
  return <section className="verification-future-preview" aria-label="Future preview, not assessed"><div><span className="eyebrow">FUTURE PREVIEW · NOT ASSESSED</span><h3>{cycle ? `${cycle.id} · ${formatDirection(cycle.direction)} · ${cycle.timestampLabel} SGT` : 'No later movements in this recording'}</h3><p>Preview signals are outside the evidence cutoff. Reveal the cycle to add it to the chronological record.</p></div>{evaluation && <dl><div><dt>Interval peak</dt><dd>{evaluation.peakCurrent?.toFixed(2) ?? '—'} A</dd></div><div><dt>Interval coverage</dt><dd>{evaluation.coveragePct}%</dd></div></dl>}</section>;
}

function ValidationSuite() {
  const [result, setResult] = useState<ReturnType<typeof runValidationSuite> | null>(null);
  return <section className="panel verification-suite" aria-labelledby="validation-suite-title">
    <div className="verification-suite-header"><div><span className="eyebrow">03 / SEPARATE VALIDATION WORKSPACE</span><h2 id="validation-suite-title">Test the assessment rules</h2><p>Run all six synthetic recordings against their expected outcomes and chronology checks.</p></div><button className="button" onClick={() => setResult(runValidationSuite())}><FlaskConical size={14} />{result ? 'Run suite again' : 'Run validation suite'}<ArrowRight size={12} /></button></div>
    <div className="verification-suite-scope"><FlaskConical size={14} /><p><strong>Whole-fixture retrospective evaluation.</strong> This separate run reads complete synthetic recordings, including later movements. The active replay cursor and its evidence ledger stay unchanged.</p></div>
    <div aria-live="polite" aria-atomic="true" className="verification-suite-announcement">{result && `Validation complete: ${result.passedCount} of ${result.totalCount} fixtures passed their expected outcomes and checks.`}</div>
    {result ? <>
      <div className="verification-suite-metrics">
        <div><span>FIXTURE CHECKS PASSED</span><strong className={result.passedCount === result.totalCount ? 'is-pass' : 'is-fail'}>{result.passedCount}<small> / {result.totalCount}</small></strong></div>
        <div><span>FIRST ASSESSMENTS</span><strong>{result.rows.filter(row => row.firstAssessedCycleId).length}</strong></div>
        <div><span>CORROBORATED</span><strong>{result.counts.corroborated}</strong></div>
        <div><span>NOT CORROBORATED</span><strong>{result.counts.not_corroborated}</strong></div>
        <div><span>INSUFFICIENT</span><strong>{result.counts.insufficient_evidence}</strong></div>
      </div>
      <div className="verification-table-scroll" tabIndex={0} role="region" aria-label="Synthetic validation results; scroll horizontally on smaller screens"><table className="verification-results-table"><caption>Expected fixture outcomes compared with the first eligible assessment</caption><thead><tr><th scope="col">Synthetic recording</th><th scope="col">Expected first result</th><th scope="col">Actual first result</th><th scope="col">Follow-ups</th><th scope="col">Checks</th></tr></thead><tbody>{result.rows.map(row => <tr key={row.scenario}><th scope="row"><strong>{row.label}</strong><span>{row.issuedCycleId ?? 'No issue'} → {row.firstAssessedCycleId ?? 'No assessment'}</span></th><td>{outcomeLabels[row.expectedStatus]}</td><td><Outcome status={row.actualStatus} /></td><td>{row.followUpCount}</td><td><details className="verification-check-details"><summary className={row.passed ? 'is-pass' : 'is-fail'}>{row.passed ? 'Pass' : 'Fail'}<span>{row.checks.filter(check => check.passed).length}/{row.checks.length}</span></summary><ul>{row.checks.map(check => <li key={check.name}><span>{check.passed ? '✓' : '×'}</span>{check.name}</li>)}</ul></details></td></tr>)}</tbody></table></div>
      <p className="verification-suite-limit"><ShieldCheck size={13} />Fixture agreement measures rule behavior on synthetic data. It does not measure mechanical fault accuracy.</p>
    </> : <div className="verification-suite-idle"><div className="verification-suite-idle-icon"><ClipboardCheck size={23} /></div><div><h3>Six cases. One consistent set of rules.</h3><p>Recurrence, clearance, missing samples, intermittent behavior, gradual drift, and an isolated spike.</p><span>First results and follow-up evidence are evaluated separately.</span></div></div>}
  </section>;
}

export function Verification({ visibleCycles, prediction, selectedDoor, state, cycles, dispatch, onReveal, revealing, scenario, onScenarioChange }: VerificationProps) {
  const currentCycle = visibleCycles[visibleCycles.length - 1];
  const canReveal = cycles.length > 0 && state.currentIndex < cycles.length - 1;
  const scenarioDescription = SCENARIOS.find(item => item.value === scenario)?.description;
  return <div className="verification-page">
    <section className="verification-workspace-header" aria-label="Audit session">
      <div className="verification-audit-title"><div className="verification-audit-icon"><FileCheck2 size={21} /></div><div><span className="eyebrow">CHRONOLOGICAL AUDIT</span><h2>A claim, then its evidence.</h2><p>Inspect what was known at issue time and what each subsequent movement contributed.</p></div></div>
      <div className="verification-scenario"><label htmlFor="verification-scenario">SYNTHETIC RECORDING</label><select id="verification-scenario" className="select-input" value={scenario} disabled={revealing} onChange={event => onScenarioChange(event.target.value as DemoScenario)}>{SCENARIOS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select><p>{scenarioDescription}</p></div>
    </section>
    {cycles.length > 0 && <ReplayTimeline state={state} cycles={cycles} dispatch={dispatch} disabled={revealing} />}
    <div className="verification-cutoff"><div><span className="verification-door-label">{selectedDoor}</span><Clock3 size={13} /><p>Evidence cutoff <strong>{currentCycle ? `${currentCycle.id} · ${currentCycle.timestampLabel} SGT` : 'No revealed movements'}</strong></p></div><div className="verification-cutoff-actions">{selectedDoor === ANOMALY_DOOR_ID && state.currentIndex < CANDIDATE_CYCLE_INDEX && cycles.length > CANDIDATE_CYCLE_INDEX && <button className="button ghost" disabled={revealing} onClick={() => dispatch({ type: 'seek', index: CANDIDATE_CYCLE_INDEX })}>Jump to detection</button>}<button className="button primary" onClick={onReveal} disabled={revealing || !canReveal}>{revealing ? 'Revealing evidence…' : canReveal ? 'Reveal next cycle' : 'Recording complete'}<ArrowRight size={13} /></button></div></div>
    {!state.hideFutureData && <FuturePreview cycle={cycles[state.currentIndex + 1]} selectedDoor={selectedDoor} />}
    <div className="verification-audit-grid"><PredictionRecord prediction={prediction} selectedDoor={selectedDoor} /><EvidenceLedger visibleCycles={visibleCycles} prediction={prediction} selectedDoor={selectedDoor} /></div>
    <details className="verification-provenance"><summary><LockKeyhole size={13} /><span>Provenance & chronology rules</span></summary><div><p><strong>Observed data only.</strong> The prediction and ledger are derived from movements up to the replay cursor. Seeking backward reconstructs the earlier evidence state. The future-preview setting does not add evidence to this ledger.</p><p><strong>Eligibility.</strong> Detection is excluded from verification. Later movements must match the predicted direction. Each eligible movement is retained, including insufficient-data attempts; follow-ups never replace the original first assessment.</p><p><strong>Demonstration provenance.</strong> Signals and healthy envelopes are generated fixtures. This browser demo reconstructs records in memory; it does not provide a signed audit trail or a server-enforced data cutoff.</p></div></details>
    <ValidationSuite />
  </div>;
}
