import {
  ANOMALY_DOOR_ID,
  DOOR_IDS,
  INITIAL_CYCLE_INDEX,
  REGION_END_PCT,
  REGION_START_PCT,
  SAMPLE_STEP_PCT,
} from '../data/mockTelemetry';
import type {
  DoorHealth,
  DoorTelemetryPoint,
  RailWitnessPrediction,
  ReplayAction,
  ReplaySnapshot,
  ReplayState,
  TelemetryCycle,
  TraceEvaluation,
  VerificationEvidence,
  VerificationOutcome,
} from '../types/railwitness';

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round = (value: number, precision = 1) => {
  const scale = 10 ** precision;
  return Math.round(value * scale) / scale;
};

export function getDoorTelemetry(cycle: TelemetryCycle, doorId: string): DoorTelemetryPoint[] {
  return cycle.telemetry[doorId] ?? [];
}

/** Evaluate the predicted interval from observed samples, independent of scenario labels. */
export function evaluateTrace(
  points: readonly DoorTelemetryPoint[],
  regionStartPct = REGION_START_PCT,
  regionEndPct = REGION_END_PCT,
  context?: { cycleId: string; doorId: string; direction: 'open' | 'close'; timestamp: number; chronologyValid?: boolean },
): TraceEvaluation {
  const qualityIssues: string[] = [];
  let validMetadata = true;
  const reject = (message: string) => { qualityIssues.push(message); validMetadata = false; };
  const validRegion = Number.isFinite(regionStartPct) && Number.isFinite(regionEndPct)
    && regionStartPct >= 0 && regionEndPct <= 100 && regionEndPct >= regionStartPct;
  if (!validRegion) reject('The assessment interval is invalid.');
  if (!points.length) qualityIssues.push('No telemetry samples were received for this door.');
  if (context && (!Number.isFinite(context.timestamp) || context.chronologyValid === false)) reject('Movement timestamps or identifiers are not chronological and unique.');
  const identity = context ?? points[0];
  if (identity && points.some(point => point.cycleId !== identity.cycleId || point.doorId !== identity.doorId || point.direction !== identity.direction)) {
    reject('Sample door, movement identifier, or direction does not match the trace.');
  }
  if (points.some((point, index) => !Number.isFinite(point.timestamp)
    || (index > 0 && point.timestamp <= points[index - 1].timestamp)
    || (context && point.timestamp > context.timestamp))) {
    reject('Sample timestamps are out of order or later than movement completion.');
  }
  if (points.some(point => !Number.isFinite(point.travelPct) || point.travelPct < 0 || point.travelPct > 100
    || Math.abs(point.travelPct / SAMPLE_STEP_PCT - Math.round(point.travelPct / SAMPLE_STEP_PCT)) > 0.000001)) {
    reject(`Samples must follow the ${SAMPLE_STEP_PCT}% travel grid from 0% to 100%.`);
  }
  if (new Set(points.map(point => point.travelPct)).size !== points.length) reject('Duplicate travel positions were received; coverage is deduplicated.');
  if (points.some((point, index) => index > 0 && point.travelPct <= points[index - 1].travelPct)) reject('Travel positions are not in movement order.');
  if (points.some(point => point.current !== null && (!Number.isFinite(point.current) || point.current < 0))) reject('The trace contains invalid current values.');
  const validEnvelope = (point: DoorTelemetryPoint) => Number.isFinite(point.expectedLower)
    && Number.isFinite(point.expectedMedian) && Number.isFinite(point.expectedUpper)
    && point.expectedLower >= 0 && point.expectedUpper > point.expectedLower
    && point.expectedMedian >= point.expectedLower && point.expectedMedian <= point.expectedUpper;
  if (points.some(point => !validEnvelope(point))) reject('The healthy envelope contains invalid or inconsistent bounds.');
  const interval = points.filter(point => validRegion && point.travelPct >= regionStartPct && point.travelPct <= regionEndPct
    && Math.abs(point.travelPct / SAMPLE_STEP_PCT - Math.round(point.travelPct / SAMPLE_STEP_PCT)) <= 0.000001);
  const unique = [...new Map(interval.map(point => [point.travelPct, point])).values()].sort((a, b) => a.travelPct - b.travelPct);
  const observed = unique.filter((point): point is DoorTelemetryPoint & { current: number } => point.current !== null && Number.isFinite(point.current) && point.current >= 0 && validEnvelope(point));
  const requiredSampleCount = validRegion ? Math.floor((regionEndPct - regionStartPct) / SAMPLE_STEP_PCT) + 1 : 0;
  const coveragePct = round(clamp(observed.length / Math.max(requiredSampleCount, 1) * 100, 0, 100));
  if (observed.length < requiredSampleCount) qualityIssues.push(`${requiredSampleCount - observed.length} of ${requiredSampleCount} interval samples are missing or invalid.`);
  const sufficientEvidence = coveragePct >= 80 && validMetadata;
  const excess = observed.filter(point => point.current > point.expectedUpper);
  const peakCurrent = observed.length ? Math.max(...observed.map(point => point.current)) : null;
  const validBounds = unique.filter(validEnvelope);
  const expectedMaximum = validBounds.length ? Math.max(...validBounds.map(point => point.expectedUpper)) : null;
  const expectedMinimum = validBounds.length ? Math.min(...validBounds.map(point => point.expectedLower)) : null;
  const maxRelativeDeviation = observed.length
    ? Math.max(...observed.map(point => (point.current - point.expectedUpper) / Math.max(point.expectedUpper, 0.01)))
    : 0;
  const meanMedianDeviation = observed.length
    ? observed.reduce((sum, point) => sum + Math.abs(point.current - point.expectedMedian) / Math.max(point.expectedUpper - point.expectedLower, 0.01), 0) / observed.length
    : 0;
  let consecutiveExcess = 0;
  let maxConsecutiveExcess = 0;
  let previousTravel: number | null = null;
  for (const point of unique) {
    if (previousTravel !== null && point.travelPct - previousTravel > SAMPLE_STEP_PCT) consecutiveExcess = 0;
    consecutiveExcess = point.current !== null && Number.isFinite(point.current) && validEnvelope(point) && point.current > point.expectedUpper ? consecutiveExcess + 1 : 0;
    maxConsecutiveExcess = Math.max(maxConsecutiveExcess, consecutiveExcess);
    previousTravel = point.travelPct;
  }
  const excessFraction = excess.length / Math.max(observed.length, 1);
  const signaturePresent = sufficientEvidence && maxConsecutiveExcess >= 3 && excessFraction >= 0.6;
  const anomalyScore = Math.round(clamp(
    excess.length / Math.max(observed.length, 1) * 65
      + Math.max(0, maxRelativeDeviation) * 100
      + meanMedianDeviation * 4,
    0,
    99,
  ));

  return {
    anomalyScore,
    regionStartPct,
    regionEndPct,
    peakCurrent: peakCurrent === null ? null : round(peakCurrent, 2),
    expectedMaximum: expectedMaximum === null ? null : round(expectedMaximum, 2),
    expectedMinimum: expectedMinimum === null ? null : round(expectedMinimum, 2),
    deviationPct: observed.length ? round(Math.max(0, maxRelativeDeviation) * 100) : null,
    coveragePct,
    sampleCount: observed.length,
    requiredSampleCount,
    excessSampleCount: excess.length,
    maxConsecutiveExcess,
    excessFraction,
    qualityIssues,
    sufficientEvidence,
    signaturePresent,
  };
}

