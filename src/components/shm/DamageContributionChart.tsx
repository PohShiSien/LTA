import type { ShmVisualizationEvidence } from '../../lib/visualEvidence';
import './ShmEvidence.css';

export default function DamageContributionChart({ evidence }: { evidence: ShmVisualizationEvidence }) {
  const max = Math.max(1e-12, ...evidence.logDamageContributions.map(item => Math.abs(item.contribution)));
  if (!evidence.logDamageContributions.length) return <p className="ve-footnote">Fitted-model contributions are unavailable for this synthetic scenario.</p>;
  return <div className="shm-contributions"><h3>Derived contribution to predicted fatigue damage</h3><p className="ve-footnote">Actual fitted-feature contributions to <strong>log(D)</strong>. Positive raises log(D); negative lowers it. These are not additive shares of D or damage accumulated at a timestamp.</p>
    {evidence.logDamageContributions.map(item => <div className="shm-contribution-row" key={item.label}><span>{item.label}</span><i aria-hidden="true"><b className={item.contribution >= 0 ? 'positive' : 'negative'} style={{ left: `${item.contribution < 0 ? 50 - Math.abs(item.contribution) / max * 50 : 50}%`, width: `${Math.abs(item.contribution) / max * 50}%` }}/></i><strong>{item.contribution > 0 ? '+' : ''}{item.contribution.toFixed(4)}</strong></div>)}
    <p className="ve-footnote">D = exp(intercept + contributions). Fitted intercept: {evidence.logDamageIntercept?.toPrecision(7) ?? 'unavailable'}. No per-cycle physical damage law is assumed.</p>
  </div>;
}
