import modelArtifacts from '../data/modelArtifacts.json';
import type { AnalysisResult, CellValue, ModelInfo, RailClass, Recording, Subsystem } from '../types/multisystem';

interface PortableTree { left: number[]; right: number[]; feature: number[]; threshold: number[]; value: number[][] }
interface Artifact {
  kind: 'classifier' | 'regressor' | 'log-linear';
  classes?: string[];
  trees?: PortableTree[];
  mean?: number[];
  scale?: number[];
  coefficients?: number[];
  intercept?: number;
  featureCount: number;
  info: ModelInfo;
  gapSeconds?: number;
  aliases?: Record<string, string[]>;
}
const models = modelArtifacts as unknown as Partial<Record<Subsystem, Artifact>>;

export function numeric(value: CellValue | undefined): number | null {
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Population moments using all finite samples; optional missing signals are separately represented by coverage features. */
export function summarizeSignal(values: readonly (number | null)[]): number[] {
  let n = 0, sum = 0, square = 0, absolute = 0, min = Infinity, max = -Infinity, diffSquare = 0, diffAbsolute = 0;
  let runningMean = 0, centeredSquare = 0;
  let previous: number | null = null;
  for (const value of values) {
    if (value === null || !Number.isFinite(value)) continue;
    n++; sum += value; square += value * value; absolute += Math.abs(value); min = Math.min(min, value); max = Math.max(max, value);
    const delta = value - runningMean; runningMean += delta / n; centeredSquare += delta * (value - runningMean);
    if (previous !== null) { const difference = value - previous; diffSquare += difference * difference; diffAbsolute += Math.abs(difference); }
    previous = value;
  }
  if (!n) return Array(8).fill(0) as number[];
  const mean = sum / n;
  return [mean, Math.sqrt(Math.max(0, centeredSquare / n)), Math.sqrt(square / n), min, max, absolute / n,
    n > 1 ? Math.sqrt(diffSquare / (n - 1)) : 0, n > 1 ? diffAbsolute / (n - 1) : 0];
}

export function evaluatePortableModel(artifact: Artifact, features: readonly number[]): number[] {
  if (features.length !== artifact.featureCount || features.some(value => !Number.isFinite(value))) {
    throw new Error('The recording did not produce the finite feature vector required by this trained model.');
  }
  if (artifact.kind === 'log-linear') {
    const { coefficients, mean, scale, intercept } = artifact;
    if (!coefficients || !mean || !scale || intercept === undefined) throw new Error('The trained regression artifact is incomplete.');
    const logDamage = features.reduce((sum, feature, index) => sum + (feature - mean[index]) / scale[index] * coefficients[index], intercept);
    const result = Math.exp(logDamage);
    if (!Number.isFinite(result)) throw new Error('The damage model returned a non-finite output for this recording.');
    return [result];
  }
  if (!artifact.trees?.length) throw new Error('The fitted tree model is unavailable.');
  const output = Array(artifact.classes?.length ?? 1).fill(0) as number[];
  for (const tree of artifact.trees) {
    let node = 0;
    while (tree.left[node] >= 0) node = features[tree.feature[node]] <= tree.threshold[node] ? tree.left[node] : tree.right[node];
    for (let index = 0; index < output.length; index++) output[index] += tree.value[node][index] / artifact.trees.length;
  }
  return output;
}

export function getTrainedModel(subsystem: Subsystem): Artifact {
  if (subsystem === 'door') throw new Error('Uploaded Door prediction requires the frozen Python backend.');
  const model = models[subsystem];
  if (!model) throw new Error(`The fitted ${subsystem.toUpperCase()} model artifact is unavailable. No substitute prediction has been generated.`);
  return model;
}

export function railFeatures(recording: Recording): number[] {
  if (recording.headers.length !== 129 || recording.rows.length < 2) throw new Error('Rail inference requires the documented 129-channel schema and at least two samples.');
  const stats: number[][] = [];
  for (let column = 1; column < 129; column++) {
    const signal = recording.rows.map(row => numeric(row[column]));
    if (signal.some(value => value === null)) throw new Error(`Rail source column ${column + 1} contains missing or non-numeric values. Inference requires complete channels.`);
    const s = summarizeSignal(signal);
    let crossings = 0;
    for (let index = 1; index < signal.length; index++) if (signal[index]! * signal[index - 1]! < 0) crossings++;
    stats.push([s[0], s[1], s[2], Math.max(Math.abs(s[3]), Math.abs(s[4])), s[5], s[6], s[7], crossings / (signal.length - 1)]);
  }
  const features = stats.flat();
  for (let side = 0; side < 2; side++) {
    for (let modality = 0; modality < 2; modality++) {
      const selected = stats.filter((_, index) => index % 2 === modality && Math.floor(index / 2) % 2 === side);
      for (const statistic of ['mean', 'max', 'std'] as const) {
        for (let feature = 0; feature < 8; feature++) {
          const values = selected.map(stat => stat[feature]);
          const s = summarizeSignal(values);
          features.push(statistic === 'mean' ? s[0] : statistic === 'max' ? s[4] : s[1]);
        }
      }
    }
  }
  const speed = recording.rows.map(row => numeric(row[0]));
  if (speed.some(value => value === null)) throw new Error('The rotational-speed channel contains missing or non-numeric values.');
  return features.concat(summarizeSignal(speed));
}

export function rainflowMoments(values: readonly number[]): number[] {
  const distinct: number[] = [];
  for (const value of values) if (!distinct.length || value !== distinct[distinct.length - 1]) distinct.push(value);
  const turns = distinct.filter((value, index) => index === 0 || index === distinct.length - 1 || (value - distinct[index - 1]) * (distinct[index + 1] - value) < 0);
  const stack: number[] = [];
  const sums = [0, 0, 0, 0, 0];
  const add = (range: number, count: number) => { for (let index = 0; index < 5; index++) sums[index] += count * range ** (index + 1); };
  for (const value of turns) {
    stack.push(value);
    while (stack.length >= 3) {
      const previous = Math.abs(stack[stack.length - 2] - stack[stack.length - 3]);
      const next = Math.abs(stack[stack.length - 1] - stack[stack.length - 2]);
      if (next < previous) break;
      if (stack.length === 3) { add(previous, .5); stack.shift(); }
      else { add(previous, 1); const last = stack.pop()!; stack.pop(); stack.pop(); stack.push(last); }
    }
  }
  for (let index = 0; index < stack.length - 1; index++) add(Math.abs(stack[index + 1] - stack[index]), .5);
  return sums;
}

export function shmFeatures(recording: Recording): number[] {
  if (recording.headers.length !== 1) throw new Error('This fitted SHM model supports one stress channel. Multiple columns require a verified adapter and retraining.');
  const signal = recording.rows.map(row => numeric(row[0]));
  if (signal.length < 3 || signal.some(value => value === null)) throw new Error('SHM inference requires at least three finite recorded stress values.');
  const values = signal as number[];
  const features = summarizeSignal(values);
  for (const exponent of [3, 4, 5]) features.push(values.reduce((sum, value) => sum + Math.abs(value - features[0]) ** exponent, 0) / values.length);
  features.push(...rainflowMoments(values));
  return features.map(value => Math.log1p(Math.abs(value)));
}

interface AcvSignal { indoor: number | null; target: number | null; outdoor: number | null; cooling: boolean; valid: boolean }

export function acvFeatures(recording: Recording, aliases = getTrainedModel('acv').aliases!): { cars: string[]; features: number[][] } {
  const registry: Record<string, Record<string, number>> = {};
  recording.headers.forEach((header, index) => {
    const match = /^Car (\d{2}) - (.+)$/.exec(header);
    if (match) (registry[match[1]] ??= {})[match[2]] = index;
  });
  const cars = Object.keys(registry).sort();
  if (cars.length !== 8) throw new Error('ACV inference requires exactly eight car identifiers from the source headers.');
  const signals: Record<string, AcvSignal[]> = {};
  for (const car of cars) {
    const columns = Object.fromEntries(Object.entries(aliases).map(([key, names]) => [key, names.map(name => registry[car][name]).find(index => index !== undefined)]));
    if (columns.indoor === undefined || columns.target === undefined) throw new Error(`Car ${car} needs recorded indoor and cooling/target temperatures for this fitted model.`);
    signals[car] = recording.rows.map(row => {
      const raw = (key: string) => columns[key] === undefined ? null : row[columns[key]!];
      const valid = columns.valid === undefined || ['valid', '1', 'true'].includes(String(raw('valid')).trim().toLowerCase());
      return { indoor: valid ? numeric(raw('indoor')) : null, target: valid ? numeric(raw('target')) : null, outdoor: valid ? numeric(raw('outdoor')) : null, cooling: String(raw('running')).toLowerCase().includes('cool'), valid };
    });
  }
  const features = cars.map(car => {
    const values = signals[car];
    const indoor = values.map(value => value.indoor).filter((value): value is number => value !== null);
    const residual = values.flatMap(value => value.indoor === null || value.target === null ? [] : [value.indoor - value.target]);
    const cooling = values.flatMap(value => value.indoor === null || value.target === null || !value.cooling ? [] : [value.indoor - value.target]);
    const ambient = values.flatMap(value => value.indoor === null || value.outdoor === null ? [] : [value.indoor - value.outdoor]);
    const peer: number[] = [];
    values.forEach((value, index) => {
      if (value.indoor === null || value.target === null) return;
      const others = cars.flatMap(other => { const v = signals[other][index]; return v.indoor === null || v.target === null ? [] : [v.indoor - v.target]; });
      if (others.length) peer.push(value.indoor - value.target - others.reduce((sum, v) => sum + v, 0) / others.length);
    });
    return [indoor, residual, cooling, ambient, peer].flatMap(summarizeSignal).concat([
      indoor.length / values.length, values.filter(value => value.cooling).length / values.length, values.filter(value => value.valid).length / values.length,
    ]);
  });
  if (features.every(feature => feature[40] === 0)) throw new Error('No valid indoor-temperature samples were recorded for any car; a ranking cannot be computed.');
  const means = features[0].map((_, index) => features.reduce((sum, feature) => sum + feature[index], 0) / cars.length);
  return { cars, features: features.map(feature => feature.concat(feature.map((value, index) => value - means[index]))) };
}

/** Runs only fitted artifacts against the uploaded recording. Missing models and unsupported schemas fail explicitly. */
export async function analyseRecording(recording: Recording): Promise<AnalysisResult> {
  if (!recording.rows.length) throw new Error('There are no recorded samples to analyse.');
  const subsystem = recording.source.subsystem;
  if (subsystem === 'door') throw new Error('Uploaded Door prediction requires the frozen Python backend.');
  const model = getTrainedModel(subsystem);
  const base = { source: { ...recording.source }, model: model.info, analysedAt: new Date().toISOString() };
  switch (subsystem) {
    case 'rail': {
      const scores = evaluatePortableModel(model, railFeatures(recording));
      const prediction = model.classes![scores.indexOf(Math.max(...scores))];
      if (!['Normal', 'Side I', 'Side II'].includes(prediction)) throw new Error('The rail model returned an unsupported class.');
      return { ...base, subsystem, scope: 'recording', prediction: prediction as RailClass, notes: ['One learned class for this entire recording. Axle-box membership is a schema mapping, not a set of independent bearing diagnoses.', 'Full-resolution samples are used for inference. No class changes occur when the waveform cursor moves.'] };
    }
    case 'shm': return { ...base, subsystem, scope: 'recording', predictedDamage: evaluatePortableModel(model, shmFeatures(recording))[0], mapping: recording.mapping, notes: ['One numeric cumulative-fatigue-damage prediction for this stress segment; no clipping, health-percentage conversion, lifetime accumulation, or guessed physical anchor.', 'The fitted log-damage model uses stress and rainflow range moments. Training data contains healthy operating conditions only.'] };
    case 'acv': {
      const { cars, features } = acvFeatures(recording, model.aliases);
      const faultyClass = model.classes!.indexOf('1');
      if (faultyClass < 0) throw new Error('The ACV ranking artifact lacks its trained positive class.');
      const ranked = cars.map((car, index) => ({ car, score: evaluatePortableModel(model, features[index])[faultyClass] })).sort((a, b) => b.score - a.score || a.car.localeCompare(b.car));
      return { ...base, subsystem, scope: 'car-case', rankedCars: ranked.map(item => item.car), scores: Object.fromEntries(ranked.map(item => [item.car, item.score])), notes: ['Ranking is derived from the complete case. Car identifiers remain exactly as supplied; geometry order is independent of rank.', 'Internal learned ranking scores are not calibrated fault probabilities. Only six labelled training cases are available; inspect the validation limits.'] };
    }
  }
}