/** Bind sample metadata to the actual movement, rather than trusting the sample itself. */
export function evaluateCycleTrace(cycle: TelemetryCycle, doorId: string, chronologyValid = true): TraceEvaluation {
  return evaluateTrace(getDoorTelemetry(cycle, doorId), REGION_START_PCT, REGION_END_PCT, {
    cycleId: cycle.id, doorId, direction: cycle.direction, timestamp: cycle.timestamp, chronologyValid,
  });
}

function validCycleChronology(cycles: readonly TelemetryCycle[], index: number): boolean {
  const cycle = cycles[index];
  return Number.isFinite(cycle.timestamp)
    && cycles.slice(0, index).every(previous => previous.timestamp < cycle.timestamp && previous.id !== cycle.id);
}

function makePrediction(cycle: TelemetryCycle, doorId: string): RailWitnessPrediction {
  return {
    predictionId: `RW-${cycle.id}-${doorId}`,
    issuedAt: cycle.timestamp,
    issuedAtLabel: cycle.timestampLabel,
    issuedCycleId: cycle.id,
    doorId,
    description: 'Persistent abnormal resistance during late-stage door closure',
    targetDirection: 'close',
    regionStartPct: REGION_START_PCT,
    regionEndPct: REGION_END_PCT,
    expectedCondition: 'Motor current should persistently exceed the synthetic healthy envelope at 60–80% travel during the next eligible closing movement.',
    status: 'awaiting',
    recommendation: 'Await the next closing movement to test this advisory prediction.',
    attempts: [],
  };
}

