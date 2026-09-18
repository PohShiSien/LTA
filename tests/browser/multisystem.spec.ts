import { expect, test, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';

const fixtures = resolve('tests/fixtures/recordings');
const railLines = readFileSync(resolve(fixtures, 'rail-first-samples.csv'), 'utf8').trim().split(/\r?\n/);
const railCsv = Buffer.from([railLines[0], ...Array.from({ length: 10000 }, (_, index) => railLines[1 + index % (railLines.length - 1)])].join('\n'));
const railUpload = { name: 'rail-recording.csv', mimeType: 'text/csv', buffer: railCsv };
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

test.beforeEach(async ({ page }) => { await page.emulateMedia({ reducedMotion: 'reduce' }); });

test('uploaded Rail uses exact channels, keeps one recording class while scrubbing, and exports its scored CSV', async ({ page }) => {
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
  await analyse(page);
  const classBefore = await resultPanel(page).getByRole('heading', { level: 2 }).textContent();
  await page.getByRole('slider', { name: 'Recording sample cursor', exact: true }).focus();
  await page.keyboard.press('End');
  await expect(page.locator('.ms-time-control')).toContainText('0.9999 s elapsed');
  await expect(resultPanel(page).getByRole('heading', { level: 2 })).toHaveText(classBefore!);
  await page.getByRole('combobox', { name: 'Metric' }).selectOption('column-0');
  await expect(page.getByRole('combobox', { name: 'Metric' }).locator('option:checked')).toHaveText('Rotating speed');
  const download = await csvDownload(page);
  expect(download.name).toBe('rail_predictions.csv');
  expect(download.text).toMatch(/^file_id,prediction\r\nrail-recording.csv,(Normal|Side I|Side II)\r\n$/);
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
  await analyse(page);
  const ranking = await page.locator('.ms-ranking li strong').allTextContents();
  expect([...ranking].sort()).toEqual(['01', '02', '03', '04', '05', '06', '07', '08']);
  expect(await page.getByRole('navigation', { name: 'Carriage navigator' }).locator('button strong').allTextContents()).toEqual(['01', '02', '03', '04', '05', '06', '07', '08']);
  const download = await csvDownload(page);
  expect(download.text).toBe(`file_id,ranked_cars\r\nacv-basic.xlsx,${ranking.join('|')}\r\n`);
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

test('SHM produces one unlocated numeric result and isolates same-named files across subsystems', async ({ page }) => {
  await page.goto('/#shm');
  await page.getByLabel('Upload recording files').setInputFiles({ name: 'Test.csv', mimeType: 'text/csv', buffer: readFileSync(resolve(fixtures, 'shm-stress.csv')) });
  await expect(inspector(page).getByRole('heading', { name: 'Measurement location not supplied' })).toBeVisible();
  await expect(page.locator('.ms-unmapped')).toContainText('not assigned to any car or bogie');
  await analyse(page);
  await expect(resultPanel(page).getByRole('heading', { level: 2 })).toHaveText('Predicted cumulative fatigue damage');
  const damage = await page.locator('.ms-damage').getAttribute('title');
  expect(Number.isFinite(Number(damage))).toBe(true);
  const download = await csvDownload(page);
  expect(download.text).toBe(`file_id,prediction\r\nTest.csv,${damage}\r\n`);
  await navigate(page, 'Doors');
  await expect(resultPanel(page)).toContainText('Choose a recording to begin');
  await page.getByLabel('Upload recording files').setInputFiles({ name: 'Test.csv', mimeType: 'text/csv', buffer: readFileSync(resolve(fixtures, 'door-controller.csv')) });
  await expect(page.locator('.ms-source-context')).toContainText('ps3-door / Test.csv');
  await expect(resultPanel(page)).toContainText('Recording ready for analysis');
  await expect(page.locator('.ms-damage')).toHaveCount(0);
  await navigate(page, 'Structural health');
  await expect(page.locator('.ms-source-context')).toContainText('ps3-shm / Test.csv');
  await expect(page.locator('.ms-damage')).toHaveAttribute('title', damage!);
});

test('ZIP exports only analysed uploaded subsystems, even while synthetic demo mode is active', async ({ page }) => {
  await page.goto('/#shm');
  await page.getByLabel('Upload recording files').setInputFiles(resolve(fixtures, 'shm-stress.csv'));
  await analyse(page);
  await navigate(page, 'ACV');
  await page.getByLabel('Upload recording files').setInputFiles(resolve(fixtures, 'acv-basic.xlsx'));
  await expect(page.getByRole('button', { name: 'Run analysis', exact: true })).toBeEnabled();
  await navigate(page, 'Rail corrugation');
  await page.getByRole('button', { name: 'Synthetic demo', exact: true }).click();
  await expect(page.locator('.ms-mode-chip')).toHaveText('SYNTHETIC DEMO');
  await analyse(page);
  await expect(resultPanel(page)).toContainText('SYNTHETIC DEMONSTRATION');
  const synthetic = await csvDownload(page);
  expect(synthetic.name).toBe('demo_rail_predictions.csv');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: /predictions.zip/ }).click();
  const archive = await pending;
  expect(archive.suggestedFilename()).toBe('predictions.zip');
  const files = unzipSync(new Uint8Array(readFileSync((await archive.path())!)));
  expect(Object.keys(files)).toEqual(['shm_predictions.csv']);
  expect(strFromU8(files['shm_predictions.csv'])).toMatch(/^file_id,prediction\r\nshm-stress.csv,/);
  await page.getByRole('button', { name: 'Uploaded sources', exact: true }).click();
  await expect(resultPanel(page)).toContainText('Choose a recording to begin');
  await expect(page.locator('.reference-train-scene')).toHaveAttribute('data-rail-class', 'uncomputed');
});

test('multiple randomly numbered SHM files rehydrate after cache eviction and export one value per file', async ({ page }) => {
  await page.goto('/#shm');
  const names = ['test16.csv', 'test03.csv', 'test01.csv', 'test09.csv'];
  await page.getByLabel('Upload recording files').setInputFiles(names.map(name => ({ name, mimeType: 'text/csv', buffer: readFileSync(resolve(fixtures, 'shm-stress.csv')) })));
  await expect(page.getByRole('button', { name: 'Analyse all 4', exact: true })).toBeEnabled();
  await page.getByRole('combobox', { name: 'Selected recording' }).selectOption({ label: 'test16.csv' });
  await expect(page.locator('.ms-time-control')).toContainText('Sample 1 · acquisition time not supplied');
  await analyse(page);
  await page.getByRole('button', { name: 'Analyse all 4', exact: true }).click();
  await expect(page.getByRole('button', { name: /predictions.zip/ }).locator('.ms-count')).toHaveText('4');
  await expect(page.getByRole('button', { name: 'Analyse all 4', exact: true })).toBeEnabled();
  await expect(page.locator('.ms-unmapped')).toContainText('not assigned to any car or bogie');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: /predictions.zip/ }).click();
  const archive = await pending;
  const files = unzipSync(new Uint8Array(readFileSync((await archive.path())!)));
  const csv = strFromU8(files['shm_predictions.csv']).trim().split(/\r?\n/);
  expect(csv).toHaveLength(5);
  expect(csv[0]).toBe('file_id,prediction');
  expect(csv.slice(1).map(line => line.split(',')[0])).toEqual(names);
  expect(csv.slice(1).every(line => Number.isFinite(Number(line.split(',')[1])))).toBe(true);
});

