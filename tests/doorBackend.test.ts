import { strToU8, unzipSync, zipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDoorClient, validateDoorAnalysis, type DoorAnalysis, type DoorCycleDetail } from '../src/lib/railwitnessDoorClient';
import { doorAnalysisResult } from '../src/lib/doorBackendAnalysis';
import type { RecordingSummary } from '../src/types/multisystem';

function analysis(): DoorAnalysis {
  return {
    job_id: 'job_123', model_name: 'logistic_regression', model_id: 'frozen-artifact-id',
    source_name: 'Recording.csv', source_sha256: 'a'.repeat(64), mode: 'offline_completed_cycle_analysis',
    summary: { rows: 4, cycles: 2, normal: 1, abnormal_resistance: 1, source_start: '2023-7-5-0-0-0-0', source_end: '2023-7-5-0-0-2-20', inference_seconds: 0.12 },
    segments: [0, 1].map(index => ({
      cycle_index: index, cycle_id: `cycle_00${index + 1}`, start_index: index * 2, end_index: index * 2 + 1,
      start_time: `2023-7-5-0-0-${index * 2}-0`, end_time: `2023-7-5-0-0-${index * 2}-20`,
      prediction: index ? 'Abnormal resistance' : 'Normal', operation_inferred: index ? 'Close' : 'Open',
      abnormal_model_score: index ? 0.71 : 0.24, score_description: 'Uncalibrated model output.', duration_s: 0.02,
      n_rows: 2, mean_current_A: 1.25, peak_current_A: 2, asset_id: null,
      recommendation: 'Review recorded evidence.', data_quality_warnings: [],
    })),
    downloads: { csv: '/api/door/jobs/job_123/predictions.csv', zip: '/api/door/jobs/job_123/predictions.zip' },
    warnings: ['No physical door identifiers supplied.'], retention: 'Cached for up to one hour.',
  };
}
function recording(): RecordingSummary {
  return {
    source: { subsystem: 'door', fileName: 'Recording.csv', fileId: 'content-hash', datasetId: 'ps3-door' },
    headers: [], fields: [], rowCount: 4, carIds: [], warnings: [], mapping: { status: 'unmapped', reason: 'No asset metadata' },
  };
}
function detail(index = 0): DoorCycleDetail {
  return {
    segment: analysis().segments[index],
    points: [0, 1].map(index => ({ elapsed_s: index * 0.02, elapsed_fraction: index, travel_fraction: index,
      current_A: 1.5 + index, voltage_V: 110, bemf_raw: index * 300, position_raw: index * 1000 })),
    display_downsampled: false,
    reference: { elapsed_fraction: [0, 1], lower_A: [0.5, 1], median_A: [1, 2], upper_A: [2, 3], n_normal_training_cycles: 40 },
    reference_method: 'Empirical 5th/50th/95th percentiles of normal training cycles.', reference_limitation: 'Descriptive only.',
    features: { current_mean: 2, unavailable: null },
    explanations: [{ feature: 'current_mean', value: 2, log_odds_contribution: 0.25, direction: 'toward Abnormal resistance' },
      { feature: 'current_max', value: 2.5, log_odds_contribution: -0.2, direction: 'toward Normal' }],
    explanation_method: 'Signed logistic log-odds contributions.', model_intercept: -0.12,
    units: { current: 'A', voltage: 'V', position: 'raw; unknown' },
  };
}
const jsonResponse = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('frozen Door backend client', () => {
  it('uploads the original file under multipart field file without overriding the browser boundary', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(analysis())); vi.stubGlobal('fetch', fetchMock);
    const file = new File(['original,source\r\n1,2\r\n'], 'Recording.csv', { type: 'text/csv' });
    const controller = new AbortController();
    const result = await createDoorClient('http://127.0.0.1:8000/').analyse(file, controller.signal);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8000/api/door/predict');
    expect(options.method).toBe('POST'); expect(options.signal).toBe(controller.signal); expect(options.headers).toBeUndefined();
    const body = options.body as FormData;
    expect([...body.keys()]).toEqual(['file']);
    expect(await (body.get('file') as File).text()).toBe(await file.text());
    expect(result.segments.map(cycle => cycle.prediction)).toEqual(['Normal', 'Abnormal resistance']);
  });

  it('fetches selected cycle evidence and preserves already converted signals and references', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(detail(1))); vi.stubGlobal('fetch', fetchMock);
    const signal = new AbortController().signal;
    const result = await createDoorClient().cycle('job_123', 1, signal);
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8000/api/door/jobs/job_123/cycles/1', { signal });
    expect(result.segment.cycle_index).toBe(1);
    expect(result.points[0].current_A).toBe(1.5); expect(result.points[0].voltage_V).toBe(110);
    expect(result.reference?.median_A).toEqual([1, 2]);
  });

  it('returns exact backend CSV and ZIP bytes without changing rows, encoding or newline style', async () => {
    const csv = strToU8('start_time,end_time,prediction\n"2023-7-5-0-0-0-0",2023-7-5-0-0-0-20,Normal\n');
    const zip = zipSync({ 'door_predictions.csv': csv });
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(csv)).mockResolvedValueOnce(new Response(zip)); vi.stubGlobal('fetch', fetchMock);
    const client = createDoorClient();
    expect(await client.csv('job_123')).toEqual(csv);
    const downloadedZip = await client.zip('job_123');
    expect(downloadedZip).toEqual(zip); expect(Object.keys(unzipSync(downloadedZip))).toEqual(['door_predictions.csv']);
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'http://127.0.0.1:8000/api/door/jobs/job_123/predictions.csv', { signal: undefined });
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:8000/api/door/jobs/job_123/predictions.zip', { signal: undefined });
  });

  it('reports network, schema and expired-job errors without manufacturing predictions', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(jsonResponse({ detail: 'Missing Motor Current column.' }, 422))
      .mockResolvedValueOnce(jsonResponse({ detail: 'Job expired.' }, 404));
    vi.stubGlobal('fetch', fetchMock);
    const client = createDoorClient(); const file = new File(['x'], 'Recording.csv');
    await expect(client.analyse(file)).rejects.toThrow('Start the Python backend');
    await expect(client.analyse(file)).rejects.toThrow('Missing Motor Current');
    await expect(client.cycle('expired', 0)).rejects.toThrow('Run analysis again or re-upload');
  });

  it('propagates cancellation, allowing UI request sequencing to ignore superseded cycles', async () => {
    const cancelled = new DOMException('Request aborted', 'AbortError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(cancelled));
    const controller = new AbortController(); controller.abort();
    await expect(createDoorClient().cycle('job_123', 0, controller.signal)).rejects.toBe(cancelled);
  });

  it('rejects wrong-cycle evidence, malformed signal/reference contracts and unsupported files', async () => {
    const wrongReference = detail(); wrongReference.reference!.upper_A = [2];
    const wrongDirection = detail(); wrongDirection.explanations[0].direction = 'toward Normal';
    const wrongSignal = detail(); wrongSignal.points[0].current_A = Number.NaN;
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(detail(1)))
      .mockResolvedValueOnce(jsonResponse(wrongReference)).mockResolvedValueOnce(jsonResponse(wrongDirection)).mockResolvedValueOnce(jsonResponse(wrongSignal));
    vi.stubGlobal('fetch', fetchMock);
    const client = createDoorClient();
    await expect(client.cycle('job_123', 0)).rejects.toThrow('selected cycle identity');
    await expect(client.cycle('job_123', 0)).rejects.toThrow('reference alignment');
    await expect(client.cycle('job_123', 0)).rejects.toThrow('signed feature contributions');
    await expect(client.cycle('job_123', 0)).rejects.toThrow('recorded cycle signals');
    await expect(client.analyse(new File(['zip'], 'upload.zip'))).rejects.toThrow('raw Door CSV');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('rejects successful HTML/error downloads and filenames different from the uploaded source', async () => {
    const wrongSource = analysis(); wrongSource.source_name = 'Another.csv';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('<html>Not the API</html>'))
      .mockResolvedValueOnce(jsonResponse(wrongSource)).mockResolvedValueOnce(new Response('<html>Not CSV</html>')));
    const client = createDoorClient();
    await expect(client.analyse(new File(['x'], 'Recording.csv'))).rejects.toThrow('invalid JSON');
    await expect(client.analyse(new File(['x'], 'Recording.csv'))).rejects.toThrow('source filename');
    await expect(client.csv('job_123')).rejects.toThrow('CSV schema');
  });
});

