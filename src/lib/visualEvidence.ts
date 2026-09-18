import type { DisplayField, Recording } from '../types/multisystem';
import { getTrainedModel, numeric, shmFeatures } from './inference';
import { amplitudeSpectrum, type SpectrumPoint } from './signals';

export interface AcvCarEvidence {
  carId: string;
  indoorMean: number | null;
  targetMean: number | null;
  residualMean: number | null;
  peerDeviation: number | null;
  coolingResidual: number | null;
  coolingResponse: number | null;
  coolingResponseUnit: string;
  coolingPairs: number;
  pairedCount: number;
  validCoverage: number;
  invalidRows: number;
  unknownValidityRows: number;
  unit: string | null;
  sourceHeaders: string[];
  warnings: string[];
}
export interface AcvVisualizationEvidence { subsystem: 'acv'; cars: AcvCarEvidence[]; rowCount: number }
export interface RailSideEvidence {
  side: 'Side I' | 'Side II'; positions: number[];
  vibrationRms: number | null; shockRms: number | null; shockPeak: number | null;
  vibrationChannels: number; shockChannels: number; validSamples: number;
  peaks: SpectrumPoint[];
  bands: { label: string; fraction: number }[];
  spectralSamples: number;
}
export interface RailVisualizationEvidence {
  subsystem: 'rail'; sides: RailSideEvidence[]; rowCount: number; sampleRateHz: number | null;
  pulseRateHz: number | null; pulseTransitions: number | null;
}
export interface RainflowBin { minimum: number; maximum: number; count: number }
export interface ShmVisualizationEvidence {
  subsystem: 'shm'; rowCount: number; stressMinimum: number | null; stressMaximum: number | null;
  rainflowBins: RainflowBin[]; equivalentCycles: number;
  logDamageContributions: { label: string; contribution: number }[];
  logDamageIntercept: number | null;
}
export type VisualizationEvidence = AcvVisualizationEvidence | RailVisualizationEvidence | ShmVisualizationEvidence;

interface Mean { sum: number; count: number }
const blankMean = (): Mean => ({ sum: 0, count: 0 });
const add = (stat: Mean, value: number | null) => { if (value !== null) { stat.sum += value; stat.count++; } };
const mean = (stat: Mean) => stat.count ? stat.sum / stat.count : null;

/** Match the frozen adapter's explicit source aliases; numeric running-mode codes stay uninterpreted. */
export function acvVisualizationEvidence(recording: Recording): AcvVisualizationEvidence {
  const aliases = getTrainedModel('acv').aliases!;
  const cars = recording.carIds.map(carId => {
    const fields = recording.fields.filter(field => field.carId === carId);
    const find = (key: string) => aliases[key]?.map(alias => fields.find(field => field.originalHeader === `Car ${carId} - ${alias}`)).find(Boolean);
    const indoor = find('indoor');
    // This alias belongs to the explicitly generated synthetic demo, never an uploaded-data fallback.
    const target = find('target') ?? (recording.source.mode === 'demo' ? fields.find(field => field.label === 'Cooling Control Temperature') : undefined);
    const running = find('running');
    const valid = find('valid');
    const unit = indoor?.displayUnit ?? null;
    const compatibleUnits = !indoor?.displayUnit || !target?.displayUnit || indoor.displayUnit === target.displayUnit;
    return { carId, indoor, target, running, valid, unit, compatibleUnits,
      indoorStats: blankMean(), targetStats: blankMean(), residual: blankMean(), peer: blankMean(), cooling: blankMean(), response: blankMean(),
      invalid: 0, unknown: 0, previousIndoor: null as number | null, previousCooling: false };
  });
  for (const row of recording.rows) {
    const samples = cars.map(car => {
      const flag = car.valid ? String(row[car.valid.columnIndex] ?? '').trim().toLowerCase() : undefined;
      const valid = flag === undefined || ['valid', '1', 'true'].includes(flag);
      if (!valid) {
        if (['invalid', '0', 'false'].includes(flag!)) car.invalid++; else car.unknown++;
      }
      const value = (field?: DisplayField) => {
        const raw = valid && field ? numeric(row[field.columnIndex]) : null;
        return raw === null ? null : raw * (field?.displayScale ?? 1);
      };
      const indoor = value(car.indoor), target = value(car.target);
      const residual = indoor !== null && target !== null && car.compatibleUnits ? indoor - target : null;
      const cooling = valid && !!car.running && String(row[car.running.columnIndex]).toLowerCase().includes('cool');
      return { indoor, target, residual, cooling };
    });
    const residuals = samples.flatMap(sample => sample.residual === null ? [] : [sample.residual]);
    const caseMean = residuals.length ? residuals.reduce((a, b) => a + b, 0) / residuals.length : null;
    samples.forEach((sample, index) => {
      const car = cars[index];
      add(car.indoorStats, sample.indoor); add(car.targetStats, sample.target); add(car.residual, sample.residual);
      if (sample.residual !== null && caseMean !== null) add(car.peer, sample.residual - caseMean);
      if (sample.cooling) add(car.cooling, sample.residual);
      // Adjacent, valid cooling samples only: never bridge a missing/invalid interval.
      if (sample.cooling && car.previousCooling && sample.indoor !== null && car.previousIndoor !== null) add(car.response, sample.indoor - car.previousIndoor);
      car.previousIndoor = sample.indoor; car.previousCooling = sample.cooling;
    });
  }
  return { subsystem: 'acv', rowCount: recording.rows.length, cars: cars.map(car => ({
    carId: car.carId, indoorMean: mean(car.indoorStats), targetMean: mean(car.targetStats), residualMean: mean(car.residual), peerDeviation: mean(car.peer),
    coolingResidual: mean(car.cooling), coolingResponse: mean(car.response) === null ? null : mean(car.response)! * (recording.sampleRateHz ? recording.sampleRateHz * 60 : 1),
    coolingResponseUnit: `${car.unit ?? 'source units'} / ${recording.sampleRateHz ? 'min' : 'sample interval'}`,
    coolingPairs: car.response.count, pairedCount: car.residual.count, validCoverage: recording.rows.length ? car.residual.count / recording.rows.length : 0,
    invalidRows: car.invalid, unknownValidityRows: car.unknown, unit: car.unit,
    sourceHeaders: [car.indoor, car.target, car.running, car.valid].flatMap(field => field ? [field.originalHeader] : []),
    warnings: [!car.indoor ? 'No supported indoor-temperature header.' : '', !car.target ? 'No supported target/control-temperature header.' : '',
      !car.compatibleUnits ? 'Indoor and target units differ; no residual calculated.' : '',
      !car.valid ? 'Validity flag not supplied; coverage counts finite paired values.' : '',
      car.unknown ? `${car.unknown} rows have unknown validity and are excluded.` : '',
      !car.cooling.count ? 'No valid explicitly labelled cooling samples; numeric mode codes are not interpreted.' : ''].filter(Boolean),
  })) };
}

