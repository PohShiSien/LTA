import { strToU8, zipSync } from 'fflate';
import type { AnalysisResult, Subsystem } from '../types/multisystem';

const csvCell = (value: string | number) => {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

function validateResults(results: readonly AnalysisResult[]): void {
  if (!results.length) throw new Error('Run analysis before exporting predictions.');
  if (new Set(results.map(result => result.source.mode)).size !== 1) throw new Error('Uploaded and synthetic demonstration results cannot share a prediction export.');
  const identities = new Set<string>();
  for (const result of results) {
    if (result.source.subsystem !== result.subsystem || !result.source.fileName || !result.source.datasetId || !result.source.fileId || !result.model?.version || !Number.isFinite(Date.parse(result.analysedAt))) throw new Error('Only analysed results with complete source and model provenance can be exported.');
    const key = `${result.subsystem}:${result.source.fileName}`;
    if (identities.has(key)) throw new Error(`Duplicate output identity ${result.source.fileName}. Export recordings with the same name separately.`);
    identities.add(key);
    if (result.subsystem === 'rail' && !['Normal', 'Side I', 'Side II'].includes(result.prediction)) throw new Error('Rail exports require one of the three specified recording-level classes.');
    if (result.subsystem === 'shm' && !Number.isFinite(result.predictedDamage)) throw new Error('SHM damage must be a finite numeric model output.');
    if (result.subsystem === 'acv' && (result.rankedCars.length !== 8 || new Set(result.rankedCars).size !== 8 || result.rankedCars.some(car => !/^\d{2}$/.test(car)))) throw new Error('ACV exports require all eight unique two-digit car identifiers.');
    if (result.subsystem === 'door' && result.segments.some(segment => !segment.start_time || !segment.end_time || !['Normal', 'Abnormal resistance'].includes(segment.prediction))) throw new Error('Every Door segment requires start_time, end_time, and a supported classification.');
  }
}

/** The exact scored CSV schema; only supplied analysed results are emitted. */
export function predictionCsv(results: readonly AnalysisResult[], subsystem: Subsystem): string {
  const selected = results.filter(result => result.subsystem === subsystem);
  validateResults(selected);
  if (subsystem === 'door' && selected.length > 1) throw new Error('Door CSV has no file_id column. Export one analysed continuous door stream at a time.');
  const rows: (string | number)[][] = [subsystem === 'door' ? ['start_time', 'end_time', 'prediction'] : subsystem === 'acv' ? ['file_id', 'ranked_cars'] : ['file_id', 'prediction']];
  for (const result of selected) {
    if (result.subsystem === 'door') rows.push(...result.segments.map(segment => [segment.start_time, segment.end_time, segment.prediction]));
    else if (result.subsystem === 'acv') rows.push([result.source.fileName, result.rankedCars.join('|')]);
    else if (result.subsystem === 'rail') rows.push([result.source.fileName, result.prediction]);
    else rows.push([result.source.fileName, result.predictedDamage]);
  }
  return `${rows.map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

/** Flat ZIP with only generated *_predictions.csv entries, never recordings or placeholders. */
export function predictionsZip(results: readonly AnalysisResult[]): Uint8Array<ArrayBuffer> {
  validateResults(results);
  const files: Record<string, Uint8Array> = {};
  for (const subsystem of ['door', 'acv', 'rail', 'shm'] as const) if (results.some(result => result.subsystem === subsystem)) files[`${subsystem}_predictions.csv`] = strToU8(predictionCsv(results, subsystem));
  return zipSync(files, { level: 6 });
}
