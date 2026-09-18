#!/usr/bin/env python3
"""Fit portable models from labelled training inputs only; never reads Test/.

Run: .tools/ml/bin/python scripts/train-models.py --datasets /path/to/02_Datasets
The JSON artifact is consumed directly by the browser worker; sklearn is training-only.
"""
from __future__ import annotations
import argparse
import csv
import datetime as dt
import hashlib
import json
import math
import re
from pathlib import Path
import numpy as np
import pandas as pd
from openpyxl import load_workbook
from sklearn.ensemble import ExtraTreesClassifier, RandomForestClassifier
from sklearn.linear_model import Ridge
from sklearn.metrics import accuracy_score, balanced_accuracy_score, f1_score, mean_absolute_error, mean_absolute_percentage_error
from sklearn.model_selection import train_test_split, StratifiedKFold, cross_validate
from sklearn.preprocessing import StandardScaler

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / '.tools/model-cache'
VERSION = 'rw-trained-2026-09-18-v1'
SEED = 1809


def finite(value):
    try:
        n = float(value)
        return n if math.isfinite(n) else None
    except (ValueError, TypeError):
        return None


def summary(values):
    a = np.asarray([x for x in values if x is not None and math.isfinite(x)], dtype=float)
    if not len(a):
        return [0.0] * 8
    d = np.diff(a)
    return [float(np.mean(a)), float(np.std(a)), float(np.sqrt(np.mean(a*a))),
            float(np.min(a)), float(np.max(a)), float(np.mean(np.abs(a))),
            float(np.sqrt(np.mean(d*d))) if len(d) else 0.0,
            float(np.mean(np.abs(d))) if len(d) else 0.0]


def rail_features(data):
    a = np.asarray(data, dtype=float)
    if a.ndim != 2 or a.shape[1] != 129 or not np.isfinite(a).all():
        raise ValueError('Rail training schema must be 129 finite numeric channels')
    x = a[:, 1:]
    dx = np.diff(x, axis=0)
    stats = np.stack([np.mean(x, axis=0), np.std(x, axis=0), np.sqrt(np.mean(x*x, axis=0)),
                      np.max(np.abs(x), axis=0), np.mean(np.abs(x), axis=0),
                      np.sqrt(np.mean(dx*dx, axis=0)), np.mean(np.abs(dx), axis=0),
                      np.mean(x[1:]*x[:-1] < 0, axis=0)], axis=1)
    features = list(stats.reshape(-1))
    # Stable odd/even axle positions, not camera orientation or train/file IDs.
    for side in range(2):
        for modality in range(2):
            indices = [2*axle+modality for axle in range(64) if axle % 2 == side]
            block = stats[indices]
            features.extend(np.mean(block, axis=0))
            features.extend(np.max(block, axis=0))
            features.extend(np.std(block, axis=0))
    features.extend(summary(a[:, 0]))
    return np.asarray(features, dtype=float)


def rainflow_moments(values):
    # Four-point compatible stack count of turning-point ranges; no material S-N constants assumed.
    a = np.asarray(values, dtype=float)
    a = a[np.r_[True, np.diff(a) != 0]]
    if len(a) < 3:
        turns = a
    else:
        turns = a[np.r_[True, np.diff(a)[:-1]*np.diff(a)[1:] < 0, True]]
    sums = np.zeros(5)
    stack = []
    def add(r, count):
        for i, exponent in enumerate([1, 2, 3, 4, 5]):
            sums[i] += count * (r ** exponent)
    for value in turns:
        stack.append(float(value))
        while len(stack) >= 3:
            old = abs(stack[-2]-stack[-3]); new = abs(stack[-1]-stack[-2])
            if new < old:
                break
            if len(stack) == 3:
                add(old, .5); stack.pop(0)
            else:
                add(old, 1); last = stack.pop(); stack.pop(); stack.pop(); stack.append(last)
    for i in range(len(stack)-1):
        add(abs(stack[i+1]-stack[i]), .5)
    return list(sums)


