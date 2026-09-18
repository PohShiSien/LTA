import { describe, expect, it } from 'vitest';
import { acvVisualizationEvidence, railVisualizationEvidence, rainflowCycles, shmVisualizationEvidence } from '../src/lib/visualEvidence';
import { evaluatePortableModel, getTrainedModel, rainflowMoments, shmFeatures } from '../src/lib/inference';
import { parseRecording } from '../src/lib/recordings';
import type { DisplayField, Recording, SourceRef } from '../src/types/multisystem';

const source = (subsystem: 'acv' | 'rail' | 'shm'): SourceRef => ({ mode: 'uploaded', subsystem, datasetId: 'test', fileId: 'evidence', fileName: 'evidence.csv' });
const base = (subsystem: 'acv' | 'rail' | 'shm'): Recording => ({ source: source(subsystem), headers: [], rows: [], fields: [], carIds: [], warnings: [], mapping: { status: 'unmapped', reason: 'No location supplied.' } });

describe('ACV full-case evidence', () => {
  it('keeps exact car IDs and excludes invalid/unknown rows and missing pairs', async () => {
    const carIds = ['03', '01', '05', '02', '04', '06', '07', '08'];
    const headers = ['Time', ...carIds.flatMap(id => [`Car ${id} - Indoor Average Temperature`, `Car ${id} - Target Temperature Value`, `Car ${id} - ACV Running Mode`, `Car ${id} - ACV Information Valid`])];
    const rows = Array.from({ length: 4 }, (_, index) => [`2026-09-18T00:0${index}:00`, ...carIds.flatMap(id => id === '03'
      ? index === 0 ? [30, 20, 'Cooling', 'Valid'] : index === 1 ? [999, 20, 'Cooling', 'Invalid'] : index === 2 ? [28, 20, 'Cooling', 'Valid'] : [26, 20, 'Cooling', 'Valid']
      : id === '05' ? [25, 20, 'Cooling', index === 0 ? 'Unknown' : 'Valid']
      : id === '08' ? [null, 20, 2, 'Valid'] : [22, 20, 'Cooling', 'Valid'])]);
    const recording = await parseRecording('case.csv', [headers, ...rows].map(row => row.join(',')).join('\n'), 'acv', 'uploaded', 'test');
    const evidence = acvVisualizationEvidence(recording);
    expect(evidence.cars.map(car => car.carId)).toEqual(['01', '02', '03', '04', '05', '06', '07', '08']);
    const car = evidence.cars.find(item => item.carId === '03')!;
    expect(car.indoorMean).toBe(28);
    expect(car.residualMean).toBe(8);
    expect(car.validCoverage).toBe(.75);
    expect(car.invalidRows).toBe(1);
    expect(car.coolingPairs).toBe(1);
    expect(car.coolingResponse).toBe(-2);
    expect(car.coolingResponseUnit).toBe('source units / min');
    expect(evidence.cars.find(item => item.carId === '05')!.unknownValidityRows).toBe(1);
    expect(evidence.cars.find(item => item.carId === '08')).toMatchObject({ residualMean: null, validCoverage: 0, coolingResidual: null });
  });
  it('does not guess an unsupported target header or interpret a numeric cooling-mode code', async () => {
    const headers = ['Time', ...Array.from({ length: 8 }, (_, index) => [`Car ${String(index + 1).padStart(2, '0')} - Indoor Average Temperature`, `Car ${String(index + 1).padStart(2, '0')} - Mystery Target`, `Car ${String(index + 1).padStart(2, '0')} - ACV Running Mode`]).flat()];
    const recording = await parseRecording('case.csv', [headers.join(','), ['2026-09-18T00:00:00', ...Array.from({ length: 8 }, () => [25, 20, 2]).flat()].join(',')].join('\n'), 'acv', 'uploaded', 'test');
    const evidence = acvVisualizationEvidence(recording);
    expect(evidence.cars.every(car => car.residualMean === null && car.coolingResponse === null)).toBe(true);
    expect(evidence.cars[0].warnings).toContain('No supported target/control-temperature header.');
  });
});

