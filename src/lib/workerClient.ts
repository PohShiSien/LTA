import type { AnalysisResult, CellValue, ComponentSelection, RecordingSummary, Subsystem } from '../types/multisystem';
import type { SignalInspection } from './signals';

export interface InspectionData { cursor: number; row: CellValue[]; signals: SignalInspection[] }
export type WorkerRequest =
  | { type: 'load'; subsystem: Subsystem; fileName: string; contents: ArrayBuffer; datasetId: string }
  | { type: 'demo'; subsystem: Subsystem }
  | { type: 'analyse'; key: string }
  | { type: 'inspect'; key: string; cursor: number; fields: string[] }
  | { type: 'remove'; key: string };
export const sourceKey = (recording: Pick<RecordingSummary, 'source'> | AnalysisResult) => {
  const source = recording.source;
  return `${source.mode}:${source.subsystem}:${source.datasetId}:${source.fileId}`;
};
let worker: Worker | undefined;
let sequence = 0;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
export function workerRequest<T>(request: WorkerRequest): Promise<T> {
  if (!worker) {
    worker = new Worker(new URL('../workers/analysis.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = event => {
      const { id, data, error } = event.data;
      const task = pending.get(id);
      if (!task) return;
      pending.delete(id);
      if (error) task.reject(new Error(error)); else task.resolve(data);
    };
    worker.onerror = event => {
      for (const task of pending.values()) task.reject(new Error(event.message || 'The analysis worker stopped. Reload the recording and retry.'));
      pending.clear(); worker?.terminate(); worker = undefined;
    };
  }
  return new Promise<T>((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve: value => resolve(value as T), reject });
    worker!.postMessage({ id, request }, request.type === 'load' ? [request.contents] : []);
  });
}
export function initialSelection(subsystem: Subsystem, recording?: RecordingSummary): ComponentSelection {
  if (!recording) return { kind: 'recording' };
  if (subsystem === 'rail') return { kind: 'axleBox', carOrdinal: 1, position: 1 };
  if (subsystem === 'acv') return { kind: 'car', carId: recording?.carIds[0] ?? '01', ordinal: 1 };
  return { kind: 'recording' };
}
