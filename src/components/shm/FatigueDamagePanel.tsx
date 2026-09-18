import type { AnalysisResult, RecordingSummary } from '../../types/multisystem';
import type { ShmVisualizationEvidence } from '../../lib/visualEvidence';
import DamageContributionChart from './DamageContributionChart';
import '../acv/AcvEvidence.css';
import './ShmEvidence.css';

interface Props { result: Extract<AnalysisResult, { subsystem: 'shm' }>; recording: RecordingSummary; evidence: ShmVisualizationEvidence | null; loading?: boolean; error?: string | null }
export default function FatigueDamagePanel({ result, recording, evidence, loading, error }: Props) {
  const max = Math.max(1, ...evidence?.rainflowBins.map(bin => bin.count) ?? []);
  return <section className="ve-panel shm-fatigue-panel" aria-label="Cumulative fatigue damage" aria-busy={loading}>
    <header className="ve-heading"><div><span className="ve-kicker">ONE NUMERIC OUTPUT · COMPLETE STRESS FILE</span><h2>Cumulative fatigue damage</h2><p>{recording.source.fileName}</p></div><span className="ve-status">{recording.source.mode === 'demo' ? 'SYNTHETIC SCENARIO' : 'MODEL OUTPUT'}</span></header>
    <div className="shm-damage-output"><span>D =</span><strong>{String(result.predictedDamage)}</strong></div>
    <p className="ve-footnote">The original numeric output is shown without clipping or conversion to health, remaining life, or failure probability. Measurement location not supplied.</p>
    {error ? <p className="ve-empty" role="alert">{error}</p> : !evidence ? <p className="ve-empty">{loading ? 'Deriving stress and fatigue-cycle evidence…' : 'Derived stress evidence is unavailable.'}</p> : <div className="shm-damage-evidence-grid">
      <div className="shm-rainflow"><h3>Derived rainflow cycle distribution</h3><p className="ve-footnote">Stress range = maximum − minimum per counted reversal cycle, in source units. Open residual cycles count as one half.</p>
        {evidence.rainflowBins.length ? <div className="shm-rainflow-bars">{evidence.rainflowBins.map((bin, index) => <div className="shm-rainflow-row" key={index}><span>{bin.minimum.toFixed(1)}–{bin.maximum.toFixed(1)}</span><i aria-hidden="true"><b style={{ width: `${bin.count / max * 100}%` }}/></i><strong>{bin.count.toLocaleString()}</strong></div>)}</div> : <p className="ve-empty">No nonzero stress-range cycles found.</p>}
        <p className="ve-footnote">{evidence.equivalentCycles.toLocaleString()} equivalent cycles · {evidence.rowCount.toLocaleString()} stress samples. Derived cycle counts describe the recording; they are not ground-truth damage labels.</p>
      </div><DamageContributionChart evidence={evidence}/>
    </div>}
  </section>;
}
