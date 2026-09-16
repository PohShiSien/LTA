/** All demo values are synthetic. Replace the telemetry adapter with model/API data. */
export type MovementDirection = 'open' | 'close';

export type VerificationOutcome =
  | 'corroborated'
  | 'not_corroborated'
  | 'insufficient_evidence';

export type DemoScenario = VerificationOutcome | 'intermittent' | 'drift' | 'isolated_spike';
export type PredictionStatus = 'awaiting' | VerificationOutcome;

export type DoorStatus =
  | 'normal'
  | 'candidate'
  | 'awaiting_verification'
  | VerificationOutcome;

export interface DoorTelemetryPoint {
  timestamp: number;
  cycleId: string;
  doorId: string;
  direction: MovementDirection;
  travelPct: number;
  /** null is a missing sample; never interpret it as zero current. */
  current: number | null;
  expectedMedian: number;
  expectedLower: number;
  expectedUpper: number;
}

export interface TelemetryCycle {
  id: string;
  /** Movement completion time: every sample is available at this instant. */
  timestamp: number;
  timestampLabel: string;
  direction: MovementDirection;
  /** Labels describe the observed movement, not its future interpretation. */
  label: string;
  telemetry: Record<string, DoorTelemetryPoint[]>;
}

export interface DoorHealth {
  id: string;
  status: DoorStatus;
  anomalyScore: number;
  lastUpdated: string;
  direction: MovementDirection;
  car: number;
  side: 'left' | 'right';
  position: number;
  dataQuality: 'sufficient' | 'insufficient_evidence';
  qualityIssues: string[];
}

export interface TraceEvaluation {
  /** 0–100 descriptive deviation index, not a model probability. */
  anomalyScore: number;
  regionStartPct: number;
  regionEndPct: number;
  peakCurrent: number | null;
  expectedMaximum: number | null;
  expectedMinimum: number | null;
  deviationPct: number | null;
  coveragePct: number;
  sampleCount: number;
  requiredSampleCount: number;
  excessSampleCount: number;
  maxConsecutiveExcess: number;
  /** Proportion of observed interval samples above the envelope, from 0 to 1. */
  excessFraction: number;
  qualityIssues: string[];
  sufficientEvidence: boolean;
  signaturePresent: boolean;
}

export interface VerificationEvidence {
  cycleId: string;
  timestamp: number;
  timestampLabel: string;
  direction: MovementDirection;
  evaluation: TraceEvaluation;
  status: VerificationOutcome;
  summary: string;
}

export interface RailWitnessPrediction {
  predictionId: string;
  issuedAt: number;
  issuedAtLabel: string;
  issuedCycleId: string;
  doorId: string;
  description: string;
  targetDirection: MovementDirection;
  regionStartPct: number;
  regionEndPct: number;
  expectedCondition: string;
  status: PredictionStatus;
  observedEvidence?: string;
  recommendation: string;
  verification?: VerificationEvidence;
  /** The original next-movement assertion is immutable; later assessments are follow-ups. */
  attempts: VerificationEvidence[];
  latestAttempt?: VerificationEvidence;
}

export interface ReplaySnapshot {
  currentIndex: number;
  currentCycle: TelemetryCycle;
  /** The sole source for chronology-sensitive UI: excludes every future cycle. */
  visibleCycles: TelemetryCycle[];
  prediction: RailWitnessPrediction | null;
  predictions: RailWitnessPrediction[];
  doors: DoorHealth[];
  healthPct: number;
  advisoryCount: number;
}

export interface ReplayState {
  currentIndex: number;
  hideFutureData: boolean;
  playing: boolean;
}

export type ReplayAction =
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'step' }
  | { type: 'reveal' }
  | { type: 'seek'; index: number }
  | { type: 'set-hide-future'; value: boolean }
  | { type: 'reset'; index?: number };
