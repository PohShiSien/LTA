from __future__ import annotations
import argparse
import csv
import datetime as dt
import hashlib
import io
import json
import math
import platform
import sys
import zipfile
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
DEFAULT_MODEL = HERE / 'shm_model.joblib'
VERSION = 'rw-trained-2026-09-19-v2'
FORMAT_VERSION = 1
MODEL_NAME = 'rainflow_miner_reference_recipe'

# ---- recipe constants ---------------------------------------------------------------------------
SHM_SKIP_FIRST_SAMPLE = 1
SHM_LOAD_CLASSES = 64
SHM_RANGE_BINS = 64
SHM_EXPONENTS = [1, 2, 3, 4, 5, 6]
SHM_DAMAGE_EXPONENT = 5
SHM_EDGE_EPSILON = 1e-9
SHM_MIN_SAMPLES = 3 + SHM_SKIP_FIRST_SAMPLE
FEATURE_NAMES = ['stress_mean', 'stress_std', 'stress_rms', 'stress_min', 'stress_max', 'stress_mean_abs',
                 'stress_diff_rms', 'stress_diff_mean_abs', 'abs_central_moment_3', 'abs_central_moment_4',
                 'abs_central_moment_5'] + [f'range_moment_{m}' for m in SHM_EXPONENTS]
SHM_DAMAGE_FEATURE = FEATURE_NAMES.index(f'range_moment_{SHM_DAMAGE_EXPONENT}')   # 15
RECIPE = {'skip_first_sample': SHM_SKIP_FIRST_SAMPLE, 'load_classes': SHM_LOAD_CLASSES, 'range_bins': SHM_RANGE_BINS,
          'exponent': SHM_DAMAGE_EXPONENT, 'edge_epsilon': SHM_EDGE_EPSILON, 'damage_feature_index': SHM_DAMAGE_FEATURE}
EXACT_TOLERANCE = 5e-5      # "label reproduced" threshold (relative)
SMALL_DAMAGE = 0.07         # per-regime reporting split


class DataError(ValueError):
    """Actionable input validation error."""


# ---- feature extraction (mirrored step for step by src/lib/inference.ts in the app) --------------
def summary(values):
    a = np.asarray(values, dtype=float)
    d = np.diff(a)
    return [float(np.mean(a)), float(np.std(a)), float(np.sqrt(np.mean(a * a))), float(np.min(a)), float(np.max(a)),
            float(np.mean(np.abs(a))), float(np.sqrt(np.mean(d * d))) if len(d) else 0.0, float(np.mean(np.abs(d))) if len(d) else 0.0]


def shm_reversals(values, classes=SHM_LOAD_CLASSES):
    """Quantise into `classes` load classes, merge equal runs, return peaks and valleys (endpoints kept)."""
    a = np.asarray(values, dtype=float)
    lo, hi = float(a.min()), float(a.max())
    if classes and hi > lo:
        width = (hi - lo) / classes
        a = np.floor((a - lo) / width + 0.5) * width + lo
    a = a[np.r_[True, np.diff(a) != 0.0]]
    if len(a) < 3:
        return a.tolist()
    d = np.diff(a)
    return a[np.r_[True, (d[:-1] * d[1:]) < 0.0, True]].tolist()


def shm_four_point(reversals):
    """Four-point rainflow counting: returns (closed-cycle ranges, residual reversal sequence)."""
    ranges, stack = [], []
    for value in reversals:
        stack.append(value)
        while len(stack) >= 4:
            d1 = abs(stack[-3] - stack[-4]); d2 = abs(stack[-2] - stack[-3]); d3 = abs(stack[-1] - stack[-2])
            if d2 <= d1 and d2 <= d3:
                ranges.append(d2)
                del stack[-3:-1]
            else:
                break
    return ranges, stack


