import type { SubsystemVisualState } from '../../types/visualization';

export const REPRESENTATIVE_DOOR = { carOrdinal: 4, localX: 1.05, y: 1.94, z: 1.26 } as const;

export function unitProgress(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

export function scanCarOrdinal(visualization?: SubsystemVisualState) {
  if (visualization?.analysisPhase !== 'scanning') return 0;
  return Math.min(8, Math.floor(unitProgress(visualization.scanProgress) * 8) + 1);
}

/** A visual rank scale, not a calibrated probability or a binary diagnosis. */
export function rankEmphasis(rank: number) {
  if (!Number.isInteger(rank) || rank < 1 || rank > 8) return 0;
  return [0, .65, .40, .23, .075, .06, .045, .03, .02][rank];
}

export function doorOpeningFraction(door: SubsystemVisualState['door'], reducedMotion: boolean) {
  if (!door || door.operation === 'Unknown') return 0;
  const progress = reducedMotion ? Number(door.completed) : unitProgress(door.progress);
  return door.operation === 'Open' ? progress : 1 - progress;
}

export function completedDoorAbnormal(door: SubsystemVisualState['door']) {
  return Boolean(door?.completed && door.prediction === 'Abnormal resistance');
}
