import type { AnalysisResult, RecordingSummary } from '../../types/multisystem';
import type { RailVisualizationEvidence } from '../../lib/visualEvidence';
import '../acv/AcvEvidence.css';
import './RailEvidencePanel.css';

interface Props {
  result: Extract<AnalysisResult, { subsystem: 'rail' }>;
  recording: RecordingSummary;
  evidence: RailVisualizationEvidence | null;
  loading?: boolean;
  error?: string | null;
  onSelectSide?: (side: 'Side I' | 'Side II') => void;
}
const number = (value: number | null) => value === null ? 'Unavailable' : value.toFixed(3);
export default function RailEvidencePanel({ result, recording, evidence, loading, error, onSelectSide }: Props) {
  return <section className="ve-panel rail-evidence-panel" aria-label="Rail side evidence" aria-busy={loading}>
    <header className="ve-heading"><div><span className="ve-kicker">RECORDING-LEVEL CLASSIFICATION</span><h2>{result.prediction === 'Normal' ? 'No corrugation signature detected' : `Corrugation signature detected — ${result.prediction}`}</h2><p className="rail-source-name">{recording.source.fileName} · {recording.rowCount.toLocaleString()} samples · one classification for this recording</p></div><span className={`ve-status ${result.prediction !== 'Normal' ? 'rail-detected' : ''}`}>{result.prediction.toUpperCase()}</span></header>
    {error ? <p className="ve-empty" role="alert">{error}</p> : !evidence ? <p className="ve-empty">{loading ? 'Summarising source sensor groups…' : 'Recorded vibration evidence is unavailable.'}</p> : <>
      <div className="rail-side-evidence-grid">{evidence.sides.map(side => <article key={side.side} className={`rail-side-evidence ${result.prediction === side.side ? 'detected' : ''}`}>
        <header><div><span className="ve-kicker">DOCUMENTED SENSOR GROUP</span><h3>{side.side}</h3></div><button type="button" className="ms-button small" onClick={() => { onSelectSide?.(side.side); document.getElementById('evidence-inspector')?.scrollIntoView({ behavior: 'auto', block: 'start' }); }}>Inspect group</button></header>
        <div className="rail-sensor-membership" aria-label={`${side.side} axle-box positions`}>{side.positions.map(position => <span key={position}><i aria-hidden="true"/>{position}</span>)}<small>positions on each source car</small></div>
        <dl className="ve-metrics"><div><dt>Vibration · pooled RMS</dt><dd>{number(side.vibrationRms)}<small>m/s² · {side.vibrationChannels} channels</small></dd></div><div><dt>Shock · pooled RMS</dt><dd>{number(side.shockRms)}<small>m/s² · {side.shockChannels} channels</small></dd></div><div><dt>Maximum absolute shock</dt><dd>{number(side.shockPeak)}<small>m/s² · full recording</small></dd></div><div><dt>Dominant vibration peak</dt><dd>{side.peaks[0] ? side.peaks[0].frequency.toFixed(1) : 'Unavailable'}<small>{side.peaks[0] ? 'Hz · selected FFT window' : 'No nonzero spectral peak'}</small></dd></div></dl>
        <div className="rail-band-energy"><h4>Relative spectral energy</h4>{side.bands.length ? side.bands.map(band => <div className="rail-band-row" key={band.label}><span>{band.label}</span><i aria-hidden="true"><b style={{ width: `${band.fraction * 100}%` }}/></i><strong>{(band.fraction * 100).toFixed(1)}%</strong></div>) : <p className="ve-footnote">No spectral energy available in this window.</p>}</div>
        <p className="ve-footnote">{side.peaks.length ? `Dominant peaks: ${side.peaks.map(peak => `${peak.frequency.toFixed(1)} Hz`).join(' · ')}.` : 'Dominant peaks unavailable.'} Mean squared Hann-window amplitudes across vibration channels, first {side.spectralSamples.toLocaleString()} samples; each band is a share of the window total.</p>
      </article>)}</div>
      <div className="rail-evidence-context"><span><strong>{evidence.sampleRateHz?.toLocaleString() ?? 'Unknown'} Hz</strong> recorded sample rate</span><span><strong>{evidence.pulseRateHz === null ? 'Unavailable' : `${evidence.pulseRateHz.toFixed(2)} pulse/s`}</strong> rotational sensor · {evidence.pulseTransitions ?? '—'} rising edges</span></div>
      <p className="ve-footnote">RMS uses all finite source samples. Spectral and side summaries are diagnostic evidence, not feature attribution or per-bearing diagnoses. Pulse frequency does not establish train speed without calibration. Select an axle-box position in the evidence inspector to switch between its recorded trace and spectrum. Physical track location is unavailable.</p>
    </>}
  </section>;
}