def shm_rainflow_ranges(values, classes=SHM_LOAD_CLASSES):
    """Closed-cycle ranges plus the cycles closed by joining the residual with itself; returns (ranges, residual length)."""
    closed, r = shm_four_point(shm_reversals(values, classes))
    if len(r) >= 2:
        start, end, join = r[1] - r[0], r[-1] - r[-2], r[0] - r[-1]
        t1, t2 = end * start, end * join
        if t1 > 0 and t2 < 0:
            joined = r + r
        elif t1 > 0:
            joined = r[:-1] + r[1:]
        elif t2 >= 0:
            joined = r + r[1:]
        else:
            joined = r[:-1] + r
        closed = closed + shm_four_point(joined)[0]
    return closed, len(r)


def shm_range_histogram(ranges, bins=SHM_RANGE_BINS):
    """Equal-width histogram over [min, max] -> (counts, centres). A value within SHM_EDGE_EPSILON bin widths
    below an edge belongs to the upper bin, so Python and the browser agree on exact-edge values."""
    r = np.asarray(ranges, dtype=float)
    lo, hi = float(r.min()), float(r.max())
    if not bins or hi <= lo:
        return np.ones(len(r)), r
    width = (hi - lo) / bins
    index = np.floor((r - lo) / width + SHM_EDGE_EPSILON).astype(int)
    index = np.minimum(np.maximum(index, 0), bins - 1)
    counts = np.bincount(index, minlength=bins).astype(float)
    centres = lo + (np.arange(bins) + 0.5) * width
    return counts, centres


def rainflow_moments(values):
    """Range moments sum(count * centre**m) for m in SHM_EXPONENTS; m = 5 is the Miner term."""
    ranges, _ = shm_rainflow_ranges(values)
    if not ranges:
        return [0.0] * len(SHM_EXPONENTS)
    counts, centres = shm_range_histogram(ranges)
    return [float(np.sum(counts * centres ** m)) for m in SHM_EXPONENTS]


def shm_features(data):
    """17 features: summary(8) + absolute central moments 3..5 + range moments 1..6, all log1p(|.|)."""
    a = np.asarray(data, dtype=float).reshape(-1)
    if len(a) < SHM_MIN_SAMPLES or not np.isfinite(a).all():
        raise ValueError(f'SHM requires at least {SHM_MIN_SAMPLES} finite stress samples')
    a = a[SHM_SKIP_FIRST_SAMPLE:]
    out = summary(a)
    centered = a - np.mean(a)
    out += [float(np.mean(np.abs(centered) ** k)) for k in [3, 4, 5]]
    out += rainflow_moments(a)
    return np.log1p(np.abs(np.asarray(out, dtype=float)))


def cycle_evidence(data):
    """What the model counted, for reporting: class width, cycles, residual length, range histogram, S5."""
    a = np.asarray(data, dtype=float).reshape(-1)[SHM_SKIP_FIRST_SAMPLE:]
    ranges, n_residual = shm_rainflow_ranges(a)
    lo, hi = float(a.min()), float(a.max())
    evidence = {'samples_counted': int(len(a)), 'class_width': (hi - lo) / SHM_LOAD_CLASSES if hi > lo else 0.0,
                'cycles': int(len(ranges)), 'residual_reversals': int(n_residual), 'range_moment_5': 0.0, 'histogram': {'centres': [], 'counts': []}}
    if ranges:
        counts, centres = shm_range_histogram(ranges)
        evidence['histogram'] = {'centres': [float(c) for c in centres], 'counts': [int(c) for c in counts]}
        evidence['range_moment_5'] = float(np.sum(counts * centres ** SHM_DAMAGE_EXPONENT))
    return evidence


