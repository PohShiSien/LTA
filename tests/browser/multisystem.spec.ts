import { expect, test, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';

const fixtures = resolve('tests/fixtures/recordings');
const railLines = readFileSync(resolve(fixtures, 'rail-first-samples.csv'), 'utf8').trim().split(/\r?\n/);
const railCsv = Buffer.from([railLines[0], ...Array.from({ length: 10000 }, (_, index) => railLines[1 + index % (railLines.length - 1)])].join('\n'));
const railUpload = { name: 'rail-recording.csv', mimeType: 'text/csv', buffer: railCsv };
// Sufficient-duration telemetry exercises upload behavior; it is not an accuracy benchmark.
const acvIds = Array.from({ length: 8 }, (_, index) => String(index + 1).padStart(2, '0'));
const acvCsv = Buffer.from([
  ['Time', ...acvIds.flatMap(car => [`Car ${car} - Indoor Average Temperature`, `Car ${car} - Control Temperature (Cooling)`])].join(','),
  ...Array.from({ length: 121 }, (_, index) => [new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(), ...acvIds.flatMap(car => [car === '03' ? 28 : 23, 22])].join(',')),
].join('\n'));
const api = process.env.VITE_API_URL || process.env.VITE_DOOR_API_URL || 'http://127.0.0.1:8000';
const integratedModels = [
  { subsystem: 'acv', upload: { name: 'acv-case.csv', mimeType: 'text/csv', buffer: acvCsv }, rows: 121 },
  { subsystem: 'rail', upload: railUpload, rows: 10000 },
  { subsystem: 'shm', upload: { name: 'shm-stress.csv', mimeType: 'text/csv', buffer: readFileSync(resolve(fixtures, 'shm-stress.csv')) }, rows: 4 },
] as const;
type RecordingAnalysis = { job_id: string; source_name: string; prediction: string | number | string[]; summary: { rows: number }; downloads: { csv: string } };
const resultPanel = (page: Page) => page.getByRole('region', { name: 'Prediction result' });
const inspector = (page: Page) => page.getByRole('region', { name: 'Evidence inspector' });
async function navigate(page: Page, label: string) { await page.getByRole('navigation', { name: 'Subsystems' }).getByRole('button', { name: label, exact: true }).click(); }
async function analyse(page: Page) {
  const button = page.getByRole('button', { name: 'Run analysis', exact: true });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.getByRole('button', { name: 'Run again', exact: true })).toBeEnabled();
  await expect(resultPanel(page).locator('.ms-kind.predicted')).toHaveText('Predicted');
}
async function csvDownload(page: Page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'CSV', exact: true }).click();
  const download = await pending;
  return { name: download.suggestedFilename(), text: readFileSync((await download.path())!, 'utf8') };
}
async function expectReady(page: Page) {
  await expect(resultPanel(page)).toContainText('Recording ready for analysis');
  await expect(resultPanel(page).locator('.ms-kind')).toHaveText('Not analysed');
  await expect(page.getByRole('button', { name: 'Run analysis', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'CSV', exact: true })).toBeDisabled();
}

test.beforeEach(async ({ page }) => { await page.emulateMedia({ reducedMotion: 'reduce' }); });

