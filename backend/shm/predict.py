from __future__ import annotations

import argparse
import csv
import io
import json
import math
import zipfile
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
DEFAULT_MODEL = HERE / 'shm_model.joblib'
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


class DataError(ValueError):
    """Actionable input validation error."""


# ---- feature extraction -------------------------------------------------------------------------
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
    """Equal-width histogram over [min, max] -> (counts, centres). Because counted ranges are whole multiples of
    the class width, many fall exactly on bin edges; a value within SHM_EDGE_EPSILON bin widths below an edge is
    assigned to the upper bin so the result does not depend on last-digit floating-point differences."""
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
def load_series(path: Path | bytes) -> tuple[np.ndarray, list[str]]:
    """One stress column. A single non-numeric first line (a real header) is dropped; anything else non-numeric is an error."""
    name = 'Uploaded CSV' if isinstance(path, bytes) else Path(path).name
    source = io.BytesIO(path) if isinstance(path, bytes) else path
    try:
        table = pd.read_csv(source, header=None, dtype=str, skip_blank_lines=True)
    except (pd.errors.ParserError, pd.errors.EmptyDataError, UnicodeError) as exc:
        raise DataError(f'{name}: upload a non-empty CSV with one numeric stress column.') from exc
    if table.shape[1] != 1:
        raise DataError(f'{name}: SHM recordings must have exactly one stress column')
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
        raise DataError(f'{name}: non-numeric sample: {exc}') from exc
    if len(values) < SHM_MIN_SAMPLES or not np.isfinite(values).all():
        raise DataError(f'{name}: SHM requires at least {SHM_MIN_SAMPLES} finite stress samples')
    return values, warnings


# ---- saved-model inference ----------------------------------------------------------------------
def evaluate_linear_model(model: dict, features) -> float:
    """D = exp(intercept + sum(coef * (f - mean) / scale)) over the feature vector."""
    z = model['intercept'] + sum((v - m) / s * c for v, m, s, c in zip(features, model['mean'], model['scale'], model['coefficients']))
    damage = math.exp(z)
    if not math.isfinite(damage) or damage <= 0:
        raise DataError('The damage model returned a non-positive or non-finite value for this recording.')
    return damage


def load_bundle(path: Path) -> dict:
    path = Path(path)
    if not path.is_file():
        raise DataError(f'Model not found at {path}. Restore the supplied shm_model.joblib file.')
    bundle = joblib.load(path)   # local, trusted file only
    if bundle.get('format_version') != FORMAT_VERSION or bundle.get('model_name') != MODEL_NAME:
        raise DataError('Unsupported SHM model format.')
    if bundle['recipe'] != RECIPE or bundle['feature_names'] != FEATURE_NAMES:
        raise DataError('The model was trained with a different counting recipe or feature schema; restore the matching supplied model and prediction script.')
    if 'linear_model' not in bundle:
        bundle['linear_model'] = bundle['browser_artifact']
    return bundle


def predict_values(bundle: dict, values: np.ndarray, warnings=()) -> dict:
    features = shm_features(values)
    damage = evaluate_linear_model(bundle['linear_model'], features)
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
    p = sub.add_parser('predict', help='predict damage for one CSV or a directory of CSVs')
    p.add_argument('--input', type=Path, required=True)
    p.add_argument('--output', type=Path, default=HERE / 'shm_predictions.csv', help='Output CSV path, or a directory receiving shm_predictions.csv')
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