# ---- loading ------------------------------------------------------------------------------------
def load_series(path: Path) -> tuple[np.ndarray, list[str]]:
    """One stress column. A single non-numeric first line (a real header) is dropped, as the app does."""
    table = pd.read_csv(path, header=None, dtype=str, skip_blank_lines=True)
    if table.shape[1] != 1:
        raise DataError(f'{path.name}: SHM recordings must have exactly one stress column')
    rows = table.iloc[:, 0].tolist()
    warnings = []
    try:
        float(rows[0])
    except (TypeError, ValueError):
        rows = rows[1:]
        warnings.append('A non-numeric first line was treated as a header and not analysed.')
    try:
        values = np.asarray([float(v) for v in rows], dtype=float)
    except (TypeError, ValueError) as exc:
        raise DataError(f'{path.name}: non-numeric sample: {exc}') from exc
    if len(values) < SHM_MIN_SAMPLES or not np.isfinite(values).all():
        raise DataError(f'{path.name}: SHM requires at least {SHM_MIN_SAMPLES} finite stress samples')
    return values, warnings


# ---- fitting, validation, bundle ----------------------------------------------------------------
def mape_optimal_scale(y, s):
    """argmin_k mean|1 - k*s/y|: weighted median of y/s with weights s/y."""
    ratio = y / s
    weight = s / y
    order = np.argsort(ratio)
    cumulative = np.cumsum(weight[order])
    return float(ratio[order][np.searchsorted(cumulative, cumulative[-1] / 2)])


def leave_one_out(y, s):
    held = np.empty(len(y))
    for i in range(len(y)):
        keep = np.arange(len(y)) != i
        held[i] = abs(mape_optimal_scale(y[keep], s[keep]) * s[i] - y[i]) / y[i]
    return held


def repeated_kfold(y, s, k=5, reps=20, seed=0):
    rng = np.random.default_rng(seed)
    scores = []
    for _ in range(reps):
        apes = np.empty(len(y))
        for fold in np.array_split(rng.permutation(len(y)), k):
            keep = np.setdiff1d(np.arange(len(y)), fold)
            apes[fold] = np.abs(mape_optimal_scale(y[keep], s[keep]) * s[fold] - y[fold]) / y[fold]
        scores.append(apes.mean())
    return float(np.mean(scores)), float(np.std(scores))


def evaluate_artifact(artifact: dict, features) -> float:
    """The app's log-linear evaluation: D = exp(intercept + sum(coef * (f - mean) / scale))."""
    z = artifact['intercept'] + sum((v - m) / s * c for v, m, s, c in zip(features, artifact['mean'], artifact['scale'], artifact['coefficients']))
    damage = math.exp(z)
    if not math.isfinite(damage):
        raise DataError('The damage model returned a non-finite value for this recording.')
    return damage