/** Full-recording pooled RMS; first-window FFT is separate diagnostic evidence, not classifier attribution. */
export function railVisualizationEvidence(recording: Recording): RailVisualizationEvidence {
  const frequency = recording.sampleRateHz ?? null;
  const size = Math.min(1024, 2 ** Math.floor(Math.log2(Math.max(1, recording.rows.length))));
  const sides = (['Side I', 'Side II'] as const).map((side, sideIndex): RailSideEvidence => {
    const fields = recording.fields.filter(field => field.mapping.status === 'mapped' && field.mapping.anchor.kind === 'axleBox' && field.mapping.anchor.position % 2 === (sideIndex === 0 ? 1 : 0));
    const vibration = fields.filter(field => /^Vibration\b/i.test(field.label));
    const shock = fields.filter(field => /^Shock\b/i.test(field.label));
    const summarize = (selected: DisplayField[]) => {
      let square = 0, count = 0, peak = 0;
      for (const row of recording.rows) for (const field of selected) {
        const raw = numeric(row[field.columnIndex]); if (raw === null) continue;
        const value = raw * (field.displayScale ?? 1); count++; square += value * value; peak = Math.max(peak, Math.abs(value));
      }
      return { rms: count ? Math.sqrt(square / count) : null, peak: count ? peak : null, count };
    };
    const v = summarize(vibration), s = summarize(shock);
    const spectra = frequency && size >= 4 ? vibration.flatMap(field => {
      const values = recording.rows.slice(0, size).map(row => numeric(row[field.columnIndex]));
      if (values.some(value => value === null)) return [];
      return [amplitudeSpectrum(values.map(value => value! * (field.displayScale ?? 1)), frequency)];
    }) : [];
    const power = spectra[0]?.map((point, index) => ({ frequency: point.frequency, amplitude: spectra.reduce((sum, spectrum) => sum + spectrum[index].amplitude ** 2, 0) / spectra.length })) ?? [];
    const total = power.reduce((sum, point) => sum + point.amplitude, 0);
    const candidates = power.filter((point, index) => index > 0 && point.amplitude > 0 && point.amplitude >= (power[index - 1]?.amplitude ?? 0) && point.amplitude >= (power[index + 1]?.amplitude ?? 0)).sort((a, b) => b.amplitude - a.amplitude);
    const peaks = candidates.slice(0, 3).map(point => ({ frequency: point.frequency, amplitude: Math.sqrt(point.amplitude) }));
    const nyquist = (frequency ?? 0) / 2;
    const boundaries = [...new Set([0, Math.min(500, nyquist), Math.min(2000, nyquist), nyquist])];
    const bands = total > 0 ? boundaries.slice(1).map((maximum, index) => {
      const minimum = boundaries[index];
      return { label: `${minimum}–${maximum} Hz`, fraction: power.filter(point => point.frequency >= minimum && (point.frequency < maximum || maximum === nyquist)).reduce((sum, point) => sum + point.amplitude, 0) / total };
    }) : [];
    return { side, positions: sideIndex === 0 ? [1, 3, 5, 7] : [2, 4, 6, 8], vibrationRms: v.rms, shockRms: s.rms, shockPeak: s.peak,
      vibrationChannels: vibration.length, shockChannels: shock.length, validSamples: v.count + s.count, peaks, bands, spectralSamples: spectra.length ? size : 0 };
  });
  const pulses = recording.rows.map(row => numeric(row[0]));
  const binary = pulses.every(value => value === 0 || value === 1);
  const transitions = binary ? pulses.slice(1).reduce<number>((count, value, index) => count + (pulses[index] === 0 && value === 1 ? 1 : 0), 0) : null;
  return { subsystem: 'rail', sides, rowCount: recording.rows.length, sampleRateHz: frequency, pulseTransitions: transitions,
    pulseRateHz: frequency && transitions !== null && pulses.length > 1 ? transitions * frequency / (pulses.length - 1) : null };
}

