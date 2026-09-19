import type { SubsystemVisualState } from '../../types/visualization';

export const REPRESENTATIVE_DOOR = { carOrdinal: 4, localX: 1.05, y: 1.94, z: 1.26 } as const;

// Provisional display bands; the trained SHM model supplies no risk cutoffs.
export const SHM_RISK_BANDS = [
  { id: 'green', label: 'Lower risk', color: '#75dfac', minimum: 0, maximum: .33, range: '0 ≤ value < 0.33' },
  { id: 'yellow', label: 'Moderate risk', color: '#f4d35e', minimum: .33, maximum: .67, range: '0.33 ≤ value < 0.67' },
  { id: 'red', label: 'Higher risk', color: '#ff8585', minimum: .67, maximum: Infinity, range: '0.67 ≤ value' },
] as const;

export function shmRiskBand(value: number | null | undefined) {
  return value != null && Number.isFinite(value) ? SHM_RISK_BANDS.find(band => value >= band.minimum && value < band.maximum) : undefined;
}

export function unitProgress(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

export function doorOpeningFraction(door: SubsystemVisualState['door'], reducedMotion: boolean) {
  if (!door || door.operation === 'Unknown') return 0;
  const progress = reducedMotion ? Number(door.completed) : unitProgress(door.progress);
  return door.operation === 'Open' ? progress : 1 - progress;
}

export function completedDoorAbnormal(door: SubsystemVisualState['door']) {
  return Boolean(door?.completed && door.prediction === 'Abnormal resistance');
}
