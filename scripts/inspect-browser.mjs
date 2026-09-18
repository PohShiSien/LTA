import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
const baseUrl = process.env.RAILWITNESS_URL || 'http://127.0.0.1:5173';
const captureDir = process.env.RAILWITNESS_CAPTURE_DIR || '/private/tmp/railwitness-v3';
await mkdir(captureDir, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.goto(baseUrl);
await page.getByRole('button', { name: 'Synthetic demo', exact: true }).click();
for (const [route, label] of [['rail', 'Rail corrugation'], ['acv', 'ACV'], ['door', 'Doors'], ['shm', 'Structural health']]) {
  await page.getByRole('navigation', { name: 'Subsystems' }).getByRole('button', { name: label, exact: true }).click();
  await page.getByRole('button', { name: 'Run analysis', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Run again', exact: true })).toBeEnabled();
  await expect(page.locator('.ms-time-control')).not.toContainText('Reading selected sample');
  await page.getByRole('button', { name: 'Fit train', exact: true }).click();
  await page.screenshot({ path: `${captureDir}/${route}.png`, fullPage: true });
}
for (const [route, label] of [['rail', 'Rail corrugation'], ['acv', 'ACV'], ['door', 'Doors'], ['shm', 'Structural health']]) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('navigation', { name: 'Subsystems' }).getByRole('button', { name: label, exact: true }).click();
  await expect(page.locator('.ms-time-control')).not.toContainText('Reading selected sample');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `${captureDir}/mobile-${route}.png`, fullPage: true });
}
console.log(JSON.stringify({ title: await page.title(), desktopAndMobileLayers: 4, errors, captureDir }));
await browser.close();
if (errors.length) throw new Error(errors.join('\n'));