/** Accept only already-visible cycles. Opening movements cannot resolve a closing prediction. */
export function derivePrediction(visibleCycles: readonly TelemetryCycle[], doorId = ANOMALY_DOOR_ID): RailWitnessPrediction | null {
  const issuedIndex = visibleCycles.findIndex((cycle, index) => cycle.direction === 'close'
    && evaluateCycleTrace(cycle, doorId, validCycleChronology(visibleCycles, index)).signaturePresent);
  if (issuedIndex < 0) return null;
  const prediction = makePrediction(visibleCycles[issuedIndex], doorId);
  const attempts: VerificationEvidence[] = [];
  for (let index = issuedIndex + 1; index < visibleCycles.length; index++) {
    const cycle = visibleCycles[index];
    if (cycle.direction !== prediction.targetDirection) continue;
    const evaluation = evaluateCycleTrace(cycle, doorId, validCycleChronology(visibleCycles, index));
    const status: VerificationOutcome = !evaluation.sufficientEvidence
      ? 'insufficient_evidence'
      : evaluation.signaturePresent ? 'corroborated' : 'not_corroborated';
    const summary = status === 'insufficient_evidence'
      ? `Cannot assess this movement: ${evaluation.sampleCount}/${evaluation.requiredSampleCount} valid interval samples. ${evaluation.qualityIssues.join(' ')}`
      : status === 'corroborated'
        ? `Signature reproduced: ${evaluation.peakCurrent?.toFixed(1)} A peak versus ${evaluation.expectedMaximum?.toFixed(1)} A expected maximum at 60–80% closure; ${evaluation.maxConsecutiveExcess} consecutive excess samples.`
        : evaluation.excessSampleCount > 0
          ? `Persistent signature did not recur: ${evaluation.excessSampleCount}/${evaluation.sampleCount} samples exceeded the envelope (${evaluation.peakCurrent?.toFixed(2)} A peak), but the persistence criteria were not met.`
          : `Signature did not recur: ${evaluation.peakCurrent?.toFixed(2)} A peak stayed within the ${evaluation.expectedMaximum?.toFixed(1)} A expected maximum at 60–80% closure.`;
    attempts.push({ cycleId: cycle.id, timestamp: cycle.timestamp, timestampLabel: cycle.timestampLabel, direction: cycle.direction, evaluation, status, summary });
  }
  const verification = attempts[0];
  if (!verification) return prediction;
  const { status, summary } = verification;

  return {
    ...prediction,
    status,
    observedEvidence: summary,
    verification,
    attempts,
    latestAttempt: attempts[attempts.length - 1],
    recommendation: status === 'corroborated'
      ? `Inspect Door ${doorId} under the applicable maintenance procedure. This advisory does not identify a confirmed mechanical fault.`
      : status === 'not_corroborated'
        ? `Continue monitoring Door ${doorId}. One non-recurrence does not establish mechanical condition.`
        : `Check telemetry completeness for Door ${doorId} and collect another eligible closing movement before assessing the prediction.`,
  };
}

