import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ReferenceTrainScene, type ReferenceTrainSceneProps } from '../src/components/train/ReferenceTrainScene';
import type { AnalysisResult, RailClass, SourceRef, Subsystem } from '../src/types/multisystem';

const ids = ['03', '07', '01', '08', '04', '06', '02', '05'];
const source = (subsystem: Subsystem): SourceRef => ({ subsystem, datasetId: `ps3-${subsystem}`, fileId: 'one-recording', fileName: 'Test.csv', mode: 'uploaded' });
const base = (subsystem: Subsystem) => ({ source: source(subsystem), model: { version: 'test', name: 'frozen model', description: '', training: '', validation: '' }, analysedAt: '2026-09-18', notes: [] });
const rail = (prediction: RailClass): AnalysisResult => ({ ...base('rail'), subsystem: 'rail', scope: 'recording', prediction });
const acv: AnalysisResult = { ...base('acv'), subsystem: 'acv', scope: 'car-case', rankedCars: ids };

function render(result: AnalysisResult, overrides: Partial<ReferenceTrainSceneProps> = {}) {
  // Node has no document/WebGL: exercise the actual accessible scene fallback.
  return renderToStaticMarkup(createElement(ReferenceTrainScene, {
    subsystem: result.subsystem, carIds: result.subsystem === 'acv' ? ids : [],
    selection: { kind: 'recording' }, onSelect: () => {}, result, source: result.source,
    mapping: { status: 'unmapped', reason: 'Physical identity unavailable' },
    xray: false, reducedMotion: true, fitKey: 0,
    visualization: { analysisPhase: 'settled', scanProgress: 1 }, ...overrides,
  }));
}

function buttons(html: string) {
  return [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(match => ({ attributes: match[1], content: match[2] }));
}

describe('rendered subsystem train schematic', () => {
  it.each(['Side I', 'Side II'] as const)('highlights only the recording-level %s rail and its documented 32 sensor members', prediction => {
    const html = render(rail(prediction));
    expect(html).toContain('data-renderer="schematic"');
    expect(html).toContain(`data-rail-class="${prediction}"`);
    expect(html).toContain(`Corrugation signature detected — ${prediction}`);
    const sideButtons = buttons(html).filter(button => button.attributes.includes('aria-label="Select reference rail'));
    expect(sideButtons).toHaveLength(4); // Both the schematic and persistent rail controls remain keyboard accessible.
    for (const button of sideButtons) {
      expect(button.attributes.includes('class="is-predicted"')).toBe(button.attributes.includes(`aria-label="Select reference rail ${prediction}"`));
    }
    const sensors = [...html.matchAll(/<i class="([^"]*)" title="Car ([^"]+) · P(\d) · (Side I|Side II)"><\/i>/g)];
    expect(sensors).toHaveLength(64);
    expect(sensors.filter(sensor => sensor[1].includes('is-side-member'))).toHaveLength(32);
    for (const sensor of sensors) {
      expect(sensor[4]).toBe(Number(sensor[3]) % 2 === 1 ? 'Side I' : 'Side II');
      expect(sensor[1].includes('is-side-member')).toBe(sensor[4] === prediction);
    }
    expect(html).toContain('Illustrative rail-side highlight');
    expect(html).not.toMatch(/defective|bearing fault|track section/i);
  });

  it('keeps both rails neutral for Normal without assigning healthy status to individual sensors', () => {
    const html = render(rail('Normal'));
    expect(html).toContain('No corrugation signature detected');
    expect(html).toContain('data-rail-class="Normal"');
    expect(html).not.toContain('is-predicted');
    expect(html).not.toContain('is-side-member');
    expect(html).not.toContain('is-amber');
    expect(html).toContain('not a component-health assessment');
  });

  it('preserves all eight exact car identities, unique ranks, and descending rendered emphasis', () => {
    const html = render(acv);
    const cars = buttons(html).filter(button => button.attributes.includes('reference-fallback__car'));
    expect(cars).toHaveLength(8);
    expect(cars.map(car => /aria-label="Focus car ([^"]+)"/.exec(car.attributes)![1])).toEqual(['01', '02', '03', '04', '05', '06', '07', '08']);
    const ranked = cars.map(car => ({
      id: /aria-label="Focus car ([^"]+)"/.exec(car.attributes)![1],
      rank: Number(/data-rank="(\d+)"/.exec(car.attributes)![1]),
      strength: Number(/--rank-strength:([\d.]+)/.exec(car.attributes)![1]),
    })).sort((left, right) => left.rank - right.rank);
    expect(ranked.map(car => car.id)).toEqual(ids);
    expect(ranked.map(car => car.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(ranked.every((car, index) => index === 0 || car.strength < ranked[index - 1].strength)).toBe(true);
    expect(cars.find(car => car.attributes.includes('data-rank="1"'))!.content).toContain('CAR 03');
    expect(html).toContain('relative leak-likelihood ranking');
    expect(html).not.toMatch(/chance of leak|definitely|healthy/i);
  });

  it.each([[0, '0.0000'], [.0000012345, '1.2345e-6'], [12.345, '12.345']] as const)('shows unlocated file-level SHM damage %s without car focus or a health conversion', (predictedDamage, display) => {
    const result: AnalysisResult = { ...base('shm'), subsystem: 'shm', scope: 'recording', predictedDamage, mapping: { status: 'unmapped', reason: 'Location not supplied' } };
    const html = render(result, { selection: { kind: 'car', carId: '03', ordinal: 3 }, visualization: { analysisPhase: 'settled', scanProgress: 1, stress: { amplitude: .8, progress: .5, playing: true } } });
    expect(html).toContain('data-selected-car=""');
    expect(html).toContain('Measurement location not supplied');
    expect(html).toContain('not a measured spatial distribution');
    expect(html).toContain(`Predicted damage <b>${display}</b>`);
    expect(html).not.toContain('is-selected');
    expect(html).not.toContain('is-ranked');
    expect(html).not.toMatch(/remaining life|health %|failure probability/i);
    const cars = buttons(html).filter(button => button.attributes.includes('reference-fallback__car'));
    expect(cars).toHaveLength(8);
    expect(cars.every(car => car.attributes.includes('disabled=""') && car.attributes.includes('aria-pressed="false"'))).toBe(true);
    expect(html).toContain('--stress-amplitude:0'); // Reduced motion suppresses the replay pulse.
  });

  it('withholds settled highlights during the explanatory scan and rejects another recording’s result', () => {
    const scanning = render(rail('Side I'), { reducedMotion: false, visualization: { analysisPhase: 'scanning', scanProgress: .5 } });
    expect(scanning).toContain('Reviewing recorded evidence · visual scan 50%');
    expect(scanning).toContain('data-rail-class="uncomputed"');
    expect(scanning).not.toContain('is-side-member');
    expect(scanning).not.toContain('Corrugation signature detected');
    const stale = render(acv, { source: { ...source('acv'), fileId: 'another-recording' } });
    expect(stale).not.toContain('data-rank=');
    expect(stale).not.toContain('Scan complete');
  });
});
