#!/usr/bin/env python3
"""Portable-artifact CLI. Reads recorded inputs only; never reads labels or trains.

Example: .tools/ml/bin/python scripts/predict.py --subsystem rail \
    --input /path/to/Rail_Corrugation/Test --output /tmp/predictions
"""
from __future__ import annotations
import argparse
import csv
import importlib.util
import json
import math
from pathlib import Path
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('railwitness_features', ROOT/'scripts/train-models.py')
features = importlib.util.module_from_spec(spec)
spec.loader.exec_module(features)


def evaluate(model, vector):
    if len(vector) != model['featureCount'] or not np.isfinite(vector).all():
        raise ValueError('Invalid feature vector for trained artifact')
    if model['kind'] == 'log-linear':
        z = model['intercept'] + sum((value-mean)/scale*weight for value,mean,scale,weight in zip(vector, model['mean'], model['scale'], model['coefficients']))
        damage = math.exp(z)
        if not math.isfinite(damage):
            raise ValueError('Non-finite predicted damage')
        return [damage]
    out = np.zeros(len(model['classes']))
    for tree in model['trees']:
        node = 0
        while tree['left'][node] >= 0:
            node = tree['left'][node] if vector[tree['feature'][node]] <= tree['threshold'][node] else tree['right'][node]
        out += np.asarray(tree['value'][node])/len(model['trees'])
    return out.tolist()


def predict_file(path, subsystem, model):
    if subsystem == 'door':
        raise ValueError('Door uses the frozen backend. Run backend/door/predict.py with its own Python environment.')
    if subsystem == 'rail':
        table = pd.read_csv(path)
        expected = ['Rotating speed'] + [f'{kind} of bearing in position {position} of car {car}' for car in range(1,9) for position in range(1,9) for kind in ['Vibration','Shock']]
        if table.columns.tolist() != expected:
            raise ValueError('Rail header order must exactly match speed followed by vibration/shock channels for 64 axle boxes')
        vector = features.rail_features(table.to_numpy(dtype=float)); scores = evaluate(model, vector)
        prediction = model['classes'][int(np.argmax(scores))]
        return [{'file_id': path.name, 'prediction': prediction}], {'features': vector.tolist(), 'prediction': prediction}
    if subsystem == 'shm':
        table = pd.read_csv(path, header=None)
        if table.shape[1] != 1:
            raise ValueError('SHM model requires one recorded stress channel')
        if features.finite(table.iloc[0,0]) is None:
            table = table.iloc[1:]
        vector = features.shm_features(table.to_numpy(dtype=float)); prediction = evaluate(model, vector)[0]
        return [{'file_id': path.name, 'prediction': prediction}], {'features': vector.tolist(), 'prediction': prediction}
    if subsystem == 'acv':
        if path.suffix.lower() == '.xlsx':
            headers, rows = features.load_acv(path)
        else:
            with path.open(newline='', encoding='utf-8-sig') as handle:
                reader = csv.reader(handle); headers = next(reader); rows = list(reader)
        cars, vectors = features.acv_features(headers, rows)
        if all(vector[40] == 0 for vector in vectors):
            raise ValueError('No valid indoor-temperature samples in any car')
        positive = model['classes'].index('1'); scores = [evaluate(model, vector)[positive] for vector in vectors]
        ranked = sorted(range(len(cars)), key=lambda index: (-scores[index], cars[index]))
        ranking = [cars[index] for index in ranked]
        return [{'file_id': path.name, 'ranked_cars': '|'.join(ranking)}], {'features': vectors.tolist(), 'cars': cars, 'ranking': ranking}
    raise ValueError('Unsupported subsystem')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--subsystem', required=True, choices=['door', 'acv', 'rail', 'shm'])
    parser.add_argument('--input', required=True, type=Path, help='One recording or a directory of recordings')
    parser.add_argument('--output', required=True, type=Path, help='Directory receiving the required prediction CSV')
    parser.add_argument('--diagnostics', type=Path, help='Optional feature/output JSON used for cross-runtime parity checking')
    args = parser.parse_args()
    if args.subsystem == 'door':
        parser.error('Door now uses backend/door/predict.py and backend/door/models/door_model.joblib; activate backend/door/.venv first.')
    models = json.loads((ROOT/'src/data/modelArtifacts.json').read_text()); model = models[args.subsystem]
    extensions = ['.xlsx', '.csv'] if args.subsystem == 'acv' else ['.csv']
    paths = [args.input] if args.input.is_file() else sorted(p for p in args.input.iterdir() if p.is_file() and p.suffix.lower() in extensions and not any(word in p.stem.lower() for word in ['label', 'answer']))
    if not paths:
        parser.error('No supported recorded inputs found')
    results = []; diagnostics = {}
    for path in paths:
        rows, detail = predict_file(path, args.subsystem, model); results.extend(rows); diagnostics[path.name] = detail
        print(f'{args.subsystem}: analysed {path.name}; {len(rows)} output row(s)', flush=True)
    args.output.mkdir(parents=True, exist_ok=True)
    target = args.output/f'{args.subsystem}_predictions.csv'
    columns = ['start_time','end_time','prediction'] if args.subsystem == 'door' else ['file_id','ranked_cars'] if args.subsystem == 'acv' else ['file_id','prediction']
    with target.open('w',newline='') as handle:
        writer = csv.DictWriter(handle,fieldnames=columns); writer.writeheader(); writer.writerows(results)
    if args.diagnostics:
        args.diagnostics.parent.mkdir(parents=True, exist_ok=True); args.diagnostics.write_text(json.dumps(diagnostics,separators=(',',':'),allow_nan=False))
    print(f'Wrote {target}', flush=True)


if __name__ == '__main__':
    main()
