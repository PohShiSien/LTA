import { describe, expect, it } from 'vitest';
import {
  CAR_COUNT, CAR_LENGTH, CAR_PITCH, RAIL_AXLE_BOXES,
  RAIL_SIDES, carCenterX, railChannelIndexes,
  referenceCarIds, selectedCarOrdinal,
} from '../src/lib/topology';

describe('documented eight-car reference topology', () => {
  it('maps the exact first and last channel pairs with zero-based indexing', () => {
    expect(railChannelIndexes(1, 1)).toEqual({ vibration: 1, shock: 2, side: 'Side I' });
    expect(railChannelIndexes(8, 8)).toEqual({ vibration: 127, shock: 128, side: 'Side II' });
  });
  it.each([0, 9, -1, 1.5, NaN, Infinity])('rejects invalid car and axle ordinals: %s', value => {
    expect(() => railChannelIndexes(value, 1)).toThrow(RangeError);
    expect(() => railChannelIndexes(1, value)).toThrow(RangeError);
  });
  it('has eight distinct cars and eight unique anchors per car', () => {
    expect(CAR_COUNT).toBe(8);
    expect(RAIL_AXLE_BOXES).toHaveLength(64);
    expect(new Set(RAIL_AXLE_BOXES.map(anchor => anchor.id)).size).toBe(64);
    for (let car = 1; car <= CAR_COUNT; car++) {
      expect(RAIL_AXLE_BOXES.filter(anchor => anchor.carOrdinal === car).map(anchor => anchor.position)).toEqual([1,2,3,4,5,6,7,8]);
    }
    expect(new Set(Array.from({ length: CAR_COUNT }, (_, index) => carCenterX(index + 1))).size).toBe(8);
    expect(carCenterX(2) - carCenterX(1)).toBe(CAR_PITCH);
    expect(carCenterX(1)).toBe(-carCenterX(8));
  });
  it('assigns 32 anchors to each stable model-local rail side', () => {
    expect(RAIL_SIDES).toHaveLength(2);
    for (const side of ['Side I', 'Side II'] as const) {
      const anchors = RAIL_AXLE_BOXES.filter(anchor => anchor.side === side);
      expect(anchors).toHaveLength(32);
      for (const anchor of anchors) {
        expect(anchor.position % 2 === 1).toBe(side === 'Side I');
        expect(Math.sign(anchor.localPosition[2])).toBe(side === 'Side I' ? -1 : 1);
        // Side identity depends on immutable topology, never camera orientation.
        const rotatedZ = -anchor.worldPosition[2];
        expect(Math.sign(rotatedZ)).toBe(side === 'Side I' ? 1 : -1);
        expect(anchor.side).toBe(side);
      }
    }
  });
  it('reproduces Figure 2 axle pair order and two bogie groups', () => {
    const anchors = RAIL_AXLE_BOXES.filter(anchor => anchor.carOrdinal === 1);
    const offsets = [-.38, -.23, .23, .38].map(offset => offset * CAR_LENGTH);
    anchors.forEach((anchor, index) => {
      expect(anchor.localPosition[0]).toBeCloseTo(offsets[Math.floor(index / 2)]);
      expect(anchor.bogie).toBe(index < 4 ? 1 : 2);
      expect(anchor.pair).toBe(Math.floor(index / 2) + 1);
      expect(anchor.worldPosition[0]).toBeCloseTo(carCenterX(1) + anchor.localPosition[0]);
    });
  });
  it('addresses each of 128 measurement columns once and keeps speed separate', () => {
    const columns = RAIL_AXLE_BOXES.flatMap(anchor => [anchor.vibrationIndex, anchor.shockIndex]);
    expect(columns.sort((a,b) => a-b)).toEqual(Array.from({ length: 128 }, (_, index) => index + 1));
    expect(columns).not.toContain(0);
    const anchor = RAIL_AXLE_BOXES.find(item => item.carOrdinal === 3 && item.position === 5)!;
    expect([anchor.vibrationIndex, anchor.shockIndex]).toEqual([41,42]);
  });
  it('keeps exact car identifiers in a deterministic schematic order', () => {
    const ids = ['08','02','01','04','03','06','05','07'];
    expect(referenceCarIds(ids)).toEqual(['01','02','03','04','05','06','07','08']);
    expect(ids[0]).toBe('08');
    expect(referenceCarIds([])).toEqual(['01','02','03','04','05','06','07','08']);
    expect(() => referenceCarIds(['01','01'])).toThrow(RangeError);
  });
  it('resolves selected cars by identity or documented axle ordinal', () => {
    const ids = referenceCarIds([]);
    expect(selectedCarOrdinal({ kind: 'axleBox', carOrdinal: 3, position: 5 }, ids)).toBe(3);
    expect(selectedCarOrdinal({ kind: 'car', carId: '06', ordinal: 6 }, ids)).toBe(6);
    expect(selectedCarOrdinal({ kind: 'recording' }, ids)).toBeNull();
    expect(selectedCarOrdinal({ kind: 'railSide', side: 'Side I' }, ids)).toBeNull();
    expect(selectedCarOrdinal({ kind: 'car', carId: 'unknown', ordinal: 3 }, ids)).toBeNull();
  });
});
