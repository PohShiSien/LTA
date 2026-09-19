import { ArrowRight, ChevronDown, FileCheck2, ShieldCheck } from 'lucide-react';
import type { AnalysisResult, RecordingSummary } from '../../types/multisystem';
import type { DoorAnalysis } from '../../lib/railwitnessDoorClient';
import type { ModelAnalysis } from '../../lib/modelBackend';

export default function ResultSummary({ result, recording, onCycle, doorAnalysis, modelAnalysis, selectedCycle, modelUnavailable = false, concealReplay = false }: { result: AnalysisResult | null; recording?: RecordingSummary; onCycle: (index: number) => void; doorAnalysis?: DoorAnalysis; modelAnalysis?: ModelAnalysis; selectedCycle?: number | null; modelUnavailable?: boolean; concealReplay?: boolean }) {
  if (modelAnalysis) return <section className="ms-result is-computed" aria-label="Prediction result">
    <div className="ms-result-label"><span className="ms-kind predicted">Predicted</span><span>SCOPED MODEL OUTPUT</span></div>
    <div className="ms-result-main"><div>
      <h2>{modelAnalysis.subsystem === 'rail' ? `Rail classification: ${modelAnalysis.prediction}` : `Fatigue damage: ${String(modelAnalysis.prediction)}`}</h2>
      <p>{modelAnalysis.subsystem === 'rail' ? 'One classification for this recording: Normal, Side I, or Side II. It does not identify a particular axle box or geographic location.' : 'One fatigue damage estimate for this stress recording. This value is not a health percentage or a remaining-life estimate.'}</p>
    </div><span className="ms-result-scope">RECORDING</span></div>
    <p className="ms-result-source"><strong>Analysed file</strong> {modelAnalysis.source_name}</p>
    <div className="ms-door-summary ms-model-summary" aria-label={modelAnalysis.subsystem === 'rail' ? 'Rail analysis summary' : 'SHM analysis summary'}>
      <span><strong>{modelAnalysis.summary.rows.toLocaleString()}</strong> source samples</span>
      {modelAnalysis.subsystem === 'rail' ? <span><strong>{modelAnalysis.evidence.speed_kmh.toFixed(2)}</strong> km/h · derived recording speed</span> : <span><strong>{modelAnalysis.evidence.cycles.toLocaleString()}</strong> counted stress cycles</span>}
    </div>
    {modelAnalysis.warnings.length > 0 && <div className="ms-result-warnings" role="note" aria-label="Model warnings"><strong>Model warnings</strong><ul>{modelAnalysis.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div>}
    <details className="ms-model"><summary><ShieldCheck size={12}/>Model details<ChevronDown size={12}/></summary><div>
      <p><strong>Model</strong> {modelAnalysis.model_name} · {modelAnalysis.model_id}</p>
      <p>The uploaded recording ran through the supplied model and its preprocessing in the Python backend. The displayed prediction preserves the returned value.</p>
      {modelAnalysis.subsystem === 'rail' ? <p><strong>Unweighted model scores (0–1)</strong> {Object.entries(modelAnalysis.evidence.probabilities).map(([label, value]) => `${label}: ${String(value)}`).join(' · ')}. The supplied script applies saved class weights before choosing the final classification, so the largest displayed score may differ from that classification. These scores do not certify mechanical condition.</p> : <p><strong>Fifth range moment</strong> {String(modelAnalysis.evidence.range_moment_5)}. A model input combining counted stress-cycle ranges raised to the fifth power; it is not an independent condition rating.</p>}
      <p><strong>Source</strong> {modelAnalysis.source_name} · SHA-256 {modelAnalysis.source_sha256}</p>
      <p>Results are temporary. Download CSV or ZIP to keep a copy; run analysis again if the backend restarts or the result expires.</p>
    </div></details>
  </section>;
  return <section className={`ms-result ${result ? 'is-computed' : ''}`} aria-label="Prediction result">
    <div className="ms-result-label"><span className={`ms-kind ${result ? 'predicted' : 'metadata'}`}>{result ? 'Predicted' : 'Not analysed'}</span><span>SCOPED MODEL OUTPUT</span></div>
    {!result ? <div className="ms-result-empty"><FileCheck2 size={23}/><div><h2>{recording ? modelUnavailable ? 'Waiting for trained model package' : 'Recording ready for analysis' : 'Choose a recording to begin'}</h2><p>{recording ? modelUnavailable ? 'Your recording is loaded and can be inspected. Connect this subsystem’s trained model to run prediction.' : 'Run analysis to produce a result. Missing predictions are never shown as Normal.' : 'Upload a supported recording to inspect its source signals.'}</p></div></div> : <>
      <div className="ms-result-main"><div>
        <h2>{result.segments.length} door cycles classified</h2>
        <p>One classification per completed recorded cycle, with its original start and end times.</p>
      </div><span className="ms-result-scope">CYCLE</span></div>
      {doorAnalysis && !concealReplay && <div className="ms-door-summary" aria-label="Door analysis summary"><span><strong>{doorAnalysis.summary.normal}</strong> Normal</span><span><strong>{doorAnalysis.summary.abnormal_resistance}</strong> Abnormal resistance</span><span><strong>{doorAnalysis.summary.rows.toLocaleString()}</strong> source rows</span><span>Frozen Python model · {doorAnalysis.model_id}</span></div>}
      {!concealReplay && <div className="ms-segments"><table><caption>Predicted segments · {result.source.fileName}</caption><thead><tr><th>Start time</th><th>End time</th><th>Prediction</th><th>Inspect</th></tr></thead><tbody>{result.segments.map((segment, index) => <tr key={`${segment.start_time}-${index}`}><td>{segment.start_time}</td><td>{segment.end_time}</td><td><span className={segment.prediction === 'Normal' ? 'ms-neutral-result' : 'ms-amber'}>{segment.prediction}</span></td><td><button className="ms-text-button" aria-pressed={selectedCycle === index} onClick={() => onCycle(index)}>Cycle {index + 1}<ArrowRight size={12}/></button></td></tr>)}</tbody></table>{!result.segments.length && <p>No complete cycles were detected in this stream.</p>}</div>}
      {concealReplay && <p className="ms-replay-pending" role="status">Recorded movement replay · classification is revealed when the cycle finishes.</p>}
      <details className="ms-model"><summary><ShieldCheck size={12}/>{result.model.name}<span>{result.model.version}</span><ChevronDown size={12}/></summary><div><p>{result.model.description}</p><p><strong>Training</strong> {result.model.training}</p><p><strong>Validation</strong> {result.model.validation}</p>{result.notes.map(note => <p key={note}>{note}</p>)}<p><strong>Source</strong> {result.source.datasetId} / {result.source.fileName} · {result.analysedAt}</p></div></details>
    </>}
  </section>;
}
