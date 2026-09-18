import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import DoorReplayTimeline from '../src/components/door/DoorReplayTimeline';
import DoorMotionVisual from '../src/components/door/DoorMotionVisual';
import DoorCycleEvidence from '../src/components/door/DoorCycleEvidence';
import { chronologicalDoorCycles, clampDoorProgress, doorCycleResultVisible, doorMotionOpenness, doorReplayProgress, DOOR_REPLAY_DURATION_MS, DOOR_REPLAY_RESULT_HOLD_MS, type DoorReplayCycle } from '../src/lib/doorReplay';
import type { DoorCycleDetail } from '../src/lib/railwitnessDoorClient';

const cycles: DoorReplayCycle[] = [0, 1, 2].map(index => ({
  index, startTime: `2023-7-5-0-0-${index * 2}-0`, endTime: `2023-7-5-0-0-${index * 2 + 1}-20`,
  startIndex: index * 3, endIndex: index * 3 + 2,
  prediction: index === 1 ? 'Abnormal resistance' : 'Normal', operation: index % 2 ? 'Close' : 'Open',
}));
const noop = () => undefined;
function timeline(playing = false, progress = 1, selectedIndex = 1) {
  return renderToStaticMarkup(createElement(DoorReplayTimeline, {
    cycles, selectedIndex, playing, progress, onPlay: noop, onPause: noop, onPrevious: noop, onNext: noop, onSelect: noop,
  }));
}
function detail(): DoorCycleDetail {
  return {
    segment: { cycle_index: 1, cycle_id: 'cycle_002', start_time: cycles[1].startTime, end_time: cycles[1].endTime,
      prediction: 'Abnormal resistance', operation_inferred: 'Close', abnormal_model_score: 0.723456789,
      score_description: 'Uncalibrated model output.', duration_s: 1.02, n_rows: 3, mean_current_A: 1, peak_current_A: 1.2,
      asset_id: null, recommendation: 'Review this recorded movement before maintenance.', data_quality_warnings: ['Short recorded cycle.'] },
    points: [0, .5, 1].map(fraction => ({ elapsed_s: fraction * 1.02, elapsed_fraction: fraction, current_A: 1 + fraction * .2,
      voltage_V: 100 + fraction, position_raw: 1000 - fraction * 700, bemf_raw: 0 })),
    display_downsampled: false, reference: { elapsed_fraction: [0, 1], lower_A: [.7, .9], median_A: [.9, 1], upper_A: [1.2, 1.3], n_normal_training_cycles: 20 },
    reference_method: 'Normal training cycles grouped by operation.', reference_limitation: 'Descriptive comparison only.',
    features: { current_mean: 1.1 }, explanations: [{ feature: 'current_mean', value: 1.1, log_odds_contribution: 0.623456, direction: 'toward Abnormal resistance' }],
    explanation_method: 'Signed logistic log-odds.', model_intercept: -.2, units: { current: 'A', voltage: 'V', position: 'raw dataset units' },
  };
}

