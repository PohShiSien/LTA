import { describe, expect, it } from 'vitest';
import {
  CANDIDATE_CYCLE_INDEX,
  createDemoCycles,
  HISTORY_CYCLE_COUNT,
  VERIFICATION_CYCLE_INDEX,
} from '../src/data/mockTelemetry';
import { getBaselineProvenance, getDoorHistory, runValidationSuite } from '../src/lib/diagnostics';
import { createReplayState, evaluateCycleTrace, evaluateTrace, getReplaySnapshot, reduceReplay } from '../src/lib/replay';
import type { DoorTelemetryPoint } from '../src/types/railwitness';

describe('historical diagnostics', () => {
  it('uses only the supplied observed history and computes movement durations', () => {
    const cycles = createDemoCycles();
    const visible = cycles.slice(0, CANDIDATE_CYCLE_INDEX + 1);
    const history = getDoorHistory(visible, 'D07');
    expect(history).toHaveLength(visible.length);
    expect(history.every(entry => entry.cycle.timestamp <= visible[visible.length - 1].timestamp)).toBe(true);
    expect(history.filter(entry => entry.evaluation.signaturePresent).map(entry => entry.cycle.id)).toEqual(['C005']);
    expect(history.every(entry => entry.durationMs === 4500)).toBe(true);
    expect(JSON.stringify(history)).not.toContain('14:21:03');
    const missing = getDoorHistory(visible, 'missing-door');
    expect(missing.every(entry => entry.durationMs === null && !entry.evaluation.sufficientEvidence)).toBe(true);
  });

  it('describes an authored synthetic baseline and the actual assessment criteria', () => {
    expect(getBaselineProvenance()).toMatchObject({ synthetic: true, sampleStepPct: 2, minimumCoveragePct: 80, minimumConsecutiveExcess: 3, minimumExcessFraction: 0.6 });
    expect(getBaselineProvenance().method).toContain('not learned');
  });
});

describe('evidence integrity', () => {
  const points = () => createDemoCycles()[CANDIDATE_CYCLE_INDEX].telemetry.D07;
  const corruptions: [string, (points: DoorTelemetryPoint[]) => void][] = [
    ['off-grid travel', values => { values[32].travelPct = 64.1; }],
    ['mixed door identifiers', values => { values[32].doorId = 'D08'; }],
    ['mixed cycle identifiers', values => { values[32].cycleId = 'C999'; }],
    ['mixed movement directions', values => { values[32].direction = 'open'; }],
    ['backwards sample timestamps', values => { values[32].timestamp = values[31].timestamp - 1; }],
    ['invalid envelope', values => { values[32].expectedUpper = Number.NaN; }],
    ['inverted envelope', values => { values[32].expectedLower = 7; }],
  ];
  for (const [label, corrupt] of corruptions) {
    it(`withholds a verdict for ${label}, even with a strong observed signature`, () => {
      const values = points();
      corrupt(values);
      const evaluation = evaluateTrace(values);
      expect(evaluation.sufficientEvidence).toBe(false);
      expect(evaluation.signaturePresent).toBe(false);
      expect(evaluation.qualityIssues.length).toBeGreaterThan(0);
    });
  }

  it('binds all sample identities and timestamps to their enclosing cycle', () => {
    const cycle = createDemoCycles()[CANDIDATE_CYCLE_INDEX];
    cycle.telemetry.D07 = cycle.telemetry.D07.map(point => ({ ...point, doorId: 'D08' }));
    expect(evaluateTrace(cycle.telemetry.D07).sufficientEvidence).toBe(true);
    expect(evaluateCycleTrace(cycle, 'D07').sufficientEvidence).toBe(false);
    const futureCycle = createDemoCycles()[CANDIDATE_CYCLE_INDEX];
    futureCycle.telemetry.D07[50].timestamp = futureCycle.timestamp + 1;
    expect(evaluateCycleTrace(futureCycle, 'D07').sufficientEvidence).toBe(false);
  });

  it('rejects an out-of-order eligible movement as insufficient evidence', () => {
    const cycles = createDemoCycles();
    cycles[VERIFICATION_CYCLE_INDEX].timestamp = cycles[CANDIDATE_CYCLE_INDEX].timestamp - 1;
    const prediction = getReplaySnapshot(cycles, VERIFICATION_CYCLE_INDEX).prediction!;
    expect(prediction.status).toBe('insufficient_evidence');
    expect(prediction.verification?.evaluation.qualityIssues.some(issue => issue.includes('chronological'))).toBe(true);
  });

  it('reports the actual persistence criteria and does not call a spike within-envelope', () => {
    const cycles = createDemoCycles('isolated_spike');
    const prediction = getReplaySnapshot(cycles, VERIFICATION_CYCLE_INDEX).prediction!;
    expect(prediction.status).toBe('not_corroborated');
    expect(prediction.verification?.evaluation).toMatchObject({ excessSampleCount: 1, maxConsecutiveExcess: 1, peakCurrent: 5.4, sufficientEvidence: true });
    expect(prediction.verification?.evaluation.excessFraction).toBeCloseTo(1 / 11);
    expect(prediction.observedEvidence).toContain('persistence criteria were not met');
    expect(prediction.observedEvidence).not.toContain('stayed within');
  });
});

