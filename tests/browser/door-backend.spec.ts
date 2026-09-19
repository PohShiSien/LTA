import { expect, test, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { unzipSync } from 'fflate';
import type { DoorAnalysis } from '../../src/lib/railwitnessDoorClient';

const api = process.env.VITE_DOOR_API_URL || 'http://127.0.0.1:8000';
const source = readFileSync(resolve('tests/fixtures/recordings/door-controller.csv'), 'utf8').trim().split(/\r?\n/);
// A small synthetic multi-cycle recording for integration behavior, not model accuracy.
const synthetic = Buffer.from([source[0], ...Array.from({ length: 3 }, (_, cycle) => source.slice(1).map((row, index) => {
  const values = row.split(','); values[0] = `2023-7-5-0-0-${cycle}-${index * 20}`; return values.join(',');
})).flat()].join('\n'));
const upload = { name: 'integration-cycles.csv', mimeType: 'text/csv', buffer: synthetic };
const result = (page: Page) => page.getByRole('region', { name: 'Prediction result' });
async function analyseDoor(page: Page): Promise<DoorAnalysis> {
  await page.goto('/#door');
  // Uploading now triggers analysis automatically, so the listener must be armed before the upload settles.
  const response = page.waitForResponse(response => response.url() === `${api}/api/door/predict` && response.request().method() === 'POST');
  await page.getByLabel('Upload recording files').setInputFiles(upload);
  const returned = await response;
  expect(returned.ok()).toBe(true);
  const analysis: DoorAnalysis = await returned.json();
  await expect(result(page).getByRole('heading', { level: 2 })).toHaveText(`${analysis.segments.length} door cycles classified`);
  return analysis;
}

test.beforeEach(async ({ page }) => { await page.emulateMedia({ reducedMotion: 'reduce' }); });

test('Door upload uses frozen API, displays every cycle, and exports exact backend bytes in CSV and a flat combined ZIP', async ({ page, request }) => {
  const analysis = await analyseDoor(page);
  expect(analysis.model_name).toBe('logistic_regression');
  expect(analysis.summary.rows).toBe(9);
  await expect(result(page).locator('tbody tr')).toHaveCount(analysis.summary.cycles);
  for (const [index, segment] of analysis.segments.entries()) {
    await expect(result(page).locator('tbody tr').nth(index)).toContainText(segment.prediction);
  }
  await expect(page.locator('.ms-door-summary')).toContainText(`${analysis.summary.normal} Normal`);
  await expect(page.locator('.ms-scene-heading')).toContainText('Illustrative location; physical asset metadata unavailable');
  const selected = page.waitForResponse(response => response.url().endsWith(`/jobs/${analysis.job_id}/cycles/1`));
  await result(page).getByRole('button', { name: 'Cycle 2', exact: true }).click();
  const detail = await (await selected).json();
  await expect(page.locator('#door-cycle-evidence')).toContainText('Uncalibrated model score');
  await expect(page.getByRole('slider', { name: 'Recording sample cursor', exact: true })).toHaveValue('3');
  await expect(page.locator('#door-cycle-evidence')).toContainText('Elapsed cycle time (%)');
  expect(detail.points[0].current_A).toBe(.121);
  expect(detail.points[0].voltage_V).toBe(4);
  const expectedCsv = await (await request.get(`${api}${analysis.downloads.csv}`)).body();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'CSV', exact: true }).click();
  const csv = await downloading;
  expect(csv.suggestedFilename()).toBe('door_predictions.csv');
  expect(readFileSync((await csv.path())!)).toEqual(expectedCsv);
  await page.getByRole('navigation', { name: 'Subsystems' }).getByRole('button', { name: 'Structural health', exact: true }).click();
  await page.getByLabel('Upload recording files').setInputFiles(resolve('tests/fixtures/recordings/shm-stress.csv'));
  await expect(page.getByRole('button', { name: 'Run again', exact: true })).toBeEnabled();
  const archivePending = page.waitForEvent('download');
  await page.getByRole('button', { name: /predictions.zip/ }).click();
  const zip = await archivePending;
  const files = unzipSync(readFileSync((await zip.path())!));
  expect(Object.keys(files).sort()).toEqual(['door_predictions.csv', 'shm_predictions.csv']);
  expect(Buffer.from(files['door_predictions.csv'])).toEqual(expectedCsv);
});

test('failed uploaded Door inference has no browser fallback and does not leave a previous Normal result', async ({ page }) => {
  await analyseDoor(page);
  await page.route('**/api/door/predict', route => route.fulfill({ status: 503, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ detail: 'Frozen model is unavailable.' }) }));
  await page.getByRole('button', { name: 'Run again', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Frozen model is unavailable');
  await expect(result(page)).toContainText('Recording ready for analysis');
  await expect(result(page).locator('tbody tr')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'CSV', exact: true })).toBeDisabled();
  await expect(page.locator('#door-cycle-evidence')).toHaveCount(0);
  await page.getByRole('button', { name: 'Synthetic demo', exact: true }).click();
  await page.getByRole('button', { name: 'Run analysis', exact: true }).click();
  await expect(result(page)).toContainText('3 door cycles classified');
  await expect(result(page)).toContainText('SYNTHETIC DEMONSTRATION');
});

