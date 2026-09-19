import type { ComponentSelection } from '../types/multisystem';

/** Schematic geometry convention; topology and channel order follow Rail kit §2.1 / Figure 2. */
export const CAR_COUNT = 8;
export const CAR_LENGTH = 9;
export const CAR_GAP = .5;
export const CAR_PITCH = CAR_LENGTH + CAR_GAP;
export const TRAIN_LENGTH = CAR_COUNT * CAR_LENGTH + (CAR_COUNT - 1) * CAR_GAP;
export type RailSide = 'Side I' | 'Side II';
export type Position3 = readonly [number, number, number];

function validateOrdinal(value: number, label: string) {
  if (!Number.isInteger(value) || value < 1 || value > 8) throw new RangeError(`${label} must be an integer from 1 to 8`);
}

export function railChannelIndexes(carOrdinal: number, position: number) {
  validateOrdinal(carOrdinal, 'Rail car ordinal');
  validateOrdinal(position, 'Axle-box position');
  const vibration = 1 + 2 * ((carOrdinal - 1) * 8 + position - 1);
  return { vibration, shock: vibration + 1, side: position % 2 === 1 ? 'Side I' as const : 'Side II' as const };
}

export function carCenterX(ordinal: number) {
  validateOrdinal(ordinal, 'Car ordinal');
  return (ordinal - (CAR_COUNT + 1) / 2) * CAR_PITCH;
}

/** Sort exact identifiers, never a leak ranking. The resulting order is schematic. */
export function referenceCarIds(carIds: readonly string[]): string[] {
  if (!carIds.length) return Array.from({ length: CAR_COUNT }, (_, index) => String(index + 1).padStart(2, '0'));
  if (carIds.length !== CAR_COUNT || new Set(carIds).size !== CAR_COUNT || carIds.some(id => !id.trim())) {
    throw new RangeError('The reference consist needs exactly eight unique, non-empty car identifiers');
  }
  return [...carIds].sort((a,b) => a.localeCompare(b, 'en', { numeric: true }) || a.localeCompare(b, 'en'));
}

export const RAIL_SIDES: readonly { side: RailSide; z: number }[] = Object.freeze([
  { side: 'Side I', z: -.91 },
  { side: 'Side II', z: .91 },
]);

export interface AxleBoxAnchor {
  id: string;
  carOrdinal: number;
  position: number;
  side: RailSide;
  bogie: 1 | 2;
  pair: number;
  localPosition: Position3;
  worldPosition: Position3;
  vibrationIndex: number;
  shockIndex: number;
}

const AXLE_PAIR_OFFSETS = [-.38, -.23, .23, .38];
export const RAIL_AXLE_BOXES: readonly AxleBoxAnchor[] = Object.freeze(Array.from({ length: 64 }, (_, index) => {
  const carOrdinal = Math.floor(index / 8) + 1;
  const position = index % 8 + 1;
  const pair = Math.floor((position - 1) / 2);
  const channels = railChannelIndexes(carOrdinal, position);
  const localPosition: Position3 = [AXLE_PAIR_OFFSETS[pair] * CAR_LENGTH, .43, channels.side === 'Side I' ? -1.15 : 1.15];
  return Object.freeze({
    id: `C${carOrdinal}:P${position}`,
    carOrdinal, position, side: channels.side,
    bogie: (position <= 4 ? 1 : 2) as 1 | 2,
    pair: pair + 1,
    localPosition: Object.freeze(localPosition),
    worldPosition: Object.freeze([carCenterX(carOrdinal) + localPosition[0], localPosition[1], localPosition[2]]) as Position3,
    vibrationIndex: channels.vibration,
    shockIndex: channels.shock,
  });
}));

export function selectedCarOrdinal(selection: ComponentSelection, carIds: readonly string[]): number | null {
  if (selection.kind === 'axleBox') {
    validateOrdinal(selection.carOrdinal, 'Rail car ordinal');
    validateOrdinal(selection.position, 'Axle-box position');
    return selection.carOrdinal;
  }
  if (selection.kind === 'car') {
    const index = carIds.indexOf(selection.carId);
    return index >= 0 ? index + 1 : null;
  }
  return null;
}
