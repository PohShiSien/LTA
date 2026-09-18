/** Recording-local cycles. `index` is never a physical door identifier. */
export interface DoorReplayCycle {
  index: number;
  startTime: string;
  endTime: string;
  startIndex: number;
  endIndex: number;
  prediction: 'Normal' | 'Abnormal resistance';
  operation: 'Open' | 'Close' | 'Unknown';
}

export const DOOR_REPLAY_DURATION_MS = 1500;
export const DOOR_REPLAY_RESULT_HOLD_MS = 500;

export function clampDoorProgress(progress: number): number {
  return Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
}

/** Source row order is stable even for unparseable or repeated source timestamps. */
export function chronologicalDoorCycles(cycles: readonly DoorReplayCycle[]): DoorReplayCycle[] {
  return [...cycles].sort((a, b) => a.startIndex - b.startIndex || a.index - b.index);
}

export function doorReplayProgress(elapsedMs: number): number {
  return clampDoorProgress(elapsedMs / DOOR_REPLAY_DURATION_MS);
}

/** Purely illustrative slide distance, not a reconstructed physical position. */
export function doorMotionOpenness(operation: DoorReplayCycle['operation'], progress: number): number | null {
  const value = clampDoorProgress(progress);
  if (operation === 'Open') return value;
  if (operation === 'Close') return 1 - value;
  return null;
}

export function doorCycleResultVisible(cyclePosition: number, selectedPosition: number, playing: boolean, progress: number): boolean {
  if (!playing && progress >= 1) return true;
  return cyclePosition < selectedPosition || (cyclePosition === selectedPosition && progress >= 1);
}