describe('Door AnalysisResult adapter', () => {
  it('accepts the supplied five-current-feature logistic regression model identity', () => {
    const value = { ...analysis(), model_name: 'logistic_regression_5_current_features', model_id: 'door5-6d2171ee2079dd86' };
    expect(validateDoorAnalysis(value)).toBe(value);
    expect(doorAnalysisResult(value, recording()).model.name).toBe(value.model_name);
  });

  it('retains exact labels, raw timestamp strings, source identity and full inclusive row coverage', () => {
    const source = recording(); const result = doorAnalysisResult(analysis(), source);
    expect(result.source).toEqual(source.source); expect(result.source).not.toBe(source.source);
    expect(result.model.version).toBe('frozen-artifact-id'); expect(result.model.name).toBe('logistic_regression');
    expect(result.subsystem).toBe('door');
    if (result.subsystem !== 'door') throw new Error('Door adapter must return Door');
    expect(result.segments).toEqual([
      { start_time: '2023-7-5-0-0-0-0', end_time: '2023-7-5-0-0-0-20', prediction: 'Normal', startIndex: 0, endIndex: 1 },
      { start_time: '2023-7-5-0-0-2-0', end_time: '2023-7-5-0-0-2-20', prediction: 'Abnormal resistance', startIndex: 2, endIndex: 3 },
    ]);
  });

  it('rejects missing backend row indices and mismatched subsystem or source manifests', async () => {
    const response = analysis();
    const missingIndices = { ...response, segments: response.segments.map(segment => ({ ...segment, start_index: undefined, end_index: undefined })) };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(missingIndices)));
    await expect(createDoorClient().analyse(new File(['x'], 'Recording.csv'))).rejects.toThrow('row indices');
    const wrongSubsystem = recording(); wrongSubsystem.source.subsystem = 'rail';
    expect(() => doorAnalysisResult(response, wrongSubsystem)).toThrow('Door recording');
    const short = recording(); short.rowCount = 3;
    expect(() => doorAnalysisResult(response, short)).toThrow('row count');
    const wrongFile = recording(); wrongFile.source.fileName = 'Different.csv';
    expect(() => doorAnalysisResult(response, wrongFile)).toThrow('source filename');
  });

  it.each([
    ['model identity', (value: DoorAnalysis) => { value.model_name = 'random_forest'; }],
    ['model identifier', (value: DoorAnalysis) => { value.model_id = ''; }],
    ['missing Normal cycle', (value: DoorAnalysis) => { value.segments.shift(); }],
    ['changed labels', (value: DoorAnalysis) => { Object.assign(value.segments[0], { prediction: 'Healthy' }); }],
    ['nonfinite scores', (value: DoorAnalysis) => { value.segments[0].abnormal_model_score = Infinity; }],
    ['wrong totals', (value: DoorAnalysis) => { value.summary.normal = 2; value.summary.abnormal_resistance = 0; }],
    ['overlapping row coverage', (value: DoorAnalysis) => { value.segments[1].start_index = 1; value.segments[1].end_index = 2; }],
    ['omitted source rows', (value: DoorAnalysis) => { value.summary.rows = 5; }],
    ['out-of-sequence cycle index', (value: DoorAnalysis) => { value.segments[1].cycle_index = 2; }],
    ['duplicate cycle identifiers', (value: DoorAnalysis) => { value.segments[1].cycle_id = value.segments[0].cycle_id; }],
    ['invented asset identity', (value: DoorAnalysis) => { Object.assign(value.segments[0], { asset_id: 'D07' }); }],
    ['wrong export job', (value: DoorAnalysis) => { value.downloads.csv = '/api/door/jobs/another/predictions.csv'; }],
  ])('fails closed on %s', (_name, change) => {
    const value = analysis(); change(value);
    expect(() => validateDoorAnalysis(value)).toThrow('invalid response');
  });
});