def model_id(k: float) -> str:
    return hashlib.sha256(json.dumps({'recipe': RECIPE, 'k': float(k), 'features': FEATURE_NAMES}, sort_keys=True).encode()).hexdigest()[:16]


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def train(datasets: Path, verbose=False):
    """Fit and validate on SHM/Train. Returns (bundle, report); writes nothing."""
    root = Path(datasets) / 'SHM'
    labels_path = root / 'Train_Labels.csv'
    labels = list(csv.DictReader(labels_path.open()))
    names = [row['filename'] for row in labels]
    y = np.asarray([float(row['damage']) for row in labels])
    x, lengths, hashes = [], [], []
    for index, name in enumerate(names):
        path = root / 'Train' / name
        values, _ = load_series(path)
        lengths.append(len(values)); hashes.append(sha256_of(path))
        x.append(shm_features(values))
        if verbose or index % 16 == 15 or index + 1 == len(names):
            print(f'features {index + 1}/{len(names)}', flush=True)
    x = np.asarray(x)
    if len(set(lengths)) > 1:
        print(f'WARNING: training files differ in length ({sorted(set(lengths))}); damage is per segment and is not length-normalised', flush=True)

    s = np.expm1(x[:, SHM_DAMAGE_FEATURE])           # S5 exactly as the app recomputes it from log1p
    k = mape_optimal_scale(y, s)
    fitted = k * s
    held = leave_one_out(y, s)
    kf_mean, kf_std = repeated_kfold(y, s)
    residual_pct = 100 * (y / fitted - 1)
    exact = int(np.sum(np.abs(fitted - y) / y < EXACT_TOLERANCE))
    small = y < SMALL_DAMAGE
    metrics = {'mape': float(held.mean()), 'mapeScore': float(max(0.0, 1 - held.mean())), 'inSampleMape': float(np.mean(np.abs(fitted - y) / y)),
               'mae': float(np.mean(np.abs(fitted - y))), 'repeatedKFoldMape': kf_mean, 'repeatedKFoldStd': kf_std,
               'mapeSmallFiles': float(held[small].mean()), 'mapeLargeFiles': float(held[~small].mean()),
               'exactlyReproduced': exact, 'exactTolerance': EXACT_TOLERANCE, 'n': int(len(y)), 'scale': k}
    print('SHM VALIDATION', json.dumps(metrics), flush=True)
    if verbose:
        print('per-file residual % (label/pred - 1) and leave-one-out APE %:')
        for i in np.argsort(residual_pct):
            print(f'  {names[i]:12s} label={y[i]:.6f} pred={fitted[i]:.6f} resid={residual_pct[i]:+.3f}% loo={100*held[i]:.3f}%')

    mean = x.mean(axis=0)
    scale = np.where(x.std(axis=0) > 0, x.std(axis=0), 1.0)
    coefficients = np.zeros(x.shape[1]); coefficients[SHM_DAMAGE_FEATURE] = scale[SHM_DAMAGE_FEATURE]
    intercept = float(math.log(k) + mean[SHM_DAMAGE_FEATURE])
    artifact = {'kind': 'log-linear', 'mean': mean.tolist(), 'scale': scale.tolist(), 'coefficients': coefficients.tolist(),
                'intercept': intercept, 'featureCount': int(x.shape[1]),
                'info': {'version': VERSION, 'name': 'SHM rainflow–Miner damage (reference recipe)',
                         'description': 'Cumulative damage D = k · Σ count·range⁵ from four-point rainflow counting (64 load classes, residual closed against itself, 64 range bins). One calibration constant; no learned features, no physical location inference.',
                         'training': f'{len(y)} labelled healthy-condition stress recordings; k is the MAPE-optimal scale (weighted median of damage/range-moment). File identifiers are excluded.',
                         'validation': f'Leave-one-out over all {len(y)} files: MAPE {held.mean():.3%}, score max(0, 1−MAPE) {max(0.0, 1 - held.mean()):.4f}; {exact}/{len(y)} training labels reproduced to 0.005%. Healthy-condition data only; no fault classification or lifetime estimate.'}}
    for i in range(len(y)):   # the artifact must reproduce k*(1+S5) for every training file
        if abs(evaluate_artifact(artifact, x[i]) / (k * (1 + s[i])) - 1) > 1e-12:
            raise RuntimeError('artifact does not reproduce the fitted model')
    generated = dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')
    bundle = {'format_version': FORMAT_VERSION, 'model_id': model_id(k), 'model_name': MODEL_NAME, 'version': VERSION,
              'recipe': RECIPE, 'feature_names': FEATURE_NAMES,
              'calibration': {'k': k, 'log_k': float(math.log(k)), 'method': 'MAPE-optimal scale: weighted median of label/S5 with weights S5/label (exact minimiser of MAPE for D = k·S5)'},
              'browser_artifact': artifact, 'validation': metrics,
              'training': {'n_files': int(len(y)), 'files': names, 'samples_per_file': int(lengths[0]) if len(set(lengths)) == 1 else None,
                           'range_moment_5_min': float(s.min()), 'range_moment_5_max': float(s.max()),
                           'labels_filename': labels_path.name, 'labels_sha256': sha256_of(labels_path),
                           'files_sha256': hashlib.sha256(''.join(hashes).encode()).hexdigest(),
                           'test_used_for_training_or_selection': False, 'example_submissions_used_for_training': False},
              'versions': {'python': platform.python_version(), 'numpy': np.__version__, 'pandas': pd.__version__, 'joblib': joblib.__version__},
              'generated_at_utc': generated}
    report = {'split': f'leave-one-out, {len(y)} folds (one constant fitted per fold); repeated 5-fold x20 for spread', 'metrics': metrics,
              'recipe': RECIPE, 'modelId': bundle['model_id'], 'heldOutFiles': names,
              'residualPercent': {name: round(float(r), 4) for name, r in zip(names, residual_pct)}, 'trainedAt': generated,
              'parityFixture': {'features': x[0].tolist(), 'prediction': evaluate_artifact(artifact, x[0])}}
    return bundle, report