describe('recorded Door cycle replay', () => {
  it('keeps all source cycles in chronological row order without modifying timestamps or IDs', () => {
    const reordered = [cycles[2], cycles[0], cycles[1]];
    expect(chronologicalDoorCycles(reordered)).toEqual(cycles);
    expect(reordered[0]).toBe(cycles[2]);
    const html = timeline();
    expect((html.match(/data-cycle-index=/g) ?? [])).toHaveLength(3);
    expect(html).toContain(cycles[1].startTime);
    expect(html).toContain(cycles[1].endTime);
    expect(html).toContain('Recorded cycle 2: Abnormal resistance');
    expect(html).toContain('abnormal selected');
    expect(html).not.toMatch(/Door D0|physical door 0|future failure/i);
  });

  it('uses 1.5 second movement followed by a readable classification hold', () => {
    expect(DOOR_REPLAY_DURATION_MS).toBe(1500);
    expect(DOOR_REPLAY_RESULT_HOLD_MS).toBe(500);
    expect(doorReplayProgress(0)).toBe(0);
    expect(doorReplayProgress(750)).toBe(.5);
    expect(doorReplayProgress(1499)).toBeLessThan(1);
    expect(doorReplayProgress(1500)).toBe(1);
    expect(doorReplayProgress(2000)).toBe(1);
    expect(clampDoorProgress(Number.NaN)).toBe(0);
    expect(clampDoorProgress(-1)).toBe(0);
  });

  it('opens apart and closes together using progress while keeping unknown movement unknown', () => {
    expect([0, .5, 1].map(progress => doorMotionOpenness('Open', progress))).toEqual([0, .5, 1]);
    expect([0, .5, 1].map(progress => doorMotionOpenness('Close', progress))).toEqual([1, .5, 0]);
    expect(doorMotionOpenness('Unknown', .5)).toBeNull();
    const html = renderToStaticMarkup(createElement(DoorMotionVisual, { operation: 'Close', progress: .25, completed: false, prediction: 'Abnormal resistance', reducedMotion: false }));
    expect(html).toContain('data-openness="0.75"');
    expect(html).toContain('Physical door identity unavailable');
    expect(html).toContain('Recorded movement in progress');
    expect(html).not.toContain('Abnormal resistance detected');
    expect(html).not.toContain('class="door-motion-visual abnormal');
  });

  it('conceals current and upcoming classifications until replay completion, even while paused', () => {
    expect(doorCycleResultVisible(0, 1, true, .5)).toBe(true);
    expect(doorCycleResultVisible(1, 1, true, .5)).toBe(false);
    expect(doorCycleResultVisible(2, 1, true, 1)).toBe(false);
    expect(doorCycleResultVisible(1, 1, false, .5)).toBe(false);
    expect(doorCycleResultVisible(1, 1, true, 1)).toBe(true);
    expect(doorCycleResultVisible(2, 1, false, 1)).toBe(true);
    expect(timeline(true, .5)).toContain('Recorded cycle 2: classification available at cycle completion');
    expect(timeline(true, .5)).not.toContain('Recorded cycle 2: Abnormal resistance');
    expect(timeline(true, 1)).toContain('Recorded cycle 2: Abnormal resistance');
  });

  it('uses native keyboard controls and a static motion state when reduced motion is requested', () => {
    expect(timeline()).toContain('aria-label="Play cycle replay"');
    expect(timeline()).toContain('type="range"');
    expect(timeline()).toContain('aria-pressed="true"');
    const html = renderToStaticMarkup(createElement(DoorMotionVisual, { operation: 'Open', progress: .7, completed: false, prediction: 'Normal', reducedMotion: true }));
    expect(html).toContain('reduced-motion');
    expect(html).toContain('data-openness="0"');
  });

  it('reveals the completed classification while keeping the movement illustrative', () => {
    const html = renderToStaticMarkup(createElement(DoorMotionVisual, { operation: 'Open', progress: 1, completed: true, prediction: 'Abnormal resistance', reducedMotion: false }));
    expect(html).toContain('Abnormal resistance detected');
    expect(html).toContain('Fault detected in this recorded movement');
    expect(html).toContain('not a measured physical door position');
  });
});

describe('Door evidence reveal', () => {
  it('withholds the score, result, contribution and recommendation during replay', () => {
    const html = renderToStaticMarkup(createElement(DoorCycleEvidence, { detail: detail(), loading: false, error: '', sourceName: 'Recording.csv', cycleNumber: 2, onRetry: noop, replayProgress: .4, concealResult: true }));
    expect(html).toContain('Awaiting cycle completion');
    expect(html).toContain('Short recorded cycle.');
    expect(html).not.toContain('0.723456789');
    expect(html).not.toContain('0.623456');
    expect(html).not.toContain('Review this recorded movement before maintenance.');
    expect(html).not.toContain('Abnormal resistance');
    expect(html).toContain('Elapsed cycle time (%)');
    expect(html).toContain('door-chart-reference-bound lower');
    expect(html).toContain('door-chart-reference-bound upper');
    expect(html).not.toContain('Normalized elapsed cycle time (%)');
  });

  it('keeps full evidence visible by default and retains exact backend units', () => {
    const html = renderToStaticMarkup(createElement(DoorCycleEvidence, { detail: detail(), loading: false, error: '', sourceName: 'Recording.csv', cycleNumber: 2, onRetry: noop }));
    expect(html).toContain('0.723456789');
    expect(html).toContain('0.623456');
    expect(html).toContain('Review this recorded movement before maintenance.');
    expect(html).toContain('Abnormal resistance');
    expect(html).toContain('1 <small>A</small>');
    expect(html).toContain('100 <small>V</small>');
  });
});
