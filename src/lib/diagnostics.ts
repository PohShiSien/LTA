import {
  ANOMALY_DOOR_ID,
  createDemoCycles,
  REGION_END_PCT,
  REGION_START_PCT,
  SAMPLE_STEP_PCT,
  SCENARIOS,
} from '../data/mockTelemetry';
import type {
  DemoScenario,
  PredictionStatus,
  RailWitnessPrediction,
  TelemetryCycle,
  TraceEvaluation,
  VerificationOutcome,
} from '../types/railwitness';
import { evaluateCycleTrace, getDoorTelemetry, getReplaySnapshot } from './replay';

export interface DoorHistoryEntry {
  cycle: TelemetryCycle;
  evaluation: TraceEvaluation;
  durationMs: number | null;
}

/** The caller supplies the observed prefix. This helper never fetches later movements. */
export function getDoorHistory(visibleCycles: readonly TelemetryCycle[], doorId: string): DoorHistoryEntry[] {
  return visibleCycles.map((cycle, index) => {
    const points = getDoorTelemetry(cycle, doorId);
    const previousCycleTimestamp = visibleCycles[index - 1]?.timestamp;
    const chronologyValid = visibleCycles.slice(0, index).every(previous => previous.timestamp < cycle.timestamp && previous.id !== cycle.id);
    const evaluation = evaluateCycleTrace(cycle, doorId, chronologyValid, previousCycleTimestamp);
    const completeMovement = points[0]?.travelPct === 0 && points[points.length - 1]?.travelPct === 100;
    const validTimes = points.length > 1 && points.every((point, sampleIndex) => Number.isFinite(point.timestamp)
      && point.timestamp <= cycle.timestamp
      && (previousCycleTimestamp === undefined || point.timestamp > previousCycleTimestamp)
      && (sampleIndex === 0 || point.timestamp > points[sampleIndex - 1].timestamp));
    return {
      cycle,
      evaluation,
      durationMs: completeMovement && validTimes && chronologyValid ? points[points.length - 1].timestamp - points[0].timestamp : null,
    };
  });
}

export function getBaselineProvenance() {
  return {
    version: 'RW-SYN-1.0',
    source: 'Deterministic synthetic signal fixture; no operational or inspection data.',
    method: 'Authored travel-dependent median and envelope; closing interval bounds are 2.8–3.5 A. This baseline is not learned from a fleet.',
    sampleStepPct: SAMPLE_STEP_PCT,
    regionStartPct: REGION_START_PCT,
    regionEndPct: REGION_END_PCT,
    minimumCoveragePct: 80,
    minimumConsecutiveExcess: 3,
    minimumExcessFraction: 0.6,
    units: 'A (motor current), % (travel), ms (duration)',
    synthetic: true as const,
  };
}

export interface ValidationResultRow {
  scenario: DemoScenario;
  label: string;
  expectedStatus: VerificationOutcome;
  actualStatus: PredictionStatus;
  passed: boolean;
  predictionId: string | null;
  issuedCycleId: string | null;
  firstAssessedCycleId: string | null;
  attemptCount: number;
  followUpCount: number;
  firstAssessmentDelayMs: number | null;
  latestStatus: PredictionStatus;
  checks: { name: string; passed: boolean }[];
}

export interface ValidationSuiteResult {
  scope: 'synthetic_fixture_suite';
  label: string;
  rows: ValidationResultRow[];
  counts: Record<VerificationOutcome, number>;
  passedCount: number;
  totalCount: number;
}

const EXPECTED_FIRST_OUTCOME: Record<DemoScenario, VerificationOutcome> = {
  corroborated: 'corroborated',
  not_corroborated: 'not_corroborated',
  insufficient_evidence: 'insufficient_evidence',
  intermittent: 'not_corroborated',
  drift: 'corroborated',
  isolated_spike: 'not_corroborated',
};

