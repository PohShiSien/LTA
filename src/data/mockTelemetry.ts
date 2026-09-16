import type {
  DemoScenario,
  DoorTelemetryPoint,
  MovementDirection,
  TelemetryCycle,
} from '../types/railwitness';

export const TRAIN_ID = '017';
export const TRAIN_LINE = 'North–South Line';
export const ANOMALY_DOOR_ID = 'D07';
export const REGION_START_PCT = 60;
export const REGION_END_PCT = 80;
export const SAMPLE_STEP_PCT = 2;
export const HISTORY_CYCLE_COUNT = 12;
export const INITIAL_CYCLE_INDEX = HISTORY_CYCLE_COUNT + 4;
export const CANDIDATE_CYCLE_INDEX = HISTORY_CYCLE_COUNT + 4;
export const VERIFICATION_CYCLE_INDEX = HISTORY_CYCLE_COUNT + 6;
export const DOOR_IDS = Array.from({ length: 24 }, (_, index) => `D${String(index + 1).padStart(2, '0')}`);
export const SCENARIOS: { value: DemoScenario; label: string; description: string }[] = [
  { value: 'corroborated', label: 'Signature recurs', description: 'Elevated current recurs during the next closing movement.' },
  { value: 'not_corroborated', label: 'Signature clears', description: 'The next closing movement stays within its healthy envelope.' },
  { value: 'insufficient_evidence', label: 'Missing samples', description: 'A telemetry gap prevents verification of the next closing movement.' },
  { value: 'intermittent', label: 'Intermittent recurrence', description: 'The next movement clears, followed by alternating recurrence and recovery.' },
  { value: 'drift', label: 'Gradual current drift', description: 'Closing current rises progressively across the recorded session.' },
  { value: 'isolated_spike', label: 'Isolated current spikes', description: 'Later peaks exceed the envelope but fail the persistence criteria.' },
];

const CYCLE_SCHEDULE: { time: string; direction: MovementDirection }[] = [
  { time: '14:03:04', direction: 'close' },
  { time: '14:04:00', direction: 'open' },
  { time: '14:05:04', direction: 'close' },
  { time: '14:06:00', direction: 'open' },
  { time: '14:07:04', direction: 'close' },
  { time: '14:08:00', direction: 'open' },
  { time: '14:09:04', direction: 'close' },
  { time: '14:10:00', direction: 'open' },
  { time: '14:11:04', direction: 'close' },
  { time: '14:12:00', direction: 'open' },
  { time: '14:13:04', direction: 'close' },
  { time: '14:14:00', direction: 'open' },
  { time: '14:15:04', direction: 'close' },
  { time: '14:16:12', direction: 'open' },
  { time: '14:16:38', direction: 'close' },
  { time: '14:18:56', direction: 'open' },
  { time: '14:19:22', direction: 'close' },
  { time: '14:20:37', direction: 'open' },
  { time: '14:21:03', direction: 'close' },
  { time: '14:22:18', direction: 'open' },
  { time: '14:22:46', direction: 'close' },
  { time: '14:24:02', direction: 'open' },
  { time: '14:24:28', direction: 'close' },
  { time: '14:25:44', direction: 'open' },
  { time: '14:26:10', direction: 'close' },
  { time: '14:27:26', direction: 'open' },
  { time: '14:27:52', direction: 'close' },
  { time: '14:29:08', direction: 'open' },
  { time: '14:29:34', direction: 'close' },
  { time: '14:30:50', direction: 'open' },
  { time: '14:31:16', direction: 'close' },
  { time: '14:32:32', direction: 'open' },
  { time: '14:32:58', direction: 'close' },
  { time: '14:34:14', direction: 'open' },
  { time: '14:34:40', direction: 'close' },
  { time: '14:35:56', direction: 'open' },
  { time: '14:36:22', direction: 'close' },
];

const CLOSING_MEDIAN_ANCHORS = [
  [0, 0.48], [6, 1.6], [14, 3.75], [22, 3.4], [35, 2.75],
  [50, 2.97], [60, 3.15], [80, 3.15], [90, 2.25], [100, 0.45],
];

function interpolateMedian(travel: number): number {
  for (let index = 1; index < CLOSING_MEDIAN_ANCHORS.length; index++) {
    const [rightTravel, rightValue] = CLOSING_MEDIAN_ANCHORS[index];
    const [leftTravel, leftValue] = CLOSING_MEDIAN_ANCHORS[index - 1];
    if (travel <= rightTravel) {
      const weight = (travel - leftTravel) / (rightTravel - leftTravel);
      return leftValue + (rightValue - leftValue) * weight;
    }
  }
  return 0.45;
}