test('SHM train highlight and side legend follow each model output and preserve values above one', async ({ page }) => {
  await page.goto('/#shm');
  const scene = page.locator('.reference-train-scene');
  const legend = scene.locator('[aria-label="SHM risk legend"]');
  const cases = [{ band: 'green', amplitude: 50 }, { band: 'yellow', amplitude: 80 }, { band: 'red', amplitude: 100 }];
  await page.getByLabel('Upload recording files').setInputFiles(cases.map(({ band, amplitude }) => ({ name: `${band}.csv`, mimeType: 'text/csv', buffer: Buffer.from([0, 0, amplitude, 0, amplitude, 0, amplitude, 0, amplitude, 0].join('\n')) })));
  await expectReady(page);
  await expect(scene).toHaveAttribute('data-shm-risk', 'uncomputed');
  await expect(legend.locator('[aria-current=true]')).toHaveCount(0);
  const responses: Promise<RecordingAnalysis>[] = [];
  page.on('response', response => { if (response.url() === `${api}/api/shm/predict`) responses.push(response.json()); });
  await page.getByRole('button', { name: 'Analyse all 3', exact: true }).click();
  await expect(page.getByRole('button', { name: 'All results CSV', exact: true })).toBeEnabled();
  const analyses = await Promise.all(responses);
  expect(analyses).toHaveLength(3);
  for (const { band } of cases) {
    const output = analyses.find(analysis => analysis.source_name === `${band}.csv`)!;
    await page.getByRole('combobox', { name: 'Selected recording' }).selectOption({ label: output.source_name });
    await expect(scene).toHaveAttribute('data-shm-risk', band);
    await expect(resultPanel(page).getByRole('heading', { level: 2 })).toHaveText(`Fatigue damage: ${output.prediction}`);
    await expect(legend.locator('[data-band]')).toHaveCount(3);
    await expect(legend.locator('[aria-current=true]')).toHaveAttribute('data-band', band);
    await expect(resultPanel(page).locator('[data-band]')).toHaveCount(0);
    await expect(legend).toContainText(String(output.prediction));
    const csv = await csvDownload(page);
    expect(csv.text.trim().split('\n')[1]).toBe(`${output.source_name},${output.prediction}`);
  }
  await expect(legend).toContainText('Above');
  const desktopStage = await scene.locator('.reference-train-stage').boundingBox();
  const desktopLegend = await legend.boundingBox();
  expect(desktopLegend!.x).toBeGreaterThanOrEqual(desktopStage!.x + desktopStage!.width - 1);
  await page.setViewportSize({ width: 430, height: 932 });
  await expect(legend).toBeVisible();
  const mobileStage = await scene.locator('.reference-train-stage').boundingBox();
  const mobileLegend = await legend.boundingBox();
  expect(mobileLegend!.y).toBeGreaterThanOrEqual(mobileStage!.y + mobileStage!.height - 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.getByLabel('Upload recording files').setInputFiles({ name: 'not-analysed.csv', mimeType: 'text/csv', buffer: Buffer.from('1\n2\n3\n4') });
  await expectReady(page);
  await expect(scene).toHaveAttribute('data-shm-risk', 'uncomputed');
  await expect(legend.locator('[aria-current=true]')).toHaveCount(0);
});

for (const { subsystem, upload, rows } of integratedModels) {
  const title = (prediction: RecordingAnalysis['prediction']) => subsystem === 'acv' ? `ACV inspection priority: Car ${(prediction as string[])[0]}` : subsystem === 'rail' ? `Rail classification: ${prediction}` : `Fatigue damage: ${prediction}`;

  test(`${subsystem} upload runs the supplied model, exports exact backend results, and clears failed reruns`, async ({ page, request }) => {
    await page.goto(`/#${subsystem}`);
    await page.getByLabel('Upload recording files').setInputFiles(upload);
    await expectReady(page);
    const pending = page.waitForResponse(response => response.url() === `${api}/api/${subsystem}/predict` && response.request().method() === 'POST');
    await analyse(page);
    const response = await pending;
    expect(response.ok()).toBe(true);
    const analysis: RecordingAnalysis = await response.json();
    expect(analysis.summary.rows).toBe(rows);
    expect(analysis.source_name).toBe(upload.name);
    await expect(resultPanel(page).getByRole('heading', { level: 2 })).toHaveText(title(analysis.prediction));
    await expect(resultPanel(page).locator('.ms-result-scope')).toHaveText('RECORDING');
    await expect(resultPanel(page).locator('.ms-result-source')).toContainText(upload.name);
    if (subsystem === 'rail') {
      await expect(page.locator('.reference-train-scene')).toHaveAttribute('data-rail-class', String(analysis.prediction));
      await expect(page.locator('.reference-rail-key .is-predicted')).toHaveCount(analysis.prediction === 'Normal' ? 0 : 1);
      if (analysis.prediction !== 'Normal') await expect(page.locator('.reference-rail-key .is-predicted')).toContainText(String(analysis.prediction));
      await expect(inspector(page).getByRole('group', { name: 'Selected signal measurements' })).toContainText('RMS · mean removed');
    } else if (subsystem === 'shm') {
      await expect(resultPanel(page).locator('.ms-model-summary')).not.toContainText('fifth range moment');
      await expect(inspector(page).getByRole('group', { name: 'Selected signal measurements' })).toContainText('Stress range');
      await expect(page.getByRole('button', { name: 'Play stress replay' })).toBeHidden();
    } else {
      expect(Array.isArray(analysis.prediction)).toBe(true);
      await expect(resultPanel(page).locator('.ms-acv-ranking tbody tr')).toHaveCount(8);
      for (const [index, car] of (analysis.prediction as string[]).entries()) {
        await expect(resultPanel(page).locator('.ms-acv-ranking tbody tr').nth(index)).toContainText(`Car ${car}`);
      }
      await expect(resultPanel(page)).toContainText('one');
      await expect(page.locator('.reference-train-scene')).toHaveAttribute('data-acv-first-car', (analysis.prediction as string[])[0]);
    }
    const expectedCsv = await (await request.get(`${api}${analysis.downloads.csv}`)).body();
    const csv = await csvDownload(page);
    expect(csv.name).toBe(`${subsystem}_predictions.csv`);
    expect(Buffer.from(csv.text)).toEqual(expectedCsv);
    const downloading = page.waitForEvent('download');
    const archiveResponse = page.waitForResponse(response => response.url() === `${api}/api/${subsystem}/export`);
    await page.getByRole('button', { name: /predictions.zip/ }).click();
    const zip = readFileSync((await (await downloading).path())!);
    expect(zip).toEqual(await (await archiveResponse).body());
    const entries = unzipSync(zip);
    expect(Object.keys(entries)).toEqual([`${subsystem}_predictions.csv`]);
    expect(Buffer.from(entries[`${subsystem}_predictions.csv`])).toEqual(expectedCsv);

    await page.route(`**/api/${subsystem}/predict`, route => route.fulfill({ status: 503, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ detail: 'Trained model is unavailable.' }) }));
    await page.getByRole('button', { name: 'Run again', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Trained model is unavailable');
    await expectReady(page);
    await expect(resultPanel(page).getByRole('heading', { name: title(analysis.prediction), exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /predictions.zip/ })).toBeDisabled();
    if (subsystem === 'rail') await expect(page.locator('.reference-train-scene')).toHaveAttribute('data-rail-class', 'uncomputed');
    if (subsystem === 'shm') await expect(page.locator('.reference-train-scene')).toHaveAttribute('data-shm-risk', 'uncomputed');
    if (subsystem === 'acv') await expect(page.locator('.reference-train-scene')).toHaveAttribute('data-acv-first-car', '');
  });

  test(`${subsystem} Analyse all preserves each recording result and downloads one combined CSV`, async ({ page, request }) => {
    await page.goto(`/#${subsystem}`);
    const extension = upload.name.split('.').at(-1)!;
    const names = [`first.${extension}`, `second.${extension}`];
    await page.getByLabel('Upload recording files').setInputFiles(names.map(name => ({ ...upload, name })));
    await expect(page.getByRole('button', { name: 'All results CSV', exact: true })).toBeDisabled();
    const responses: Promise<RecordingAnalysis>[] = [];
    page.on('response', response => {
      if (response.url() === `${api}/api/${subsystem}/predict` && response.request().method() === 'POST') responses.push(response.json());
    });
    await page.getByRole('button', { name: 'Analyse all 2', exact: true }).click();
    await expect(page.getByRole('button', { name: 'All results CSV', exact: true })).toBeEnabled();
    const analyses = await Promise.all(responses);
    expect(analyses.map(analysis => analysis.source_name).sort()).toEqual(names);
    for (const analysis of analyses) {
      await page.getByRole('combobox', { name: 'Selected recording' }).selectOption({ label: analysis.source_name });
      await expect(resultPanel(page).getByRole('heading', { level: 2 })).toHaveText(title(analysis.prediction));
    }
    const expected = await request.post(`${api}/api/${subsystem}/export`, { data: { job_ids: analyses.map(analysis => analysis.job_id), format: 'csv' } });
    expect(expected.ok()).toBe(true);
    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: 'All results CSV', exact: true }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe(`${subsystem}_predictions.csv`);
    const bytes = readFileSync((await download.path())!);
    expect(bytes).toEqual(await expected.body());
    const lines = bytes.toString('utf8').trim().split(/\r?\n/);
    expect(lines).toHaveLength(3);
    expect(lines.slice(1).map(line => line.split(',')[0]).sort()).toEqual(names);
    await page.getByLabel('Upload recording files').setInputFiles({ ...upload, name: `not-analysed.${extension}` });
    await expect(page.getByRole('button', { name: 'All results CSV', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: /predictions.zip/ })).toBeDisabled();
  });
}

