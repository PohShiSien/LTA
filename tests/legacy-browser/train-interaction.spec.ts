import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });

test('visible 3D doors update analysis and the opaque shell blocks hidden doors', async ({ page }) => {
  await page.goto('/');
  const scene = page.locator('.train-scene');
  await expect(scene).toHaveAttribute('data-ready', 'true');
  await expect(scene).toHaveAttribute('data-renderer', 'webgl');
  await expect(page.locator('.door-chip')).toHaveText('D07');

  const canvas = await scene.locator('canvas').boundingBox();
  if (!canvas) throw new Error('The interactive train canvas has no bounds.');
  const observedTrace = page.locator('.signal-chart__observed:not(.signal-chart__observed--glow):not(.signal-chart__observed--anomaly)');
  const initialTrace = await observedTrace.getAttribute('d');
  expect(initialTrace).toBeTruthy();

  // These canvas-local points were visually checked at the fixed viewport.
  // The first lies on the near-side shell, with hidden D01 behind it. The
  // second lies inside the visible D06 door. No semantic door-map clicks.
  const shellPoint = { x: canvas.x + canvas.width * .0805, y: canvas.y + canvas.height * .6328 };
  const visibleDoorPoint = { x: canvas.x + canvas.width * .1839, y: canvas.y + canvas.height * .6195 };
  await page.mouse.move(shellPoint.x, shellPoint.y);
  await page.mouse.click(shellPoint.x, shellPoint.y);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator('.door-chip')).toHaveText('D07');
  await expect(page.locator('.train-door-callout__id').filter({ hasText: /^D01$/ })).toHaveCount(0);

  await page.mouse.move(visibleDoorPoint.x, visibleDoorPoint.y);
  await expect(page.locator('.train-door-callout__id').filter({ hasText: /^D06$/ })).toBeVisible();
  await page.mouse.click(visibleDoorPoint.x, visibleDoorPoint.y);
  await expect(page.locator('.door-chip')).toHaveText('D06');
  await expect(page.getByRole('slider', { name: 'D06 waveform cursor', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Select door D06', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(observedTrace).not.toHaveAttribute('d', initialTrace!);
});