test('expired Door detail and exports offer re-analysis and do not reconstruct the CSV', async ({ page }) => {
  const analysis = await analyseDoor(page);
  await page.route(`**/api/door/jobs/${analysis.job_id}/**`, route => route.fulfill({ status: 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ detail: 'Analysis expired or unknown.' }) }));
  await result(page).getByRole('button', { name: 'Cycle 2', exact: true }).click();
  await expect(page.locator('#door-cycle-evidence')).toContainText('Run analysis again or re-upload');
  const downloads: string[] = []; page.on('download', download => downloads.push(download.suggestedFilename()));
  await page.getByRole('button', { name: 'CSV', exact: true }).click();
  await expect(page.locator('.ms-error')).toContainText('Run analysis again or re-upload');
  await page.getByRole('button', { name: /predictions.zip/ }).click();
  await expect(page.locator('.ms-error')).toContainText('expired');
  await expect(page.getByRole('button', { name: /predictions.zip/ })).toBeEnabled();
  expect(downloads).toEqual([]);
});

test('late cycle details cannot overwrite a newer selection even if transport cancellation is ignored', async ({ page }) => {
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => original(input, String(input).includes('/cycles/') ? { ...init, signal: undefined } : init);
  });
  const analysis = await analyseDoor(page);
  let release!: () => void;
  const delayed = new Promise<void>(resolveDelay => { release = resolveDelay; });
  let arrived!: () => void;
  const started = new Promise<void>(resolveStarted => { arrived = resolveStarted; });
  await page.route(`**/api/door/jobs/${analysis.job_id}/cycles/1`, async route => {
    const response = await route.fetch(); arrived(); await delayed; await route.fulfill({ response });
  });
  await result(page).getByRole('button', { name: 'Cycle 2', exact: true }).click();
  await started;
  const newest = page.waitForResponse(response => response.url().endsWith(`/jobs/${analysis.job_id}/cycles/2`));
  await result(page).getByRole('button', { name: 'Cycle 3', exact: true }).click();
  await newest;
  await expect(page.locator('#door-cycle-evidence').getByRole('heading', { name: 'Cycle 3', exact: true })).toBeVisible();
  const late = page.waitForResponse(response => response.url().endsWith(`/jobs/${analysis.job_id}/cycles/1`));
  release(); await late;
  await expect(page.locator('#door-cycle-evidence').getByRole('heading', { name: 'Cycle 3', exact: true })).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Recording sample cursor', exact: true })).toHaveValue('6');
  await expect(page.locator('#door-cycle-evidence').getByRole('heading', { name: 'Cycle 2', exact: true })).toHaveCount(0);
});

test('full supplied Door Test matches the frozen acceptance predictions and covers every row once', async ({ page, request }) => {
  const path = process.env.RAILWITNESS_DOOR_TEST_CSV;
  test.skip(!path || !existsSync(path), 'Set RAILWITNESS_DOOR_TEST_CSV to the supplied Test(1).csv or its byte-identical Test.csv.');
  await page.goto('/#door');
  const pending = page.waitForResponse(response => response.url() === `${api}/api/door/predict`);
  await page.getByLabel('Upload recording files').setInputFiles(path!);
  const analysis: DoorAnalysis = await (await pending).json();
  expect(analysis.summary).toMatchObject({ rows: 6253, cycles: 38, normal: 30, abnormal_resistance: 8 });
  let next = 0;
  for (const segment of analysis.segments) {
    expect(segment.start_index).toBe(next);
    next = segment.end_index! + 1;
    expect(segment.n_rows).toBe(segment.end_index! - segment.start_index! + 1);
  }
  expect(next).toBe(6253);
  await expect(result(page).locator('tbody tr')).toHaveCount(38);
  const expected = readFileSync(resolve('backend/door/railwitness_door_pipeline/outputs/door_predictions.csv'));
  expect(await (await request.get(`${api}${analysis.downloads.csv}`)).body()).toEqual(expected);
});

test('dragging a second upload cannot unlock or overwrite an in-flight Door analysis', async ({ page }) => {
  let release!: () => void;
  const delayed = new Promise<void>(resolveDelay => { release = resolveDelay; });
  let arrived!: () => void;
  const started = new Promise<void>(resolveStarted => { arrived = resolveStarted; });
  let posts = 0;
  await page.route('**/api/door/predict', async route => {
    posts++; const response = await route.fetch(); arrived(); await delayed; await route.fulfill({ response });
  });
  await page.goto('/#door');
  await page.getByLabel('Upload recording files').setInputFiles(upload);
  await started;
  const transfer = await page.evaluateHandle(contents => {
    const data = new DataTransfer(); data.items.add(new File([contents], 'second.csv', { type: 'text/csv' })); return data;
  }, synthetic.toString('utf8'));
  await page.locator('.ms-source-panel').dispatchEvent('drop', { dataTransfer: transfer });
  await expect(page.locator('.ms-error')).toContainText('session is processing');
  await expect(page.getByRole('button', { name: 'Processing…', exact: true })).toBeDisabled();
  await expect(page.getByRole('combobox', { name: 'Selected recording' }).locator('option')).toHaveCount(2);
  release();
  await expect(result(page)).toContainText('3 door cycles classified');
  expect(posts).toBe(1);
  await expect(page.getByRole('combobox', { name: 'Selected recording' }).locator('option:checked')).toHaveText('integration-cycles.csv');
});
