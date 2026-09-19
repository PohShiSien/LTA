import { useEffect, useId, useRef } from 'react';
import { ArrowRight, ChevronDown, FileCheck2, ShieldCheck, X } from 'lucide-react';
import type { AnalysisResult, RecordingSummary } from '../../types/multisystem';
import type { DoorAnalysis } from '../../lib/railwitnessDoorClient';
import type { ModelAnalysis } from '../../lib/modelBackend';
import { shmRiskBand } from '../train/subsystemVisuals';

export function NextSteps({ doorAnalysis, modelAnalysis, onCycle, onCar, onRailSide, concealReplay = false }: {
  doorAnalysis?: DoorAnalysis;
  modelAnalysis?: ModelAnalysis;
  onCycle: (index: number) => void;
  onCar?: (carId: string) => void;
  onRailSide?: (side: 'Side I' | 'Side II') => void;
  concealReplay?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const analysis = modelAnalysis ?? doorAnalysis;
  useEffect(() => { dialog.current?.close(); }, [analysis?.job_id]);
  if (!analysis || (doorAnalysis && concealReplay)) return null;
  const abnormal = doorAnalysis?.segments.find(cycle => cycle.prediction === 'Abnormal resistance');
  const band = modelAnalysis?.subsystem === 'shm' ? shmRiskBand(modelAnalysis.prediction) : undefined;
  const status = modelAnalysis?.subsystem === 'rail' ? `Rail: ${modelAnalysis.prediction}`
    : modelAnalysis?.subsystem === 'acv' ? `Inspect Car ${modelAnalysis.prediction[0]} first`
    : modelAnalysis?.subsystem === 'shm' ? `${band?.label ?? 'Unclassified'} · SHM`
    : abnormal ? `${doorAnalysis!.summary.abnormal_resistance} abnormal door cycles` : 'Door cycles classified Normal';
  const action = modelAnalysis?.subsystem === 'rail' ? modelAnalysis.prediction === 'Normal'
    ? 'Retain this recording’s result for comparison with later inspections.'
    : `Review the ${modelAnalysis.prediction} recording and inspect that rail side; an individual axle box is not identified.`
    : modelAnalysis?.subsystem === 'acv' ? 'Inspect the highest-ranked car first, then compare its recorded conditions with the other cars.'
    : modelAnalysis?.subsystem === 'shm' ? 'Review the stress recording and compare its fatigue estimate with your engineering assessment criteria.'
    : abnormal ? 'Review the flagged cycle’s current trace and supporting model evidence before arranging a physical inspection.'
    : 'Keep the cycle results for reference; a Normal model label does not certify mechanical condition.';
  const tone = abnormal || (modelAnalysis?.subsystem === 'rail' && modelAnalysis.prediction !== 'Normal') || band?.id === 'red' ? 'critical'
    : modelAnalysis?.subsystem === 'acv' || band?.id === 'yellow' ? 'warning' : 'healthy';
  const inspect = abnormal ? () => onCycle(abnormal.cycle_index)
    : modelAnalysis?.subsystem === 'acv' && onCar ? () => onCar(modelAnalysis.prediction[0])
    : modelAnalysis?.subsystem === 'rail' && modelAnalysis.prediction !== 'Normal' && onRailSide ? () => onRailSide(modelAnalysis.prediction as 'Side I' | 'Side II') : undefined;
  return <>
    <section className="ms-next-steps" aria-label="Recommended next steps">
      <table><thead><tr><th>Status</th><th>Recommended action</th><th>Evidence</th></tr></thead>
        <tbody><tr className={tone}><td><span className={`ms-status-dot ${tone}`} aria-hidden="true"/>{status}</td><td>{action}</td><td><button className="ms-text-button" onClick={() => dialog.current?.showModal()}>Why?</button></td></tr></tbody>
      </table>
    </section>
    <dialog className="ms-dialog ms-why-dialog" ref={dialog} aria-labelledby={titleId} onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
      <div><header><h2 id={titleId}>Supporting evidence</h2><button aria-label="Close evidence" onClick={() => dialog.current?.close()}><X size={17}/></button></header>
        <div className="ms-why-body"><p><strong>{status}</strong></p><p><strong>Analysed file:</strong> {analysis.source_name}</p>
          {doorAnalysis && <>
            <p>{doorAnalysis.summary.normal} Normal and {doorAnalysis.summary.abnormal_resistance} Abnormal resistance cycles, covering {doorAnalysis.summary.rows.toLocaleString()} source rows.</p>
            <table className="ms-why-table"><thead><tr><th>Cycle</th><th>Recorded interval</th><th>Prediction</th><th>Peak current</th></tr></thead><tbody>{doorAnalysis.segments.filter(cycle => !abnormal || cycle.prediction === 'Abnormal resistance').slice(0, 10).map(cycle => <tr key={cycle.cycle_id}><td>{cycle.cycle_index + 1}</td><td>{cycle.start_time} – {cycle.end_time}</td><td>{cycle.prediction}</td><td>{String(cycle.peak_current_A)} A</td></tr>)}</tbody></table>
            <p>Up to ten matching cycles shown. Peak current is recorded evidence, not a separate fault threshold. The model classifies completed cycles; physical door identity is unavailable.</p>
          </>}
          {modelAnalysis?.subsystem === 'rail' && <>
            <p><strong>Returned classification:</strong> {modelAnalysis.prediction}. Derived recording speed: {String(modelAnalysis.evidence.speed_kmh)} km/h.</p>
            <table className="ms-why-table"><thead><tr><th>Class</th><th>Unweighted model score</th></tr></thead><tbody>{Object.entries(modelAnalysis.evidence.probabilities).map(([label, score]) => <tr key={label}><td>{label}</td><td>{String(score)}</td></tr>)}</tbody></table>
            <p>The script applies saved class weights before selecting the final label. These scores describe the recording and do not locate a defective axle box.</p>
          </>}
          {modelAnalysis?.subsystem === 'acv' && <>
            <table className="ms-why-table"><thead><tr><th>Rank / car</th><th>Relative score</th><th>Thermal deficit</th><th>Usable minutes</th></tr></thead><tbody>{modelAnalysis.evidence.cars.map(car => <tr key={car.car_id}><td>{car.rank} · Car {car.car_id}</td><td>{String(car.probability)}</td><td>{car.thermal_deficit_degC === null ? 'Unavailable' : `${String(car.thermal_deficit_degC)} °C`}</td><td>{String(car.valid_minutes)}{!car.has_data && ' · insufficient data'}</td></tr>)}</tbody></table>
            <p>The supplied model assumes one leaking car per case. Its ranking and relative scores are inspection priorities, not confirmed faults or calibrated failure probabilities.</p>
          </>}
          {modelAnalysis?.subsystem === 'shm' && <>
            <p><strong>Fatigue damage:</strong> {String(modelAnalysis.prediction)}</p>
            <p><strong>Counted stress cycles:</strong> {modelAnalysis.evidence.cycles.toLocaleString()}<br/><strong>Fifth range moment:</strong> {String(modelAnalysis.evidence.range_moment_5)}</p>
            <p>The train colour uses provisional display thresholds of 0.33 and 0.67, not model-validated engineering limits. The result applies to this recording; it is not a health percentage or a located structural defect.</p>
          </>}
          {analysis.warnings.length > 0 && <ul className="ms-why-notes">{analysis.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
          <p><strong>Model:</strong> {analysis.model_name} · {analysis.model_id}</p>
        </div>
        <div className="ms-why-actions">{inspect && <button className="ms-button primary" onClick={() => { inspect(); dialog.current?.close(); }}>Inspect finding<ArrowRight size={13}/></button>}<button className="ms-button" onClick={() => dialog.current?.close()}>Close</button></div>
      </div>
    </dialog>
  </>;
}

export default function ResultSummary({ result, recording, onCycle, onCar, doorAnalysis, modelAnalysis, selectedCycle, concealReplay = false }: { result: AnalysisResult | null; recording?: RecordingSummary; onCycle: (index: number) => void; onCar?: (carId: string) => void; doorAnalysis?: DoorAnalysis; modelAnalysis?: ModelAnalysis; selectedCycle?: number | null; concealReplay?: boolean }) {
  if (modelAnalysis) return <section className="ms-result is-computed" aria-label="Prediction result">
    <div className="ms-result-label"><span className="ms-kind predicted">Predicted</span><span>SCOPED MODEL OUTPUT</span></div>
    <div className="ms-result-main"><div>
      <h2>{modelAnalysis.subsystem === 'rail' ? `Rail classification: ${modelAnalysis.prediction}` : modelAnalysis.subsystem === 'shm' ? `Fatigue damage: ${String(modelAnalysis.prediction)}` : modelAnalysis.evidence.cars.some(car => car.has_data) ? `ACV inspection priority: Car ${modelAnalysis.prediction[0]}` : 'ACV ranking: insufficient thermal data'}</h2>
      <p>{modelAnalysis.subsystem === 'rail' ? 'One classification for this recording: Normal, Side I, or Side II. It does not identify a particular axle box or geographic location.' : modelAnalysis.subsystem === 'shm' ? 'One fatigue damage estimate for this stress recording. This value is not a health percentage or a remaining-life estimate.' : 'All eight source cars, in the model’s inspection order. The model assumes one faulty car per case; rank 1 is a relative priority, not a confirmed fault. Cars without enough usable thermal data are ranked last and are not confirmed healthy.'}</p>
    </div><span className="ms-result-scope">RECORDING</span></div>
    <p className="ms-result-source"><strong>Analysed file</strong> {modelAnalysis.source_name}</p>
    <div className="ms-door-summary ms-model-summary" aria-label={modelAnalysis.subsystem === 'rail' ? 'Rail analysis summary' : `${modelAnalysis.subsystem.toUpperCase()} analysis summary`}>
      <span><strong>{modelAnalysis.summary.rows.toLocaleString()}</strong> source samples</span>
      {modelAnalysis.subsystem === 'rail' ? <span><strong>{modelAnalysis.evidence.speed_kmh.toFixed(2)}</strong> km/h · derived recording speed</span> : modelAnalysis.subsystem === 'shm' ? <span><strong>{modelAnalysis.evidence.cycles.toLocaleString()}</strong> counted stress cycles</span> : <span><strong>{modelAnalysis.evidence.cars.filter(car => car.has_data).length} / 8</strong> cars with usable thermal data</span>}
    </div>
    {modelAnalysis.subsystem === 'acv' && <div className="ms-segments ms-acv-ranking"><table><caption>ACV model ranking · {modelAnalysis.source_name}</caption><thead><tr><th>Rank</th><th>Source car</th><th>Peer-relative thermal deficit</th><th>Usable thermal minutes</th></tr></thead><tbody>{modelAnalysis.evidence.cars.map(car => <tr key={car.car_id} className={car.has_data ? undefined : 'ms-acv-unobserved'}><td>{car.rank}</td><td>{onCar ? <button className="ms-text-button" onClick={() => onCar(car.car_id)} aria-label={`Inspect Car ${car.car_id}`}>Car {car.car_id}<ArrowRight size={12}/></button> : `Car ${car.car_id}`}{!car.has_data && <span>Insufficient thermal data</span>}</td><td title={car.thermal_deficit_degC === null ? undefined : String(car.thermal_deficit_degC)}>{car.thermal_deficit_degC === null ? 'Unavailable' : `${car.thermal_deficit_degC.toFixed(2)} °C`}</td><td title={String(car.valid_minutes)}>{car.valid_minutes.toLocaleString(undefined, { maximumFractionDigits: 2 })} min</td></tr>)}</tbody></table><p>Thermal deficit measures sustained warmth relative to peer cars, accounting for set points. It is not the cabin temperature. Usable minutes reflect the model’s filtering and smoothing.</p></div>}
    {modelAnalysis.warnings.length > 0 && <div className="ms-result-warnings" role="note" aria-label="Model warnings"><strong>Model warnings</strong><ul>{modelAnalysis.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div>}
    <details className="ms-model"><summary><ShieldCheck size={12}/>Model details<ChevronDown size={12}/></summary><div>
      <p><strong>Model</strong> {modelAnalysis.model_name} · {modelAnalysis.model_id}</p>
      <p>The uploaded recording ran through the supplied model and its preprocessing in the Python backend. The displayed prediction preserves the returned value.</p>
      {modelAnalysis.subsystem === 'rail' ? <p><strong>Unweighted model scores (0–1)</strong> {Object.entries(modelAnalysis.evidence.probabilities).map(([label, value]) => `${label}: ${String(value)}`).join(' · ')}. The supplied script applies saved class weights before choosing the final classification, so the largest displayed score may differ from that classification. These scores do not certify mechanical condition.</p> : modelAnalysis.subsystem === 'shm' ? <p><strong>Fifth range moment</strong> {String(modelAnalysis.evidence.range_moment_5)}. A model input combining counted stress-cycle ranges raised to the fifth power; it is not an independent condition rating.</p> : <>
        <p><strong>Relative model scores (0–1)</strong> Scores sum to one under the model’s one-fault-per-case assumption. They are not calibrated confidence or a health percentage. The displayed order is the script’s returned ranking.</p>
        <ul className="ms-acv-scores">{modelAnalysis.evidence.cars.map(car => <li key={car.car_id}><strong>Car {car.car_id}</strong> · score {String(car.probability)} · intervention {car.intervention_level}{car.intervention_minutes === null ? ' (telemetry unavailable)' : ` (${String(car.intervention_minutes)} min)`} · compressor start ratio {car.compressor_start_ratio === null ? 'unavailable' : String(car.compressor_start_ratio)}</li>)}</ul>
        <p><strong>Timestamp processing</strong> {modelAnalysis.evidence.analysed_rows.toLocaleString()} rows analysed; {modelAnalysis.evidence.dropped_timestamp_rows.toLocaleString()} invalid timestamps and {modelAnalysis.evidence.duplicate_timestamp_rows.toLocaleString()} duplicate timestamps excluded.</p>
      </>}
      <p><strong>Source</strong> {modelAnalysis.source_name} · SHA-256 {modelAnalysis.source_sha256}</p>
      <p>Results are temporary. Download CSV or ZIP to keep a copy; run analysis again if the backend restarts or the result expires.</p>
    </div></details>
  </section>;
  return <section className={`ms-result ${result ? 'is-computed' : ''}`} aria-label="Prediction result">
    <div className="ms-result-label"><span className={`ms-kind ${result ? 'predicted' : 'metadata'}`}>{result ? 'Predicted' : 'Not analysed'}</span><span>SCOPED MODEL OUTPUT</span></div>
    {!result ? <div className="ms-result-empty"><FileCheck2 size={23}/><div><h2>{recording ? 'Recording ready for analysis' : 'Choose a recording to begin'}</h2><p>{recording ? 'Run analysis to produce a result. Missing predictions are never shown as Normal.' : 'Upload a supported recording to inspect its source signals.'}</p></div></div> : <>
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
