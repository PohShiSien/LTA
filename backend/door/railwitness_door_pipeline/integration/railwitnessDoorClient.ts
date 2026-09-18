/** Typed adapter for the included Python API. No model training occurs in React. */
export type DoorLabel = 'Normal' | 'Abnormal resistance';
export interface DoorCycle {
  cycle_index: number;
  cycle_id: string; // Local recording ID, NOT a physical door identifier.
  start_time: string;
  end_time: string;
  prediction: DoorLabel;
  operation_inferred: 'Open' | 'Close';
  abnormal_model_score: number; // Uncalibrated. Do not relabel "failure probability".
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
  travel_fraction: number;
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

export function createDoorClient(baseUrl = 'http://127.0.0.1:8000') {
  const base = baseUrl.replace(/\/$/, '');
  async function json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(base + path, init);
    const body: unknown = await response.json();
    if (!response.ok) {
      const message = typeof body === 'object' && body !== null && 'detail' in body
        ? String((body as { detail: unknown }).detail) : 'Door analysis request failed.';
      throw new Error(message);
    }
    return body as T;
  }
  return {
    async analyse(file: File, signal?: AbortSignal): Promise<DoorAnalysis> {
      if (!file.name.toLowerCase().endsWith('.csv')) throw new Error('Select a raw Door CSV.');
      const form = new FormData(); form.append('file', file);
      // Do NOT set Content-Type manually: the browser adds the multipart boundary.
      return json<DoorAnalysis>('/api/door/predict', { method: 'POST', body: form, signal });
    },
    cycle(jobId: string, index: number, signal?: AbortSignal): Promise<DoorCycleDetail> {
      return json<DoorCycleDetail>(`/api/door/jobs/${encodeURIComponent(jobId)}/cycles/${index}`, { signal });
    },
    downloadUrl(path: string): string {
      if (!path.startsWith('/api/door/jobs/')) throw new Error('Unexpected download path.');
      return base + path;
    },
  };
}
