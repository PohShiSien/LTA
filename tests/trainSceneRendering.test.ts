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
    expect(html).not.toMatch(/data-rank|is-ranked|leak-likelihood|leaking car/);
  });

  it('keeps SHM stress unlocated and disables the pulse under reduced motion', () => {
    const html = render('shm', {
      selection: { kind: 'car', carId: '03', ordinal: 3 },
      visualization: { stress: { amplitude: .8, progress: .5, playing: true } },
    });
    expect(html).toContain('data-selected-car=""');
    expect(html).toContain('Measurement location not supplied');
    expect(html).toContain('not a measured spatial distribution');
    expect(html).not.toMatch(/is-selected|Predicted damage|remaining life|health %/);
    const cars = buttons(html).filter(button => button.attributes.includes('reference-fallback__car'));
    expect(cars).toHaveLength(8);
    expect(cars.every(car => car.attributes.includes('disabled=""') && car.attributes.includes('aria-pressed="false"'))).toBe(true);
    expect(html).toContain('--stress-amplitude:0');
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