def shm_features(data):
    a = np.asarray(data, dtype=float).reshape(-1)
    if len(a) < 3 or not np.isfinite(a).all():
        raise ValueError('SHM requires at least three finite stress samples')
    out = summary(a)
    centered = a - np.mean(a)
    out += [float(np.mean(np.abs(centered)**k)) for k in [3, 4, 5]]
    out += rainflow_moments(a)
    # Log magnitudes suit stress-amplitude power laws; no ID or filename features.
    return np.log1p(np.abs(np.asarray(out, dtype=float)))


def timestamp(value):
    if re.match(r'^\d{4}-\d{1,2}-\d{1,2}-\d{1,2}-\d{1,2}-\d{1,2}-\d{1,3}$', str(value)):
        parts = [int(p) for p in str(value).split('-')]
        return dt.datetime(*parts[:6], tzinfo=dt.timezone.utc).timestamp() + parts[6]/1000
    parsed = dt.datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    return parsed.replace(tzinfo=dt.timezone.utc).timestamp() if parsed.tzinfo is None else parsed.timestamp()


def door_segments(rows, gap_seconds):
    times = [timestamp(row[0]) for row in rows]
    starts = [0] + [i for i in range(1, len(rows)) if times[i]-times[i-1] > gap_seconds]
    return [(start, (starts[index+1]-1 if index+1 < len(starts) else len(rows)-1)) for index, start in enumerate(starts)]


def door_features(rows):
    a = np.asarray([[float(v) for v in row[1:]] for row in rows], dtype=float)
    features = [len(rows), timestamp(rows[-1][0])-timestamp(rows[0][0])]
    for index in [0, 1, 2, 3, 4, 13, 14, 15]:
        features.extend(summary(a[:, index]))
    # Normalized travel-bin currents describe localized resistance without an invented envelope.
    current = a[:, 0]; pos = a[:, 15]
    travel = np.abs(pos-pos[0]) / max(abs(pos[-1]-pos[0]), 1)
    for lo in [0, .2, .4, .6, .8]:
        mask = (travel >= lo) & (travel <= lo+.2 if lo == .8 else travel < lo+.2)
        vals = current[mask]
        features.extend([float(np.mean(vals)) if len(vals) else 0, float(np.max(vals)) if len(vals) else 0])
    return np.asarray(features)


ACV_ALIASES = {
    'indoor': ['Indoor Average Temperature', 'Passenger Cabin Temperature Detected Value', 'Observation Area Temperature Detected Value'],
    'target': ['ACV Control Temperature (Cooling)', 'Target Temperature Value'],
    'outdoor': ['Outdoor Average Temperature', 'Outside Temperature Sensor Reading', 'Fresh Air Temperature Detected Value'],
    'running': ['ACV Running Mode'],
    'valid': ['ACV Information Valid'],
}