export function getReplaySnapshot(cycles: readonly TelemetryCycle[], requestedIndex: number): ReplaySnapshot {
  if (!cycles.length) throw new Error('Replay requires at least one telemetry cycle.');
  const currentIndex = clamp(Number.isFinite(requestedIndex) ? Math.floor(requestedIndex) : 0, 0, cycles.length - 1);
  const visibleCycles = cycles.slice(0, currentIndex + 1);
  const currentCycle = visibleCycles[visibleCycles.length - 1];
  const predictions = DOOR_IDS.map(id => derivePrediction(visibleCycles, id)).filter((prediction): prediction is RailWitnessPrediction => prediction !== null);
  const prediction = predictions.find(item => item.doorId === ANOMALY_DOOR_ID) ?? predictions[0] ?? null;
  const predictionByDoor = new Map(predictions.map(item => [item.doorId, item]));
  const doors: DoorHealth[] = DOOR_IDS.map((id, index) => {
    const evaluation = evaluateCycleTrace(currentCycle, id, validCycleChronology(visibleCycles, currentIndex));
    const doorPrediction = predictionByDoor.get(id);
    const latestStatus = doorPrediction?.latestAttempt?.status ?? doorPrediction?.status;
    // Current data loss is visible immediately; otherwise fleet state follows the latest eligible assessment.
    const status = !evaluation.sufficientEvidence ? 'insufficient_evidence'
      : doorPrediction
        ? latestStatus === 'awaiting'
          ? currentCycle.id === doorPrediction.issuedCycleId ? 'candidate' : 'awaiting_verification'
          : latestStatus!
        : 'normal';
    return {
      id,
      status,
      anomalyScore: evaluation.anomalyScore,
      lastUpdated: currentCycle.timestampLabel,
      direction: currentCycle.direction,
      car: Math.floor(index / 8) + 1,
      side: index % 8 < 4 ? 'left' : 'right',
      position: index % 4,
      dataQuality: evaluation.sufficientEvidence ? 'sufficient' : 'insufficient_evidence',
      qualityIssues: evaluation.qualityIssues,
    };
  });
  const activeDoors = doors.filter(door => door.status !== 'normal' && door.status !== 'not_corroborated');
  const activeScores = activeDoors.map(door => {
    const doorPrediction = predictionByDoor.get(door.id);
    const issuedCycle = doorPrediction ? visibleCycles.find(cycle => cycle.id === doorPrediction.issuedCycleId) : undefined;
    return issuedCycle ? evaluateCycleTrace(issuedCycle, door.id).anomalyScore : 0;
  });

  return {
    currentIndex,
    currentCycle,
    visibleCycles,
    prediction,
    predictions,
    doors,
    // Demo index derived from the active deviation; not an operational fleet-health metric.
    healthPct: Math.round(clamp(100 - activeScores.reduce((sum, score) => sum + score, 0) * 0.09, 0, 100)),
    advisoryCount: activeDoors.length,
  };
}

export function createReplayState(currentIndex = INITIAL_CYCLE_INDEX): ReplayState {
  return { currentIndex, hideFutureData: true, playing: false };
}

/** Seeking rewinds evidence as well as the waveform. A visibility toggle never verifies a prediction. */
export function reduceReplay(state: ReplayState, action: ReplayAction, cycles: readonly TelemetryCycle[]): ReplayState {
  const finalIndex = Math.max(0, cycles.length - 1);
  switch (action.type) {
    case 'play':
      return { ...state, playing: state.currentIndex < finalIndex };
    case 'pause':
      return { ...state, playing: false };
    case 'set-hide-future':
      return { ...state, hideFutureData: action.value };
    case 'reset':
      return { ...createReplayState(clamp(action.index ?? INITIAL_CYCLE_INDEX, 0, finalIndex)), hideFutureData: state.hideFutureData };
    case 'seek':
      return { ...state, currentIndex: clamp(Number.isFinite(action.index) ? Math.floor(action.index) : 0, 0, finalIndex), playing: false };
    case 'step':
    case 'reveal': {
      const currentIndex = Math.min(state.currentIndex + 1, finalIndex);
      const before = getReplaySnapshot(cycles, state.currentIndex).predictions;
      const after = getReplaySnapshot(cycles, currentIndex).predictions;
      const previousById = new Map(before.map(prediction => [prediction.predictionId, prediction]));
      const predictionIssued = after.some(prediction => !previousById.has(prediction.predictionId));
      const predictionResolved = after.some(prediction => previousById.get(prediction.predictionId)?.status === 'awaiting'
        && prediction.status !== 'awaiting');
      return {
        ...state,
        currentIndex,
        playing: action.type === 'reveal' || predictionIssued || predictionResolved || currentIndex === finalIndex ? false : state.playing,
      };
    }
  }
}

export function formatDirection(direction: 'open' | 'close'): string {
  return direction === 'close' ? 'Closing' : 'Opening';
}

export function formatDoorStatus(status: DoorHealth['status']): string {
  const labels: Record<DoorHealth['status'], string> = {
    normal: 'Normal',
    candidate: 'Candidate anomaly',
    awaiting_verification: 'Awaiting verification',
    corroborated: 'Corroborated',
    not_corroborated: 'Unconfirmed',
    insufficient_evidence: 'Insufficient evidence',
  };
  return labels[status];
}
