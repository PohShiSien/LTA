import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ReferenceTrainScene, type ReferenceTrainSceneProps } from '../src/components/train/ReferenceTrainScene';
import type { SourceRef, Subsystem } from '../src/types/multisystem';

const ids = ['03', '07', '01', '08', '04', '06', '02', '05'];
const source = (subsystem: Subsystem): SourceRef => ({ subsystem, datasetId: `ps3-${subsystem}`, fileId: 'one-recording', fileName: 'Test.csv' });

function render(subsystem: Subsystem, overrides: Partial<ReferenceTrainSceneProps> = {}) {
  // Node has no document/WebGL: exercise the actual accessible scene fallback.
  return renderToStaticMarkup(createElement(ReferenceTrainScene, {
    subsystem, carIds: subsystem === 'acv' ? ids : [],
    selection: { kind: 'recording' }, onSelect: () => {}, source: source(subsystem),
    xray: false, reducedMotion: true, fitKey: 0, ...overrides,
  }));
}

function buttons(html: string) {
  return [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(match => ({ attributes: match[1], content: match[2] }));
}

describe('rendered subsystem train schematic', () => {
  it('preserves the 64 recorded sensor addresses and both neutral rail-side controls', () => {
    const html = render('rail', { selection: { kind: 'railSide', side: 'Side II' } });
    expect(html).toContain('data-renderer="schematic"');
    expect(html).toContain('data-rail-class="uncomputed"');
    expect(html).toContain('Rail model · Not analysed');
    const sideButtons = buttons(html).filter(button => button.attributes.includes('aria-label="Select reference rail'));
    expect(sideButtons).toHaveLength(4);
    for (const button of sideButtons) {
      expect(button.attributes.includes('aria-pressed="true"')).toBe(button.attributes.includes('aria-label="Select reference rail Side II"'));
    }
    const sensors = [...html.matchAll(/<i title="Car ([^"]+) · P(\d) · (Side I|Side II)"><\/i>/g)];
    expect(sensors).toHaveLength(64);
    for (const sensor of sensors) expect(sensor[3]).toBe(Number(sensor[2]) % 2 === 1 ? 'Side I' : 'Side II');
    expect(html).not.toMatch(/is-predicted|is-side-member|corrugation signature|bearing fault/i);
  });

  it.each(['Side I', 'Side II'] as const)('highlights only the predicted reference rail for %s, independently of channel selection', prediction => {
    const selectedSide = prediction === 'Side I' ? 'Side II' : 'Side I';
    const html = render('rail', { selection: { kind: 'railSide', side: selectedSide }, visualization: { rail: { prediction } } });
    expect(html).toContain(`data-rail-class="${prediction}"`);
    expect(html).toContain(`Recording model result · ${prediction}`);
    expect(html).toContain('Recording-level result · no individual car or axle-box localisation');
    const sideButtons = buttons(html).filter(button => button.attributes.includes('aria-label="Select reference rail'));
    expect(sideButtons).toHaveLength(4);
    for (const button of sideButtons) {
      const predicted = button.attributes.includes(`aria-label="Select reference rail ${prediction}"`);
      expect(button.attributes.includes('is-predicted')).toBe(predicted);
      expect(button.content.includes('Model result')).toBe(predicted);
      expect(button.attributes.includes('aria-pressed="true"')).toBe(!predicted);
    }
    expect(buttons(html).filter(button => button.attributes.includes('reference-fallback__car')).every(button => !button.attributes.includes('is-predicted'))).toBe(true);
    expect(html.match(/<i title="Car /g)).toHaveLength(64);
  });

  it('keeps a Normal model result distinct from an unanalysed recording without marking cars healthy', () => {
    const normal = render('rail', { visualization: { rail: { prediction: 'Normal' } } });
    expect(normal).toContain('data-rail-class="Normal"');
    expect(normal).toContain('Recording model result · Normal');
    expect(normal).not.toMatch(/is-predicted|is-amber|healthy/);
    const cleared = render('rail', { visualization: undefined });
    expect(cleared).toContain('data-rail-class="uncomputed"');
    expect(cleared).toContain('Not analysed');
    expect(cleared).not.toContain('Recording model result');
  });

  it('shows the selected axle-box source fields and recorded values without a prediction', () => {
    const html = render('rail', {
      selection: { kind: 'axleBox', carOrdinal: 2, position: 3 },
      cursorLabel: '0.025 s', sensorReadout: { vibration: 1.25, shock: 2.5 },
    });
    expect(html).toContain('data-selected-car="2"');
    expect(html).toContain('Car 2 · Axle box 3');
    expect(html).toContain('1.25 m/s²');
    expect(html).toContain('2.5 m/s²');
    expect(html).toContain('0.025 s');
    expect(html).toContain('<dt>Source columns</dt><dd>22, 23</dd>');
    expect(html).not.toContain('Predicted:');
  });

  it('preserves all eight exact car identities and source-car selection without inferred ranks', () => {
    const html = render('acv', { selection: { kind: 'car', carId: '03', ordinal: 3 } });
    const cars = buttons(html).filter(button => button.attributes.includes('reference-fallback__car'));
    expect(cars).toHaveLength(8);
    expect(cars.map(car => /aria-label="Focus car ([^"]+)"/.exec(car.attributes)![1])).toEqual(['01', '02', '03', '04', '05', '06', '07', '08']);
    expect(cars.find(car => car.attributes.includes('aria-label="Focus car 03"'))!.attributes).toContain('aria-pressed="true"');
    expect(html).toContain('ACV model · Not analysed');
    expect(html).not.toMatch(/data-acv-rank|is-ranked|leak-likelihood|leaking car/);
    expect(html).not.toContain('reference-passenger-face');
  });

  it.each([ids, [...ids].reverse()])('shows returned ACV ranks without rearranging source identities (%s)', (...rankedCars) => {
    const html = render('acv', {
      selection: { kind: 'car', carId: '03', ordinal: 1 },
      visualization: { acv: { rankedCars } },
    });
    const cars = buttons(html).filter(button => button.attributes.includes('reference-fallback__car'));
    expect(cars.map(car => /aria-label="Focus car ([^"]+)"/.exec(car.attributes)![1])).toEqual(['01', '02', '03', '04', '05', '06', '07', '08']);
    expect(html).toContain(`data-acv-first-car="${rankedCars[0]}"`);
    expect(html).toContain(`ACV model · Car ${rankedCars[0]} ranked first`);
    expect(html).toContain('ranking does not confirm a leak');
    expect(html).toContain('data-selected-car="3"');
    expect(html).toContain(`reference-passenger-face ${rankedCars.indexOf('03') === 0 ? 'is-alert' : 'is-ok'}`);
    expect(html).toContain(`Ranked #${rankedCars.indexOf('03') + 1} of 8`);
    expect(html).toContain('Relative model ranking: red = rank 1, green = ranks 2–8');
    for (const car of cars) {
      const id = /aria-label="Focus car ([^"]+)"/.exec(car.attributes)![1];
      const rank = rankedCars.indexOf(id) + 1;
      expect(car.attributes).toContain(`data-acv-rank="${rank}"`);
      expect(car.content).toContain(`Rank ${rank}`);
      expect(car.attributes.includes('is-ranked-first')).toBe(rank === 1);
      expect(car.attributes.includes('is-selected')).toBe(id === '03');
      expect(car.attributes.includes('aria-pressed="true"')).toBe(id === '03');
    }
    expect(html).not.toMatch(/healthy|confirmed fault|leaking car|confidence|probability/i);
  });

  it('retains the returned ACV order without suggesting a suspect when thermal data is unusable', () => {
    const html = render('acv', { selection: { kind: 'car', carId: '03', ordinal: 3 }, visualization: { acv: { rankedCars: ids, hasUsableData: false } } });
    const cars = buttons(html).filter(button => button.attributes.includes('reference-fallback__car'));
    expect(cars).toHaveLength(8);
    expect(html).toContain(`data-acv-first-car="${ids[0]}"`);
    expect(html).toContain('ACV model · Insufficient thermal data');
    for (const car of cars) {
      const id = /aria-label="Focus car ([^"]+)"/.exec(car.attributes)![1];
      expect(car.attributes).toContain(`data-acv-rank="${ids.indexOf(id) + 1}"`);
    }
    expect(html).not.toMatch(/is-amber|is-ranked-first|most suspected|ranked first/);
    expect(html).not.toContain('reference-passenger-face');
  });

  it('keeps an individual ACV car with missing telemetry neutral while preserving its returned rank', () => {
    const rankedCars = ['03', '01', '02', '04', '05', '06', '07', '08'];
    const acv = { rankedCars, hasUsableData: true, usableCarIds: rankedCars.slice(0, 7) };
    const missing = render('acv', { selection: { kind: 'car', carId: '08', ordinal: 8 }, visualization: { acv } });
    expect(missing).toContain('Car 08 · Ranked #8 of 8');
    expect(missing).toContain('Insufficient thermal data; this rank does not indicate healthy equipment.');
    expect(missing).not.toContain('reference-passenger-face');
    expect(missing).toContain('data-acv-first-car="03"');
    const cars = buttons(missing).filter(button => button.attributes.includes('reference-fallback__car'));
    expect(cars).toHaveLength(8);
    expect(cars.find(car => car.attributes.includes('aria-label="Focus car 08"'))!.attributes).toContain('data-acv-rank="8"');
    for (const [carId, face] of [['03', 'is-alert'], ['01', 'is-ok']]) {
      const available = render('acv', { selection: { kind: 'car', carId, ordinal: Number(carId) }, visualization: { acv } });
      expect(available).toContain(`reference-passenger-face ${face}`);
      expect(available).not.toContain('Insufficient thermal data;');
    }
  });

  it('keeps SHM stress unlocated and disables the pulse under reduced motion', () => {
    const html = render('shm', {
      selection: { kind: 'car', carId: '03', ordinal: 3 },
      visualization: { stress: { amplitude: .8, progress: .5, playing: true } },
    });
    expect(html).toContain('data-selected-car=""');
    expect(html).toContain('Recording-level colour; sensor location unavailable.');
    expect(html).toContain('data-shm-risk="uncomputed"');
    expect(html).toContain('SHM model · Not analysed');
    expect(html).not.toContain('aria-current="true"');
    expect(html).not.toMatch(/is-selected|Predicted damage|remaining life|health %/);
    const cars = buttons(html).filter(button => button.attributes.includes('reference-fallback__car'));
    expect(cars).toHaveLength(8);
    expect(cars.every(car => car.attributes.includes('disabled=""') && car.attributes.includes('aria-pressed="false"'))).toBe(true);
    expect(html).toContain('--stress-amplitude:0');
  });

  it.each([[.03275079057348264, 'green'], [.33, 'yellow'], [.816841668231493, 'red'], [1.5, 'red']] as const)('colours all reference cars for SHM output %s, even with reduced motion', (prediction, band) => {
    const html = render('shm', { visualization: { shm: { prediction }, stress: { amplitude: .8, progress: .5, playing: true } } });
    const cars = buttons(html).filter(button => button.attributes.includes('reference-fallback__car'));
    expect(cars).toHaveLength(8);
    expect(cars.every(car => car.attributes.includes(`data-shm-risk="${band}"`))).toBe(true);
    expect(html).toContain('<aside class="reference-shm-legend" aria-label="SHM risk legend">');
    expect(html).toContain(`data-band="${band}" aria-current="true"`);
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
    expect(html).toContain(`<output aria-label="SHM fatigue damage">${String(prediction)}</output>`);
    expect(html).toContain('--stress-amplitude:0');
    expect(html).toContain('Recording-level colour; sensor location unavailable.');
    expect(html.includes('Above the displayed 0–1 range')).toBe(prediction > 1);
  });

  it.each([undefined, -1, NaN, Infinity])('clears SHM train colour and the current legend marker for unavailable output %s', prediction => {
    const html = render('shm', { visualization: prediction === undefined ? undefined : { shm: { prediction } } });
    expect(html).toContain('data-shm-risk="uncomputed"');
    expect(html).not.toContain('aria-current="true"');
    expect(buttons(html).filter(button => button.attributes.includes('reference-fallback__car')).every(car => !car.attributes.includes('data-shm-risk'))).toBe(true);
  });

  it('keeps the SHM result unchanged when optional illustrative X-ray is enabled', () => {
    const visualization = { shm: { prediction: .816841668231493 } };
    const normal = render('shm', { visualization });
    const xray = render('shm', { visualization, xray: true });
    expect(normal).toContain('data-xray="false"');
    expect(normal).toContain('X-ray reveals illustrative internal structure');
    expect(xray).toContain('data-xray="true"');
    expect(xray).toContain('X-ray internals are illustrative scaffolding, not verified engineering geometry');
    for (const html of [normal, xray]) {
      expect(html).toContain('data-shm-risk="red"');
      expect(html).toContain('<output aria-label="SHM fatigue damage">0.816841668231493</output>');
      expect(html).toContain('Recording-level colour; sensor location unavailable.');
    }
  });

  it('renders just one representative Door cabin without a physical car assignment', () => {
    const html = render('door', { selection: { kind: 'car', carId: '03', ordinal: 3 } });
    expect(html).toContain('data-car-count="1"');
    expect(html).toContain('aria-label="Representative door cabin layout"');
    expect(html).toContain('Representative cabin · physical door identity unavailable');
    expect(html).toContain('data-selected-car=""');
    const cars = buttons(html).filter(button => button.attributes.includes('reference-fallback__car'));
    expect(cars).toHaveLength(1);
    expect(cars[0].attributes).toContain('disabled=""');
    expect(cars[0].content).toContain('REFERENCE');
    expect(cars[0].content).not.toContain('CAR 04');
  });

  it('shows an illustrative Door movement and reveals its classification only on completion', () => {
    const door = { cycleNumber: 2, operation: 'Close', progress: .4, completed: false, prediction: 'Abnormal resistance' } as const;
    const playing = render('door', { visualization: { door } });
    expect(playing).toContain('Illustrative Close movement, cycle 2');
    expect(playing).toContain('Physical door identity unavailable');
    expect(playing).not.toMatch(/Abnormal resistance|is-abnormal|is-amber/);
    const completed = render('door', { visualization: { door: { ...door, completed: true } } });
    expect(completed).toContain('Cycle 2 · classified as Abnormal resistance');
    expect(completed).toContain('is-abnormal');
    expect(completed).toContain('is-amber');
  });
});