def acv_features(headers, rows):
    registry = {}
    for index, header in enumerate(headers):
        match = re.match(r'^Car (\d{2}) - (.+)$', str(header))
        if match:
            registry.setdefault(match[1], {})[match[2]] = index
    cars = sorted(registry)
    if len(cars) != 8:
        raise ValueError('ACV expects exactly eight exact car identifiers')
    signals = {}
    for car in cars:
        lookup = {key: next((registry[car][alias] for alias in aliases if alias in registry[car]), None) for key, aliases in ACV_ALIASES.items()}
        if lookup['indoor'] is None or lookup['target'] is None:
            raise ValueError('ACV model needs indoor and cooling/target temperature fields')
        signals[car] = []
        for row in rows:
            vals = {key: (row[index] if index is not None else None) for key, index in lookup.items()}
            validity = str(vals['valid']).strip().lower()
            valid = lookup['valid'] is None or validity in ['valid', '1', 'true']
            indoor = finite(vals['indoor']) if valid else None
            target = finite(vals['target']) if valid else None
            outdoor = finite(vals['outdoor']) if valid else None
            cooling = 'cool' in str(vals['running']).lower()
            signals[car].append((indoor, target, outdoor, cooling, valid))
    features = []
    for car in cars:
        s = signals[car]
        indoor = [x[0] for x in s if x[0] is not None]
        residual = [x[0]-x[1] for x in s if x[0] is not None and x[1] is not None]
        cooling_residual = [x[0]-x[1] for x in s if x[0] is not None and x[1] is not None and x[3]]
        ambient = [x[0]-x[2] for x in s if x[0] is not None and x[2] is not None]
        peer_residual = []
        for index, x in enumerate(s):
            if x[0] is None or x[1] is None:
                continue
            peers = [signals[c][index][0]-signals[c][index][1] for c in cars if signals[c][index][0] is not None and signals[c][index][1] is not None]
            if peers:
                peer_residual.append((x[0]-x[1])-float(np.mean(peers)))
        features.append(summary(indoor) + summary(residual) + summary(cooling_residual) + summary(ambient) + summary(peer_residual)
                        + [len(indoor)/len(s), sum(x[3] for x in s)/len(s), sum(x[4] for x in s)/len(s)])
    features = np.asarray(features)
    # Retain both absolute case summaries and cross-car relative summaries.
    return cars, np.concatenate([features, features-np.mean(features, axis=0)], axis=1)


def portable_forest(model, kind='classifier'):
    trees = []
    for estimator in model.estimators_:
        t = estimator.tree_
        values = t.value[:, 0, :]
        if kind == 'classifier':
            totals = values.sum(axis=1, keepdims=True)
            values = values / np.maximum(totals, 1e-12)
        trees.append({'left': t.children_left.tolist(), 'right': t.children_right.tolist(), 'feature': t.feature.tolist(),
                      'threshold': t.threshold.tolist(), 'value': values.tolist()})
    return {'kind': kind, 'classes': [str(x) for x in model.classes_] if kind == 'classifier' else None, 'trees': trees}


def classifier_report(y, predicted):
    return {'accuracy': float(accuracy_score(y, predicted)), 'balancedAccuracy': float(balanced_accuracy_score(y, predicted)),
            'macroF1': float(f1_score(y, predicted, average='macro', zero_division=0)), 'n': len(y)}


def info(name, description, training, validation):
    return {'version': VERSION, 'name': name, 'description': description, 'training': training, 'validation': validation}


def cache_features(key, files, fn):
    path = CACHE / f'{key}.npz'
    names = [p.name for p in files]
    fingerprint = hashlib.sha256('|'.join(f'{p.name}:{p.stat().st_size}:{p.stat().st_mtime_ns}' for p in files).encode()).hexdigest()
    if path.exists():
        cache = np.load(path)
        if str(cache['fingerprint']) == fingerprint:
            print(f'{key}: using cached features', flush=True)
            return cache['x']
    out = []
    for index, p in enumerate(files):
        out.append(fn(p))
        if index % 10 == 0 or index+1 == len(files):
            print(f'{key}: extracted {index+1}/{len(files)}', flush=True)
    x = np.asarray(out)
    np.savez(path, x=x, names=np.asarray(names), fingerprint=fingerprint)
    return x


