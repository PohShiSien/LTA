import { readFileSync } from 'node:fs';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { fieldValue, parseCsv, parseRecording, railHeaders, sampleTimeLabel } from '../src/lib/recordings';

const fixtureText = (name: string) => readFileSync(new URL(`./fixtures/recordings/${name}`, import.meta.url), 'utf8');
const fixtureBinary = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/recordings/${name}`, import.meta.url))).buffer;
const railExcerpt = parseCsv(fixtureText('rail-first-samples.csv'));
const fullRail = (withHeader = true) => [withHeader ? railExcerpt[0].join(',') : null, ...Array.from({ length: 10000 }, (_, index) => railExcerpt[1 + index % 3].join(','))].filter(row => row !== null).join('\n');

describe('CSV boundary and provenance', () => {
  it('preserves quoted delimiters, quotes, embedded newlines, null positions and UTF-8 BOM', () => {
    expect(parseCsv('\uFEFFname,value,extra\r\n"a,b","x""y",\r\n"line\nbreak",2,3')).toEqual([['name', 'value', 'extra'], ['a,b', 'x"y', ''], ['line\nbreak', '2', '3']]);
    expect(() => parseCsv('a,b\n"unfinished,2')).toThrow('unclosed');
    expect(() => parseCsv('a,b\n"closed"oops,2')).toThrow('Unexpected');
  });

  it('does not merge files with the same filename across subsystem, dataset or contents', async () => {
    const text = fixtureText('shm-stress.csv');
    const a = await parseRecording('Test.csv', text, 'shm', 'dataset-a');
    const b = await parseRecording('Test.csv', text, 'shm', 'dataset-b');
    const c = await parseRecording('Test.csv', `${text}\n2`, 'shm', 'dataset-a');
    const d = await parseRecording('Test.csv', fixtureText('door-controller.csv'), 'door', 'dataset-a');
    const repeated = await parseRecording('Test.csv', text, 'shm', 'dataset-a');
    expect(new Set([a, b, c, d].map(recording => recording.source.fileId)).size).toBe(4);
    expect(repeated.source.fileId).toBe(a.source.fileId);
    expect(a.fields[0].source).toEqual(a.source);
  });
});

describe('actual Door controller schema', () => {
  it('preserves all 17 source columns, native timestamps and explicit conversions without assigning D07', async () => {
    const recording = await parseRecording('Test.csv', fixtureText('door-controller.csv'), 'door');
    expect(recording.fields).toHaveLength(17);
    expect(recording.rows[0][0]).toBe('2023-7-5-0-0-0-0');
    expect(recording.mapping.status).toBe('unmapped');
    expect(recording.carIds).toEqual([]);
    expect(fieldValue(recording, recording.fields[1], recording.rows[0])).toMatchObject({ raw: 121, value: 0.121, validity: 'valid' });
    expect(fieldValue(recording, recording.fields[2], recording.rows[0])).toMatchObject({ raw: 400, value: 4 });
    expect(fieldValue(recording, recording.fields[4], recording.rows[0]).value).toBeCloseTo(2.3);
    expect(recording.fields[3].rawUnit).toBeNull();
    expect(recording.fields[16].rawUnit).toBeNull();
  });

  it('preserves actual identity text without guessing a physical anchor', async () => {
    const recording = await parseRecording('identified.csv', 'Datetime,Car Number,Door Number,Motor current(mA),Door leaf position\n2023-7-5-0-0-0-0,03,02,120,700', 'door');
    expect(recording.rows[0].slice(1, 3)).toEqual(['03', '02']);
    expect(recording.fields[1].kind).toBe('metadata');
    expect(recording.fields.every(field => field.mapping.status === 'unmapped')).toBe(true);
  });

  it('rejects ragged rows and unrelated label tables rather than shifting columns', async () => {
    await expect(parseRecording('Test.csv', 'Datetime,Motor current(mA),Door leaf position\n2023-7-5-0-0-0-0,120,700,extra', 'door')).rejects.toThrow('No channel shifting');
    await expect(parseRecording('labels.csv', 'start_time,end_time,prediction\n1,2,Normal', 'door')).rejects.toThrow('controller headers');
  });
});

describe('actual Rail measurement registry', () => {
  it('retains every recorded sample and maps the exact header endpoints', async () => {
    const recording = await parseRecording('Test36.csv', fullRail(), 'rail');
    expect(recording.rows).toHaveLength(10000);
    expect(recording.headers).toEqual(railHeaders());
    expect(recording.fields).toHaveLength(129);
    expect(recording.rows[0][1]).toBe(-0.25634765625);
    expect(recording.rows[0][128]).toBe(-0.42724609375);
    expect(recording.fields[1].mapping).toMatchObject({ status: 'mapped', anchor: { kind: 'axleBox', carOrdinal: 1, position: 1 } });
    expect(recording.fields[128].mapping).toMatchObject({ status: 'mapped', anchor: { kind: 'axleBox', carOrdinal: 8, position: 8 } });
    expect(recording.fields[0].mapping.status).toBe('unmapped');
    expect(recording.fields[0].rawUnit).toBe('binary pulse');
    expect(recording.fields[42].mapping).toMatchObject({ anchor: { carOrdinal: 3, position: 5 } });
    expect(sampleTimeLabel(recording, recording.rows[1234], 1234)).toBe('0.1234 s elapsed');
  });

  it('handles documented headerless numeric files explicitly without losing the first sample', async () => {
    const recording = await parseRecording('headerless.csv', fullRail(false), 'rail');
    expect(recording.rows).toHaveLength(10000);
    expect(recording.rows[0][1]).toBe(-0.25634765625);
    expect(recording.warnings.some(warning => warning.includes('no header'))).toBe(true);
  });

  it('rejects shifted channel order, extra columns, truncated duration and missing values', async () => {
    const headers = railHeaders();
    [headers[1], headers[2]] = [headers[2], headers[1]];
    await expect(parseRecording('shifted.csv', `${headers.join(',')}\n${railExcerpt[1].join(',')}`, 'rail')).rejects.toThrow('documented order');
    await expect(parseRecording('extra.csv', `${railExcerpt[0].join(',')},extra\n${railExcerpt[1].join(',')},0`, 'rail')).rejects.toThrow('129 columns');
    await expect(parseRecording('short.csv', fixtureText('rail-first-samples.csv'), 'rail')).rejects.toThrow('10,000');
    const missing = fullRail().replace('-0.25634765625', '');
    await expect(parseRecording('missing.csv', missing, 'rail')).rejects.toThrow('missing or nonnumeric');
  });
});

describe('actual ACV OOXML cases', () => {
  it('reads basic source headers and text flags, leading-zero IDs and Excel time without DOM', async () => {
    const recording = await parseRecording('acv_test_case.xlsx', fixtureBinary('acv-basic.xlsx'), 'acv');
    expect(recording.rows).toHaveLength(2);
    expect(recording.fields).toHaveLength(67);
    expect(recording.carIds).toEqual(['01', '02', '03', '04', '05', '06', '07', '08']);
    expect(recording.rows[0][1]).toBe('0620');
    expect(recording.rows[0][2]).toBe(44371);
    expect(recording.rows[0][3]).toBe('Centralized Control');
    expect(sampleTimeLabel(recording, recording.rows[0], 0)).toBe('2021-06-24 00:00:00.000 (source time)');
    expect(recording.fields[3]).toMatchObject({ carId: '08', label: 'ACV Setting Mode', validityFieldKey: 'column-13' });
    expect(recording.fields[4].rawUnit).toBeNull();
    expect(recording.sampleRateHz).toBeCloseTo(1 / 30);
  });

  it('preserves every richer-case column rather than forcing the basic schema', async () => {
    const recording = await parseRecording('acv_case_04.xlsx', fixtureBinary('acv-rich.xlsx'), 'acv');
    expect(recording.fields).toHaveLength(483);
    expect(recording.rows[0]).toHaveLength(483);
    expect(recording.carIds).toHaveLength(8);
    expect(recording.fields.some(field => field.label === 'ACV Grounding Detection Status')).toBe(true);
    expect(recording.fields.some(field => field.label === 'Refrigeration System 2 Low Pressure Value')).toBe(true);
    expect(recording.rows[0][3]).toBe('None');
    expect(recording.rows[0][4]).toBe('Invalid');
    expect(recording.sampleRateHz).toBeCloseTo(1 / 10);
  });

  it('reads worksheet rows across compressed chunk boundaries without losing fields or observations', async () => {
    const files = unzipSync(new Uint8Array(fixtureBinary('acv-basic.xlsx')));
    const xml = strFromU8(files['xl/worksheets/sheet1.xml']);
    const header = xml.match(/<row\b[^>]*>[\s\S]*?<\/row>/)![0];
    let random = 1234567;
    const rows = Array.from({ length: 1600 }, (_, row) => `<row r="${row + 2}">${Array.from({ length: 67 }, (_, column) => {
      let remaining = column + 1, letters = '';
      while (remaining > 0) { letters = String.fromCharCode(65 + (remaining - 1) % 26) + letters; remaining = Math.floor((remaining - 1) / 26); }
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      return `<c r="${letters}${row + 2}" t="n"><v>${random / 1000}</v></c>`;
    }).join('')}</row>`).join('');
    files['xl/worksheets/sheet1.xml'] = strToU8(`<worksheet><sheetData>${header}${rows}</sheetData></worksheet>`);
    const archive = zipSync(files);
    expect(archive.byteLength).toBeGreaterThan(65536);
    const recording = await parseRecording('chunked-case.xlsx', new Uint8Array(archive).buffer, 'acv');
    expect(recording.rows).toHaveLength(1600);
    expect(recording.rows.every(row => row.length === 67)).toBe(true);
    expect(recording.rows[1599][66]).toBe(random / 1000);
  });

  it('keeps undocumented codes, invalid flags and missing telemetry distinct from numeric zero', async () => {
    const headers = ['Time', ...Array.from({ length: 8 }, (_, index) => [`Car ${String(index + 1).padStart(2, '0')} - Custom Mode`, `Car ${String(index + 1).padStart(2, '0')} - ACV Information Valid`]).flat()];
    const recording = await parseRecording('case.csv', `${headers.join(',')}\n2023-01-01,97,Invalid,0,Valid,,Valid,1,Unknown,2,Valid,3,Valid,4,Valid,5,Valid`, 'acv');
    expect(fieldValue(recording, recording.fields[1], recording.rows[0])).toMatchObject({ raw: 97, value: 97, validity: 'invalid' });
    expect(fieldValue(recording, recording.fields[3], recording.rows[0])).toMatchObject({ raw: 0, value: 0, validity: 'valid' });
    expect(fieldValue(recording, recording.fields[5], recording.rows[0])).toMatchObject({ raw: null, value: null, validity: 'not_recorded' });
    expect(fieldValue(recording, recording.fields[7], recording.rows[0]).validity).toBe('unknown');
  });

  it('does not present a nominal sample rate as elapsed time when actual timestamps contain gaps', async () => {
    const headers = ['Time', ...Array.from({ length: 8 }, (_, index) => `Car ${String(index + 1).padStart(2, '0')} - Indoor Average Temperature`)];
    const rows = ['2023-01-01T00:00:00', '2023-01-01T00:00:30', '2023-01-01T00:02:00'].map(time => [time, 21, 22, 23, 24, 25, 26, 27, 28].join(','));
    const recording = await parseRecording('gapped-case.csv', `${headers.join(',')}\n${rows.join('\n')}`, 'acv');
    expect(recording.sampleRateHz).toBeUndefined();
    expect(recording.rows[2][0]).toBe('2023-01-01T00:02:00');
    expect(recording.warnings.some(warning => warning.includes('not uniformly spaced'))).toBe(true);
  });
});

describe('actual SHM scalar stress schema', () => {
  it('retains the first headerless observation and never maps random filenames to train geometry', async () => {
    const recording = await parseRecording('test09.csv', fixtureText('shm-stress.csv'), 'shm');
    expect(recording.rows[0]).toEqual([-1.1347008]);
    expect(recording.rows).toHaveLength(4);
    expect(recording.fields).toHaveLength(1);
    expect(recording.fields[0].rawUnit).toBeNull();
    expect(recording.sampleRateHz).toBeUndefined();
    expect(recording.mapping).toMatchObject({ status: 'unmapped' });
    expect(recording.carIds).toEqual([]);
    expect(sampleTimeLabel(recording, recording.rows[0], 0)).toContain('acquisition time not supplied');
  });
});
