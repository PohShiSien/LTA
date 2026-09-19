import { parseRecording } from '../lib/recordings';
import { inspectSpectrum, summarizeSignal, type SignalInspection } from '../lib/signals';
import type { Recording } from '../types/multisystem';
import type { WorkerRequest } from '../lib/workerClient';

const recordings = new Map<string, Recording>();
const traces = new Map<string, SignalInspection>();
const keyFor = (recording: Recording) => `${recording.source.subsystem}:${recording.source.datasetId}:${recording.source.fileId}`;
function forget(key: string) {
  recordings.delete(key);
  for (const cached of traces.keys()) if (cached.startsWith(`${key}:`)) traces.delete(cached);
}
async function execute(request: WorkerRequest) {
  if (request.type === 'load') {
    // The UI retains original File handles and can rehydrate an evicted source.
    // Avoid retaining dozens of full-resolution rail files or several rich XLSX cases, but keep enough
    // headroom that the common "one recording per subsystem, across all four tabs" workflow never evicts
    // a recording the user hasn't looked away from yet (a single Rail file alone is ~1.29M cells).
    let cells = [...recordings.values()].reduce((sum, item) => sum + item.rows.length * item.fields.length, 0);
    while (recordings.size && (recordings.size >= 8 || cells > 4_500_000)) {
      const oldest = recordings.keys().next().value!;
      const item = recordings.get(oldest)!;
      cells -= item.rows.length * item.fields.length;
      forget(oldest);
    }
    const recording = await parseRecording(request.fileName, request.contents, request.subsystem, request.datasetId);
    const key = keyFor(recording);
    recordings.set(key, recording);
    for (const cached of traces.keys()) if (cached.startsWith(`${key}:`)) traces.delete(cached);
    const { rows, ...metadata } = recording;
    return { ...metadata, rowCount: rows.length };
  }
  if (request.type === 'remove') { forget(request.key); return true; }
  const recording = recordings.get(request.key);
  if (!recording) throw new Error('This recording is no longer loaded. Upload it again.');
  const cursor = Math.max(0, Math.min(recording.rows.length - 1, Math.floor(request.cursor)));
  const signals = request.fields.slice(0, 4).flatMap(key => {
    const field = recording.fields.find(item => item.fieldKey === key);
    if (!field) return [];
    const cacheKey = `${request.key}:${field.fieldKey}`;
    let signal = traces.get(cacheKey);
    if (!signal) { signal = summarizeSignal(recording.rows, field, 900, recording.fields.find(item => item.fieldKey === field.validityFieldKey)?.columnIndex); traces.set(cacheKey, signal); }
    return [{ ...signal, spectrum: inspectSpectrum(recording, field, cursor) }];
  });
  return { cursor, row: recording.rows[cursor], signals };
}
let requestQueue = Promise.resolve();
self.onmessage = event => {
  const { id, request } = event.data as { id: number; request: WorkerRequest };
  requestQueue = requestQueue.then(async () => {
    try { self.postMessage({ id, data: await execute(request) }); }
    catch (error) { self.postMessage({ id, error: error instanceof Error ? error.message : 'The recording could not be processed.' }); }
  });
};