const round = (value: number) => Math.round(value * 1000) / 1000;

/** A repeatable signal fixture, not real LTA data or a trained diagnostic model. */
export function createDemoCycles(scenario: DemoScenario = 'corroborated'): TelemetryCycle[] {
  return CYCLE_SCHEDULE.map(({ time, direction }, scheduleIndex) => {
    // Keep the original C001–C009 fixture exactly reproducible after adding history.
    const cycleIndex = scheduleIndex - HISTORY_CYCLE_COUNT;
    const timestamp = Date.parse(`2026-09-16T${time}+08:00`);
    const id = cycleIndex < 0 ? `H${String(scheduleIndex + 1).padStart(3, '0')}` : `C${String(cycleIndex + 1).padStart(3, '0')}`;
    const telemetry: Record<string, DoorTelemetryPoint[]> = {};

    for (let doorIndex = 0; doorIndex < DOOR_IDS.length; doorIndex++) {
      const doorId = DOOR_IDS[doorIndex];
      const isCandidate = doorId === ANOMALY_DOOR_ID && scheduleIndex === CANDIDATE_CYCLE_INDEX;
      const isVerification = doorId === ANOMALY_DOOR_ID && scheduleIndex >= VERIFICATION_CYCLE_INDEX && direction === 'close';
      const secondaryRecurrence = doorId === 'D12' && cycleIndex >= 12 && direction === 'close';
      const recurring = isVerification && (
        scenario === 'corroborated'
        || (scenario === 'intermittent' && cycleIndex % 4 === 0)
        || (scenario === 'insufficient_evidence' && cycleIndex >= 10)
      );
      const durationMs = cycleIndex < 9 ? 4500 : 4500 + Math.max(0, cycleIndex - 8) * (doorId === ANOMALY_DOOR_ID ? 32 : 2);
      telemetry[doorId] = Array.from({ length: 100 / SAMPLE_STEP_PCT + 1 }, (_, sampleIndex) => {
        const travelPct = sampleIndex * SAMPLE_STEP_PCT;
        const inRegion = travelPct >= REGION_START_PCT && travelPct <= REGION_END_PCT;
        const closingMedian = interpolateMedian(travelPct);
        const expectedMedian = round(direction === 'close' ? closingMedian : closingMedian * 0.81);
        const expectedLower = round(Math.max(0, inRegion && direction === 'close' ? 2.8 : expectedMedian - 0.32));
        const expectedUpper = round(inRegion && direction === 'close' ? 3.5 : expectedMedian + 0.35);
        const jitter = Math.sin(sampleIndex * 1.31 + doorIndex * 0.43 + cycleIndex * 0.77) * 0.055;
        let current: number | null = round(expectedMedian + jitter + Math.sin(travelPct / 9 + doorIndex) * 0.055);

        if (inRegion && (isCandidate || recurring || secondaryRecurrence)) {
          const peak = isCandidate ? 4.2 : 4.1;
          current = round(peak - 0.16 * Math.abs(travelPct - 70) / 10);
        }
        if (inRegion && doorId === ANOMALY_DOOR_ID && direction === 'close' && scenario === 'drift' && cycleIndex >= 0) {
          current = round(3.25 + cycleIndex * 0.09 - 0.045 * Math.abs(travelPct - 70) / 10);
        }
        if (isVerification && scenario === 'isolated_spike' && travelPct === 70) current = 5.4;
        // A conspicuous gap deliberately includes the entire predicted interval.
        if (isVerification && scenario === 'insufficient_evidence' && cycleIndex < 10 && travelPct >= 58 && travelPct <= 82) {
          current = null;
        }
        if (doorId === 'D19' && cycleIndex === 16) current = null;

        return {
          timestamp: timestamp - Math.round((1 - sampleIndex / (100 / SAMPLE_STEP_PCT)) * durationMs),
          cycleId: id,
          doorId,
          direction,
          travelPct,
          current,
          expectedMedian,
          expectedLower,
          expectedUpper,
        };
      });
    }

    return {
      id,
      timestamp,
      timestampLabel: time,
      direction,
      label: direction === 'close' ? 'Closing movement' : 'Opening movement',
      telemetry,
    };
  });
}

export const DEMO_CYCLES = createDemoCycles();