const frozenAssertion = (prediction: RailWitnessPrediction) => JSON.stringify({
  id: prediction.predictionId,
  issuedAt: prediction.issuedAt,
  issuedCycleId: prediction.issuedCycleId,
  doorId: prediction.doorId,
  direction: prediction.targetDirection,
  start: prediction.regionStartPct,
  end: prediction.regionEndPct,
  description: prediction.description,
  expectedCondition: prediction.expectedCondition,
});

/**
 * A separate full-fixture regression run, never an assessment of the active replay.
 * Expectations are authored test labels, not inspection truth or model accuracy.
 * Every evaluated snapshot receives only its chronological prefix.
 */
export function runValidationSuite(): ValidationSuiteResult {
  const rows = SCENARIOS.map(({ value: scenario, label }): ValidationResultRow => {
    const fixture = createDemoCycles(scenario);
    let firstPrediction: RailWitnessPrediction | null = null;
    let finalPrediction: RailWitnessPrediction | null = null;
    let firstAssessment: string | null = null;
    let chronologyPassed = true;
    let immutableAssertion = true;
    let immutableFirstAssessment = true;
    for (let index = 0; index < fixture.length; index++) {
      // Cut off future data before calling any evaluator, including the fleet evaluator.
      const available = fixture.slice(0, index + 1);
      const snapshot = getReplaySnapshot(available, available.length - 1);
      const prediction = snapshot.predictions.find(item => item.doorId === ANOMALY_DOOR_ID) ?? null;
      for (const record of snapshot.predictions) {
        chronologyPassed &&= record.issuedAt <= snapshot.currentCycle.timestamp
          && record.attempts.every(attempt => attempt.timestamp > record.issuedAt
            && attempt.timestamp <= snapshot.currentCycle.timestamp
            && available.some(cycle => cycle.id === attempt.cycleId && cycle.direction === record.targetDirection));
      }
      if (!prediction) continue;
      firstPrediction ??= prediction;
      immutableAssertion &&= frozenAssertion(prediction) === frozenAssertion(firstPrediction);
      if (prediction.verification) {
        const serialized = JSON.stringify(prediction.verification);
        firstAssessment ??= serialized;
        immutableFirstAssessment &&= serialized === firstAssessment;
      }
      finalPrediction = prediction;
    }
    const actualStatus = finalPrediction?.status ?? 'awaiting';
    const expectedStatus = EXPECTED_FIRST_OUTCOME[scenario];
    const checks = [
      { name: 'First eligible assessment matches the authored fixture expectation', passed: actualStatus === expectedStatus },
      { name: 'Each assessment uses only movements available at its cutoff', passed: chronologyPassed },
      { name: 'The original prediction remains unchanged', passed: immutableAssertion && firstPrediction !== null },
      { name: 'Later follow-ups preserve the first assessment', passed: immutableFirstAssessment && firstAssessment !== null },
    ];
    return {
      scenario,
      label,
      expectedStatus,
      actualStatus,
      passed: checks.every(check => check.passed),
      predictionId: finalPrediction?.predictionId ?? null,
      issuedCycleId: finalPrediction?.issuedCycleId ?? null,
      firstAssessedCycleId: finalPrediction?.verification?.cycleId ?? null,
      attemptCount: finalPrediction?.attempts.length ?? 0,
      followUpCount: Math.max(0, (finalPrediction?.attempts.length ?? 0) - 1),
      firstAssessmentDelayMs: finalPrediction?.verification ? finalPrediction.verification.timestamp - finalPrediction.issuedAt : null,
      latestStatus: finalPrediction?.latestAttempt?.status ?? 'awaiting',
      checks,
    };
  });
  const counts: Record<VerificationOutcome, number> = { corroborated: 0, not_corroborated: 0, insufficient_evidence: 0 };
  for (const row of rows) if (row.actualStatus !== 'awaiting') counts[row.actualStatus] += 1;
  return {
    scope: 'synthetic_fixture_suite',
    label: 'Separate full-fixture run · synthetic regression checks, not field accuracy',
    rows,
    counts,
    passedCount: rows.filter(row => row.passed).length,
    totalCount: rows.length,
  };
}
