import { ArrowRight, Check, CheckCheck, CircleDot, Clock3, Fingerprint, LoaderCircle, LockKeyhole, ShieldCheck, TriangleAlert } from 'lucide-react';
import type { RailWitnessPrediction } from '../../types/railwitness';

interface Props { prediction: RailWitnessPrediction | null; doorId: string; onReveal: () => void; revealing: boolean; canReveal: boolean; onOpenVerification?: () => void; dataSufficient?: boolean }

export function PredictionCard({ prediction, doorId, onReveal, revealing, canReveal, onOpenVerification, dataSufficient = true }: Props) {
  const assessment = prediction?.latestAttempt ?? prediction?.verification;
  const effectiveStatus = assessment?.status ?? prediction?.status;
  const resolved = prediction && effectiveStatus !== 'awaiting';
  const corroborated = effectiveStatus === 'corroborated';
  const insufficient = effectiveStatus === 'insufficient_evidence' || (!prediction && !dataSufficient);
  const recommendation = corroborated ? `Inspect Door ${doorId} under the applicable maintenance procedure. This advisory does not establish a mechanical fault.` : insufficient ? `Check telemetry completeness for Door ${doorId} and collect another eligible closing movement.` : `Continue monitoring Door ${doorId}. One non-recurrence does not establish mechanical condition.`;
  const status = !prediction ? insufficient ? 'INSUFFICIENT EVIDENCE' : 'MONITORING' : !resolved ? 'AWAITING NEXT CYCLE' : corroborated ? 'CORROBORATED' : insufficient ? 'INSUFFICIENT EVIDENCE' : 'NOT CORROBORATED';
  return <section className="panel witness-panel" aria-label="RailWitness prediction">
    <div className="panel-heading">
      <div className="witness-title"><Fingerprint size={19} /><h2>RailWitness</h2></div>
      <span className={`status-pill ${prediction && !resolved ? 'amber' : corroborated ? 'red' : insufficient ? 'amber' : ''}`}><span className={`status-dot ${prediction && !resolved ? 'amber' : corroborated ? 'red' : ''}`} />{status}</span>
    </div>
    <div className="witness-body" aria-live="polite">
      <div className="workflow" aria-label="Detection and verification progress">
        <span className={prediction ? 'done' : 'current'}><Check size={11} /> Detect</span><i />
        <span className={prediction ? 'done' : ''}><Check size={11} /> Predict</span><i />
        <span className={resolved ? 'done' : prediction ? 'current' : ''}>{resolved ? <CheckCheck size={11} /> : <CircleDot size={10} />} Verify</span><i />
        <span className={resolved ? 'done' : ''}>Act</span>
      </div>
      <h3>{!prediction ? insufficient ? 'The latest movement is incomplete.' : 'Every movement adds evidence.' : !resolved ? 'An anomaly is a question.\nThe next cycle is the test.' : corroborated ? 'The signature repeated.' : insufficient ? 'The evidence is incomplete.' : 'The persistent signature did not recur.'}</h3>
      <p className="prediction-description">{!prediction ? `No persistent closing signature has been recorded for ${doorId}. Review the observed signal and its data quality in Door Analysis.` : `Suspected pattern: ${prediction.description.charAt(0).toLowerCase()}${prediction.description.slice(1)}.`}</p>
      <div className="prediction-timestamp"><LockKeyhole size={10} />{prediction ? <>Prediction recorded <time className="mono">{prediction.issuedAtLabel}</time><span>SGT · {prediction.issuedCycleId}</span></> : 'No prediction issued for this door'}</div>
      <div className="evidence-box">
        <div className="eyebrow">{resolved ? 'Latest observed assessment' : prediction ? 'Expected next evidence' : 'What we are watching'}</div>
        {resolved ? assessment?.summary : prediction ? prediction.expectedCondition : 'Actual motor current compared with the authored synthetic reference envelope.'}
        {resolved && <div className="prediction-timestamp" style={{ marginBottom: 0 }}><Clock3 size={10} />{assessment?.timestampLabel} SGT · {assessment?.cycleId} · Closing</div>}
      </div>
    </div>
    {resolved && prediction.attempts.length > 1 && <p className="witness-assessment-caption">{prediction.attempts.length} assessments · original verdict retained in Verification</p>}
    {onOpenVerification && <button className="text-link prediction-audit-link" onClick={onOpenVerification}>Open prediction audit <ArrowRight size={12} /></button>}
    <div className="witness-action">
      {resolved ? <div className="recommendation">{corroborated ? <TriangleAlert size={15} /> : <ShieldCheck size={15} />}<span>{recommendation}</span></div> : <><p>{prediction ? <>Prediction recorded.<br />Awaiting eligible evidence.</> : <>Advisory intelligence.<br />Grounded in each cycle.</>}</p><button className="button primary reveal-button" onClick={onReveal} disabled={revealing || !canReveal}>
        {revealing ? <LoaderCircle size={13} className="spin" /> : <>{prediction ? 'Reveal next cycle' : 'Next movement'}<ArrowRight size={13} /></>}
      </button></>}
    </div>
  </section>;
}
