import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { predictionCsv, predictionsZip } from '../src/lib/exportPredictions';
import type { AnalysisResult, SourceMode, Subsystem } from '../src/types/multisystem';

function result(subsystem: Subsystem, mode: SourceMode = 'uploaded'): AnalysisResult {
  const shared = { source: { datasetId: `ps3-${subsystem}`, subsystem, fileId: `${subsystem}-test`, fileName: 'Test.csv', mode }, model: { version: 'test-v1', name: 'Test fixture', description: 'Export fixture', training: 'Test only', validation: 'Test only' }, analysedAt: '2026-09-18T00:00:00Z', notes: [] };
  if (subsystem === 'door') return { ...shared, subsystem, scope: 'cycle', segments: [{ start_time: '2023-7-5-0-0-0-0', end_time: '2023-7-5-0-0-3-760', prediction: 'Abnormal resistance', startIndex: 0, endIndex: 188 }] };
  if (subsystem === 'acv') return { ...shared, subsystem, scope: 'car-case', rankedCars: ['03', '01', '05', '02', '04', '06', '07', '08'] };
  if (subsystem === 'rail') return { ...shared, subsystem, scope: 'recording', prediction: 'Side I' };
  return { ...shared, subsystem, scope: 'recording', predictedDamage: 1.2345678901234567e-9, mapping: { status: 'unmapped', reason: 'No sensor mapping' } };
}

describe('scored CSV and ZIP outputs', () => {
  it('uses exact subsystem columns and preserves two-digit ranking and numeric precision', () => {
    expect(predictionCsv([result('door')], 'door')).toBe('start_time,end_time,prediction\r\n2023-7-5-0-0-0-0,2023-7-5-0-0-3-760,Abnormal resistance\r\n');
    expect(predictionCsv([result('acv')], 'acv')).toBe('file_id,ranked_cars\r\nTest.csv,03|01|05|02|04|06|07|08\r\n');
    expect(predictionCsv([result('rail')], 'rail')).toBe('file_id,prediction\r\nTest.csv,Side I\r\n');
    expect(predictionCsv([result('shm')], 'shm')).toContain('1.2345678901234566e-9');
  });

  it('places only analysed CSVs at ZIP top level and safely quotes filenames', () => {
    const rail = result('rail');
    rail.source.fileName = 'Test,"one".csv';
    const files = unzipSync(predictionsZip([rail, result('shm')]));
    expect(Object.keys(files).sort()).toEqual(['rail_predictions.csv', 'shm_predictions.csv']);
    expect(strFromU8(files['rail_predictions.csv'])).toContain('"Test,""one"".csv",Side I');
    expect(Object.keys(files).some(name => name.includes('/'))).toBe(false);
  });

  it('refuses unanalysed inputs, mixed source modes, duplicate IDs and ambiguous multiple Door streams', () => {
    expect(() => predictionsZip([])).toThrow('Run analysis');
    expect(() => predictionsZip([result('rail'), result('shm', 'demo')])).toThrow('cannot share');
    expect(() => predictionCsv([result('rail'), result('rail')], 'rail')).toThrow('Duplicate');
    const door2 = result('door'); door2.source.fileName = 'Train.csv';
    expect(() => predictionCsv([result('door'), door2], 'door')).toThrow('one analysed continuous');
    const malformed = result('shm'); malformed.analysedAt = '';
    expect(() => predictionsZip([malformed])).toThrow('Only analysed');
  });

  it('does not convert SHM damage into a clipped score or add unsupported rail classes', () => {
    const shm = result('shm'); if (shm.subsystem === 'shm') shm.predictedDamage = 1.42;
    expect(predictionCsv([shm], 'shm')).toContain('1.42');
    const rail = result('rail'); if (rail.subsystem === 'rail') Object.assign(rail, { prediction: 'Both sides' });
    expect(() => predictionCsv([rail], 'rail')).toThrow('three specified');
  });
});
