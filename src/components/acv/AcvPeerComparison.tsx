import { useId, useState } from 'react';
import type { AcvVisualizationEvidence } from '../../lib/visualEvidence';
import type { AcvCarRankingProps } from './AcvCarRanking';
import './AcvEvidence.css';

interface Props extends Omit<AcvCarRankingProps, 'scanning'> { evidence: AcvVisualizationEvidence | null; loading?: boolean; error?: string | null }
const number = (value: number | null | undefined, digits = 2) => value === null || value === undefined ? 'Unavailable' : value.toFixed(digits);
export default function AcvPeerComparison({ result, recording, selectedCarId, onSelectCar, evidence, loading, error }: Props) {
  const [metric, setMetric] = useState<'residual' | 'score'>('residual');
  const selectId = useId();
  const selected = evidence?.cars.find(car => car.carId === selectedCarId) ?? evidence?.cars.find(car => car.carId === result.rankedCars[0]);
  const values = result.rankedCars.map(carId => ({ carId, value: metric === 'score' ? result.scores?.[carId] ?? null : evidence?.cars.find(car => car.carId === carId)?.residualMean ?? null }));
  const max = Math.max(1e-12, ...values.map(item => Math.abs(item.value ?? 0)));
  return <section className="ve-panel" aria-label="ACV peer evidence" aria-busy={loading}>
    <header className="ve-heading"><div><span className="ve-kicker">RECORDED + DERIVED EVIDENCE</span><h2>Relative ranking evidence</h2><p>Compare all source cars over the complete recording.</p></div>
      <label className="ve-select" htmlFor={selectId}>Compare<select id={selectId} value={metric} onChange={event => setMetric(event.target.value as 'residual' | 'score')}><option value="residual">Indoor − target residual</option><option value="score" disabled={!result.scores}>Relative model ranking score</option></select></label>
    </header>
    {error ? <p className="ve-empty" role="alert">{error}</p> : !evidence ? <p className="ve-empty">{loading ? 'Summarising recorded cooling evidence…' : 'Recorded cooling evidence is unavailable.'}</p> : <>
      <div className="acv-peer-layout"><div className="acv-peer-bars">
        <div className="acv-peer-axis"><span>{metric === 'residual' ? 'Mean indoor − target · source units unless supplied' : 'Uncalibrated model score · relative ordering'}</span></div>
        {values.map(({ carId, value }, index) => <button key={carId} type="button" className="acv-peer-row" aria-pressed={selected?.carId === carId} onClick={() => onSelectCar(carId)}>
          <span className="acv-peer-label"><small>#{index + 1}</small>Car {carId}</span><span className="acv-peer-track" aria-hidden="true"><span className="acv-peer-zero"/><i className={index < 3 ? 'warm' : ''} style={{ left: `${value !== null && value < 0 ? 50 - Math.abs(value) / max * 50 : 50}%`, width: `${Math.abs(value ?? 0) / max * 50}%` }}/></span><strong>{number(value, metric === 'score' ? 4 : 2)}</strong>
        </button>)}
        <p className="ve-footnote">{metric === 'residual' ? 'Zero-centred comparison. Positive residual means the recorded indoor temperature is above its target/control value. These summaries provide context; they are not model feature attributions.' : 'The original learned scores determine ordering. A score is not a calibrated leak probability.'}</p>
      </div>
      {selected && <aside className="acv-selected-evidence"><span className="ve-kicker">SELECTED SOURCE CAR</span><h3>Car {selected.carId}<small>Rank #{result.rankedCars.indexOf(selected.carId) + 1}</small></h3>
        <dl className="ve-metrics"><div><dt>Mean indoor</dt><dd>{number(selected.indoorMean)}<small>{selected.unit ?? 'source units'}</small></dd></div><div><dt>Mean target / control</dt><dd>{number(selected.targetMean)}<small>{selected.unit ?? 'source units'}</small></dd></div><div><dt>Residual vs case mean</dt><dd>{number(selected.peerDeviation)}<small>{selected.unit ?? 'source units'}</small></dd></div><div><dt>Valid paired coverage</dt><dd>{(selected.validCoverage * 100).toFixed(1)}%<small>{selected.pairedCount.toLocaleString()} / {recording.rowCount.toLocaleString()} rows</small></dd></div><div><dt>Cooling-state residual</dt><dd>{number(selected.coolingResidual)}<small>{selected.unit ?? 'source units'}</small></dd></div><div><dt>Cooling response</dt><dd>{number(selected.coolingResponse)}<small>{selected.coolingResponseUnit}</small></dd></div></dl>
        <p className="ve-footnote">Cooling response is mean indoor change over {selected.coolingPairs.toLocaleString()} adjacent valid cooling pairs; negative means cooling. Peer deviation uses simultaneous valid car residuals, including the selected car.</p>
        {!!selected.warnings.length && <ul className="ve-warnings">{selected.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>}
        <details className="ve-details"><summary>Source headers and coverage</summary><p>{selected.invalidRows.toLocaleString()} invalid rows · {selected.unknownValidityRows.toLocaleString()} unknown-validity rows. Missing or invalid paired measurements are excluded.</p><ul>{selected.sourceHeaders.map(header => <li key={header}>{header}</li>)}</ul></details>
      </aside>}</div>
    </>}
  </section>;
}
