#!/usr/bin/env python3
"""Predict every cycle from a raw Door stream. No labels or example CSVs are read."""
from __future__ import annotations
import argparse
import io
import json
from pathlib import Path
import zipfile
from threadpoolctl import threadpool_limits
from door_pipeline.io import DataError, load_stream, predictions_csv
from door_pipeline.runtime import load_bundle, predict_stream

ROOT = Path(__file__).resolve().parent

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True, help='Raw, continuous Door CSV')
    parser.add_argument('--output', type=Path, required=True, help='Output CSV path, or an output directory')
    parser.add_argument('--model', type=Path, default=ROOT/'models/door_model.joblib')
    parser.add_argument('--details', type=Path, help='Optional JSON with per-cycle scores and evidence summaries')
    parser.add_argument('--zip', type=Path, dest='zip_path', help='Optional submission ZIP containing only door_predictions.csv')
    args = parser.parse_args()
    bundle = load_bundle(args.model)
    stream = load_stream(args.input)
    with threadpool_limits(limits=1):
        result, _, _ = predict_stream(bundle, stream)
    output = args.output
    if output.is_dir() or output.suffix.lower() != '.csv':
        output = output/'door_predictions.csv'
    if output.resolve() == args.input.resolve():
        raise DataError('Output must not overwrite the input stream.')
    output.parent.mkdir(parents=True, exist_ok=True)
    raw = predictions_csv(result['segments']).encode('utf-8')
    output.write_bytes(raw)
    if args.details:
        args.details.parent.mkdir(parents=True, exist_ok=True)
        args.details.write_text(json.dumps(result, indent=2, allow_nan=False), encoding='utf-8')
    if args.zip_path:
        args.zip_path.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(args.zip_path, 'w', zipfile.ZIP_DEFLATED) as z:
            z.writestr('door_predictions.csv', raw)
    print(json.dumps({'output':str(output), 'model':result['model_name'], **result['summary']}, indent=2))

if __name__ == '__main__':
    try:
        main()
    except (DataError, FileNotFoundError) as exc:
        raise SystemExit(str(exc)) from exc
