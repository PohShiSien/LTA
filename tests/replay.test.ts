import { describe, expect, it } from 'vitest';
import {
  ANOMALY_DOOR_ID,
  CANDIDATE_CYCLE_INDEX,
  createDemoCycles,
  DOOR_IDS,
  HISTORY_CYCLE_COUNT,
  VERIFICATION_CYCLE_INDEX,
} from '../src/data/mockTelemetry';
import {
  createReplayState,
  derivePrediction,
  evaluateTrace,
  getDoorTelemetry,
  getReplaySnapshot,
  reduceReplay,
} from '../src/lib/replay';
import type { DemoScenario, DoorTelemetryPoint } from '../src/types/railwitness';

const scenarios: DemoScenario[] = ['corroborated', 'not_corroborated', 'insufficient_evidence'];

describe('synthetic signal fixtures', () => {
  it('reproduces 24 unique doors and strictly chronological movement cycles', () => {
    const cycles = createDemoCycles();
    expect(createDemoCycles()).toEqual(cycles);
    expect(new Set(DOOR_IDS).size).toBe(24);
    expect(cycles).toHaveLength(37);
    for (let index = 0; index < cycles.length; index++) {
      expect(Object.keys(cycles[index].telemetry)).toHaveLength(24);
      if (index) expect(cycles[index].timestamp).toBeGreaterThan(cycles[index - 1].timestamp);
      for (const points of Object.values(cycles[index].telemetry)) {
        expect(points).toHaveLength(51);
        expect(points[0].travelPct).toBe(0);
        expect(points[50].travelPct).toBe(100);
        expect(points.every(point => point.timestamp <= cycles[index].timestamp)).toBe(true);
      }
    }
  });

  it('keeps every scenario identical until the unseen verification movement', () => {
    const reference = createDemoCycles('corroborated').slice(0, VERIFICATION_CYCLE_INDEX);
    for (const scenario of scenarios) {
      expect(createDemoCycles(scenario).slice(0, VERIFICATION_CYCLE_INDEX)).toEqual(reference);
    }
  });

  it('retains the original demonstration times after a healthy historical prefix', () => {
    const cycles = createDemoCycles();
    expect(cycles[HISTORY_CYCLE_COUNT]).toMatchObject({ id: 'C001', timestampLabel: '14:15:04' });
    expect(cycles[CANDIDATE_CYCLE_INDEX]).toMatchObject({ id: 'C005', timestampLabel: '14:19:22' });
    expect(cycles[VERIFICATION_CYCLE_INDEX]).toMatchObject({ id: 'C007', timestampLabel: '14:21:03' });
    expect(cycles.slice(0, CANDIDATE_CYCLE_INDEX + 1).filter(cycle => cycle.direction === 'close')).toHaveLength(9);
  });

  it('isolates the candidate deviation to D07 and derives the visible physics', () => {
    const candidate = createDemoCycles()[CANDIDATE_CYCLE_INDEX];
    for (const doorId of DOOR_IDS) {
      const evaluation = evaluateTrace(getDoorTelemetry(candidate, doorId));
      expect(evaluation.signaturePresent).toBe(doorId === ANOMALY_DOOR_ID);
    }
    const evaluation = evaluateTrace(getDoorTelemetry(candidate, ANOMALY_DOOR_ID));
    expect(evaluation.peakCurrent).toBe(4.2);
    expect(evaluation.expectedMaximum).toBe(3.5);
    expect(evaluation.expectedMinimum).toBe(2.8);
    expect(evaluation.deviationPct).toBe(20);
    expect(evaluation.coveragePct).toBe(100);
    expect(evaluation.anomalyScore).toBeGreaterThan(80);
  });
});