describe('shared fleet and assessment record', () => {
  it('preserves inconclusive evidence and records a later recovery separately', () => {
    const cycles = createDemoCycles('insufficient_evidence');
    const first = getReplaySnapshot(cycles, VERIFICATION_CYCLE_INDEX).prediction!;
    const recovered = getReplaySnapshot(cycles, HISTORY_CYCLE_COUNT + 10);
    expect(recovered.prediction?.status).toBe('insufficient_evidence');
    expect(recovered.prediction?.verification).toEqual(first.verification);
    expect(recovered.prediction?.attempts.map(attempt => attempt.status)).toEqual(['insufficient_evidence', 'insufficient_evidence', 'corroborated']);
    expect(recovered.prediction?.latestAttempt?.status).toBe('corroborated');
    expect(recovered.doors.find(door => door.id === 'D07')?.status).toBe('corroborated');
    expect(getReplaySnapshot(cycles, CANDIDATE_CYCLE_INDEX).prediction?.attempts).toEqual([]);
  });

  it('evaluates another door independently and counts both active advisories', () => {
    const cycles = createDemoCycles();
    const snapshot = getReplaySnapshot(cycles, HISTORY_CYCLE_COUNT + 14);
    expect(snapshot.predictions.map(prediction => prediction.doorId)).toEqual(['D07', 'D12']);
    expect(snapshot.predictions.find(prediction => prediction.doorId === 'D12')).toMatchObject({ status: 'corroborated', issuedCycleId: 'C013' });
    expect(snapshot.doors.find(door => door.id === 'D12')?.status).toBe('corroborated');
    expect(snapshot.advisoryCount).toBe(2);
    expect(getReplaySnapshot(cycles, CANDIDATE_CYCLE_INDEX).predictions.map(prediction => prediction.doorId)).toEqual(['D07']);
  });

  it('pauses playback when a second door issues a prediction', () => {
    const cycles = createDemoCycles();
    const before = { ...createReplayState(HISTORY_CYCLE_COUNT + 11), playing: true };
    expect(reduceReplay(before, { type: 'step' }, cycles)).toMatchObject({ currentIndex: HISTORY_CYCLE_COUNT + 12, playing: false });
  });

  it('shows missing data as insufficient evidence even for a door without a prediction', () => {
    const cycles = createDemoCycles();
    const snapshot = getReplaySnapshot(cycles, HISTORY_CYCLE_COUNT + 16);
    expect(snapshot.predictions.find(prediction => prediction.doorId === 'D19')).toBeUndefined();
    expect(snapshot.doors.find(door => door.id === 'D19')).toMatchObject({ status: 'insufficient_evidence', dataQuality: 'insufficient_evidence' });
    expect(snapshot.advisoryCount).toBe(3);
  });
});

describe('separate synthetic regression suite', () => {
  it('checks six authored scenarios at chronological cutoffs, preserving first assessments', () => {
    const report = runValidationSuite();
    expect(report.scope).toBe('synthetic_fixture_suite');
    expect(report.totalCount).toBe(6);
    expect(report.passedCount).toBe(6);
    expect(report.counts).toEqual({ corroborated: 2, not_corroborated: 3, insufficient_evidence: 1 });
    expect(report.rows.every(row => row.checks.every(check => check.passed))).toBe(true);
    expect(report.rows.every(row => row.firstAssessedCycleId === 'C007')).toBe(true);
    expect(report.rows.every(row => row.firstAssessmentDelayMs === 101000)).toBe(true);
    expect(report.rows.find(row => row.scenario === 'insufficient_evidence')).toMatchObject({ actualStatus: 'insufficient_evidence', latestStatus: 'corroborated' });
    expect(report.rows.find(row => row.scenario === 'intermittent')).toMatchObject({ actualStatus: 'not_corroborated', latestStatus: 'corroborated' });
  });
});