def save_bundle(bundle: dict, path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(bundle, path, compress=3)
    return path


def load_bundle(path: Path) -> dict:
    path = Path(path)
    if not path.is_file():
        raise DataError(f'Model not found at {path}. Run `python {Path(__file__).name} train --datasets ...` first.')
    bundle = joblib.load(path)   # local, trusted artifact only
    if bundle.get('format_version') != FORMAT_VERSION or bundle.get('model_name') != MODEL_NAME:
        raise DataError('Unsupported SHM model format.')
    if bundle['recipe'] != RECIPE or bundle['feature_names'] != FEATURE_NAMES:
        raise DataError('The model was trained with a different counting recipe or feature schema; retrain with this script.')
    return bundle


def predict_values(bundle: dict, values: np.ndarray, warnings=()) -> dict:
    features = shm_features(values)
    damage = evaluate_artifact(bundle['browser_artifact'], features)
    evidence = cycle_evidence(values)
    warnings = list(warnings)
    expected = bundle['training']['samples_per_file']
    if expected and len(values) != expected:
        warnings.append(f'Recording has {len(values)} samples; the model was calibrated on {expected}-sample segments. Damage is per segment and is not length-normalised.')
    lo, hi = bundle['training']['range_moment_5_min'], bundle['training']['range_moment_5_max']
    if not (0.5 * lo <= evidence['range_moment_5'] <= 2 * hi):
        warnings.append('The counted range moment lies outside the calibration range; the estimate is an extrapolation.')
    return {'prediction': damage, 'cycles': evidence['cycles'], 'residual_reversals': evidence['residual_reversals'],
            'range_moment_5': evidence['range_moment_5'], 'class_width': evidence['class_width'],
            'features': {name: float(v) for name, v in zip(FEATURE_NAMES, features)}, 'warnings': warnings}


def predictions_csv(rows) -> str:
    out = io.StringIO()
    writer = csv.DictWriter(out, fieldnames=['file_id', 'prediction'], lineterminator='\n')
    writer.writeheader()
    for row in rows:
        writer.writerow({'file_id': row['file_id'], 'prediction': repr(float(row['prediction']))})
    return out.getvalue()


# ---- command line -------------------------------------------------------------------------------
def write_json(path: Path, key, value, indent=None):
    data = json.loads(path.read_text()) if path.exists() else {}
    data[key] = value
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=indent, separators=(',', ':') if indent is None else None, allow_nan=False))


def cmd_train(args):
    bundle, report = train(args.datasets, verbose=args.verbose)
    if args.no_write:
        print('validation only; nothing written', flush=True)
        return
    path = save_bundle(bundle, args.model)
    reloaded = load_bundle(path)
    first = Path(args.datasets) / 'SHM/Train' / bundle['training']['files'][0]
    check = predict_values(reloaded, load_series(first)[0])['prediction']
    if abs(check / report['parityFixture']['prediction'] - 1) > 1e-12:
        raise RuntimeError('saved bundle does not reproduce the trainer prediction')
    print(f'wrote {path} (model_id {bundle["model_id"]}, k={bundle["calibration"]["k"]:.6e}, LOO MAPE {bundle["validation"]["mape"]:.4%})', flush=True)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2, allow_nan=False) + '\n')
        print(f'wrote {args.report}', flush=True)
    if args.export_app:
        root = args.export_app
        write_json(root / 'src/data/modelArtifacts.json', 'shm', bundle['browser_artifact'])
        write_json(root / 'docs/model-validation.json', 'shm', {k: v for k, v in report.items() if k != 'parityFixture'}, indent=2)
        write_json(root / 'tests/fixtures/model-parity.json', 'shm', report['parityFixture'])
        parity = root / 'tests/fixtures/feature-parity.json'
        if parity.exists():
            data = json.loads(parity.read_text())
            rows = data.get('shm', {}).get('rows') or [[v] for v in range(15)]
            data['shm'] = {'rows': rows, 'features': shm_features(np.asarray(rows, dtype=float)).tolist()}
            parity.write_text(json.dumps(data, separators=(',', ':'), allow_nan=False))
        print(f'exported browser artifact and fixtures under {root} (src/lib/inference.ts must implement this recipe; run npm test)', flush=True)