describe('prediction chronology', () => {
  it('issues no prediction before seeing the anomalous closing movement', () => {
    const cycles = createDemoCycles();
    for (let index = 0; index < CANDIDATE_CYCLE_INDEX; index++) {
      const snapshot = getReplaySnapshot(cycles, index);
      expect(snapshot.prediction).toBeNull();
      expect(snapshot.advisoryCount).toBe(0);
      expect(snapshot.doors.every(door => door.status === 'normal')).toBe(true);
    }
  });

  it('locks the timestamped prediction before any evidence exists', () => {
    const cycles = createDemoCycles();
    const candidate = getReplaySnapshot(cycles, CANDIDATE_CYCLE_INDEX);
    expect(candidate.prediction).toMatchObject({
      status: 'awaiting',
      doorId: 'D07',
      issuedAtLabel: '14:19:22',
      targetDirection: 'close',
      regionStartPct: 60,
      regionEndPct: 80,
    });
    expect(candidate.prediction?.verification).toBeUndefined();
    expect(candidate.prediction?.observedEvidence).toBeUndefined();
    expect(candidate.currentCycle.telemetry.D07.every(point => point.timestamp <= candidate.prediction!.issuedAt)).toBe(true);
    expect(candidate.visibleCycles).toHaveLength(CANDIDATE_CYCLE_INDEX + 1);
    expect(JSON.stringify(candidate)).not.toContain('14:21:03');
    expect(candidate.doors.find(door => door.id === 'D07')?.status).toBe('candidate');
  });

  it('cannot corroborate from an opening movement even if its current exceeds the envelope', () => {
    const cycles = createDemoCycles();
    const opening = cycles[CANDIDATE_CYCLE_INDEX + 1];
    opening.telemetry.D07 = opening.telemetry.D07.map(point => ({ ...point, current: 8 }));
    const snapshot = getReplaySnapshot(cycles, CANDIDATE_CYCLE_INDEX + 1);
    expect(snapshot.currentCycle.direction).toBe('open');
    expect(snapshot.prediction?.status).toBe('awaiting');
    expect(snapshot.prediction?.verification).toBeUndefined();
    expect(snapshot.doors.find(door => door.id === 'D07')?.status).toBe('awaiting_verification');
  });

  for (const scenario of scenarios) {
    it(`resolves ${scenario} solely from the next eligible closing trace`, () => {
      const cycles = createDemoCycles(scenario);
      const before = getReplaySnapshot(cycles, CANDIDATE_CYCLE_INDEX).prediction!;
      const after = getReplaySnapshot(cycles, VERIFICATION_CYCLE_INDEX).prediction!;
      expect(after.status).toBe(scenario);
      expect(after.verification?.timestampLabel).toBe('14:21:03');
      expect(after.verification?.direction).toBe('close');
      for (const key of ['predictionId', 'issuedAt', 'issuedAtLabel', 'issuedCycleId', 'description', 'expectedCondition', 'targetDirection', 'regionStartPct', 'regionEndPct'] as const) {
        expect(after[key]).toEqual(before[key]);
      }
      expect(before.status).toBe('awaiting');
      expect(before.verification).toBeUndefined();
    });
  }

  it('rewinds all evidence, statuses, timestamps and scores when the timeline is scrubbed back', () => {
    const cycles = createDemoCycles();
    const expectedBefore = getReplaySnapshot(cycles, CANDIDATE_CYCLE_INDEX);
    expect(getReplaySnapshot(cycles, VERIFICATION_CYCLE_INDEX).prediction?.status).toBe('corroborated');
    expect(getReplaySnapshot(cycles, CANDIDATE_CYCLE_INDEX)).toEqual(expectedBefore);
    expect(getReplaySnapshot(cycles, 0).prediction).toBeNull();
    expect(getReplaySnapshot(cycles, 0).doors.every(door => door.status === 'normal')).toBe(true);
  });

  it('does not change the past when future traces change', () => {
    const snapshots = scenarios.map(scenario => getReplaySnapshot(createDemoCycles(scenario), CANDIDATE_CYCLE_INDEX + 1));
    expect(snapshots[1]).toEqual(snapshots[0]);
    expect(snapshots[2]).toEqual(snapshots[0]);
  });

  it('keeps the first eligible-cycle result once later movements appear', () => {
    const cycles = createDemoCycles('not_corroborated');
    const later = VERIFICATION_CYCLE_INDEX + 2;
    cycles[later].telemetry.D07 = cycles[later].telemetry.D07.map(point => ({ ...point, current: 8 }));
    const first = getReplaySnapshot(cycles, VERIFICATION_CYCLE_INDEX).prediction!;
    const followUp = getReplaySnapshot(cycles, later).prediction!;
    expect(followUp.verification).toEqual(first.verification);
    expect(followUp.status).toBe('not_corroborated');
    expect(followUp.attempts).toHaveLength(2);
    expect(followUp.latestAttempt?.status).toBe('corroborated');
    expect(getReplaySnapshot(cycles, later).doors.find(door => door.id === 'D07')?.status).toBe('corroborated');
  });

  it('does not create a prediction for another healthy door', () => {
    expect(derivePrediction(createDemoCycles(), 'D08')).toBeNull();
  });
});

