/** Recording-level inference for the supplied subsystem models. */
export type RecordingModel = 'rail' | 'shm' | 'acv';
export type RailPrediction = 'Normal' | 'Side I' | 'Side II';
export interface AcvCarEvidence {
  car_id: string;
  rank: number;
  probability: number;
  thermal_deficit_degC: number | null;
  valid_minutes: number;
  has_data: boolean;
  intervention_minutes: number | null;
  intervention_level: 'none' | 'brief' | 'sustained' | 'unobserved';
  compressor_start_ratio: number | null;
}
interface ModelResponse {
  job_id: string;
  model_name: string;
  model_id: string;
  source_name: string;
  source_sha256: string;
  summary: { rows: number };
  warnings: string[];
  downloads: { csv: string; zip: string };
}
export type ModelAnalysis = ModelResponse & (
  | { subsystem: 'rail'; prediction: RailPrediction; evidence: { speed_kmh: number; probabilities: Record<RailPrediction, number> } }
  | { subsystem: 'shm'; prediction: number; evidence: { cycles: number; range_moment_5: number } }
  | { subsystem: 'acv'; prediction: string[]; evidence: { cars: AcvCarEvidence[]; analysed_rows: number; dropped_timestamp_rows: number; duplicate_timestamp_rows: number } }
);

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const nonnegative = (value: unknown): value is number => finite(value) && value >= 0;
const labels: RailPrediction[] = ['Normal', 'Side I', 'Side II'];
function contract(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error(`Model backend returned an invalid response (${detail}). Run analysis again; no replacement prediction was generated.`);
}
export function validateModelAnalysis(value: unknown, subsystem: RecordingModel): ModelAnalysis {
  contract(record(value) && value.subsystem === subsystem, 'subsystem');
  contract(text(value.job_id) && /^[a-f0-9]+$/i.test(value.job_id), 'job identifier');
  contract(text(value.model_name) && text(value.model_id), 'model identity');
  contract(text(value.source_name) && typeof value.source_sha256 === 'string' && /^[a-f0-9]{64}$/i.test(value.source_sha256), 'source provenance');
  contract(record(value.summary) && finite(value.summary.rows) && Number.isSafeInteger(value.summary.rows) && value.summary.rows > 0, 'source row count');
  contract(Array.isArray(value.warnings) && value.warnings.every(item => typeof item === 'string'), 'warnings');
  contract(record(value.evidence), 'model evidence');
  const evidence = value.evidence;
  if (subsystem === 'rail') {
    contract(labels.includes(value.prediction as RailPrediction), 'Rail classification');
    contract(finite(evidence.speed_kmh) && evidence.speed_kmh >= 0 && record(evidence.probabilities), 'Rail evidence');
    const probabilities = evidence.probabilities;
    // The supplied predictor rounds each of its three scores to four decimal places.
    contract(Object.keys(probabilities).length === labels.length && labels.every(label => finite(probabilities[label]) && probabilities[label] >= 0 && probabilities[label] <= 1)
      && Math.abs(labels.reduce((sum, label) => sum + (probabilities[label] as number), 0) - 1) <= 2e-4, 'Rail class probabilities');
  } else if (subsystem === 'shm') {
    contract(finite(value.prediction) && value.prediction > 0, 'SHM damage');
    contract(finite(evidence.cycles) && Number.isSafeInteger(evidence.cycles) && evidence.cycles >= 0 && finite(evidence.range_moment_5) && evidence.range_moment_5 >= 0, 'SHM evidence');
  } else {
    contract(Array.isArray(value.prediction) && value.prediction.length === 8 && value.prediction.every(car => typeof car === 'string' && /^\d{2}$/.test(car)) && new Set(value.prediction).size === 8, 'ACV eight-car ranking');
    const ranking = value.prediction;
    contract(['analysed_rows', 'dropped_timestamp_rows', 'duplicate_timestamp_rows'].every(key => nonnegative(evidence[key]) && Number.isSafeInteger(evidence[key]))
      && (evidence.analysed_rows as number) > 0
      && (evidence.analysed_rows as number) + (evidence.dropped_timestamp_rows as number) + (evidence.duplicate_timestamp_rows as number) === value.summary.rows, 'ACV analysed row counts');
    contract(Array.isArray(evidence.cars) && evidence.cars.length === 8 && evidence.cars.some(car => record(car) && car.has_data === true), 'ACV car evidence');
    let unobserved = false;
    let scoreSum = 0;
    for (const [index, car] of evidence.cars.entries()) {
      contract(record(car) && car.car_id === ranking[index] && car.rank === index + 1, 'ACV car rank alignment');
      contract(typeof car.has_data === 'boolean' && nonnegative(car.valid_minutes)
        && (car.has_data ? nonnegative(car.thermal_deficit_degC) : car.thermal_deficit_degC === null), 'ACV thermal evidence');
      contract(!unobserved || !car.has_data, 'ACV unobserved cars ranked last');
      unobserved ||= !car.has_data;
      contract(nonnegative(car.probability) && car.probability <= 1 && (car.has_data || car.probability === 0), 'ACV relative model scores');
      scoreSum += car.probability;
      contract((car.intervention_minutes === null || nonnegative(car.intervention_minutes))
        && ['none', 'brief', 'sustained', 'unobserved'].includes(String(car.intervention_level))
        && (car.intervention_minutes !== null || car.intervention_level === 'unobserved')
        && (car.compressor_start_ratio === null || nonnegative(car.compressor_start_ratio)), 'ACV intervention and compressor evidence');
    }
    contract(Math.abs(scoreSum - 1) <= 1e-6, 'ACV relative model scores');
  }
  const path = `/api/${subsystem}/jobs/${value.job_id}`;
  contract(record(value.downloads) && value.downloads.csv === `${path}/predictions.csv` && value.downloads.zip === `${path}/predictions.zip`, 'job download paths');
  return value as unknown as ModelAnalysis;
}

