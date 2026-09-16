import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { CANDIDATE_CYCLE_INDEX, createDemoCycles } from '../../src/data/mockTelemetry';

const firstResult = (page: Page) => page.locator('.verification-first-result');
const ledger = (page: Page) => page.getByRole('region', { name: 'Chronological evidence ledger' });
async function seek(page: Page, index: number) {
  const slider = page.getByRole('slider', { name: 'Replay cycle', exact: true });
  await slider.focus();
  await slider.press('Home');
  for (let step = 0; step < index; step++) await slider.press('ArrowRight');
}

test('overview retains the interactive twin and routes to a distinct investigation workspace', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('.train-scene')).toHaveAttribute('data-ready', 'true');
  await expect(page.getByRole('button', { name: 'Test this prediction' })).toBeInViewport();
  await expect(page.getByRole('slider', { name: 'Replay cycle' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Select door D08', exact: true }).click();
  await expect(page.locator('.door-chip')).toHaveText('D08');
  await expect(page.getByText('No prediction issued for this door', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Door analysis', exact: true }).click();
  await expect(page.getByLabel('Selected door')).toHaveValue('D08');
  await expect(page.getByRole('heading', { name: 'Cycle history', exact: true })).toBeVisible();
  await expect(page.locator('.da-history-row')).toHaveCount(9);
  await expect(page.locator('.witness-panel')).toHaveCount(0);
  await expect(page.getByRole('slider', { name: 'Replay cycle' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('history inspection and peer comparisons do not change the evidence cutoff', async ({ page }) => {
  await page.goto('/#analysis');
  await page.getByRole('button', { name: /^Inspect H001,/ }).click();
  await expect(page.locator('.da-inspection-divider')).toContainText('Selected H001');
  await expect(page.locator('.da-inspection-divider')).toContainText('Session remains at C005');
  await page.getByRole('combobox', { name: 'Overlay', exact: true }).selectOption('peer:D08');
  await expect(page.locator('.signal-chart__legend')).toContainText('D08 · H001 closing');
  await expect(page.locator('.da-comparison-note')).toContainText('Operating load and environment are not recorded');
  const chart = page.locator('.signal-chart__interaction');
  await chart.focus(); await chart.press('Home'); await chart.press('ArrowRight');
  await expect(chart).toHaveAttribute('aria-valuetext', /2% travel/);
  await page.getByRole('button', { name: /^Inspect C005,/ }).click();
  await expect(page.locator('.da-criteria-list')).toContainText('11');
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await expect(page.locator('.overview-cutoff')).toContainText('C005');
});

test('ledger withholds future evidence, excludes opening, preserves first result and retracts on rewind', async ({ page }) => {
  await page.goto('/#verification');
  await expect(firstResult(page)).toContainText('Awaiting evidence');
  await expect(ledger(page)).not.toContainText('C007');
  await page.getByRole('button', { name: 'Step to next cycle' }).click();
  await expect(firstResult(page)).toContainText('Awaiting evidence');
  await expect(ledger(page)).toContainText('does not match the predicted closing direction');
  await page.getByRole('button', { name: 'Reveal next cycle', exact: true }).click();
  await expect(firstResult(page)).toContainText('Corroborated');
  await expect(firstResult(page)).toContainText('C007');
  await expect(ledger(page)).toContainText('4.1 A peak');
  await page.getByRole('button', { name: 'Reveal next cycle', exact: true }).click();
  await expect(firstResult(page)).toContainText('C007');
  await expect(ledger(page)).toContainText('Follow-up 1');
  await seek(page, CANDIDATE_CYCLE_INDEX);
  await expect(firstResult(page)).toContainText('Awaiting evidence');
  await expect(ledger(page)).not.toContainText('C007');
  await expect(ledger(page)).not.toContainText('Signature reproduced');
});

test('missing-data follow-ups recover without rewriting the first insufficient result', async ({ page }) => {
  await page.goto('/#verification');
  await page.getByLabel('SYNTHETIC RECORDING').selectOption('insufficient_evidence');
  await page.getByRole('button', { name: 'Reveal next cycle', exact: true }).click();
  await expect(firstResult(page)).toContainText('Insufficient evidence');
  await page.getByRole('button', { name: 'Door analysis', exact: true }).click();
  await expect(page.locator('.da-trace-panel .da-outcome')).toHaveText('Cannot assess');
  await expect(page.getByText('MISSING SAMPLES', { exact: true })).toBeVisible();
  await expect(page.locator('.da-cycle-stats')).toContainText('—');
  await page.getByRole('button', { name: 'Verification', exact: true }).click();
  await page.getByRole('button', { name: 'Reveal next cycle', exact: true }).click();
  await expect(page.locator('.verification-cutoff')).toContainText('C009');
  await page.getByRole('button', { name: 'Reveal next cycle', exact: true }).click();
  await expect(page.locator('.verification-cutoff')).toContainText('C011');
  await expect(firstResult(page)).toContainText('Insufficient evidence');
  await expect(ledger(page)).toContainText('Corroborated');
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await expect(page.getByText('The signature repeated.', { exact: true })).toBeVisible();
  await expect(page.locator('.witness-assessment-caption')).toContainText('3 assessments');
});

test('an isolated high spike fails persistence and explains why', async ({ page }) => {
  await page.goto('/#verification');
  await page.getByLabel('SYNTHETIC RECORDING').selectOption('isolated_spike');
  await page.getByRole('button', { name: 'Reveal next cycle', exact: true }).click();
  await expect(firstResult(page)).toContainText('Not corroborated');
  await expect(ledger(page)).toContainText('persistence criteria were not met');
  await expect(ledger(page)).not.toContainText('stayed within');
  await page.getByRole('button', { name: 'Door analysis', exact: true }).click();
  await expect(page.locator('.da-trace-panel .da-outcome')).toHaveText('No persistent excess');
  await expect(page.locator('.da-criterion').filter({ hasText: 'Consecutive excess' })).toContainText('1 samples');
  await expect(page.locator('.da-criterion').filter({ hasText: 'Interval persistence' })).toContainText('9%');
});

test('separate fixture validation and future preview never alter active assessment or export cutoff', async ({ page }) => {
  await page.goto('/#verification');
  await page.getByRole('button', { name: 'Run validation suite', exact: true }).click();
  await expect(page.locator('.verification-suite-announcement')).toContainText('6 of 6');
  await expect(firstResult(page)).toContainText('Awaiting evidence');
  await expect(page.getByRole('slider', { name: 'Replay cycle', exact: true })).toHaveValue(String(CANDIDATE_CYCLE_INDEX));
  await expect(ledger(page)).not.toContainText('C007');
  await page.getByRole('checkbox', { name: 'Hide future data' }).uncheck();
  await expect(page.getByRole('region', { name: 'Future preview, not assessed' })).toBeVisible();
  await expect(firstResult(page)).toContainText('Awaiting evidence');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export evidence' }).click();
  const download = await pending;
  const data = JSON.parse(await readFile((await download.path())!, 'utf8'));
  expect(data.observedCycles).toHaveLength(CANDIDATE_CYCLE_INDEX + 1);
  expect(data.prediction.status).toBe('awaiting');
  expect(data.prediction.attempts).toEqual([]);
  expect(data.observedCycles.map((cycle: { id: string }) => cycle.id)).not.toContain('C007');
  await page.getByRole('checkbox', { name: 'Hide future data' }).check();
  await expect(page.getByRole('region', { name: 'Future preview, not assessed' })).toHaveCount(0);
});

test('every door shares the advisory model and current data loss is visible', async ({ page }) => {
  await page.goto('/#verification');
  const cycles = createDemoCycles();
  await seek(page, cycles.findIndex(cycle => cycle.id === 'C017'));
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Review D12 advisory', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review D19 advisory', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Review D12 advisory', exact: true }).click();
  await expect(page.locator('.door-chip')).toHaveText('D12');
  await expect(page.getByText('The signature repeated.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Review D19 advisory', exact: true }).click();
  await expect(page.getByText('The latest movement is incomplete.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Door analysis', exact: true }).click();
  await expect(page.getByLabel('Selected door')).toHaveValue('D19');
  await expect(page.locator('.da-quality-panel')).toContainText('Cannot assess');
});

test('advisory shortcut selects a currently active door after an earlier signature clears', async ({ page }) => {
  await page.goto('/#verification');
  await page.getByLabel('SYNTHETIC RECORDING').selectOption('not_corroborated');
  const cycles = createDemoCycles('not_corroborated');
  await seek(page, cycles.findIndex(cycle => cycle.id === 'C015'));
  await page.getByLabel('Selected door').selectOption('D01');
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await page.getByRole('button', { name: 'Review advisory', exact: true }).click();
  await expect(page.locator('.door-chip')).toHaveText('D12');
  await expect(page.getByText('The signature repeated.', { exact: true })).toBeVisible();
});

test('engineer reviews persist locally and follow the recorded evidence cutoff', async ({ page }) => {
  await page.goto('/#analysis');
  await page.getByRole('button', { name: 'Acknowledge advisory' }).click();
  await page.getByLabel('Investigation note', { exact: true }).fill('Inspect guide alignment during the next scheduled review.');
  await page.getByRole('button', { name: 'Save review', exact: true }).click();
  await page.reload();
  await expect(page.locator('.review-history')).toContainText('Inspect guide alignment');
  await expect(page.getByRole('button', { name: 'Acknowledged', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Verification', exact: true }).click();
  await page.getByRole('button', { name: 'Reveal next cycle', exact: true }).click();
  await expect(firstResult(page)).toContainText('Corroborated');
  await page.getByRole('button', { name: 'Door analysis', exact: true }).click();
  await page.getByLabel('Investigation note', { exact: true }).fill('Follow-up evidence reviewed after C007.');
  await page.getByRole('button', { name: 'Save review', exact: true }).click();
  await page.getByRole('button', { name: 'Verification', exact: true }).click();
  await seek(page, CANDIDATE_CYCLE_INDEX);
  await page.getByRole('button', { name: 'Door analysis', exact: true }).click();
  await expect(page.locator('.review-history')).toContainText('Inspect guide alignment');
  await expect(page.locator('.review-history')).not.toContainText('Follow-up evidence reviewed after C007');
});

test('playback pauses at first detection and first assessment', async ({ page }) => {
  await page.goto('/#replay');
  await page.getByRole('button', { name: 'Restart from first cycle' }).click();
  await expect(page.getByRole('heading', { name: 'No prediction issued for D07' })).toBeVisible();
  await page.getByRole('button', { name: 'Play replay', exact: true }).click();
  await expect(firstResult(page)).toContainText('Awaiting evidence', { timeout: 17_000 });
  await expect(page.getByRole('button', { name: 'Play replay', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Play replay', exact: true }).click();
  await expect(firstResult(page)).toContainText('Corroborated');
  await expect(page.getByRole('button', { name: 'Play replay', exact: true })).toBeVisible();
});

test('leaving verification pauses playback for investigation and browser hash navigation', async ({ page }) => {
  await page.goto('/#verification');
  await page.getByRole('button', { name: 'Restart from first cycle' }).click();
  await page.getByRole('button', { name: 'Play replay', exact: true }).click();
  await page.getByRole('button', { name: 'Door analysis', exact: true }).click();
  await expect(page.locator('.da-session-boundary')).toContainText('H001');
  await page.getByRole('button', { name: 'Verification', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Play replay', exact: true })).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Replay cycle', exact: true })).toHaveValue('0');
  await page.getByRole('button', { name: 'Play replay', exact: true }).click();
  await page.evaluate(() => { location.hash = 'overview'; });
  await expect(page.locator('.overview-cutoff')).toContainText('H001');
  await page.getByRole('button', { name: 'Verification', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Play replay', exact: true })).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Replay cycle', exact: true })).toHaveValue('0');
});

test('all three pages fit mobile and help restores keyboard focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const route of ['overview', 'analysis', 'verification']) {
    await page.goto(`/#${route}`);
    await expect(page.locator('h1')).toBeVisible();
    if (route === 'overview') await expect(page.locator('.train-scene')).toHaveAttribute('data-ready', 'true');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/mobile-${route}.png`, fullPage: true });
  }
  const help = page.getByRole('button', { name: 'About RailWitness' });
  await help.click(); await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape'); await expect(help).toBeFocused();
});

test('WebGL-unavailable browsers retain selectable train schematic', async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...args: unknown[]) {
      if (kind === 'webgl' || kind === 'webgl2' || kind === 'experimental-webgl') return null;
      return original.apply(this, [kind, ...args] as Parameters<typeof original>);
    } as typeof original;
  });
  await page.goto('/');
  await expect(page.getByRole('group', { name: 'Interactive train schematic' })).toBeVisible();
  await page.getByRole('button', { name: /Door D08, car 1/ }).click();
  await expect(page.locator('.door-chip')).toHaveText('D08');
});
