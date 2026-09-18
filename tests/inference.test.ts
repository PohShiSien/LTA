import { describe, expect, it } from 'vitest';
import featureParity from './fixtures/feature-parity.json';
import modelParity from './fixtures/model-parity.json';
import { acvFeatures, analyseRecording, evaluatePortableModel, getTrainedModel, railFeatures, shmFeatures } from '../src/lib/inference';
import type { CellValue, Recording, Subsystem } from '../src/types/multisystem';

function recording(subsystem: Subsystem, rows: CellValue[][], headers: string[], fileName = 'uploaded.csv'): Recording {
  return { source: { datasetId: `ps3-${subsystem}`, subsystem, fileId: fileName, fileName, mode: 'uploaded' }, rows, headers, fields: [], carIds: [], warnings: [], mapping: { status: 'unmapped', reason: 'No verified physical location' }, timeColumnIndex: subsystem === 'door' ? 0 : undefined };
}

function expectFeatures(actual: number[], expected: number[]) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, index) => expect(Math.abs(value - expected[index]) / Math.max(1, Math.abs(expected[index])), `feature ${index}`).toBeLessThan(1e-9));
}

describe('Python training / browser feature parity', () => {
  it('uses identical full-resolution rail features and fixed side membership', () => {
    const fixture = featureParity.rail;
    expectFeatures(railFeatures(recording('rail', fixture.rows, Array.from({ length: 129 }, (_, i) => `channel-${i}`))), fixture.features);
  });

  it('uses identical stress and rainflow range moments', () => {
    const fixture = featureParity.shm;
    expectFeatures(shmFeatures(recording('shm', fixture.rows, ['stress'])), fixture.features);
  });

  it('matches ACV temperatures, validity filtering and relative case features', () => {
    const fixture = featureParity.acv;
    const extracted = acvFeatures(recording('acv', fixture.rows, fixture.headers));
    expect(extracted.cars).toEqual(fixture.cars);
    extracted.features.forEach((features, index) => expectFeatures(features, fixture.features[index]));
  });
});

describe('portable fitted artifacts', () => {
  for (const subsystem of ['rail'] as const) {
    it(`reproduces Python's fitted ${subsystem} prediction`, () => {
      const model = getTrainedModel(subsystem);
      const fixture = modelParity[subsystem];
      const scores = evaluatePortableModel(model, fixture.features);
      expect(model.classes![scores.indexOf(Math.max(...scores))]).toBe(fixture.prediction);
    });
  }

  it('preserves full-precision Python SHM regression output', () => {
    const fixture = modelParity.shm;
    expect(evaluatePortableModel(getTrainedModel('shm'), fixture.features)[0]).toBeCloseTo(fixture.prediction, 12);
  });

  it('reproduces the fitted ACV ranking votes without presenting them as probabilities', () => {
    const fixture = modelParity.acv;
    expectFeatures(evaluatePortableModel(getTrainedModel('acv'), fixture.features), fixture.scores);
  });

  it('does not clip damage output to a display range', () => {
    const model = { ...getTrainedModel('shm'), featureCount: 1, coefficients: [0], mean: [0], scale: [1], intercept: Math.log(3.25) };
    expect(evaluatePortableModel(model, [0])[0]).toBeCloseTo(3.25, 12);
  });
});

describe('real-recording inference contract', () => {
  it('requires the frozen Python backend for uploaded Door prediction and cannot use the old browser artifact', async () => {
    const fixture = modelParity.door;
    await expect(analyseRecording(recording('door', fixture.rows, fixture.headers))).rejects.toThrow('frozen Python backend');
    expect(() => getTrainedModel('door')).toThrow('frozen Python backend');
  });

  it('preserves all eight exact car IDs in one case-level ranking with no probability field', async () => {
    const fixture = featureParity.acv;
    const result = await analyseRecording(recording('acv', fixture.rows, fixture.headers, 'actual-case.xlsx'));
    if (result.subsystem !== 'acv') throw new Error('wrong subsystem');
    expect([...result.rankedCars].sort()).toEqual(fixture.cars);
    expect(result.scope).toBe('car-case');
    expect(Object.keys(result.scores ?? {}).sort()).toEqual(fixture.cars);
    const features = acvFeatures(recording('acv', fixture.rows, fixture.headers));
    const model = getTrainedModel('acv');
    const classIndex = model.classes!.indexOf('1');
    features.cars.forEach((car, index) => {
      expect(result.scores?.[car]).toEqual(evaluatePortableModel(model, features.features[index])[classIndex]);
    });
  });

  it('cannot use randomly numbered SHM filenames as predictive features or spatial mapping', async () => {
    const fixture = featureParity.shm;
    const first = await analyseRecording(recording('shm', fixture.rows, ['stress'], 'test03.csv'));
    const second = await analyseRecording(recording('shm', fixture.rows, ['stress'], 'test64.csv'));
    if (first.subsystem !== 'shm' || second.subsystem !== 'shm') throw new Error('wrong subsystem');
    expect(first.predictedDamage).toBe(second.predictedDamage);
    expect(first.mapping.status).toBe('unmapped');
    expect(first.scope).toBe('recording');
  });

  it('rejects missing required observations and unsupported schemas instead of producing a fallback', async () => {
    await expect(analyseRecording(recording('shm', [[1], [null], [2]], ['stress']))).rejects.toThrow('finite');
    await expect(analyseRecording(recording('rail', [[1, 2], [3, 4]], ['a', 'b']))).rejects.toThrow('129-channel');
    await expect(analyseRecording(recording('door', [], modelParity.door.headers))).rejects.toThrow('no recorded samples');
    await expect(analyseRecording(recording('acv', [[1]], ['Car 01 - Unknown field']))).rejects.toThrow('eight');
  });
});