test('uploaded Rail preserves exact channels while scrubbing and waits for an explicit analysis request', async ({ page }) => {
  const predictionRequests: string[] = [];
  page.on('request', request => { if (/\/api\/rail\/predict(?:\?|$)/.test(request.url())) predictionRequests.push(request.url()); });
  await page.goto('/#rail');
  await expect(page.getByRole('navigation', { name: 'Carriage navigator' }).getByRole('button')).toHaveCount(8);
  await expect(page.getByRole('button', { name: 'CSV', exact: true })).toBeDisabled();
  await page.getByLabel('Upload recording files').setInputFiles(railUpload);
  await expect(page.locator('.ms-source-context')).toContainText('10,000 rows · 129 source fields');
  await page.getByRole('button', { name: 'Select car 3', exact: true }).click();
  await inspector(page).getByRole('button', { name: 'Select car 3 axle box 5', exact: true }).click();
  await expect(inspector(page).getByRole('heading', { name: 'Car 3 · Axle box 5 · Side I' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Metric' })).toHaveValue('column-41');
  const channel = page.locator('.ms-field').filter({ has: page.locator('.ms-field-name', { hasText: 'Vibration of bearing in position 5 of car 3' }) });
  await channel.locator('summary').click();
  await expect(channel).toContainText('42 (index 41)');
  await expect(channel).toContainText('m/s²');
  await expectReady(page);
  await page.getByRole('slider', { name: 'Recording sample cursor', exact: true }).focus();
  await page.keyboard.press('End');
  await expect(page.locator('.ms-time-control')).toContainText('0.9999 s elapsed');
  await expectReady(page);
  await expect(page.locator('.reference-train-scene')).toHaveAttribute('data-rail-class', 'uncomputed');
  await page.getByRole('combobox', { name: 'Metric' }).selectOption('column-0');
  await expect(page.getByRole('combobox', { name: 'Metric' }).locator('option:checked')).toHaveText('Rotating speed');
  await expect(inspector(page).getByRole('group', { name: 'Selected signal measurements' })).toContainText('Selected sample');
  await expect(inspector(page).getByRole('group', { name: 'Selected signal measurements' })).not.toContainText('RMS');
  await expect(page.getByRole('button', { name: /predictions.zip/ })).toBeDisabled();
  expect(predictionRequests).toEqual([]);
});

test('actual ACV XLSX preserves all eight source IDs, the chosen cross-car metric, and car-qualified pins', async ({ page }) => {
  await page.goto('/#acv');
  await page.getByLabel('Upload recording files').setInputFiles(resolve(fixtures, 'acv-basic.xlsx'));
  await expect(page.locator('.ms-source-context')).toContainText('2 rows · 67 source fields');
  await page.getByRole('combobox', { name: 'Metric' }).selectOption({ label: '01 · Outdoor Average Temperature' });
  await expect(page.locator('.ms-time-control')).toContainText('2021-06-24 00:00:00.000');
  const field = page.locator('.ms-field').filter({ has: page.locator('.ms-field-name', { hasText: 'Car 01 - Outdoor Average Temperature' }) });
  await field.locator('summary').click();
  await field.getByRole('button', { name: 'Pin field', exact: true }).click();
  await page.getByRole('button', { name: 'Select car 03', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Metric' }).locator('option:checked')).toHaveText('03 · Outdoor Average Temperature');
  await expect(page.locator('.ms-pinned-fields')).toContainText('Car 01 - Outdoor Average Temperature');
  await expect(page.locator('.ms-car-comparison').getByRole('button')).toHaveCount(8);
  await expectReady(page);
  await expect(page.locator('.ms-ranking')).toHaveCount(0);
  expect(await page.getByRole('navigation', { name: 'Carriage navigator' }).locator('button strong').allTextContents()).toEqual(['01', '02', '03', '04', '05', '06', '07', '08']);
});

test('richer ACV headers stay searchable and expose raw unknown units and invalid readings', async ({ page }) => {
  await page.goto('/#acv');
  await page.getByLabel('Upload recording files').setInputFiles(resolve(fixtures, 'acv-rich.xlsx'));
  await expect(page.locator('.ms-source-context')).toContainText('483 source fields');
  await page.getByRole('checkbox', { name: 'All recording fields' }).check();
  await page.getByRole('textbox', { name: 'Search source fields' }).fill('Refrigeration System 2 Low Pressure Value');
  await expect(page.locator('.ms-field')).toHaveCount(8);
  await page.locator('.ms-field').first().locator('summary').click();
  await expect(page.locator('.ms-field').first()).toContainText('Unit not supplied');
  await expect(page.locator('.ms-field').first()).toContainText('acv-rich.xlsx');
  await page.getByRole('textbox', { name: 'Search source fields' }).fill('Car 01 - ACV Operating Mode');
  await expect(page.locator('.ms-field')).toContainText('Invalid');
});

test('Door controller remains unlocated, preserves raw conversions, and exports classified segments directly', async ({ page }) => {
  await page.goto('/#door');
  await page.getByLabel('Upload recording files').setInputFiles(resolve(fixtures, 'door-controller.csv'));
  await expect(inspector(page).getByRole('heading', { name: 'Door stream — location unmapped' })).toBeVisible();
  const current = page.locator('.ms-field').filter({ has: page.locator('.ms-field-name', { hasText: 'Motor current(mA)' }) });
  await current.locator('summary').click();
  await expect(current).toContainText('121 · mA');
  await expect(current).toContainText('0.121 · A');
  await expect(current).toContainText('Raw × 0.001');
  await analyse(page);
  await expect(resultPanel(page).getByRole('heading', { level: 2 })).toHaveText('1 door cycles classified');
  const download = await csvDownload(page);
  expect(download.name).toBe('door_predictions.csv');
  expect(download.text.split(/\r?\n/)[0]).toBe('start_time,end_time,prediction');
  expect(download.text).toContain('2023-7-5-0-0-0-0');
  expect(download.text).not.toContain('file_id');
  await page.getByRole('button', { name: 'Select car 03', exact: true }).click();
  await expect(page.locator('.ms-unmapped')).toContainText('No uploaded controller stream is mapped');
  await expect(page.getByRole('button', { name: 'Inspect unlocated stream' })).toBeVisible();
});

test('unlocated SHM inspection keeps same-named Door recordings and predictions separate', async ({ page }) => {
  await page.goto('/#shm');
  await page.getByLabel('Upload recording files').setInputFiles({ name: 'Test.csv', mimeType: 'text/csv', buffer: readFileSync(resolve(fixtures, 'shm-stress.csv')) });
  await expect(inspector(page).getByRole('heading', { name: 'Measurement location not supplied' })).toBeVisible();
  await expect(page.locator('.ms-unmapped')).toContainText('not assigned to any car or bogie');
  await expectReady(page);
  await expect(page.locator('.ms-damage')).toHaveCount(0);
  const shmKey = await page.getByRole('combobox', { name: 'Selected recording' }).inputValue();
  await navigate(page, 'Doors');
  await expect(resultPanel(page)).toContainText('Choose a recording to begin');
  await page.getByLabel('Upload recording files').setInputFiles({ name: 'Test.csv', mimeType: 'text/csv', buffer: readFileSync(resolve(fixtures, 'door-controller.csv')) });
  await expect(page.locator('.ms-source-context')).toContainText('ps3-door / Test.csv');
  await expect(resultPanel(page)).toContainText('Recording ready for analysis');
  await expect(page.locator('.ms-damage')).toHaveCount(0);
  expect(await page.getByRole('combobox', { name: 'Selected recording' }).inputValue()).not.toBe(shmKey);
  await analyse(page);
  await expect(resultPanel(page)).toContainText('1 door cycles classified');
  await navigate(page, 'Structural health');
  await expect(page.locator('.ms-source-context')).toContainText('ps3-shm / Test.csv');
  await expect(page.getByRole('combobox', { name: 'Selected recording' })).toHaveValue(shmKey);
  await expectReady(page);
  await expect(page.locator('.ms-damage')).toHaveCount(0);
  await expect(resultPanel(page)).not.toContainText('door cycles classified');
});

test('Door ZIP retains exact analysed output while other recordings have not been analysed', async ({ page }) => {
  await page.goto('/#door');
  await page.getByLabel('Upload recording files').setInputFiles(resolve(fixtures, 'door-controller.csv'));
  await analyse(page);
  const doorCsv = await csvDownload(page);
  await navigate(page, 'ACV');
  await page.getByLabel('Upload recording files').setInputFiles(resolve(fixtures, 'acv-basic.xlsx'));
  await expectReady(page);
  await navigate(page, 'Structural health');
  await page.getByLabel('Upload recording files').setInputFiles(resolve(fixtures, 'shm-stress.csv'));
  await expectReady(page);
  await expect(page.getByRole('button', { name: /predictions.zip/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Synthetic demo', exact: true })).toHaveCount(0);
  await navigate(page, 'Doors');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: /predictions.zip/ }).click();
  const archive = await pending;
  expect(archive.suggestedFilename()).toBe('predictions.zip');
  const files = unzipSync(new Uint8Array(readFileSync((await archive.path())!)));
  expect(Object.keys(files)).toEqual(['door_predictions.csv']);
  expect(strFromU8(files['door_predictions.csv'])).toBe(doorCsv.text);
  await navigate(page, 'Rail corrugation');
  await expect(resultPanel(page)).toContainText('Choose a recording to begin');
  await expect(page.locator('.reference-train-scene')).toHaveAttribute('data-rail-class', 'uncomputed');
});

test('multiple SHM recordings rehydrate distinct source values after worker cache eviction', async ({ page }) => {
  await page.goto('/#shm');
  const names = ['test16.csv', 'test03.csv', 'test01.csv', 'test09.csv'];
  await page.getByLabel('Upload recording files').setInputFiles(names.map((name, index) => ({ name, mimeType: 'text/csv', buffer: Buffer.from([1, 2, 3, 4].map(value => value + index * 10).join('\n')) })));
  await expect(page.getByRole('button', { name: 'Analyse all 4', exact: true })).toBeEnabled();
  for (const [index, name] of names.entries()) {
    await page.getByRole('combobox', { name: 'Selected recording' }).selectOption({ label: name });
    await expect(page.locator('.ms-source-context')).toContainText(`ps3-shm / ${name}`);
    await expect(page.locator('.ms-time-control')).toContainText('Sample 1 · acquisition time not supplied');
    await expect(inspector(page).locator('.ms-field summary strong')).toHaveText(String(index * 10 + 1));
    await page.getByRole('slider', { name: 'Recording sample cursor', exact: true }).focus();
    await page.keyboard.press('End');
    await expect(inspector(page).locator('.ms-field summary strong')).toHaveText(String(index * 10 + 4));
  }
  await expectReady(page);
  await expect(page.locator('.ms-unmapped')).toContainText('not assigned to any car or bogie');
  await expect(page.getByRole('button', { name: /predictions.zip/ })).toBeDisabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('rejects malformed Rail and distinguishes same-named recordings when removing the selected source', async ({ page }) => {
  await page.goto('/#rail');
  await page.getByLabel('Upload recording files').setInputFiles({ name: 'broken.csv', mimeType: 'text/csv', buffer: Buffer.from('Rotating speed,Vibration of bearing in position 1 of car 1\n0,1\n') });
  await expect(page.getByRole('alert')).toContainText('129 columns');
  await expect(page.getByRole('button', { name: 'Run analysis', exact: true })).toBeDisabled();
  await expect(resultPanel(page)).toContainText('Choose a recording to begin');
  await expect(page.locator('.reference-train-scene')).toHaveAttribute('data-rail-class', 'uncomputed');

  await navigate(page, 'Structural health');
  await page.getByLabel('Upload recording files').setInputFiles({ name: 'Test.csv', mimeType: 'text/csv', buffer: readFileSync(resolve(fixtures, 'shm-stress.csv')) });
  await expectReady(page);
  await expect(inspector(page).locator('.ms-field summary strong')).toHaveText('-1.134701');
  const originalKey = await page.getByRole('combobox', { name: 'Selected recording' }).inputValue();

  await page.getByLabel('Upload recording files').setInputFiles({ name: 'Test.csv', mimeType: 'text/csv', buffer: Buffer.from('-2.2694016\n-2.4904954\n-1.8442208\n-2.817224\n') });
  const namedOptions = page.getByRole('combobox', { name: 'Selected recording' }).locator('option', { hasText: /^Test\.csv(?: · source [0-9a-f]{8})?$/ });
  await expect(namedOptions).toHaveCount(2);
  expect(new Set(await namedOptions.allTextContents()).size).toBe(2);
  await expectReady(page);
  const changedKey = await page.getByRole('combobox', { name: 'Selected recording' }).inputValue();
  expect(changedKey).not.toBe(originalKey);
  await expect(inspector(page).locator('.ms-field summary strong')).toHaveText('-2.269402');

  await page.getByRole('button', { name: 'Remove selected recording', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Selected recording' })).toHaveValue(originalKey);
  await expect(page.getByRole('combobox', { name: 'Selected recording' }).locator('option', { hasText: /^Test\.csv$/ })).toHaveCount(1);
  await expect(inspector(page).locator('.ms-field summary strong')).toHaveText('-1.134701');
  await expectReady(page);
  await expect(page.getByRole('button', { name: /predictions.zip/ })).toBeDisabled();
});

test('keyboard-accessible schematic retains recorded component inspection without WebGL', async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...args: unknown[]) {
      if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') return null;
      return original.call(this, type as '2d', ...args as []);
    } as typeof original;
  });
  await page.goto('/#rail');
  await expect(page.getByRole('group', { name: 'Eight-car reference schematic' })).toBeVisible();
  await page.getByLabel('Upload recording files').setInputFiles(railUpload);
  await expect(page.locator('.ms-source-context')).toContainText('10,000 rows · 129 source fields');
  await expectReady(page);
  await page.getByRole('button', { name: 'Select car 3', exact: true }).click();
  await inspector(page).getByRole('button', { name: 'Select car 3 axle box 5', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(inspector(page).getByRole('heading', { name: 'Car 3 · Axle box 5 · Side I' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Metric' })).toHaveValue('column-41');
  await expect(page.locator('.reference-train-scene')).toHaveAttribute('data-rail-class', 'uncomputed');
  await page.getByRole('button', { name: 'Fit train', exact: true }).click();
  await expect(page.locator('.reference-train-scene')).toHaveAttribute('data-selected-car', '');
});

test('full supplied rich ACV workbook preserves all 483 columns before analysis', async ({ page }) => {
  const source = process.env.RAILWITNESS_DATA_ROOT ?? '/Users/bytedance/Downloads/NebulaX-Hackathon-ProblemStatement-main/PS3/02_Datasets';
  const path = resolve(source, 'ACV/Train/acv_case_04.xlsx');
  test.skip(process.env.RAILWITNESS_HEAVY_XLSX !== '1' || !existsSync(path), 'Optional full-data smoke: set RAILWITNESS_HEAVY_XLSX=1 and RAILWITNESS_DATA_ROOT if needed.');
  test.setTimeout(120000);
  await page.goto('/#acv');
  await page.getByLabel('Upload recording files').setInputFiles(path);
  await expect(page.locator('.ms-source-context')).toContainText('22,262 rows · 483 source fields', { timeout: 90000 });
  await expectReady(page);
  expect(await page.getByRole('navigation', { name: 'Carriage navigator' }).locator('button strong').allTextContents()).toEqual(['01', '02', '03', '04', '05', '06', '07', '08']);
  await page.getByRole('checkbox', { name: 'All recording fields' }).check();
  await page.getByRole('textbox', { name: 'Search source fields' }).fill('Grounding Detection');
  await expect(page.locator('.ms-field')).toHaveCount(8);
});

test('supplied ACV test workbook matches the saved ranking, exact download, and source-car selection', async ({ page }) => {
  const source = process.env.RAILWITNESS_DATA_ROOT ?? '/Users/bytedance/Downloads/NebulaX-Hackathon-ProblemStatement-main/PS3/02_Datasets';
  const path = resolve(source, 'ACV/Test/acv_test_case.xlsx');
  test.skip(!existsSync(path), 'Set RAILWITNESS_DATA_ROOT to run the supplied ACV workbook check.');
  test.setTimeout(120000);
  const expected = readFileSync(resolve('backend/acv/acv_predictions.csv'), 'utf8');
  const ranking = expected.trim().split(/\r?\n/)[1].split(',')[1].split('|');
  await page.goto('/#acv');
  await page.getByLabel('Upload recording files').setInputFiles(path);
  await expect(page.locator('.ms-source-context')).toContainText('9,082 rows', { timeout: 90000 });
  await analyse(page);
  await expect(resultPanel(page).getByRole('heading', { level: 2 })).toHaveText(`ACV inspection priority: Car ${ranking[0]}`);
  for (const [index, car] of ranking.entries()) await expect(resultPanel(page).locator('.ms-acv-ranking tbody tr').nth(index)).toContainText(`Car ${car}`);
  await expect(page.locator('.reference-train-scene')).toHaveAttribute('data-acv-first-car', ranking[0]);
  expect((await csvDownload(page)).text).toBe(expected);
  await resultPanel(page).getByRole('button', { name: `Inspect Car ${ranking[1]}`, exact: true }).click();
  await expect(inspector(page).getByRole('heading', { name: `Car ${ranking[1]}`, exact: true })).toBeVisible();
  expect(await page.getByRole('navigation', { name: 'Carriage navigator' }).locator('button strong').allTextContents()).toEqual(acvIds);
  await page.setViewportSize({ width: 430, height: 932 });
  await expect(resultPanel(page).getByRole('heading', { level: 2 })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
