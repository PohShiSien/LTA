import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DoorAnalysis } from '../../src/lib/railwitnessDoorClient';

const fixtures = resolve('tests/fixtures/recordings');
const rows = readFileSync(resolve(fixtures, 'door-controller.csv'), 'utf8').trim().split(/\r?\n/);
// Test-only recording exercises three movements through the actual frozen backend.
// Classification is read from its response; this fixture makes no accuracy claim.
const replayUpload = { name: 'replay-cycles.csv', mimeType: 'text/csv', buffer: Buffer.from([rows[0], ...Array.from({ length: 3 }, (_, cycle) => rows.slice(1).map((row, index) => {
  const values = row.split(','); const opening = cycle === 1;
  values[0] = `2023-7-5-0-0-${cycle * 10}-${index * 20}`;
  values[6] = values[15] = opening ? '0' : '1'; values[7] = values[14] = opening ? '1' : '0';
  values[16] = String(opening ? 698 + index : 700 - index);
  return values.join(',');
})).flat()].join('\n')) };

async function analyse(page: Page): Promise<DoorAnalysis> {
  const pending = page.waitForResponse(response => response.url().endsWith('/api/door/predict') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Run analysis', exact: true }).click();
  const response = await pending;
  expect(response.ok()).toBe(true);
  await expect(page.getByRole('button', { name: 'Run again', exact: true })).toBeEnabled();
  await expect(page.locator('.door-evidence-classification')).toContainText(/Normal|Abnormal resistance/);
  return response.json();
}
test.beforeEach(async ({ page }) => { await page.emulateMedia({ reducedMotion: 'reduce' }); });

test('uploaded Door timeline preserves every cycle, timestamps, keyboard selection, and inferred direction', async ({ page }) => {
  await page.goto('/#door');
  await page.getByLabel('Upload recording files').setInputFiles(replayUpload);
  const analysis = await analyse(page);
  const cycles = page.getByRole('group', { name: 'All detected Door cycles' });
  await expect(cycles.getByRole('button')).toHaveCount(analysis.segments.length);
  await expect(cycles.locator('.abnormal')).toHaveCount(analysis.summary.abnormal_resistance);
  await expect(page.locator('.door-motion-visual svg')).toHaveAttribute('data-operation', 'Close');
  await cycles.getByRole('button').first().focus();
  await page.keyboard.press('ArrowRight');
  await expect(cycles.getByRole('button').nth(1)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.door-motion-visual svg')).toHaveAttribute('data-operation', 'Open');
  await page.keyboard.press('End');
  await expect(cycles.getByRole('button').nth(2)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.door-motion-visual')).toContainText('Physical door identity unavailable');
  await expect(page.locator('.door-replay-timestamps')).toContainText(analysis.segments[2].start_time);
  await expect(page.locator('#door-replay')).not.toContainText(/\bD0[1-9]\b|next-cycle|future failure/i);
  await expect(page.getByRole('button', { name: 'Synthetic demo', exact: true })).toHaveCount(0);
});

test('Door replay conceals completed-cycle output, pauses and resumes the same movement', async ({ page }) => {
  await page.goto('/#door');
  await page.getByLabel('Upload recording files').setInputFiles(resolve(fixtures, 'door-controller.csv'));
  await analyse(page);
  await page.clock.install({ time: new Date('2026-09-18T12:00:00Z') });
  await page.clock.pauseAt(new Date('2026-09-18T12:00:01Z'));
  await page.getByRole('button', { name: 'Play cycle replay' }).click();
  await page.clock.runFor(600);
  const progress = page.getByRole('progressbar', { name: 'Selected cycle replay progress' });
  const beforePause = Number(await progress.getAttribute('aria-valuenow'));
  expect(beforePause).toBeGreaterThan(0); expect(beforePause).toBeLessThan(100);
  await expect(page.locator('.reference-train-scene')).toHaveAttribute('data-door-completed', 'false');
  await expect(page.locator('.ms-segments')).toHaveCount(0);
  await expect(page.locator('.door-motion-result')).toHaveText('Recorded movement in progress');
  await page.getByRole('button', { name: 'Pause cycle replay' }).click();
  const paused = await progress.getAttribute('aria-valuenow');
  await page.clock.runFor(700);
  await expect(progress).toHaveAttribute('aria-valuenow', paused!);
  await page.getByRole('button', { name: 'Play cycle replay' }).click();
  await page.clock.runFor(100);
  expect(Number(await progress.getAttribute('aria-valuenow'))).toBeGreaterThanOrEqual(Number(paused));
  await page.clock.runFor(1600);
  await expect(progress).toHaveAttribute('aria-valuenow', '100');
  await expect(page.locator('.reference-train-scene')).toHaveAttribute('data-door-completed', 'true');
  await expect(page.locator('.door-evidence-classification')).toContainText(/Normal|Abnormal resistance/);
  await expect(page.locator('#door-cycle-evidence')).toContainText('Elapsed cycle time (%)');
});

test('Door replay advances chronologically and cancels when the selected recording changes', async ({ page }) => {
  await page.goto('/#door');
  await page.getByLabel('Upload recording files').setInputFiles([replayUpload, { name: 'other.csv', mimeType: 'text/csv', buffer: Buffer.from(rows.join('\n')) }]);
  await page.getByRole('combobox', { name: 'Selected recording' }).selectOption({ label: replayUpload.name });
  await analyse(page);
  await page.clock.install({ time: new Date('2026-09-18T12:00:00Z') });
  await page.clock.pauseAt(new Date('2026-09-18T12:00:01Z'));
  await page.getByRole('button', { name: 'Play cycle replay' }).click();
  await page.clock.runFor(2200);
  await expect(page.locator('.door-replay-now')).toContainText('Cycle 2 of 3');
  await expect(page.locator('.door-motion-visual svg')).toHaveAttribute('data-operation', 'Open');
  await page.getByRole('combobox', { name: 'Selected recording' }).selectOption({ label: 'other.csv' });
  await expect(page.locator('#door-replay')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'CSV', exact: true })).toBeDisabled();
  await page.clock.fastForward(5000);
  await page.getByRole('combobox', { name: 'Selected recording' }).selectOption({ label: replayUpload.name });
  await expect(page.getByRole('button', { name: 'Play cycle replay' })).toBeVisible();
  await expect(page.locator('.door-replay-now')).toContainText('Cycle 2 of 3');
});

test('SHM stress inspection stays unlocated, respects reduced motion, and waits for explicit analysis', async ({ page }) => {
  await page.goto('/#shm');
  await page.getByLabel('Upload recording files').setInputFiles({ name: 'test99.csv', mimeType: 'text/csv', buffer: readFileSync(resolve(fixtures, 'shm-stress.csv')) });
  await expect(page.getByRole('button', { name: 'Run analysis', exact: true })).toBeEnabled();
  await expect(page.locator('.reference-train-scene')).toHaveAttribute('data-selected-car', '');
  await expect(page.locator('.reference-train-scene')).toContainText('sensor location unavailable');
  await expect(page.locator('.multi-shell')).toHaveAttribute('data-reduced-motion', 'true');
  await expect(page.locator('.ms-damage')).toHaveCount(0);
  await page.locator('.ms-stress-disclosure > summary').click();
  await page.getByRole('button', { name: 'Select car 03', exact: true }).click();
  await expect(page.locator('.reference-train-scene')).toHaveAttribute('data-selected-car', '');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(page.locator('.multi-shell')).toHaveAttribute('data-reduced-motion', 'false');
  await page.clock.install({ time: new Date('2026-09-18T12:00:00Z') });
  await page.clock.pauseAt(new Date('2026-09-18T12:00:01Z'));
  await page.getByRole('button', { name: 'Play stress replay' }).click();
  await page.clock.runFor(3000);
  expect(Number(await page.getByRole('slider', { name: 'Stress replay sample', exact: true }).inputValue())).toBeGreaterThan(0);
  await expect(page.locator('.ms-damage')).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Reduce motion', exact: true }).check();
  await expect(page.locator('.reference-train-scene')).toHaveAttribute('data-reduced-motion', 'true');
  await expect(page.getByRole('button', { name: 'Play stress replay' })).toBeDisabled();
});

test('SHM cursor reads the original sample even when chart downsampling omits it', async ({ page }) => {
  const samples = Array.from({ length: 10000 }, () => 0);
  samples[1] = 7; samples[2] = 100; // The first chart bucket keeps 0 and 100, not the selected 7.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/#shm');
  await page.getByLabel('Upload recording files').setInputFiles({ name: 'cursor.csv', mimeType: 'text/csv', buffer: Buffer.from(samples.join('\n')) });
  await page.getByRole('spinbutton', { name: 'Sample number', exact: true }).fill('2');
  await page.locator('.ms-stress-disclosure > summary').click();
  await expect(page.getByLabel('Selected stress value')).toHaveText('7');
  await expect(page.locator('.reference-train-scene')).toHaveCSS('--stress-amplitude', '0.07');
  await expect(page.getByRole('group', { name: 'Selected signal measurements' })).toContainText('Stress range');
  await expect(page.getByRole('region', { name: 'Prediction result' })).toContainText('Recording ready for analysis');
});
