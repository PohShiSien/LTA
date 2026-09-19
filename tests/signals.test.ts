import { describe, expect, it } from 'vitest';
import { amplitudeSpectrum, summarizeSignal } from '../src/lib/signals';
import type { DisplayField, Recording } from '../src/types/multisystem';

describe('recording evidence summaries', () => {
  const field = { fieldKey: 'x', columnIndex: 0 } as DisplayField;
  it('preserves a narrow impulse and missing data without changing full-sample statistics', () => {
    const rows: Recording['rows'] = Array.from({ length: 10000 }, () => [1]);
    rows[4137] = [100]; rows[4140] = [null];
    const result = summarizeSignal(rows, field, 300);
    expect(result.points.length).toBeLessThan(305);
    expect(result.points).toContainEqual({ index: 4137, value: 100 });
    expect(result.points.some(point => point.value === null)).toBe(true);
    expect(result.statistics).toMatchObject({ count: 9999, missing: 1, peak: 100, startIndex: 0, endIndex: 9999 });
    expect(result.statistics.rms).toBeCloseTo(Math.sqrt((9998 + 10000) / 9999));
  });
  it('retains actual units when explicit display conversion is applied', () => {
    const result = summarizeSignal([[1000], [2000]], { ...field, displayScale: .001 });
    expect(result.points).toEqual([{ index: 0, value: 1 }, { index: 1, value: 2 }]);
    expect(result.statistics.rms).toBeCloseTo(Math.sqrt(2.5));
  });
  it('keeps invalid ACV measurements out of the plotted trace and derived statistics', () => {
    const result = summarizeSignal([[2, 'Valid'], [99, 'Invalid'], [4, 'Valid']], field, 300, 1);
    expect(result.points).toEqual([{ index: 0, value: 2 }, { index: 1, value: null }, { index: 2, value: 4 }]);
    expect(result.statistics).toMatchObject({ count: 2, missing: 1, peak: 4, mean: 3 });
    expect(result.statistics.rms).toBeCloseTo(Math.sqrt(10));
  });
  it('removes DC for vibration metrics using every valid converted sample', () => {
    const rows: Recording['rows'] = [[1001, 'Valid'], [1002, 'Valid'], [1003, 'Valid'], [9999, 'Invalid'], [null], ['bad'], [Infinity]];
    const result = summarizeSignal(rows, { ...field, displayScale: 2 }, 4, 1);
    expect(result.statistics).toMatchObject({ count: 3, missing: 4, mean: 2004, peak: 2006, acPeak: 2, minimum: 2002, maximum: 2006 });
    expect(result.statistics.acRms).toBeCloseTo(Math.sqrt(8 / 3));
    expect(result.statistics.rms).toBeCloseTo(Math.sqrt((2002 ** 2 + 2004 ** 2 + 2006 ** 2) / 3));
    expect(summarizeSignal([[1e12 + 1], [1e12 + 2], [1e12 + 3]], field).statistics.acRms).toBeCloseTo(Math.sqrt(2 / 3));
    expect(summarizeSignal([[5], [5]], field).statistics).toMatchObject({ acRms: 0, acPeak: 0, minimum: 5, maximum: 5 });
    const empty = summarizeSignal([[null], [NaN], [1e308]], { ...field, displayScale: 10 });
    expect(empty.statistics).toMatchObject({ count: 0, missing: 3, mean: null, rms: null, peak: null, acRms: null, acPeak: null, minimum: null, maximum: null });
    expect(empty.points.every(point => point.value === null)).toBe(true);
  });
  it('locates a known sine frequency and amplitude while removing DC offset', () => {
    const values = Array.from({ length: 1024 }, (_, index) => 5 + 3 * Math.sin(2 * Math.PI * 128 * index / 1024));
    const spectrum = amplitudeSpectrum(values, 1024);
    const peak = spectrum.reduce((maximum, point) => point.amplitude > maximum.amplitude ? point : maximum);
    expect(peak.frequency).toBe(128);
    expect(peak.amplitude).toBeCloseTo(3, 2);
    expect(spectrum[0].amplitude).toBeLessThan(.001);
    expect(amplitudeSpectrum([1, Number.NaN, 2, 3], 10)).toEqual([]);
  });
});