test('rejects malformed Rail and recovers from duplicate export names by removing only the selected recording', async ({ page }) => {
  await page.goto('/#rail');
  await page.getByLabel('Upload recording files').setInputFiles({ name: 'broken.csv', mimeType: 'text/csv', buffer: Buffer.from('Rotating speed,Vibration of bearing in position 1 of car 1\n0,1\n') });
  await expect(page.getByRole('alert')).toContainText('129 columns');
  await expect(page.getByRole('button', { name: 'Run analysis', exact: true })).toBeDisabled();
  await expect(resultPanel(page)).toContainText('Choose a recording to begin');
  await expect(page.locator('.reference-train-scene')).toHaveAttribute('data-rail-class', 'uncomputed');

  await navigate(page, 'Structural health');
  await page.getByLabel('Upload recording files').setInputFiles({ name: 'Test.csv', mimeType: 'text/csv', buffer: readFileSync(resolve(fixtures, 'shm-stress.csv')) });
  await analyse(page);
  const originalCsv = (await csvDownload(page)).text;
  const originalKey = await page.getByRole('combobox', { name: 'Selected recording' }).inputValue();

  await page.getByLabel('Upload recording files').setInputFiles({ name: 'Test.csv', mimeType: 'text/csv', buffer: Buffer.from('-2.2694016\n-2.4904954\n-1.8442208\n-2.817224\n') });
  const namedOptions = page.getByRole('combobox', { name: 'Selected recording' }).locator('option', { hasText: /^Test\.csv(?: · source [0-9a-f]{8})?$/ });
  await expect(namedOptions).toHaveCount(2);
  expect(new Set(await namedOptions.allTextContents()).size).toBe(2);
  await expect(resultPanel(page)).toContainText('Recording ready for analysis');
  const changedKey = await page.getByRole('combobox', { name: 'Selected recording' }).inputValue();
  expect(changedKey).not.toBe(originalKey);
  await analyse(page);
  await expect(page.getByRole('button', { name: /predictions.zip/ }).locator('.ms-count')).toHaveText('2');
  await page.getByRole('button', { name: /predictions.zip/ }).click();
  await expect(page.getByRole('alert')).toContainText('Duplicate output identity Test.csv');

  await page.getByRole('button', { name: 'Remove selected recording', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Selected recording' })).toHaveValue(originalKey);
  await expect(page.getByRole('combobox', { name: 'Selected recording' }).locator('option', { hasText: /^Test\.csv$/ })).toHaveCount(1);
  await expect(page.getByRole('button', { name: /predictions.zip/ }).locator('.ms-count')).toHaveText('1');
  await expect(resultPanel(page).getByRole('heading', { level: 2 })).toHaveText('Predicted cumulative fatigue damage');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: /predictions.zip/ }).click();
  const archive = await pending;
  const files = unzipSync(new Uint8Array(readFileSync((await archive.path())!)));
  expect(Object.keys(files)).toEqual(['shm_predictions.csv']);
  expect(strFromU8(files['shm_predictions.csv'])).toBe(originalCsv);
});