export function createModelClient(baseUrl = 'http://127.0.0.1:8000') {
  const base = baseUrl.replace(/\/+$/, '');
  async function request(path: string, init?: RequestInit): Promise<Response> {
    let response: Response;
    try { response = await fetch(base + path, init); }
    catch (cause) { throw new Error(`Cannot reach the model backend at ${base || 'this server'}. Start the Python backend and check VITE_API_URL, then run analysis again.`, { cause }); }
    if (!response.ok) {
      let detail = '';
      try { const body: unknown = await response.json(); if (record(body) && text(body.detail)) detail = body.detail; } catch { /* Preserve the HTTP error when an upstream server returns non-JSON. */ }
      throw new Error(response.status === 404 ? `Analysis expired or is unavailable. Run analysis again. ${detail}` : `Model backend request failed (${response.status}). ${detail || 'Check the uploaded recording and try again.'}`);
    }
    return response;
  }
  async function download(path: string, format: 'csv' | 'zip', subsystem: RecordingModel, init?: RequestInit): Promise<Uint8Array<ArrayBuffer>> {
    const bytes = new Uint8Array(await (await request(path, init)).arrayBuffer());
    if (format === 'csv') contract(new TextDecoder().decode(bytes).split(/\r?\n/, 1)[0] === (subsystem === 'acv' ? 'file_id,ranked_cars' : 'file_id,prediction'), 'prediction CSV schema');
    else contract(bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04, 'prediction ZIP');
    return bytes;
  }
  return {
    async analyse(subsystem: RecordingModel, file: File, rowCount: number, expectedCarIds?: string[]): Promise<ModelAnalysis> {
      if (!(subsystem === 'acv' ? /\.(csv|xlsx)$/i : /\.csv$/i).test(file.name)) throw new Error(subsystem === 'acv' ? 'Select an ACV recording CSV or XLSX workbook.' : 'Select a raw recording CSV.');
      const form = new FormData(); form.append('file', file);
      const response = await request(`/api/${subsystem}/predict`, { method: 'POST', body: form });
      let value: unknown;
      try { value = await response.json(); } catch (cause) { throw new Error('Model backend returned invalid JSON. Check the API URL and run analysis again.', { cause }); }
      const analysis = validateModelAnalysis(value, subsystem);
      contract(analysis.source_name === file.name && analysis.summary.rows === rowCount, 'uploaded source filename or row count');
      if (analysis.subsystem === 'acv' && expectedCarIds) contract(expectedCarIds.length === 8 && new Set(expectedCarIds).size === 8 && expectedCarIds.every(car => analysis.prediction.includes(car)), 'uploaded ACV source cars');
      const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
      const sha256 = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
      contract(analysis.source_sha256.toLowerCase() === sha256, 'uploaded source content');
      return analysis;
    },
    csv(analysis: ModelAnalysis) { return download(analysis.downloads.csv, 'csv', analysis.subsystem); },
    export(subsystem: RecordingModel, analyses: ModelAnalysis[], format: 'csv' | 'zip') {
      if (!analyses.length || analyses.some(analysis => analysis.subsystem !== subsystem)) throw new Error('Run analysis for each recording before exporting.');
      if (new Set(analyses.map(analysis => analysis.source_name)).size !== analyses.length) throw new Error('Combined export requires unique filenames. Rename or remove duplicate recordings, then run analysis again.');
      return download(`/api/${subsystem}/export`, format, subsystem, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ job_ids: analyses.map(analysis => analysis.job_id), format }) });
    },
  };
}