describe('evidence quality', () => {
  const candidatePoints = () => getDoorTelemetry(createDemoCycles()[CANDIDATE_CYCLE_INDEX], 'D07');

  it('treats missing samples as insufficient evidence, never negative evidence', () => {
    const cycles = createDemoCycles('insufficient_evidence');
    const evaluation = evaluateTrace(getDoorTelemetry(cycles[VERIFICATION_CYCLE_INDEX], 'D07'));
    expect(evaluation).toMatchObject({ sampleCount: 0, requiredSampleCount: 11, coveragePct: 0, peakCurrent: null, deviationPct: null, sufficientEvidence: false, signaturePresent: false });
    expect(getReplaySnapshot(cycles, VERIFICATION_CYCLE_INDEX).prediction?.status).toBe('insufficient_evidence');
    expect(evaluateTrace([]).sufficientEvidence).toBe(false);
  });

  it('does not let duplicate samples inflate interval coverage', () => {
    const point = candidatePoints().find(point => point.travelPct === 70)!;
    const repeated: DoorTelemetryPoint[] = Array.from({ length: 20 }, () => ({ ...point }));
    expect(evaluateTrace(repeated).sampleCount).toBe(1);
    expect(evaluateTrace(repeated).sufficientEvidence).toBe(false);
  });

  it('rejects isolated spikes as persistent resistance', () => {
    const points = candidatePoints().map(point => ({
      ...point,
      current: point.travelPct === 70 ? 7 : point.expectedMedian,
    }));
    expect(evaluateTrace(points).signaturePresent).toBe(false);
    expect(evaluateTrace(points).excessSampleCount).toBe(1);
  });

  it('requires sufficient coverage despite an observed excess', () => {
    const points = candidatePoints().map(point => ({ ...point, current: point.travelPct < 74 ? point.current : null }));
    expect(evaluateTrace(points).coveragePct).toBeLessThan(80);
    expect(evaluateTrace(points).signaturePresent).toBe(false);
  });
});

describe('replay controls', () => {
  it('pauses automatic playback when the prediction appears and when it resolves', () => {
    const cycles = createDemoCycles();
    let state = { ...createReplayState(CANDIDATE_CYCLE_INDEX - 1), playing: true };
    state = reduceReplay(state, { type: 'step' }, cycles);
    expect(state).toMatchObject({ currentIndex: CANDIDATE_CYCLE_INDEX, playing: false });
    state = reduceReplay(state, { type: 'play' }, cycles);
    state = reduceReplay(state, { type: 'step' }, cycles);
    expect(state).toMatchObject({ currentIndex: CANDIDATE_CYCLE_INDEX + 1, playing: true });
    state = reduceReplay(state, { type: 'step' }, cycles);
    expect(state).toMatchObject({ currentIndex: VERIFICATION_CYCLE_INDEX, playing: false });
  });

  it('reveals exactly one ordinary cycle and preserves the ineligible opening', () => {
    const cycles = createDemoCycles();
    let state = reduceReplay(createReplayState(), { type: 'reveal' }, cycles);
    expect(state.currentIndex).toBe(CANDIDATE_CYCLE_INDEX + 1);
    expect(getReplaySnapshot(cycles, state.currentIndex).prediction?.status).toBe('awaiting');
    state = reduceReplay(state, { type: 'reveal' }, cycles);
    expect(state.currentIndex).toBe(VERIFICATION_CYCLE_INDEX);
    expect(getReplaySnapshot(cycles, state.currentIndex).prediction?.status).toBe('corroborated');
  });

  it('does not reveal evidence when future-data visibility is toggled', () => {
    const cycles = createDemoCycles();
    const state = reduceReplay(createReplayState(), { type: 'set-hide-future', value: false }, cycles);
    expect(state.currentIndex).toBe(CANDIDATE_CYCLE_INDEX);
    expect(getReplaySnapshot(cycles, state.currentIndex).prediction?.status).toBe('awaiting');
  });

  it('bounds seek, step, reset and malformed indices', () => {
    const cycles = createDemoCycles();
    const finalIndex = cycles.length - 1;
    const initial = createReplayState();
    expect(reduceReplay(initial, { type: 'seek', index: -20 }, cycles).currentIndex).toBe(0);
    expect(reduceReplay(initial, { type: 'seek', index: 200 }, cycles).currentIndex).toBe(finalIndex);
    expect(reduceReplay(initial, { type: 'seek', index: Number.NaN }, cycles).currentIndex).toBe(0);
    expect(reduceReplay(createReplayState(finalIndex), { type: 'step' }, cycles).currentIndex).toBe(finalIndex);
    expect(reduceReplay(createReplayState(finalIndex), { type: 'play' }, cycles).playing).toBe(false);
    expect(reduceReplay(initial, { type: 'reset', index: 0 }, cycles).currentIndex).toBe(0);
    expect(getReplaySnapshot(cycles, -4).currentIndex).toBe(0);
    expect(getReplaySnapshot(cycles, 200).currentIndex).toBe(finalIndex);
    expect(() => getReplaySnapshot([], 0)).toThrow('at least one');
  });
});
