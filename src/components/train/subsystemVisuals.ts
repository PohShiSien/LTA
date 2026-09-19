import type { SubsystemVisualState } from '../../types/visualization';

export const REPRESENTATIVE_DOOR = { carOrdinal: 4, localX: 1.05, y: 1.94, z: 1.26 } as const;

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