def train_rail(root):
    labels = list(csv.DictReader((root/'Rail_Corrugation/Train_Labels.csv').open()))
    files = [root/'Rail_Corrugation/Train'/row['filename'] for row in labels]
    x = cache_features('rail-v1', files, lambda p: rail_features(pd.read_csv(p).to_numpy(dtype=float)))
    y = np.asarray([row['label'] for row in labels])
    train, val = train_test_split(np.arange(len(y)), test_size=.2, stratify=y, random_state=SEED)
    candidates = {
        'Extra Trees sqrt': ExtraTreesClassifier(n_estimators=160, max_depth=12, class_weight='balanced', random_state=SEED, n_jobs=-1),
        'Extra Trees all': ExtraTreesClassifier(n_estimators=160, max_depth=12, max_features=1.0, class_weight='balanced', random_state=SEED, n_jobs=-1),
        'Balanced Random Forest': RandomForestClassifier(n_estimators=160, max_features=.5, class_weight='balanced_subsample', random_state=SEED, n_jobs=-1),
    }
    development_scores = {}
    for name, candidate in candidates.items():
        scores = cross_validate(candidate, x[train], y[train], cv=StratifiedKFold(4, shuffle=True, random_state=719), scoring=['balanced_accuracy', 'f1_macro'])
        development_scores[name] = {'balancedAccuracy': float(scores['test_balanced_accuracy'].mean()), 'macroF1': float(scores['test_f1_macro'].mean())}
    selected = max(development_scores, key=lambda name: development_scores[name]['balancedAccuracy'])
    print('RAIL DEVELOPMENT SELECTION', selected, development_scores, flush=True)
    model = candidates[selected]
    model.fit(x[train], y[train]); report = classifier_report(y[val], model.predict(x[val]))
    print('RAIL VALIDATION', report, flush=True)
    model.fit(x, y)
    artifact = portable_forest(model)
    artifact.update({'featureCount': x.shape[1], 'info': info('Rail '+selected, 'Learned recording-level class from full-resolution channel statistics; no per-bearing diagnosis.',
        f'{len(y)} labelled training recordings; stratified class counts: '+str(dict(zip(*np.unique(y, return_counts=True)))),
        f"Stratified held-out {len(val)} files: accuracy {report['accuracy']:.3f}, balanced accuracy {report['balancedAccuracy']:.3f}, macro F1 {report['macroF1']:.3f}. Few minority-class validation files; unseen-route generalization is unknown.")})
    return artifact, {'split': 'stratified random 80/20 files, seed 1809; forest selection by four-fold CV within development files', 'developmentCV': development_scores, 'selectedModel': selected, 'metrics': report, 'heldOutFiles': [files[i].name for i in val], 'classCounts': {str(k): int(v) for k,v in zip(*np.unique(y, return_counts=True))}}, {'features': x[val[0]].tolist(), 'prediction': str(model.predict(x[val[:1]])[0])}


def train_shm(root):
    labels = list(csv.DictReader((root/'SHM/Train_Labels.csv').open()))
    files = [root/'SHM/Train'/row['filename'] for row in labels]
    x = cache_features('shm-v1', files, lambda p: shm_features(pd.read_csv(p, header=None).to_numpy(dtype=float)))
    y = np.asarray([float(row['damage']) for row in labels])
    train, val = train_test_split(np.arange(len(y)), test_size=.25, random_state=SEED)
    scaler = StandardScaler().fit(x[train]); model = Ridge(alpha=1.0).fit(scaler.transform(x[train]), np.log(y[train]))
    pred = np.exp(model.predict(scaler.transform(x[val])))
    mape = float(mean_absolute_percentage_error(y[val], pred))
    report = {'mape': mape, 'mapeScore': max(0, 1-mape), 'mae': float(mean_absolute_error(y[val], pred)), 'n': len(val)}
    print('SHM VALIDATION', report, flush=True)
    scaler.fit(x); model.fit(scaler.transform(x), np.log(y))
    artifact = {'kind': 'log-linear', 'mean': scaler.mean_.tolist(), 'scale': scaler.scale_.tolist(), 'coefficients': model.coef_.tolist(), 'intercept': float(model.intercept_), 'featureCount': x.shape[1],
                'info': info('SHM log-damage ridge regression', 'Learned cumulative-damage regression using stress moments and rainflow range moments; no physical location inference.', f'{len(y)} labelled healthy-condition stress recordings. File identifiers are excluded.',
                f'Random held-out {len(val)} files: MAPE {mape:.3%}, score max(0, 1−MAPE) {max(0,1-mape):.3f}, MAE {report["mae"]:.6g}. Healthy-condition data only; no fault classification or lifetime estimate.')}
    return artifact, {'split': 'random 75/25 files, seed 1809', 'metrics': report, 'heldOutFiles': [files[i].name for i in val]}, {'features': x[val[0]].tolist(), 'prediction': float(np.exp(model.predict(scaler.transform(x[val[:1]]))[0]))}


