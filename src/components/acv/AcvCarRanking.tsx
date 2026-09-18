import type { AnalysisResult, RecordingSummary } from '../../types/multisystem';
import './AcvEvidence.css';

export interface AcvCarRankingProps {
  result: Extract<AnalysisResult, { subsystem: 'acv' }>;
  recording: RecordingSummary;
  selectedCarId?: string;
  onSelectCar: (carId: string) => void;
  scanning?: boolean;
}
export default function AcvCarRanking({ result, recording, selectedCarId, onSelectCar, scanning = false }: AcvCarRankingProps) {
  return <section className="ve-panel acv-ranking-panel" aria-label="ACV car ranking">
    <header className="ve-heading"><div><span className="ve-kicker">MODEL OUTPUT · RELATIVE RANKING</span><h2>Eight cars. One ranked case.</h2><p>Select a car to inspect its recorded cooling evidence.</p></div><span className="ve-status">{scanning ? 'SCANNING CARS' : 'RANKING COMPLETE'}</span></header>
    <ol className="acv-rank-cards">{result.rankedCars.map((carId, index) => <li key={carId}>
      <button type="button" className={`acv-rank-card acv-rank-${Math.min(index + 1, 4)}`} aria-pressed={selectedCarId === carId} aria-label={`Car ${carId}, rank ${index + 1}`} onClick={() => onSelectCar(carId)}>
        <span className="acv-rank-ordinal">#{index + 1}</span><span className="acv-car-caption">CAR</span><strong>{carId}</strong>
        <span className="acv-rank-strength" aria-hidden="true"><i style={{ width: `${100 - index * 10}%` }}/></span>
        <small>{result.scores?.[carId] !== undefined ? `Score ${result.scores[carId].toFixed(4)}` : `Rank ${index + 1} of ${result.rankedCars.length}`}</small>
      </button>
    </li>)}</ol>
    <p className="ve-footnote">Exact source car IDs · strongest glow means highest relative suspicion. Ranking scores are uncalibrated; they do not establish a confirmed leak. {recording.source.mode === 'demo' ? 'Synthetic demonstration case.' : 'Complete uploaded case analysed.'}</p>
  </section>;
}