test('keyboard-accessible schematic retains component selection and results without WebGL', async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...args: unknown[]) {
      if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') return null;
      return original.call(this, type as '2d', ...args as []);
    } as typeof original;
  });
  await page.goto('/#rail');
  await expect(page.getByRole('group', { name: 'Eight-car reference schematic' })).toBeVisible();
  await page.getByRole('button', { name: 'Synthetic demo', exact: true }).click();
  await analyse(page);
  await page.getByRole('button', { name: 'Select car 3', exact: true }).click();
  await inspector(page).getByRole('button', { name: 'Select car 3 axle box 5', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(inspector(page).getByRole('heading', { name: 'Car 3 · Axle box 5 · Side I' })).toBeVisible();
  await expect(resultPanel(page)).toContainText('Predicted: Side I corrugation');
  await page.getByRole('button', { name: 'Fit train', exact: true }).click();
  await expect(page.locator('.reference-train-scene')).toHaveAttribute('data-selected-car', '');
});

test('full supplied rich ACV workbook uploads all 483 columns and runs its fitted model', async ({ page }) => {
  const source = process.env.RAILWITNESS_DATA_ROOT ?? '/Users/bytedance/Downloads/NebulaX-Hackathon-ProblemStatement-main/PS3/02_Datasets';
  const path = resolve(source, 'ACV/Train/acv_case_04.xlsx');
  test.skip(process.env.RAILWITNESS_HEAVY_XLSX !== '1' || !existsSync(path), 'Optional full-data smoke: set RAILWITNESS_HEAVY_XLSX=1 and RAILWITNESS_DATA_ROOT if needed.');
  test.setTimeout(120000);
  await page.goto('/#acv');
  await page.getByLabel('Upload recording files').setInputFiles(path);
  await expect(page.locator('.ms-source-context')).toContainText('22,262 rows · 483 source fields', { timeout: 90000 });
  await analyse(page);
  expect([...await page.locator('.ms-ranking li strong').allTextContents()].sort()).toEqual(['01', '02', '03', '04', '05', '06', '07', '08']);
  await page.getByRole('checkbox', { name: 'All recording fields' }).check();
  await page.getByRole('textbox', { name: 'Search source fields' }).fill('Grounding Detection');
  await expect(page.locator('.ms-field')).toHaveCount(8);
});