/** The same reversal/half-cycle rules as the existing model's rainflowMoments; no per-cycle damage law is invented. */
export function rainflowCycles(values: readonly number[]): { range: number; count: number }[] {
  const distinct: number[] = [];
  for (const value of values) if (!distinct.length || value !== distinct[distinct.length - 1]) distinct.push(value);
  const turns = distinct.filter((value, index) => index === 0 || index === distinct.length - 1 || (value - distinct[index - 1]) * (distinct[index + 1] - value) < 0);
  const stack: number[] = [], cycles: { range: number; count: number }[] = [];
  for (const value of turns) {
    stack.push(value);
    while (stack.length >= 3) {
      const previous = Math.abs(stack[stack.length - 2] - stack[stack.length - 3]);
      const next = Math.abs(stack[stack.length - 1] - stack[stack.length - 2]);
      if (next < previous) break;
      if (stack.length === 3) { cycles.push({ range: previous, count: .5 }); stack.shift(); }
      else { cycles.push({ range: previous, count: 1 }); const last = stack.pop()!; stack.pop(); stack.pop(); stack.push(last); }
    }
  }
  for (let index = 0; index < stack.length - 1; index++) cycles.push({ range: Math.abs(stack[index + 1] - stack[index]), count: .5 });
  return cycles;
}
export function shmVisualizationEvidence(recording: Recording): ShmVisualizationEvidence {
  const values = recording.rows.map(row => numeric(row[0]));
  if (values.some(value => value === null)) throw new Error('Stress evidence requires finite recorded samples.');
  const stress = values as number[];
  const cycles = rainflowCycles(stress);
  const maximum = cycles.reduce((result, cycle) => Math.max(result, cycle.range), 0);
  const bins: RainflowBin[] = maximum ? Array.from({ length: 6 }, (_, index) => ({ minimum: maximum * index / 6, maximum: maximum * (index + 1) / 6, count: 0 })) : [];
  for (const cycle of cycles) if (bins.length) bins[Math.min(5, Math.floor(cycle.range / maximum * 6))].count += cycle.count;
  // Synthetic demo damage is a scripted scenario, not this fitted regressor: no attribution is fabricated for it.
  const model = getTrainedModel('shm');
  const features = recording.source.mode === 'uploaded' && stress.length >= 3 ? shmFeatures(recording) : null;
  const contributions = features && model.coefficients && model.mean && model.scale ? features.map((value, index) => (value - model.mean![index]) / model.scale![index] * model.coefficients![index]) : null;
  return { subsystem: 'shm', rowCount: stress.length, stressMinimum: stress.length ? stress.reduce((a, b) => Math.min(a, b)) : null,
    stressMaximum: stress.length ? stress.reduce((a, b) => Math.max(a, b)) : null, rainflowBins: bins, equivalentCycles: cycles.reduce((sum, cycle) => sum + cycle.count, 0),
    logDamageContributions: contributions ? [
      { label: 'Stress summary', contribution: contributions.slice(0, 8).reduce((a, b) => a + b, 0) },
      { label: 'Higher stress moments', contribution: contributions.slice(8, 11).reduce((a, b) => a + b, 0) },
      { label: 'Rainflow range moments', contribution: contributions.slice(11).reduce((a, b) => a + b, 0) },
    ] : [], logDamageIntercept: contributions ? model.intercept ?? null : null };
}
export function deriveVisualizationEvidence(recording: Recording): VisualizationEvidence {
  switch (recording.source.subsystem) {
    case 'acv': return acvVisualizationEvidence(recording);
    case 'rail': return railVisualizationEvidence(recording);
    case 'shm': return shmVisualizationEvidence(recording);
    default: throw new Error('Door cycle evidence is supplied by the frozen Python backend.');
  }
}