def cmd_predict(args):
    bundle = load_bundle(args.model)
    source = Path(args.input)
    if source.is_file():
        files = [source]
    else:
        files = sorted(p for p in source.iterdir() if p.is_file() and p.suffix.lower() == '.csv'
                       and not any(word in p.stem.lower() for word in ['label', 'answer', 'prediction']))
        if not files:
            raise DataError(f'No .csv recordings found in {source}.')
    rows, details = [], {}
    for path in files:
        values, warnings = load_series(path)
        result = predict_values(bundle, values, warnings)
        rows.append({'file_id': path.name, 'prediction': result['prediction']}); details[path.name] = result
        print(f'shm: {path.name} -> {result["prediction"]!r} ({result["cycles"]} cycles)', flush=True)
    output = Path(args.output)
    if output.is_dir() or output.suffix.lower() != '.csv':
        output = output / 'shm_predictions.csv'
    output.parent.mkdir(parents=True, exist_ok=True)
    raw = predictions_csv(rows).encode('utf-8')
    output.write_bytes(raw)
    if args.details:
        args.details.parent.mkdir(parents=True, exist_ok=True)
        args.details.write_text(json.dumps(details, indent=2, allow_nan=False))
    if args.zip_path:
        args.zip_path.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(args.zip_path, 'w', zipfile.ZIP_DEFLATED) as z:
            z.writestr('shm_predictions.csv', raw)
    print(json.dumps({'output': str(output), 'model_id': bundle['model_id'], 'files': len(rows)}, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    t = sub.add_parser('train', help='fit, validate and write shm_model.joblib')
    t.add_argument('--datasets', type=Path, required=True, help='Path to 02_Datasets (containing SHM/Train and SHM/Train_Labels.csv)')
    t.add_argument('--model', type=Path, default=DEFAULT_MODEL, help='Output bundle path (default: shm_model.joblib next to this script)')
    t.add_argument('--report', type=Path, help='Optional JSON validation report with per-file residuals')
    t.add_argument('--export-app', type=Path, metavar='REPO_ROOT', help='Also write the browser artifact and parity fixtures into the RailWitness repository at this root')
    t.add_argument('--no-write', action='store_true', help='Validate only; write nothing')
    t.add_argument('--verbose', action='store_true', help='Print per-file residuals')
    t.set_defaults(run=cmd_train)
    p = sub.add_parser('predict', help='predict damage for one CSV or a directory of CSVs')
    p.add_argument('--input', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True, help='Output CSV path, or a directory receiving shm_predictions.csv')
    p.add_argument('--model', type=Path, default=DEFAULT_MODEL)
    p.add_argument('--details', type=Path, help='Optional JSON with per-file evidence, features and warnings')
    p.add_argument('--zip', type=Path, dest='zip_path', help='Optional submission ZIP containing only shm_predictions.csv')
    p.set_defaults(run=cmd_predict)
    args = parser.parse_args()
    args.run(args)


if __name__ == '__main__':
    try:
        main()
    except (DataError, FileNotFoundError) as exc:
        raise SystemExit(str(exc)) from exc
