/** Optional real-file parity suite. It never reads test labels or scores test predictions.
 * RAILWITNESS_DATASETS=/path/to/02_Datasets npm test -- tests/inference.integration.test.ts
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acvFeatures, analyseRecording, doorFeatures, railFeatures, shmFeatures } from '../src/lib/inference';
import { parseRecording } from '../src/lib/recordings';
import type { Subsystem } from '../src/types/multisystem';

const datasetRoot = process.env.RAILWITNESS_DATASETS;
const cases: { subsystem: Subsystem; path: string; fileName: string }[] = [
  { subsystem: 'door', path: 'Door/Test.csv', fileName: 'Test.csv' },
  { subsystem: 'rail', path: 'Rail_Corrugation/Test/Test1.csv', fileName: 'Test1.csv' },
  { subsystem: 'shm', path: 'SHM/Test/test01.csv', fileName: 'test01.csv' },
  { subsystem: 'acv', path: 'ACV/Test/acv_test_case.xlsx', fileName: 'acv_test_case.xlsx' },
];

function compareFeatures(actual: number[], expected: number[]) {
  expect(actual.length).toBe(expected.length);
  actual.forEach((value, index) => expect(Math.abs(value - expected[index]) / Math.max(1, Math.abs(expected[index])), `feature ${index}`).toBeLessThan(1e-8));
}

describe.runIf(Boolean(datasetRoot))('actual uploaded files: Python CLI / browser inference parity', () => {
  for (const example of cases) {
    it(`${example.subsystem}: reads full raw input and produces identical trained inference`, async () => {
      const directory = mkdtempSync(join(tmpdir(), 'railwitness-parity-'));
      try {
        const input = join(datasetRoot!, example.path);
        const diagnostics = join(directory, 'features.json');
        execFileSync(process.env.RAILWITNESS_PYTHON ?? resolve('.tools/ml/bin/python'), [resolve('scripts/predict.py'), '--subsystem', example.subsystem, '--input', input, '--output', directory, '--diagnostics', diagnostics], { timeout: 120_000 });
        const expected = JSON.parse(readFileSync(diagnostics, 'utf8'))[example.fileName];
        const bytes = readFileSync(input);
        const contents = example.fileName.endsWith('.xlsx') ? Uint8Array.from(bytes).buffer : bytes.toString('utf8');
        const recording = await parseRecording(example.fileName, contents, example.subsystem);
        const result = await analyseRecording(recording);
        expect(result.source.mode).toBe('uploaded');
        expect(result.model.name.toLowerCase()).not.toContain('synthetic');
        if (result.subsystem === 'door') {
          expect(result.segments.map(({ start_time, end_time, prediction }) => ({ start_time, end_time, prediction }))).toEqual(expected.predictions);
          result.segments.forEach((segment, index) => compareFeatures(doorFeatures(recording.rows.slice(segment.startIndex, segment.endIndex + 1)), expected.features[index]));
        } else if (result.subsystem === 'rail') {
          compareFeatures(railFeatures(recording), expected.features);
          expect(result.prediction).toBe(expected.prediction);
          expect(recording.rows).toHaveLength(10_000);
        } else if (result.subsystem === 'shm') {
          compareFeatures(shmFeatures(recording), expected.features);
          expect(result.predictedDamage).toBeCloseTo(expected.prediction, 10);
          expect(recording.rows.length).toBeGreaterThan(500_000);
        } else if (result.subsystem === 'acv') {
          const vectors = acvFeatures(recording);
          vectors.features.forEach((vector, index) => compareFeatures(vector, expected.features[index]));
          expect(vectors.cars).toEqual(expected.cars);
          expect(result.rankedCars).toEqual(expected.ranking);
        }
      } finally { rmSync(directory, { recursive: true, force: true }); }
    }, 180_000);
  }
});
