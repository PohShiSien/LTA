import { describe, expect, it } from 'vitest';
import type { SubsystemVisualState } from '../src/types/visualization';
import { completedDoorAbnormal, doorOpeningFraction, unitProgress } from '../src/components/train/subsystemVisuals';

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
  it('handles invalid animation values safely', () => {
    expect(unitProgress(Infinity)).toBe(0);
    expect(unitProgress(-1)).toBe(0);
    expect(unitProgress(2)).toBe(1);
  });
});