describe('Rail side evidence', () => {
  function railRecording(): Recording {
    const recording = base('rail');
    recording.sampleRateHz = 1024;
    recording.fields = Array.from({ length: 8 }, (_, index): DisplayField => {
      const position = Math.floor(index / 2) + 1;
      const vibration = index % 2 === 0;
      return { source: recording.source, fieldKey: `column-${index + 1}`, columnIndex: index + 1, originalHeader: `channel-${index + 1}`, label: `${vibration ? 'Vibration' : 'Shock'} · Position ${position}`, kind: 'recorded', scope: 'sample', rawUnit: 'm/s²', displayUnit: 'm/s²', mapping: { status: 'mapped', basis: 'dataset-schema', provenance: 'Test schema', anchor: { kind: 'axleBox', carOrdinal: 1, position } } };
    });
    recording.rows = Array.from({ length: 1024 }, (_, sample) => [sample % 2, ...Array.from({ length: 8 }, (_, index) => {
      const sideI = Math.floor(index / 2) % 2 === 0;
      return index % 2 === 0 ? (sideI ? 2 : 1) * Math.sin(2 * Math.PI * 128 * sample / 1024) : sideI ? 3 : 5;
    })]);
    return recording;
  }
  it('aggregates documented odd/even groups and identifies actual spectral peaks', () => {
    const result = railVisualizationEvidence(railRecording());
    const [sideI, sideII] = result.sides;
    expect(sideI.positions).toEqual([1, 3, 5, 7]);
    expect(sideII.positions).toEqual([2, 4, 6, 8]);
    expect(sideI.vibrationChannels).toBe(2);
    expect(sideI.vibrationRms).toBeCloseTo(Math.sqrt(2));
    expect(sideII.vibrationRms).toBeCloseTo(1 / Math.sqrt(2));
    expect(sideI.shockPeak).toBe(3);
    expect(sideII.shockRms).toBe(5);
    expect(sideI.peaks[0].frequency).toBe(128);
    expect(sideI.peaks[0].amplitude).toBeCloseTo(2, 3);
    expect(sideI.bands.reduce((sum, band) => sum + band.fraction, 0)).toBeCloseTo(1);
    expect(result.pulseTransitions).toBe(512);
    expect(result.pulseRateHz).toBeCloseTo(512 * 1024 / 1023);
  });
  it('does not invent speed or spectra without sampling metadata', () => {
    const recording = railRecording(); delete recording.sampleRateHz;
    recording.rows[0][0] = 99;
    const result = railVisualizationEvidence(recording);
    expect(result.pulseRateHz).toBeNull();
    expect(result.pulseTransitions).toBeNull();
    expect(result.sides.every(side => side.peaks.length === 0 && side.bands.length === 0)).toBe(true);
  });
});

describe('SHM derivation transparency', () => {
  it.each([[0, 5, 0, 3, -2, 4, 0], [1, 1, 1], [0, 10, -10, 10, -10, 0]])('rainflow distribution reproduces the existing feature moments for %j', (...values) => {
    const cycles = rainflowCycles(values);
    const moments = Array.from({ length: 5 }, (_, index) => cycles.reduce((sum, cycle) => sum + cycle.count * cycle.range ** (index + 1), 0));
    expect(moments).toEqual(rainflowMoments(values));
  });
  it('attributes only log(D), and contributions plus intercept reconstruct the unchanged regression output', () => {
    const recording = base('shm'); recording.headers = ['Stress'];
    recording.rows = Array.from({ length: 1000 }, (_, index) => [10 * Math.sin(index / 7) + 2 * Math.cos(index / 3)]);
    const evidence = shmVisualizationEvidence(recording);
    const actual = evaluatePortableModel(getTrainedModel('shm'), shmFeatures(recording))[0];
    const reconstructed = Math.exp(evidence.logDamageIntercept! + evidence.logDamageContributions.reduce((sum, item) => sum + item.contribution, 0));
    expect(reconstructed / actual).toBeCloseTo(1, 12);
    expect(evidence.rainflowBins.reduce((sum, bin) => sum + bin.count, 0)).toBe(evidence.equivalentCycles);
    expect(evidence.logDamageContributions.map(item => item.label)).toEqual(['Stress summary', 'Higher stress moments', 'Rainflow range moments']);
  });
  it('does not attribute scripted demo output to the fitted regression model', () => {
    const recording = base('shm'); recording.source.mode = 'demo'; recording.headers = ['Stress']; recording.rows = [[0], [5], [-5], [0]];
    const evidence = shmVisualizationEvidence(recording);
    expect(evidence.logDamageContributions).toEqual([]);
    expect(evidence.logDamageIntercept).toBeNull();
    expect(evidence.equivalentCycles).toBeGreaterThan(0);
  });
});
