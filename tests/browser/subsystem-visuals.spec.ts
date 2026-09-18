import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const fixtures = resolve('tests/fixtures/recordings');
async function analyse(page: Page) {
  await page.getByRole('button', { name: 'Run analysis', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Run again', exact: true })).toBeEnabled();
}
async function demo(page: Page, subsystem: string) {
  await page.goto(`/#${subsystem}`);
  await page.getByRole('button', { name: 'Synthetic demo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Run analysis', exact: true })).toBeEnabled();
  await analyse(page);
}
test.beforeEach(async ({ page }) => { await page.emulateMedia({ reducedMotion: 'reduce' }); });

test('Door timeline preserves all cycles, keyboard selection, inferred direction and abnormal text markers', async ({ page }) => {
  await demo(page, 'door');
  const cycles = page.getByRole('group', { name: 'All detected Door cycles' });
  await expect(cycles.getByRole('button')).toHaveCount(3);
  await expect(cycles.locator('.abnormal')).toHaveCount(1);
  await expect(cycles.locator('.abnormal')).toHaveAccessibleName(/Recorded cycle 3: Abnormal resistance/);
  await expect(page.locator('.door-motion-visual svg')).toHaveAttribute('data-operation', 'Close');
  await cycles.getByRole('button').first().focus();
  await page.keyboard.press('ArrowRight');
  await expect(cycles.getByRole('button').nth(1)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.door-motion-visual svg')).toHaveAttribute('data-operation', 'Open');
  await page.keyboard.press('End');
  await expect(page.locator('.door-motion-visual')).toContainText('Abnormal resistance detected');
  await expect(page.locator('.door-motion-visual')).toContainText('Physical door identity unavailable');
  await expect(page.locator('.door-replay-timestamps')).toContainText('2026-09-18');
  await expect(page.locator('#door-replay')).not.toContainText(/\bD0[1-9]\b|next-cycle|future failure/i);
});

test('Door replay conceals completed-cycle output, pauses and resumes the same movement', async ({ page }) => {
  await page.goto('/#door');
  await page.getByLabel('Upload recording files').setInputFiles(resolve(fixtures, 'door-controller.csv'));
  await analyse(page);
  await expect(page.locator('.door-evidence-classification')).toContainText(/Normal|Abnormal resistance/);
  await page.clock.install({ time: new Date('2026-09-18T12:00:00Z') });
  await page.clock.pauseAt(new Date('2026-09-18T12:00:01Z'));
  await page.getByRole('button', { name: 'Play cycle replay' }).click();
  await page.clock.runFor(600);
  const progress = page.getByRole('progressbar', { name: 'Selected cycle replay progress' });
  const beforePause = Number(await progress.getAttribute('aria-valuenow'));
  expect(beforePause).toBeGreaterThan(0);
  expect(beforePause).toBeLessThan(100);
  await expect(page.locator('.reference-train-scene')).toHaveAttribute('data-door-completed', 'false');
  await expect(page.locator('.ms-segments')).toHaveCount(0);
  await expect(page.locator('.door-motion-result')).toHaveText('Recorded movement in progress');
  await page.getByRole('button', { name: 'Pause cycle replay' }).click();
  const paused = await progress.getAttribute('aria-valuenow');
  expect(Number(paused)).toBeLessThan(100);
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

test('Door replay advances chronologically and cancels when the source mode changes', async ({ page }) => {
  await demo(page, 'door');
  await page.clock.install({ time: new Date('2026-09-18T12:00:00Z') });
  await page.clock.pauseAt(new Date('2026-09-18T12:00:01Z'));
  await page.getByRole('button', { name: 'Play cycle replay' }).click();
  await page.clock.runFor(2200);
  await expect(page.locator('.door-replay-now')).toContainText('Cycle 2 of 3');
  await expect(page.locator('.door-motion-visual svg')).toHaveAttribute('data-operation', 'Open');
  await page.getByRole('button', { name: 'Uploaded sources', exact: true }).click();
  await expect(page.locator('#door-replay')).toHaveCount(0);
  await page.clock.fastForward(5000);
  await page.getByRole('button', { name: 'Synthetic demo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Play cycle replay' })).toBeVisible();
  await expect(page.locator('.door-replay-now')).toContainText('Cycle 2 of 3');
});

test('ACV ranks every exact source car, emphasizes rank one and connects selection to recorded peer evidence', async ({ page }) => {
  await page.goto('/#acv');
  await page.getByLabel('Upload recording files').setInputFiles(resolve(fixtures, 'acv-basic.xlsx'));
  await analyse(page);
  const cards = page.getByRole('region', { name: 'ACV car ranking' });
  await expect(cards.getByRole('button')).toHaveCount(8);
  const labels = await cards.getByRole('button').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')));
  expect(labels.map(label => Number(label!.match(/rank (\d+)/)![1])).sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  expect(labels.map(label => label!.match(/Car (\d+)/)![1]).sort()).toEqual(['01', '02', '03', '04', '05', '06', '07', '08']);
  const first = cards.locator('.acv-rank-1');
  const firstId = (await first.getAttribute('aria-label'))!.match(/Car (\d+)/)![1];
  await first.click();
  await expect(page.locator('.acv-selected-evidence')).toContainText(`Car ${firstId}`);
  await expect(page.locator('.acv-selected-evidence')).toContainText('Rank #1');
  await expect(page.locator('.reference-train-scene')).toHaveAttribute('data-selected-car', String(Number(firstId)));
  const peers = page.getByRole('region', { name: 'ACV peer evidence' });
  await expect(peers.locator('.acv-peer-row')).toHaveCount(8);
  await peers.getByRole('combobox').selectOption('score');
  await expect(peers).toContainText('Uncalibrated model score');
  await expect(peers).not.toContainText(/\d+% chance|confirmed leaking car/i);
});

test('Rail links the recording side to odd/even sensor groups and keeps a text-labelled neutral opposite side', async ({ page }) => {
  await demo(page, 'rail');
  await expect(page.locator('.reference-train-scene')).toHaveAttribute('data-rail-class', 'Side I');
  await expect(page.locator('.reference-train-scene')).toHaveAttribute('data-axle-box-count', '64');
  const sides = page.getByRole('group', { name: 'Recording-level reference rails' });
  await expect(sides.locator('.is-predicted')).toHaveCount(1);
  await expect(sides.locator('.is-predicted')).toContainText('Side I');
  await sides.getByRole('button', { name: 'Select reference rail Side II' }).click();
  await expect(sides.getByRole('button', { name: 'Select reference rail Side II' })).toHaveAttribute('aria-pressed', 'true');
  await expect(sides.locator('.is-predicted')).toContainText('Side I');
  await expect(page.locator('.reference-train-scene')).toContainText('Illustrative rail-side highlight');
});

test('SHM retains exact damage, replays samples without assigning a component, and responds to reduced motion', async ({ page }) => {
  await page.goto('/#shm');
  await page.getByLabel('Upload recording files').setInputFiles({ name: 'test99.csv', mimeType: 'text/csv', buffer: readFileSync(resolve(fixtures, 'shm-stress.csv')) });
  await analyse(page);
  await expect(page.locator('.reference-train-scene')).toHaveAttribute('data-selected-car', '');
  await expect(page.locator('.reference-train-scene')).toContainText('physical sensor location unavailable');
  await expect(page.locator('.multi-shell')).toHaveAttribute('data-reduced-motion', 'true');
  const exact = await page.locator('.ms-damage').getAttribute('title');
  expect(Number.isFinite(Number(exact))).toBe(true);
  await expect(page.locator('main')).not.toContainText(/\d+(?:\.\d+)?%\s*health|remaining life\s*[:=]\s*\d/i);
  await page.getByRole('button', { name: 'Select car 03', exact: true }).click();
  await expect(page.locator('.reference-train-scene')).toHaveAttribute('data-selected-car', '');
  await expect(page.locator('.ms-damage')).toHaveAttribute('title', exact!);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(page.locator('.multi-shell')).toHaveAttribute('data-reduced-motion', 'false');
  await page.clock.install({ time: new Date('2026-09-18T12:00:00Z') });
  await page.clock.pauseAt(new Date('2026-09-18T12:00:01Z'));
  await page.getByRole('button', { name: 'Play stress replay' }).click();
  await page.clock.runFor(3000);
  expect(Number(await page.getByRole('slider', { name: 'Stress replay sample', exact: true }).inputValue())).toBeGreaterThan(0);
  await expect(page.locator('.ms-damage')).toHaveAttribute('title', exact!);
  await page.getByRole('checkbox', { name: 'Reduce motion', exact: true }).check();
  await expect(page.locator('.reference-train-scene')).toHaveAttribute('data-reduced-motion', 'true');
  await expect(page.getByRole('button', { name: 'Play stress replay' })).toBeDisabled();
});
