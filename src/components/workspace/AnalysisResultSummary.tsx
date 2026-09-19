import { ArrowRight, ChevronDown, FileCheck2, ShieldCheck } from 'lucide-react';
import type { AnalysisResult, RecordingSummary } from '../../types/multisystem';
import type { DoorAnalysis } from '../../lib/railwitnessDoorClient';

export default function ResultSummary({ result, recording, onCycle, doorAnalysis, selectedCycle, modelUnavailable = false, concealReplay = false }: { result: AnalysisResult | null; recording?: RecordingSummary; onCycle: (index: number) => void; doorAnalysis?: DoorAnalysis; selectedCycle?: number | null; modelUnavailable?: boolean; concealReplay?: boolean }) {
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