def train_door(root):
    table = pd.read_csv(root/'Door/Train.csv'); rows = table.to_numpy().tolist()
    answers = list(csv.DictReader((root/'Door/Train_Segments_Answer.csv').open()))
    lookup = {str(row[0]): index for index, row in enumerate(rows)}
    cutoff = int(len(answers)*.7)
    # Derive boundary threshold exclusively from the development prefix.
    times = [timestamp(row[0]) for row in rows[:lookup[answers[cutoff]['start_time']]]]
    differences = np.diff(times)
    gap_seconds = float(np.median(differences)*5)
    ranges = door_segments(rows, gap_seconds)
    by_bounds = {(answer['start_time'], answer['end_time']): answer['status'] for answer in answers}
    exact = sum((str(rows[start][0]), str(rows[end][0])) in by_bounds for start,end in ranges)
    if exact != len(answers) or len(ranges) != len(answers):
        raise ValueError('Automatic segmentation did not exactly recover labelled training cycles; implement IoU evaluation before proceeding')
    x = np.asarray([door_features(rows[start:end+1]) for start,end in ranges]); y = np.asarray([by_bounds[(str(rows[start][0]), str(rows[end][0]))] for start,end in ranges])
    model = ExtraTreesClassifier(n_estimators=120, max_depth=9, class_weight='balanced', random_state=SEED, n_jobs=-1)
    model.fit(x[:cutoff], y[:cutoff]); predicted = model.predict(x[cutoff:]); report = classifier_report(y[cutoff:], predicted)
    # With exact one-to-one boundaries and identical segment counts, soft IoU-F1 equals label accuracy.
    report['iouWeightedF1'] = report['accuracy']; report['exactBoundaryRecall'] = 1.0
    print('DOOR VALIDATION', report, flush=True)
    model.fit(x,y); artifact = portable_forest(model)
    artifact.update({'gapSeconds': gap_seconds, 'featureCount': x.shape[1], 'info': info('Door cycle Extra Trees', 'Detects timestamp-gap cycle boundaries, then classifies learned current, voltage, back-EMF and position statistics.', f'{len(answers)} labelled cycles in Train.csv. Timestamp cadence threshold fit on the initial {cutoff} cycles.',
        f'Chronological final {len(y)-cutoff} cycles: IoU-weighted F1 {report["iouWeightedF1"]:.3f}, macro F1 {report["macroF1"]:.3f}; boundaries exactly matched held-out labels. Gap-based segmentation assumes the supplied stream acquisition pattern.')})
    fixture_rows = rows[ranges[-1][0]:ranges[-1][1]+1]
    return artifact, {'split': 'first 70% cycles development, last 30% chronological validation', 'metrics': report, 'trainCycles': cutoff, 'validationCycles': len(y)-cutoff, 'gapSeconds': gap_seconds}, {'features': x[-1].tolist(), 'prediction': str(model.predict(x[-1:])[0]), 'headers': table.columns.tolist(), 'rows': fixture_rows}


def load_acv(path):
    workbook = load_workbook(path, read_only=True, data_only=True)
    values = workbook.worksheets[0].values
    headers = [str(v) for v in next(values)]
    rows = list(values)
    workbook.close()
    return headers, rows


