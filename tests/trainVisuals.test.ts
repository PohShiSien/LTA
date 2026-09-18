import { describe, expect, it } from 'vitest';
import type { SubsystemVisualState } from '../src/types/visualization';
import { completedDoorAbnormal, doorOpeningFraction, rankEmphasis, scanCarOrdinal, unitProgress } from '../src/components/train/subsystemVisuals';

const cycle: NonNullable<SubsystemVisualState['door']> = { cycleNumber: 7, operation: 'Open', progress: .4, completed: false, prediction: 'Abnormal resistance' };

describe('subsystem scene truth and motion boundaries', () => {
  it('withholds the abnormal visual until a recorded cycle has completed', () => {
    expect(completedDoorAbnormal(cycle)).toBe(false);
    expect(completedDoorAbnormal({ ...cycle, completed: true })).toBe(true);
    expect(completedDoorAbnormal({ ...cycle, completed: true, prediction: 'Normal' })).toBe(false);
  });
  it('uses only known movement direction and stops sliding with reduced motion', () => {
    expect(doorOpeningFraction(cycle, false)).toBe(.4);
    expect(doorOpeningFraction({ ...cycle, operation: 'Close' }, false)).toBe(.6);
    expect(doorOpeningFraction({ ...cycle, operation: 'Unknown' }, false)).toBe(0);
    expect(doorOpeningFraction(cycle, true)).toBe(0);
    expect(doorOpeningFraction({ ...cycle, completed: true }, true)).toBe(1);
  });
  it('scans all eight schematic cars without changing their source identifiers', () => {
    expect(scanCarOrdinal()).toBe(0);
    expect(scanCarOrdinal({ analysisPhase: 'scanning', scanProgress: 0 })).toBe(1);
    expect(scanCarOrdinal({ analysisPhase: 'scanning', scanProgress: .5 })).toBe(5);
    expect(scanCarOrdinal({ analysisPhase: 'scanning', scanProgress: 1 })).toBe(8);
    expect(scanCarOrdinal({ analysisPhase: 'settled', scanProgress: 1 })).toBe(0);
  });
  it('uses a descending rank scale and handles invalid animation values safely', () => {
    const strengths = Array.from({ length: 8 }, (_, index) => rankEmphasis(index + 1));
    expect(strengths.every((strength, index) => index === 0 || strength < strengths[index - 1])).toBe(true);
    expect(rankEmphasis(0)).toBe(0);
    expect(rankEmphasis(9)).toBe(0);
    expect(unitProgress(Infinity)).toBe(0);
    expect(unitProgress(-1)).toBe(0);
    expect(unitProgress(2)).toBe(1);
  });
});
