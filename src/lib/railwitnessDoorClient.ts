/** Client for the frozen Python Door model. No prediction fallback runs in React. */
export type DoorLabel = 'Normal' | 'Abnormal resistance';
export interface DoorCycle {
  cycle_index: number;
  cycle_id: string; // Recording-local identifier; never a physical door identity.
  start_index: number;
  end_index: number; // Zero-based, inclusive.
  start_time: string;
  end_time: string;
  prediction: DoorLabel;
  operation_inferred: 'Open' | 'Close';
  abnormal_model_score: number;
  score_description: string;
  duration_s: number;
  n_rows: number;
  mean_current_A: number;
  peak_current_A: number;
  asset_id: null;
  recommendation: string;
  data_quality_warnings: string[];
}
export interface DoorAnalysis {
  job_id: string;
  model_name: string;
  model_id: string;
  source_name: string;
  source_sha256: string;
  mode: 'offline_completed_cycle_analysis';
  summary: {
    rows: number; cycles: number; normal: number; abnormal_resistance: number;
    source_start: string; source_end: string; inference_seconds: number;
  };
  segments: DoorCycle[];
  downloads: { csv: string; zip: string };
  warnings: string[];
  retention: string;
}
export interface DoorPoint {
  elapsed_s: number;
  elapsed_fraction: number;
  travel_fraction?: number | null;
  current_A: number;
  voltage_V: number;
  bemf_raw: number;
  position_raw: number;
}
export interface DoorCycleDetail {
  segment: DoorCycle;
  points: DoorPoint[];
  display_downsampled: boolean;
  reference: null | {
    elapsed_fraction: number[]; lower_A: number[]; median_A: number[];
    upper_A: number[]; n_normal_training_cycles: number;
  };
  reference_method: string;
  reference_limitation: string;
  features: Record<string, number | null>;
  explanations: {
    feature: string; value: number | null; log_odds_contribution: number;
    direction: 'toward Abnormal resistance' | 'toward Normal';
  }[];
  explanation_method: string;
  model_intercept: number | null;
  units: Record<string, string>;
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const integer = (value: unknown, minimum = 0): value is number => finite(value) && Number.isSafeInteger(value) && value >= minimum;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const numbers = (value: unknown): value is number[] => Array.isArray(value) && value.every(finite);
const nullableNumber = (value: unknown): value is number | null => value === null || finite(value);
const fraction = (value: unknown): value is number => finite(value) && value >= 0 && value <= 1;
const increasing = (values: number[]): boolean => values.every((value, index) => index === 0 || value >= values[index - 1]);
function contract(condition: unknown, description: string): asserts condition {
  if (!condition) throw new Error(`Door backend returned an invalid response (${description}). Run analysis again; no replacement prediction was generated.`);
}
function validCycle(value: unknown): value is DoorCycle {
  if (!record(value)) return false;
  return integer(value.cycle_index) && text(value.cycle_id) && text(value.start_time) && text(value.end_time)
    && (value.prediction === 'Normal' || value.prediction === 'Abnormal resistance')
    && (value.operation_inferred === 'Open' || value.operation_inferred === 'Close')
    && finite(value.abnormal_model_score) && text(value.score_description)
    && finite(value.duration_s) && value.duration_s >= 0 && integer(value.n_rows, 1)
    && finite(value.mean_current_A) && finite(value.peak_current_A) && value.asset_id === null
    && text(value.recommendation) && strings(value.data_quality_warnings)
    && integer(value.start_index) && integer(value.end_index) && value.end_index - value.start_index + 1 === value.n_rows;
}

/** Validate counts and explicit, contiguous coverage of every source row. */
export function validateDoorAnalysis(value: unknown): DoorAnalysis {
  contract(record(value), 'analysis object');
  contract(text(value.job_id) && /^[a-zA-Z0-9_-]+$/.test(value.job_id), 'job identifier');
  contract(value.model_name === 'logistic_regression' && text(value.model_id), 'frozen logistic_regression model identity');
  contract(text(value.source_name) && typeof value.source_sha256 === 'string' && /^[a-fA-F0-9]{64}$/.test(value.source_sha256), 'source provenance');
  contract(value.mode === 'offline_completed_cycle_analysis', 'completed-cycle scope');
  contract(record(value.summary), 'summary');
  const summary = value.summary;
  contract(integer(summary.rows, 1) && integer(summary.cycles, 1) && integer(summary.normal) && integer(summary.abnormal_resistance)
    && text(summary.source_start) && text(summary.source_end) && finite(summary.inference_seconds) && summary.inference_seconds >= 0, 'summary fields');
  contract(Array.isArray(value.segments) && value.segments.every(validCycle), 'cycle fields, labels or row indices');
  const segments = value.segments as DoorCycle[];
  contract(segments.length === summary.cycles && summary.normal + summary.abnormal_resistance === summary.cycles, 'cycle totals');
  let nextIndex = 0;
  const cycleIds = new Set<string>();
  for (const [index, segment] of segments.entries()) {
    contract(segment.cycle_index === index && !cycleIds.has(segment.cycle_id), 'cycle index sequence');
    cycleIds.add(segment.cycle_id);
    contract(segment.start_index === nextIndex, 'contiguous source row coverage');
    nextIndex = segment.end_index + 1;
  }
  contract(nextIndex === summary.rows, 'complete source row coverage');
  contract(segments.filter(segment => segment.prediction === 'Normal').length === summary.normal, 'classification totals');
  contract(segments[0]?.start_time === summary.source_start && segments.at(-1)?.end_time === summary.source_end, 'source timestamps');
  const path = `/api/door/jobs/${encodeURIComponent(value.job_id)}`;
  contract(record(value.downloads) && value.downloads.csv === `${path}/predictions.csv` && value.downloads.zip === `${path}/predictions.zip`, 'job download paths');
  contract(strings(value.warnings) && text(value.retention), 'warnings and retention');
  return value as unknown as DoorAnalysis;
}

function validateCycleDetail(value: unknown, index: number): DoorCycleDetail {
  contract(record(value) && validCycle(value.segment) && value.segment.cycle_index === index, 'selected cycle identity');
  contract(Array.isArray(value.points) && value.points.length > 0 && value.points.every(point => record(point)
    && finite(point.elapsed_s) && point.elapsed_s >= 0 && fraction(point.elapsed_fraction)
    && (point.travel_fraction === undefined || nullableNumber(point.travel_fraction))
    && finite(point.current_A) && finite(point.voltage_V) && finite(point.bemf_raw) && finite(point.position_raw)), 'recorded cycle signals');
  const points = value.points as DoorPoint[];
  contract(increasing(points.map(point => point.elapsed_fraction)) && increasing(points.map(point => point.elapsed_s)), 'elapsed cycle time');
  contract(typeof value.display_downsampled === 'boolean' && (value.display_downsampled ? points.length <= value.segment.n_rows : points.length === value.segment.n_rows), 'display sample coverage');
  if (value.reference !== null) {
    const reference = value.reference;
    contract(record(reference) && numbers(reference.elapsed_fraction) && reference.elapsed_fraction.length > 1
      && reference.elapsed_fraction.every(fraction) && increasing(reference.elapsed_fraction)
      && numbers(reference.lower_A) && numbers(reference.median_A) && numbers(reference.upper_A)
      && integer(reference.n_normal_training_cycles, 1), 'normal training reference');
    contract(reference.lower_A.length === reference.elapsed_fraction.length && reference.median_A.length === reference.elapsed_fraction.length
      && reference.upper_A.length === reference.elapsed_fraction.length, 'reference alignment');
    const lower = reference.lower_A;
    const upper = reference.upper_A;
    contract(reference.median_A.every((median, i) => lower[i] <= median && median <= upper[i]), 'reference percentile order');
  }
  contract(text(value.reference_method) && text(value.reference_limitation) && text(value.explanation_method), 'evidence limitations');
  contract(record(value.features) && Object.values(value.features).every(nullableNumber) && nullableNumber(value.model_intercept), 'model features');
  contract(Array.isArray(value.explanations) && value.explanations.every(explanation => record(explanation) && text(explanation.feature)
    && nullableNumber(explanation.value) && finite(explanation.log_odds_contribution)
    && explanation.direction === (explanation.log_odds_contribution > 0 ? 'toward Abnormal resistance' : 'toward Normal')), 'signed feature contributions');
  contract(record(value.units) && Object.values(value.units).every(text), 'signal units');
  return value as unknown as DoorCycleDetail;
}

function errorDetail(body: unknown): string | null {
  if (!record(body) || !('detail' in body)) return null;
  if (text(body.detail)) return body.detail;
  if (Array.isArray(body.detail)) {
    const messages = body.detail.flatMap(item => record(item) && text(item.msg) ? [item.msg] : []);
    return messages.length ? messages.join('; ') : null;
  }
  return null;
}

export function createDoorClient(baseUrl = 'http://127.0.0.1:8000') {
  const base = baseUrl.replace(/\/+$/, '');
  function jobPath(jobId: string): string {
    if (!jobId.trim()) throw new Error('Door analysis job is unavailable. Run analysis again or re-upload the CSV.');
    return `/api/door/jobs/${encodeURIComponent(jobId)}`;
  }
  async function request(path: string, init?: RequestInit): Promise<Response> {
    let response: Response;
    try { response = await fetch(base + path, init); }
    catch (error) {
      if (init?.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
      throw new Error(`Cannot reach the Door backend at ${base || 'this server'}. Start the Python backend and check VITE_DOOR_API_URL, then run analysis again.`, { cause: error });
    }
    if (!response.ok) {
      let body: unknown = null;
      try { body = await response.json(); }
      catch (error) {
        if (init?.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
      }
      const detail = errorDetail(body);
      if (response.status === 404) throw new Error(`Door analysis expired or is unavailable. Run analysis again or re-upload the CSV.${detail ? ` ${detail}` : ''}`);
      throw new Error(`Door backend request failed (${response.status}). ${detail ?? 'Check that the Python backend is running and try again.'}`);
    }
    return response;
  }
  async function json(path: string, init?: RequestInit): Promise<unknown> {
    const response = await request(path, init);
    try { return await response.json(); }
    catch (error) {
      if (init?.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
      throw new Error('Door backend returned invalid JSON. Check the API URL and run analysis again.', { cause: error });
    }
  }
  async function download(jobId: string, extension: 'csv' | 'zip', signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    const response = await request(`${jobPath(jobId)}/predictions.${extension}`, { signal });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (extension === 'csv') {
      contract(new TextDecoder().decode(bytes).split(/\r?\n/, 1)[0] === 'start_time,end_time,prediction', 'Door CSV schema');
    } else contract(bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04, 'prediction ZIP');
    return bytes;
  }
  return {
    async analyse(file: File, signal?: AbortSignal): Promise<DoorAnalysis> {
      if (!file.name.toLowerCase().endsWith('.csv')) throw new Error('Select a raw Door CSV.');
      const form = new FormData();
      form.append('file', file);
      // The browser supplies the multipart boundary; do not override Content-Type.
      const analysis = validateDoorAnalysis(await json('/api/door/predict', { method: 'POST', body: form, signal }));
      contract(analysis.source_name === file.name, 'uploaded source filename');
      return analysis;
    },
    async cycle(jobId: string, index: number, signal?: AbortSignal): Promise<DoorCycleDetail> {
      if (!integer(index)) throw new Error('Select a valid recorded cycle.');
      return validateCycleDetail(await json(`${jobPath(jobId)}/cycles/${index}`, { signal }), index);
    },
    csv(jobId: string, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> { return download(jobId, 'csv', signal); },
    zip(jobId: string, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> { return download(jobId, 'zip', signal); },
  };
}
