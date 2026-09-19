import { strToU8, unzipSync, zipSync } from 'fflate';
import { createHash } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { createModelClient, validateModelAnalysis, type ModelAnalysis } from '../src/lib/modelBackend';
import ResultSummary from '../src/components/workspace/AnalysisResultSummary';

function analysis(subsystem: 'rail' | 'shm' = 'rail'): ModelAnalysis {
  const base = { job_id: 'abc123', model_name: 'supplied-model', model_id: 'artifact-id', source_name: 'Test1.csv', source_sha256: 'a'.repeat(64), summary: { rows: 10000 }, warnings: [], downloads: { csv: `/api/${subsystem}/jobs/abc123/predictions.csv`, zip: `/api/${subsystem}/jobs/abc123/predictions.zip` } };
  return subsystem === 'rail' ? { ...base, subsystem, prediction: 'Side II', evidence: { speed_kmh: 44.2, probabilities: { Normal: .1, 'Side I': .2, 'Side II': .7 } } } : { ...base, subsystem, prediction: 1.27e-8, evidence: { cycles: 21, range_moment_5: 8.2e10 } };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
afterEach(() => vi.unstubAllGlobals());

it.each(['rail', 'shm'] as const)('uploads original %s bytes and validates the matching source and response', async subsystem => {
  const file = new File(['original,CSV\r\n1,2\r\n'], 'Test1.csv');
  const response = { ...analysis(subsystem), source_sha256: createHash('sha256').update(new Uint8Array(await file.arrayBuffer())).digest('hex') };
  const fetch = vi.fn().mockResolvedValueOnce(json(response)).mockResolvedValueOnce(json({ ...response, source_name: 'Different.csv' })).mockResolvedValueOnce(json(response)).mockResolvedValueOnce(json({ ...response, source_sha256: 'a'.repeat(64) }));
  vi.stubGlobal('fetch', fetch);
  const client = createModelClient('http://localhost:8000/');
  expect(await client.analyse(subsystem, file, 10000)).toEqual(response);
  const [url, options] = fetch.mock.calls[0] as [string, RequestInit];
  expect(url).toBe(`http://localhost:8000/api/${subsystem}/predict`);
  expect(options.headers).toBeUndefined();
  expect([...(options.body as FormData).keys()]).toEqual(['file']);
  expect(await ((options.body as FormData).get('file') as File).text()).toBe(await file.text());
  await expect(client.analyse(subsystem, file, 10000)).rejects.toThrow('uploaded source filename or row count');
  await expect(client.analyse(subsystem, file, 3)).rejects.toThrow('uploaded source filename or row count');
  await expect(client.analyse(subsystem, file, 10000)).rejects.toThrow('uploaded source content');
  expect(() => validateModelAnalysis(response, subsystem === 'rail' ? 'shm' : 'rail')).toThrow('subsystem');
  expect(() => validateModelAnalysis({ ...response, prediction: subsystem === 'rail' ? 'Healthy' : 0 }, subsystem)).toThrow('invalid response');
  expect(() => validateModelAnalysis({ ...response, evidence: { speed_kmh: 12, probabilities: { Normal: .6, 'Side I': .6, 'Side II': .1 }, cycles: Infinity } }, subsystem)).toThrow('invalid response');
  expect(() => validateModelAnalysis({ ...response, downloads: { ...response.downloads, csv: '/another-job.csv' } }, subsystem)).toThrow('job download paths');
  if (response.subsystem === 'rail') {
    const rounded = { ...response, evidence: { ...response.evidence, probabilities: { Normal: .3333, 'Side I': .3333, 'Side II': .3333 } } };
    expect(validateModelAnalysis(rounded, 'rail')).toEqual(rounded);
  }
});

it('shows the supplied weighted Rail classification even when another raw score is larger', () => {
  const response = analysis('rail');
  if (response.subsystem !== 'rail') throw new Error('Expected Rail analysis');
  response.evidence.probabilities = { Normal: .7, 'Side I': .2, 'Side II': .1 };
  const validated = validateModelAnalysis(response, 'rail');
  const html = renderToStaticMarkup(createElement(ResultSummary, { result: null, onCycle: () => {}, modelAnalysis: validated }));
  expect(html).toContain('<h2>Rail classification: Side II</h2>');
  expect(html).toContain('<strong>Analysed file</strong> Test1.csv');
  const [visible, details] = html.split('<details');
  expect(visible).not.toContain('Unweighted model scores');
  expect(details).toContain('Normal: 0.7');
  expect(details).toContain('saved class weights');
});

it.each([0.03279583668012471, 1.274536387945621e-8])('shows every returned SHM prediction digit for %s, with clear scope and warnings', prediction => {
  const response = { ...analysis('shm'), prediction, warnings: ['Damage is per segment and is not length-normalised.'] };
  const validated = validateModelAnalysis(response, 'shm');
  const html = renderToStaticMarkup(createElement(ResultSummary, { result: null, onCycle: () => {}, modelAnalysis: validated }));
  expect(html).toContain(`<h2>Fatigue damage: ${String(prediction)}</h2>`);
  expect(html).toContain('not a health percentage or a remaining-life estimate');
  expect(html).toContain('counted stress cycles');
  expect(html).toContain('source samples');
  expect(html).toContain('aria-label="Model warnings"');
  expect(html).toContain('Damage is per segment and is not length-normalised.');
  const [visible, details] = html.split('<details');
  expect(visible).not.toContain('Fifth range moment');
  expect(visible).not.toContain('artifact-id');
  expect(details).toContain('Fifth range moment');
  expect(details).toContain('artifact-id');
});

it('preserves exact selected and combined CSV/ZIP output and refuses mixed or duplicate sources', async () => {
  const csv = strToU8('file_id,prediction\r\nTest1.csv,1.27e-08\r\nTest2.csv,0.00003\r\n');
  const zip = zipSync({ 'shm_predictions.csv': csv });
  const fetch = vi.fn().mockResolvedValueOnce(new Response(csv)).mockResolvedValueOnce(new Response(csv)).mockResolvedValueOnce(new Response(zip));
  vi.stubGlobal('fetch', fetch);
  const client = createModelClient();
  const first = analysis('shm');
  const second = { ...first, job_id: 'def456', source_name: 'Test2.csv' };
  expect(await client.csv(first)).toEqual(csv);
  expect(await client.export('shm', [first, second], 'csv')).toEqual(csv);
  const downloaded = await client.export('shm', [first, second], 'zip');
  expect(unzipSync(downloaded)).toEqual({ 'shm_predictions.csv': csv });
  expect(fetch.mock.calls[0][0]).toBe('http://127.0.0.1:8000/api/shm/jobs/abc123/predictions.csv');
  const [url, options] = fetch.mock.calls[1] as [string, RequestInit];
  expect(url).toBe('http://127.0.0.1:8000/api/shm/export');
  expect(JSON.parse(options.body as string)).toEqual({ job_ids: ['abc123', 'def456'], format: 'csv' });
  expect(() => client.export('shm', [first, { ...second, source_name: first.source_name }], 'csv')).toThrow('unique filenames');
  expect(() => client.export('shm', [analysis('rail')], 'zip')).toThrow('each recording');
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('surfaces unavailable inference, invalid responses and expired exports without fallback results', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new TypeError('Network error')).mockResolvedValueOnce(json({ detail: 'Stress values must be finite.' }, 422)).mockResolvedValueOnce(json({ detail: 'Job no longer cached.' }, 404)).mockResolvedValueOnce(new Response('<html>wrong server</html>')).mockResolvedValueOnce(new Response('<html>not CSV</html>')));
  const client = createModelClient(); const file = new File(['1'], 'Test1.csv');
  await expect(client.analyse('shm', file, 1)).rejects.toThrow('Start the Python backend');
  await expect(client.analyse('shm', file, 1)).rejects.toThrow('Stress values must be finite');
  await expect(client.csv(analysis('shm'))).rejects.toThrow('Analysis expired');
  await expect(client.analyse('shm', file, 1)).rejects.toThrow('invalid JSON');
  await expect(client.csv(analysis('shm'))).rejects.toThrow('CSV schema');
});