def train_acv(root):
    labels = list(csv.DictReader((root/'ACV/Train_Labels.csv').open()))
    cases = []
    for row in labels:
        cached = CACHE / (row['filename']+'.npz')
        if cached.exists():
            d = np.load(cached); cars = d['cars'].tolist(); x = d['x']
        else:
            headers, rows = load_acv(root/'ACV/Train'/row['filename'])
            cars, x = acv_features(headers, rows); np.savez(cached, cars=np.asarray(cars), x=x)
        cases.append((row['filename'], cars, x, np.asarray([int(c == row['faulty_car']) for c in cars])))
        print('ACV extracted', row['filename'], flush=True)
    ranks = []
    for held in range(len(cases)):
        x = np.concatenate([case[2] for i,case in enumerate(cases) if i != held]); y = np.concatenate([case[3] for i,case in enumerate(cases) if i != held])
        model = ExtraTreesClassifier(n_estimators=200, max_depth=4, min_samples_leaf=2, class_weight='balanced', random_state=SEED, n_jobs=-1).fit(x,y)
        scores = model.predict_proba(cases[held][2])[:,1]
        order = sorted(range(8), key=lambda i: (-scores[i], cases[held][1][i]))
        faulty_index = int(np.flatnonzero(cases[held][3])[0]); rank = order.index(faulty_index)+1
        ranks.append({'file': cases[held][0], 'faultyRank': rank, 'score': (9-rank)/8})
    report = {'meanRankDecayScore': float(np.mean([r['score'] for r in ranks])), 'top1Accuracy': sum(r['faultyRank']==1 for r in ranks)/len(ranks), 'n': len(cases)}
    print('ACV VALIDATION', report, ranks, flush=True)
    x = np.concatenate([case[2] for case in cases]); y = np.concatenate([case[3] for case in cases])
    model = ExtraTreesClassifier(n_estimators=200, max_depth=4, min_samples_leaf=2, class_weight='balanced', random_state=SEED, n_jobs=-1).fit(x,y)
    artifact = portable_forest(model)
    artifact.update({'featureCount': x.shape[1], 'aliases': ACV_ALIASES, 'info': info('ACV case-relative Extra Trees ranker', 'Ranks all eight exact car identifiers using observed temperature residuals and control context. Internal scores are not calibrated probabilities.',
        'Six labelled cases, eight cars each. Car identifiers and case filenames are excluded from feature vectors.',
        f'Leave-one-case-out across six cases: mean rank-decay score {report["meanRankDecayScore"]:.3f}; top-1 {int(report["top1Accuracy"]*6)}/6. Extremely small heterogeneous sample; ranking quality remains uncertain.')})
    return artifact, {'split': 'leave-one-case-out (six independent held-out folds)', 'metrics': report, 'folds': ranks}, {'features': x[0].tolist(), 'scores': model.predict_proba(x[:1])[0].tolist()}


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--datasets', type=Path, required=True); parser.add_argument('--only', choices=['door','rail','shm','acv'])
    args = parser.parse_args(); CACHE.mkdir(parents=True, exist_ok=True)
    artifact_path = ROOT/'src/data/modelArtifacts.json'; report_path = ROOT/'docs/model-validation.json'; fixtures_path = ROOT/'tests/fixtures/model-parity.json'
    artifacts = json.loads(artifact_path.read_text()) if artifact_path.exists() else {}
    reports = json.loads(report_path.read_text()) if report_path.exists() else {}
    fixtures = json.loads(fixtures_path.read_text()) if fixtures_path.exists() else {}
    trainers = {'door': train_door, 'rail': train_rail, 'shm': train_shm, 'acv': train_acv}
    for key, fn in trainers.items():
        if args.only and key != args.only:
            continue
        artifacts[key], reports[key], fixtures[key] = fn(args.datasets)
        artifact_path.parent.mkdir(parents=True, exist_ok=True); report_path.parent.mkdir(parents=True, exist_ok=True); fixtures_path.parent.mkdir(parents=True, exist_ok=True)
        artifact_path.write_text(json.dumps(artifacts, separators=(',', ':'), allow_nan=False))
        report_path.write_text(json.dumps(reports, indent=2, allow_nan=False))
        fixtures_path.write_text(json.dumps(fixtures, separators=(',', ':'), allow_nan=False))
        print('Saved', key, 'trained artifact', flush=True)


if __name__ == '__main__':
    main()
