import type { CellValue, DisplayField, Recording } from '../types/multisystem';

export interface TracePoint { index: number; value: number | null }
export interface SignalStatistics { count: number; missing: number; rms: number | null; peak: number | null; mean: number | null; acRms?: number | null; acPeak?: number | null; minimum?: number | null; maximum?: number | null; startIndex: number; endIndex: number }
export interface SpectrumPoint { frequency: number; amplitude: number }
export interface SignalInspection {
  fieldKey: string;
  points: TracePoint[];
  statistics: SignalStatistics;
  spectrum?: { points: SpectrumPoint[]; startIndex: number; endIndex: number; resolutionHz: number; window: string };
}
export function numericValue(value: CellValue | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}
/** Ordered min/max buckets keep impulses visible. Inference always uses original rows. */
export function summarizeSignal(rows: Recording['rows'], field: DisplayField, maxPoints = 900, validityColumnIndex?: number): SignalInspection {
  const points: TracePoint[] = [];
  const scale = field.displayScale ?? 1;
  const bucketSize = Math.max(1, Math.ceil(rows.length / Math.max(1, Math.floor(maxPoints / 4))));
  let count = 0, mean = 0, centeredSquares = 0, sumSquares = 0, peak = 0;
  let minimumValue = Infinity, maximumValue = -Infinity;
  for (let start = 0; start < rows.length; start += bucketSize) {
    const end = Math.min(rows.length, start + bucketSize);
    let minimum: TracePoint | undefined, maximum: TracePoint | undefined, missing: TracePoint | undefined;
    for (let index = start; index < end; index++) {
      const invalid = validityColumnIndex !== undefined && /^invalid$/i.test(String(rows[index][validityColumnIndex]));
      const raw = invalid ? null : numericValue(rows[index][field.columnIndex]);
      const value = raw === null ? null : raw * scale;
      if (value === null || !Number.isFinite(value)) { missing ??= { index, value: null }; continue; }
      const point = { index, value };
      count++;
      const delta = value - mean;
      mean += delta / count;
      centeredSquares += delta * (value - mean);
      sumSquares += value * value; peak = Math.max(peak, Math.abs(value));
      minimumValue = Math.min(minimumValue, value); maximumValue = Math.max(maximumValue, value);
      if (!minimum || value < minimum.value!) minimum = point;
      if (!maximum || value > maximum.value!) maximum = point;
      if (bucketSize === 1) points.push(point);
    }
    if (bucketSize === 1) { if (missing) points.push(missing); }
    else {
      const candidates = [minimum, maximum, missing].filter((point): point is TracePoint => Boolean(point));
      for (const index of [start === 0 ? 0 : -1, end === rows.length ? end - 1 : -1]) if (index >= 0) {
        const invalid = validityColumnIndex !== undefined && /^invalid$/i.test(String(rows[index][validityColumnIndex]));
        const raw = invalid ? null : numericValue(rows[index][field.columnIndex]);
        const value = raw === null ? null : raw * scale;
        candidates.push({ index, value: value !== null && Number.isFinite(value) ? value : null });
      }
      points.push(...[...new Map(candidates.map(point => [point.index, point])).values()].sort((a, b) => a.index - b.index));
    }
  }
  return { fieldKey: field.fieldKey, points, statistics: { count, missing: rows.length - count, rms: count ? Math.sqrt(sumSquares / count) : null, peak: count ? peak : null, mean: count ? mean : null, acRms: count ? Math.sqrt(Math.max(0, centeredSquares / count)) : null, acPeak: count ? Math.max(maximumValue - mean, mean - minimumValue) : null, minimum: count ? minimumValue : null, maximum: count ? maximumValue : null, startIndex: 0, endIndex: Math.max(0, rows.length - 1) } };
}

/** Single-sided, coherent-gain corrected Hann-window amplitude spectrum. */
export function amplitudeSpectrum(values: readonly number[], sampleRateHz: number): SpectrumPoint[] {
  const n = values.length;
  if (n < 4 || (n & (n - 1)) !== 0 || !Number.isFinite(sampleRateHz) || sampleRateHz <= 0 || values.some(value => !Number.isFinite(value))) return [];
  const real = new Float64Array(n), imaginary = new Float64Array(n);
  const mean = values.reduce((sum, value) => sum + value, 0) / n;
  let weight = 0;
  for (let i = 0; i < n; i++) { const window = .5 * (1 - Math.cos(2 * Math.PI * i / (n - 1))); weight += window; real[i] = (values[i] - mean) * window; }
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
    if (i < j) [real[i], real[j]] = [real[j], real[i]];
  }
  for (let size = 2; size <= n; size <<= 1) {
    const angle = -2 * Math.PI / size;
    for (let start = 0; start < n; start += size) for (let k = 0; k < size / 2; k++) {
      const cosine = Math.cos(angle * k), sine = Math.sin(angle * k);
      const even = start + k, odd = even + size / 2;
      const x = cosine * real[odd] - sine * imaginary[odd], y = sine * real[odd] + cosine * imaginary[odd];
      real[odd] = real[even] - x; imaginary[odd] = imaginary[even] - y; real[even] += x; imaginary[even] += y;
    }
  }
  return Array.from({ length: n / 2 + 1 }, (_, bin) => ({ frequency: bin * sampleRateHz / n, amplitude: Math.hypot(real[bin], imaginary[bin]) / weight * (bin === 0 || bin === n / 2 ? 1 : 2) }));
}
export function inspectSpectrum(recording: Recording, field: DisplayField, cursor: number): SignalInspection['spectrum'] {
  if (recording.source.subsystem !== 'rail' || !recording.sampleRateHz || field.columnIndex === 0) return undefined;
  const size = Math.min(1024, 2 ** Math.floor(Math.log2(recording.rows.length)));
  const start = Math.max(0, Math.min(recording.rows.length - size, cursor - size / 2));
  const values = recording.rows.slice(start, start + size).map(row => numericValue(row[field.columnIndex]));
  if (values.some(value => value === null)) return undefined;
  return { points: amplitudeSpectrum(values.map(value => value! * (field.displayScale ?? 1)), recording.sampleRateHz), startIndex: start, endIndex: start + size - 1, resolutionHz: recording.sampleRateHz / size, window: 'Hann; mean removed; amplitude corrected' };
}
