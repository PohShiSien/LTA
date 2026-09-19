#!/usr/bin/env python3
"""RailWitness Door: self-contained, frozen five-feature inference.

Keep this file next to door_model.joblib; no door_pipeline/ folder is required.
The model is the exact five-feature artifact delivered earlier, not retrained.

CLI: python predict.py --input /path/to/Test.csv --output door_predictions.csv
API: python -m uvicorn predict:app --host 127.0.0.1 --port 8000
Check: python predict.py --model-info

Dependencies: see ../requirements-door-5feature.txt in the download.
Trusted artifacts only: joblib uses pickle. Never load user-uploaded model files.
The CSV beside this script is an output example from the real Test run, NEVER an
inference input, lookup table, fallback, or source of labels.
"""
from __future__ import annotations
import argparse
import csv
import hashlib
import io
import json
import os
import re
import time
import uuid
import warnings
import zipfile
from dataclasses import dataclass, asdict
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path
from threading import Lock

import joblib
import numpy as np
import sklearn
from sklearn.exceptions import InconsistentVersionWarning
from threadpoolctl import threadpool_limits
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

ROOT = Path(__file__).resolve().parent
MODEL_PATH = ROOT / 'door_model.joblib'
EXPECTED_SKLEARN = '1.8.0'
MAX_UPLOAD = 25 * 1024 * 1024
MAX_JOBS = 6
JOB_TTL_SECONDS = 3600


# -- CSV schema and parsing --
LABELS = ('Normal', 'Abnormal resistance')

EPOCH = datetime(1970, 1, 1)

COLUMNS = ['current', 'voltage', 'bemf', 'opening_time', 'closing_time', 'close_command', 'open_command', 'dcsr', 'dcsl', 'dlsr', 'dlsl', 'opened', 'locked', 'is_opening', 'is_closing', 'position']

ORIGINAL_HEADERS = ['Datetime', 'Motor current(mA)', 'Motor Voltage(10mV)', 'Motor electrodynamic force', 'Door opening time(.1s)', 'Door closing time(.1s)', 'Close command', 'Open command', 'DCSR', 'DCSL', 'DLSR', 'DLSL', 'Door Opened', 'Door Locked', 'Door is opening', 'Door is closing', 'Door leaf position']

def norm(s: str) -> str:
    return re.sub('[^a-z0-9]', '', s.lower().replace('\ufeff', ''))

ALIASES = {norm(k): v for k, v in zip(ORIGINAL_HEADERS, ['timestamp'] + COLUMNS)}

NATIVE_RE = re.compile('^(\\d{4})-(\\d{1,2})-(\\d{1,2})-(\\d{1,2})-(\\d{1,2})-(\\d{1,2})-(\\d{1,3})$')

class DataError(ValueError):
    """Actionable input validation error suitable for display in the app."""

def parse_timestamp(value: str) -> int:
    """Milliseconds on the supplied naive clock; '.92' native field means 92 ms."""
    s = str(value).strip()
    match = NATIVE_RE.fullmatch(s)
    try:
        if match:
            y, mo, d, h, mi, sec, ms = map(int, match.groups())
            dt = datetime(y, mo, d, h, mi, sec, ms * 1000)
        else:
            dt = datetime.fromisoformat(s)
            if dt.tzinfo is not None:
                raise ValueError("Timezone-aware input is unsupported; use the dataset's native clock.")
            if dt.microsecond % 1000:
                raise ValueError('Sub-millisecond timestamps are unsupported.')
        delta = dt - EPOCH
        return (delta.days * 86400 + delta.seconds) * 1000 + delta.microseconds // 1000
    except (ValueError, OverflowError) as exc:
        raise DataError(f'Invalid timestamp {s!r}: {exc}') from exc

def format_timestamp(ms: int) -> str:
    d = EPOCH + timedelta(milliseconds=int(ms))
    return f'{d.year}-{d.month}-{d.day}-{d.hour}-{d.minute}-{d.second}-{d.microsecond // 1000}'

@dataclass
class Stream:
    timestamps: list[str]
    t_ms: np.ndarray
    x: np.ndarray
    source_name: str = ''
    extra_columns: tuple[str, ...] = ()

    def subset(self, lo: int, hi: int) -> 'Stream':
        return Stream(self.timestamps[lo:hi], self.t_ms[lo:hi], self.x[lo:hi], self.source_name, self.extra_columns)

    def column(self, name: str) -> np.ndarray:
        return self.x[:, COLUMNS.index(name)]

def load_stream(source: str | Path | bytes) -> Stream:
    if isinstance(source, bytes):
        raw, name = (source, 'uploaded.csv')
    else:
        path = Path(source)
        raw, name = (path.read_bytes(), path.name)
    if len(raw) > 25 * 1024 * 1024:
        raise DataError('CSV exceeds the 25 MiB limit for this local prototype.')
    try:
        text = raw.decode('utf-8-sig')
    except UnicodeDecodeError as exc:
        raise DataError('Save the CSV with UTF-8 encoding.') from exc
    reader = csv.reader(io.StringIO(text))
    try:
        header = next(reader)
    except StopIteration:
        raise DataError('The CSV is empty.')
    canonical = [ALIASES.get(norm(h)) for h in header]
    required = ['timestamp'] + COLUMNS
    if len(header) != len(set((norm(h) for h in header))):
        raise DataError('Duplicate column headers are not supported.')
    for c in required:
        if canonical.count(c) != 1:
            raise DataError(f'Missing or ambiguous telemetry column: {c}. Upload a raw Door stream, not a submission CSV.')
    idx = [canonical.index(c) for c in required]
    stamps, times, values = ([], [], [])
    for line_no, row in enumerate(reader, start=2):
        if not row or not any((s.strip() for s in row)):
            continue
        if len(row) != len(header):
            raise DataError(f'Row {line_no}: expected {len(header)} fields, got {len(row)}.')
        stamp = row[idx[0]].strip()
        t = parse_timestamp(stamp)
        if times and t <= times[-1]:
            raise DataError(f'Row {line_no}: timestamps must strictly increase. Duplicate/interleaved assets require separate streams.')
        vals = []
        for col, j in zip(COLUMNS, idx[1:]):
            s = row[j].strip()
            try:
                v = float(s) if s.lower() not in ('', 'na', 'nan', 'null') else np.nan
            except ValueError as exc:
                raise DataError(f'Row {line_no}, {col}: {s!r} is not numeric.') from exc
            if np.isinf(v):
                raise DataError(f'Row {line_no}, {col}: infinite values are invalid.')
            vals.append(v)
        stamps.append(stamp)
        times.append(t)
        values.append(vals)
    if len(times) < 2:
        raise DataError('At least two telemetry rows are required.')
    x = np.asarray(values, dtype=np.float64)
    if np.any(np.mean(~np.isfinite(x), axis=0) > 0.1):
        raise DataError('More than 10% of a required signal is missing. Repair the source before inference.')
    extra = tuple((h for h, c in zip(header, canonical) if c is None))
    return Stream(stamps, np.asarray(times, dtype=np.int64), x, name, extra)

@dataclass(frozen=True)
class Segment:
    lo: int
    hi: int
    start_ms: int
    end_ms: int
    start_time: str
    end_time: str

def make_segment(stream: Stream, lo: int, hi: int) -> Segment:
    return Segment(lo, hi, int(stream.t_ms[lo]), int(stream.t_ms[hi - 1]), stream.timestamps[lo], stream.timestamps[hi - 1])

def predictions_csv(segments: list[dict]) -> str:
    output = io.StringIO(newline='')
    writer = csv.DictWriter(output, fieldnames=['start_time', 'end_time', 'prediction'], lineterminator='\n')
    writer.writeheader()
    for s in segments:
        if s['prediction'] not in LABELS:
            raise DataError('Invalid prediction label.')
        if parse_timestamp(s['end_time']) <= parse_timestamp(s['start_time']):
            raise DataError('Predicted segments must have positive duration.')
        writer.writerow({k: s[k] for k in writer.fieldnames})
    return output.getvalue()
ALIASES.update({norm('Motor back electromotive force'): 'bemf', norm('Door opening time(0.1s)'): 'opening_time', norm('Door closing time(0.1s)'): 'closing_time'})


# -- Recorded-cycle segmentation --
@dataclass
class GapSegmenter:
    threshold_ms: float = 200.0
    nominal_step_ms: float = 20.0
    max_training_within_gap_ms: float = 20.0
    min_training_between_gap_ms: float = 10000.0
    min_training_rows: int = 2
    max_training_rows: int = 1000000

    def predict(self, stream: Stream) -> list[Segment]:
        boundaries = np.r_[0, np.flatnonzero(np.diff(stream.t_ms) > self.threshold_ms) + 1, len(stream.t_ms)]
        result = []
        for lo, hi in zip(boundaries[:-1], boundaries[1:]):
            if hi - lo < 2:
                raise DataError('A gap-delimited block has fewer than two rows. Check incomplete/missing telemetry; it was not silently dropped.')
            result.append(make_segment(stream, int(lo), int(hi)))
        return result

# -- Per-cycle signals and five frozen features --
def clean_cycle(stream: Stream, segment: Segment) -> tuple[np.ndarray, list[str]]:
    x = stream.x[segment.lo:segment.hi].copy()
    t = (stream.t_ms[segment.lo:segment.hi] - segment.start_ms) / 1000.0
    warnings = []
    for j, c in enumerate(COLUMNS):
        valid = np.isfinite(x[:, j])
        if valid.mean() < 0.9:
            raise DataError(f'{segment.start_time}: more than 10% of {c} is missing within this cycle.')
        if not valid.all():
            x[:, j] = np.interp(t, t[valid], x[valid, j])
            warnings.append(f'{c}: {int((~valid).sum())} missing samples interpolated within this cycle only.')
    return (x, warnings)

def cycle_signals(stream: Stream, segment: Segment) -> dict:
    x, warnings = clean_cycle(stream, segment)
    t = (stream.t_ms[segment.lo:segment.hi] - segment.start_ms) / 1000.0
    c = {name: x[:, j] for j, name in enumerate(COLUMNS)}
    pos = c['position']
    delta = pos[-1] - pos[0]
    if abs(delta) > max(1.0, 0.2 * np.ptp(pos)):
        op = 'Open' if delta > 0 else 'Close'
        progress = np.clip((pos - pos[0]) / delta, 0, 1)
    else:
        op = 'Open' if np.mean(c['open_command']) >= np.mean(c['close_command']) else 'Close'
        progress = t / max(t[-1], 1e-09)
        warnings.append('Incomplete/low-net-travel cycle: progress falls back to normalised elapsed time.')
    current = c['current'] / 1000.0
    voltage = c['voltage'] * 0.01
    speed = np.gradient(pos, t)
    return {'t': t, 'current': current, 'voltage': voltage, 'bemf': c['bemf'], 'position': pos, 'speed': speed, 'progress': progress, 'operation': op, 'raw': c, 'warnings': warnings}

FEATURE_SCHEMA = 'door_current5_v1'

FEATURE_NAMES = ['moving_current_mean_A', 'moving_current_q90_A', 'moving_current_rms_A', 'current_q10_A', 'current_median_A']

def normalized_travel(position: np.ndarray) -> np.ndarray:
    """Same normalization as the lean notebook (not the legacy97 fallback)."""
    position = np.asarray(position, dtype=np.float64)
    if position.ndim != 1 or len(position) < 2 or (not np.isfinite(position).all()):
        raise DataError('Current5 features require at least two finite position readings.')
    span = position[-1] - position[0]
    if abs(span) < 1e-12:
        return np.linspace(0.0, 1.0, len(position))
    return (position - position[0]) / span

def extract_arrays(current_mA: np.ndarray, position: np.ndarray) -> tuple[np.ndarray, list[str]]:
    """Five statistics, in frozen order; input current is in source mA units."""
    current = np.asarray(current_mA, dtype=np.float64) / 1000.0
    position = np.asarray(position, dtype=np.float64)
    if current.ndim != 1 or current.shape != position.shape or len(current) < 2:
        raise DataError('Current and position need matching cycle-length arrays.')
    if not np.isfinite(current).all():
        raise DataError('Current5 features require finite current after within-cycle cleaning.')
    travel = normalized_travel(position)
    notes: list[str] = []
    if abs(position[-1] - position[0]) < 1e-12:
        notes.append('Current5 movement region used sample-order progress because net position change is zero; review this recording.')
    moving = current[(travel >= 0.1) & (travel <= 0.9)]
    if len(moving) < 5:
        moving = current
        notes.append('Current5 movement-region statistics used the full cycle because fewer than five central-travel samples were available.')
    row = np.array([np.mean(moving), np.quantile(moving, 0.9), np.sqrt(np.mean(moving ** 2)), np.quantile(current, 0.1), np.median(current)], dtype=np.float64)
    if not np.isfinite(row).all():
        raise DataError('Non-finite Current5 features; inspect the uploaded signal values.')
    return (row, notes)

def extract_one(stream: Stream, segment: Segment) -> tuple[np.ndarray, list[str]]:
    clean, notes = clean_cycle(stream, segment)
    row, extra_notes = extract_arrays(clean[:, COLUMNS.index('current')], clean[:, COLUMNS.index('position')])
    return (row, notes + extra_notes)

def feature_matrix(stream: Stream, segments: list[Segment]) -> tuple[np.ndarray, list[str]]:
    if not segments:
        raise DataError('No completed cycles available for Current5 inference.')
    return (np.vstack([extract_one(stream, s)[0] for s in segments]), FEATURE_NAMES.copy())

def abnormal_score(model, X: np.ndarray) -> np.ndarray:
    """An uncalibrated model score, not a probability of mechanical failure."""
    if hasattr(model, 'predict_proba'):
        p = model.predict_proba(X)
        classes = list(model.classes_)
        return p[:, classes.index(1)] if 1 in classes else np.zeros(len(X))
    z = model.decision_function(X)
    return 1 / (1 + np.exp(-np.clip(z, -40, 40)))


def load_bundle(path: str | Path = MODEL_PATH) -> dict:
    """Load only a trusted, local Current5 artifact; never fit or repair weights."""
    path = Path(path)
    if not path.is_file():
        raise DataError(f'Model not found: {path}. Place the provided door_model.joblib beside predict.py.')
    if sklearn.__version__ != EXPECTED_SKLEARN:
        raise DataError(f'This frozen artifact requires scikit-learn {EXPECTED_SKLEARN}; installed {sklearn.__version__}. Use the supplied pinned requirements in a virtual environment.')
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', InconsistentVersionWarning)
            bundle = joblib.load(path)
    except Exception as exc:
        raise DataError(f'Could not load the trusted model artifact: {exc}. Restore the supplied file and matching environment.') from exc
    if not isinstance(bundle, dict) or bundle.get('format_version') != 2:
        raise DataError('This script requires the supplied v2 five-feature model, not the original 97-feature artifact.')
    if bundle.get('feature_schema') != FEATURE_SCHEMA or bundle.get('feature_names') != FEATURE_NAMES:
        raise DataError('Wrong feature schema. Replace predict.py and door_model.joblib together.')
    model = bundle.get('classifier')
    if getattr(model, 'n_features_in_', None) != 5 or list(getattr(model, 'classes_', [])) != [0, 1]:
        raise DataError('The artifact must have five inputs and trained Normal/Abnormal classes.')
    if bundle.get('versions', {}).get('sklearn') != sklearn.__version__:
        raise DataError('Artifact version differs from installed scikit-learn.')
    expected_steps = ['imputer', 'scaler', 'classifier']
    if list(getattr(model, 'named_steps', {})) != expected_steps:
        raise DataError('Unexpected preprocessing pipeline. Use the matching release artifact.')
    for required in ['segmenter', 'normal_reference', 'training_cycles', 'model_id', 'model_name']:
        if required not in bundle:
            raise DataError(f'Model is missing required metadata: {required}.')
    if not np.isfinite(bundle['segmenter'].get('threshold_ms', float('nan'))) or bundle['segmenter']['threshold_ms'] <= 0:
        raise DataError('Invalid learned segmentation threshold.')
    return bundle


# -- Predictions and evidence --
def predict_stream(bundle: dict, stream: Stream) -> tuple[dict, list[Segment], np.ndarray]:
    tick = time.perf_counter()
    segmenter = GapSegmenter(**bundle['segmenter'])
    segments = segmenter.predict(stream)
    X, names = feature_matrix(stream, segments)
    if names != bundle['feature_names']:
        raise DataError('Feature schema does not match model; use the matching code or retrain.')
    model = bundle['classifier']
    pred = model.predict(X)
    scores = abnormal_score(model, X)
    results = []
    global_warnings = []
    if stream.extra_columns:
        global_warnings.append('Extra columns ignored: ' + ', '.join(stream.extra_columns) + '. Asset identities are not inferred from them.')
    for i, (s, label, score) in enumerate(zip(segments, pred, scores)):
        a = cycle_signals(stream, s)
        warnings = list(a['warnings'])
        if bundle.get('feature_schema') == FEATURE_SCHEMA:
            _, lean_warnings = extract_one(stream, s)
            warnings = list(dict.fromkeys(warnings + lean_warnings))
        gaps = np.diff(stream.t_ms[s.lo:s.hi])
        if np.any(gaps != segmenter.nominal_step_ms):
            warnings.append('Within-cycle sampling differs from training; feature reliability needs review.')
        if not segmenter.min_training_rows <= s.hi - s.lo <= segmenter.max_training_rows:
            warnings.append('Cycle length falls outside training range; check incomplete or merged cycles.')
        results.append({'cycle_index': i, 'start_index': s.lo, 'end_index': s.hi - 1, 'startIndex': s.lo, 'endIndex': s.hi - 1, 'cycle_id': f'cycle_{i + 1:03d}', 'start_time': s.start_time, 'end_time': s.end_time, 'prediction': LABELS[int(label)], 'operation_inferred': a['operation'], 'abnormal_model_score': float(score), 'score_description': 'Uncalibrated classifier output; not a probability of mechanical failure.', 'duration_s': (s.end_ms - s.start_ms) / 1000.0, 'n_rows': s.hi - s.lo, 'mean_current_A': float(np.mean(a['current'])), 'peak_current_A': float(np.max(a['current'])), 'data_quality_warnings': warnings, 'asset_id': None, 'recommendation': 'Review this abnormal-resistance cycle and follow the applicable inspection procedure.' if label else 'No abnormal-resistance signature classified in this cycle; this is not a safety clearance.'})
    summary = {'rows': len(stream.t_ms), 'cycles': len(segments), 'normal': int(np.sum(pred == 0)), 'abnormal_resistance': int(np.sum(pred == 1)), 'source_start': stream.timestamps[0], 'source_end': stream.timestamps[-1], 'inference_seconds': round(time.perf_counter() - tick, 4)}
    response = {'model_name': bundle['model_name'], 'model_id': bundle['model_id'], 'source_name': stream.source_name, 'mode': 'offline_completed_cycle_analysis', 'summary': summary, 'segments': results, 'warnings': global_warnings + ['Dataset has no car/door identifiers; cycle IDs are not physical door IDs.', 'Gap segmentation is validated for the supplied recording format, not arbitrary uninterrupted live telemetry.', 'Advisory only. No train control, safety clearance or future-failure prediction.']}
    return (response, segments, X)

def cycle_detail(bundle: dict, stream: Stream, segment: Segment, feature_row: np.ndarray) -> dict:
    a = cycle_signals(stream, segment)
    n = len(a['t'])
    indices = np.arange(n) if n <= 1500 else np.unique(np.linspace(0, n - 1, 1500).astype(int))
    points = [{'elapsed_s': float(a['t'][j]), 'elapsed_fraction': float(a['t'][j] / a['t'][-1]), 'travel_fraction': float(a['progress'][j]), 'current_A': float(a['current'][j]), 'voltage_V': float(a['voltage'][j]), 'bemf_raw': float(a['bemf'][j]), 'position_raw': float(a['position'][j])} for j in indices]
    model = bundle['classifier']
    names = bundle['feature_names']
    explanations = []
    classifier = model.named_steps['classifier']
    if hasattr(classifier, 'coef_'):
        transformed = model[:-1].transform(feature_row.reshape(1, -1))[0]
        keep = model.named_steps['variance'].get_support() if 'variance' in model.named_steps else np.ones(len(names), dtype=bool)
        active = np.array(names)[keep]
        contributions = transformed * classifier.coef_[0]
        order = np.argsort(np.abs(contributions))[::-1][:8]
        for j in order:
            k = names.index(str(active[j]))
            val = feature_row[k]
            explanations.append({'feature': str(active[j]), 'value': float(val) if np.isfinite(val) else None, 'log_odds_contribution': float(contributions[j]), 'direction': 'toward Abnormal resistance' if contributions[j] > 0 else 'toward Normal'})
        explanation_method = 'Largest signed feature contributions to the logistic log-odds; correlated features share influence. These are model explanations, not mechanical causes.'
        intercept = float(classifier.intercept_[0])
    else:
        explanation_method = 'Local additive explanation unavailable for this selected model; inspect signals and cycle-level features.'
        intercept = None
    feats = {k: float(v) if np.isfinite(v) else None for k, v in zip(names, feature_row)}
    return {'points': points, 'display_downsampled': n > 1500, 'reference': bundle['normal_reference']['by_operation'].get(a['operation']), 'reference_method': bundle['normal_reference']['method'], 'reference_limitation': bundle['normal_reference']['limitation'], 'features': feats, 'explanations': explanations, 'explanation_method': explanation_method, 'model_intercept': intercept, 'units': {'current': 'A (source mA / 1000)', 'voltage': 'V (source 10 mV units × 0.01)', 'bemf': 'raw; source units unspecified', 'position': 'raw; source units unspecified'}}

# ------------------------ Local HTTP API ------------------------
app = FastAPI(
    title='RailWitness Door API', version='2.0.0-current5-flat',
    description='Frozen five-feature completed-cycle analysis. Read-only; no future-failure forecast.'
)
_origins = os.environ.get(
    'RAILWITNESS_CORS_ORIGINS',
    'http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000,http://127.0.0.1:3000'
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in _origins.split(',') if origin.strip()],
    allow_credentials=False, allow_methods=['GET', 'POST'], allow_headers=['Content-Type']
)

@dataclass
class Job:
    created: float
    stream: Stream
    segments: list[Segment]
    features: np.ndarray
    result: dict
    csv: bytes

jobs: dict[str, Job] = {}
cache_lock = Lock()
inference_lock = Lock()

@lru_cache(maxsize=1)
def model() -> dict:
    return load_bundle(MODEL_PATH)

def _prune_jobs() -> None:
    for key in list(jobs):
        if time.time() - jobs[key].created > JOB_TTL_SECONDS:
            del jobs[key]

def get_job(job_id: str) -> Job:
    with cache_lock:
        _prune_jobs()
        if job_id not in jobs:
            raise HTTPException(404, 'Analysis expired or unknown. Re-analyse the recording, or upload the original CSV again.')
        return jobs[job_id]

def describe_model(bundle: dict, path: Path = MODEL_PATH) -> dict:
    return {
        'model_name': bundle['model_name'], 'model_id': bundle['model_id'],
        'feature_count': len(bundle['feature_names']), 'feature_names': bundle['feature_names'],
        'feature_schema': bundle['feature_schema'], 'training_cycles': bundle['training_cycles'],
        'versions': bundle['versions'], 'segmenter': bundle['segmenter'],
        'artifact_sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
        'reference_method': bundle['normal_reference']['method'],
        'score_description': 'Uncalibrated classifier output; not a probability of mechanical failure.',
        'scope': 'Supplied gap-separated completed-cycle recordings; no physical door identity or future-failure forecast.',
        'runtime': 'single-file-predict-current5-v1',
    }

@app.get('/', include_in_schema=False)
def index():
    return {'service': 'RailWitness Door API', 'runtime': 'single-file-predict-current5-v1',
            'docs': '/docs', 'model': '/api/door/model'}

@app.get('/api/health')
def health():
    return {'status': 'ok', 'mode': 'local_advisory', 'model_file_present': MODEL_PATH.is_file(),
            'note': 'Use /api/door/model to verify successful model loading.'}

@app.get('/api/door/model')
def model_info():
    try:
        return describe_model(model())
    except (DataError, FileNotFoundError) as exc:
        raise HTTPException(503, str(exc)) from exc

@app.post('/api/door/predict')
def upload_predict(file: UploadFile = File(...)):
    filename = Path((file.filename or 'uploaded.csv').replace('\\', '/')).name
    if not filename.lower().endswith('.csv'):
        raise HTTPException(422, 'Upload a raw Door .csv file, not a ZIP, model, or example submission.')
    raw = file.file.read(MAX_UPLOAD + 1)
    if len(raw) > MAX_UPLOAD:
        raise HTTPException(413, 'File exceeds the 25 MiB limit.')
    try:
        bundle = model()
    except (DataError, FileNotFoundError) as exc:
        raise HTTPException(503, str(exc)) from exc
    try:
        stream = load_stream(raw)
        stream.source_name = filename
        with inference_lock, threadpool_limits(limits=1):
            result, segments, features = predict_stream(bundle, stream)
    except (DataError, FileNotFoundError) as exc:
        raise HTTPException(422, str(exc)) from exc
    result['source_sha256'] = hashlib.sha256(raw).hexdigest()
    result['feature_count'] = len(FEATURE_NAMES)
    result['feature_schema'] = FEATURE_SCHEMA
    result['analysed_at'] = datetime.now(timezone.utc).isoformat()
    job_id = uuid.uuid4().hex
    base = f'/api/door/jobs/{job_id}'
    result.update({
        'job_id': job_id,
        'downloads': {'csv': base + '/predictions.csv', 'zip': base + '/predictions.zip'},
        'retention': 'Results cached in local memory for up to one hour or until eviction/restart. Upload spooling may use local temporary files. No intentional dataset archive.'
    })
    blob = predictions_csv(result['segments']).encode('utf-8')
    with cache_lock:
        _prune_jobs()
        while len(jobs) >= MAX_JOBS:
            del jobs[min(jobs, key=lambda key: jobs[key].created)]
        jobs[job_id] = Job(time.time(), stream, segments, features, result, blob)
    return result

@app.get('/api/door/jobs/{job_id}/cycles/{cycle_index}')
def detail(job_id: str, cycle_index: int):
    job = get_job(job_id)
    if not 0 <= cycle_index < len(job.segments):
        raise HTTPException(404, 'Cycle index is out of range.')
    segment = job.segments[cycle_index]
    with inference_lock, threadpool_limits(limits=1):
        evidence = cycle_detail(model(), job.stream, segment, job.features[cycle_index])
    return {
        'segment': job.result['segments'][cycle_index],
        'model_id': job.result['model_id'], 'feature_count': 5,
        'start_index': segment.lo, 'end_index': segment.hi - 1,
        **evidence,
    }

@app.get('/api/door/jobs/{job_id}/predictions.csv')
def download_csv(job_id: str):
    return Response(get_job(job_id).csv, media_type='text/csv',
                    headers={'Content-Disposition': 'attachment; filename="door_predictions.csv"', 'Cache-Control': 'no-store'})

@app.get('/api/door/jobs/{job_id}/predictions.zip')
def download_zip(job_id: str):
    memory = io.BytesIO()
    with zipfile.ZipFile(memory, 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('door_predictions.csv', get_job(job_id).csv)
    return Response(memory.getvalue(), media_type='application/zip',
                    headers={'Content-Disposition': 'attachment; filename="predictions.zip"', 'Cache-Control': 'no-store'})

# ------------------------ Command-line interface ------------------------
def predict_file(input_path: str | Path, model_path: str | Path = MODEL_PATH) -> dict:
    """Return backend-style predictions from raw telemetry; never read cached CSVs."""
    bundle = load_bundle(model_path)
    stream = load_stream(input_path)
    with threadpool_limits(limits=1):
        result, _, _ = predict_stream(bundle, stream)
    result['feature_count'] = len(FEATURE_NAMES)
    result['feature_schema'] = FEATURE_SCHEMA
    result['source_sha256'] = hashlib.sha256(Path(input_path).read_bytes()).hexdigest()
    return result

def _write_outputs(args, result: dict) -> Path:
    output = args.output or ROOT / 'door_predictions.csv'
    if output.is_dir() or output.suffix.lower() != '.csv':
        output = output / 'door_predictions.csv'
    paths = [output] + [p for p in [args.details, args.zip_path] if p is not None]
    resolved = [p.resolve() for p in paths]
    protected = {args.input.resolve(), args.model.resolve(), Path(__file__).resolve()}
    if len(set(resolved)) != len(resolved) or any(p in protected for p in resolved):
        raise DataError('Outputs must be distinct and must not overwrite the input, model, or prediction script.')
    raw = predictions_csv(result['segments']).encode('utf-8')
    for path in paths:
        path.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(raw)
    if args.details:
        args.details.write_text(json.dumps(result, indent=2, allow_nan=False), encoding='utf-8')
    if args.zip_path:
        with zipfile.ZipFile(args.zip_path, 'w', zipfile.ZIP_DEFLATED) as archive:
            archive.writestr('door_predictions.csv', raw)
    return output

def main() -> None:
    parser = argparse.ArgumentParser(description='Frozen five-feature Door inference; no retraining.')
    parser.add_argument('--input', type=Path, help='Raw continuous Door CSV (required for prediction)')
    parser.add_argument('--output', type=Path, help='CSV filename or output directory; default is beside this script')
    parser.add_argument('--model', type=Path, default=MODEL_PATH, help='Trusted five-feature artifact; default is beside this script')
    parser.add_argument('--details', type=Path, help='Optional analysis JSON')
    parser.add_argument('--zip', type=Path, dest='zip_path', help='Optional flat submission ZIP')
    parser.add_argument('--model-info', action='store_true', help='Load model and report five-feature metadata, without running inference')
    parser.add_argument('--serve', action='store_true', help='Start the local Door API instead of CLI prediction')
    parser.add_argument('--port', type=int, default=8000, help='Local API port (with --serve)')
    args = parser.parse_args()
    if args.model_info and args.serve:
        parser.error('Use --model-info or --serve, not both.')
    if args.serve:
        if args.input or args.output or args.details or args.zip_path or args.model.resolve() != MODEL_PATH.resolve():
            parser.error('--serve uses the model beside this script. Do not mix it with CLI input/output/model options.')
        if not 1 <= args.port <= 65535:
            parser.error('--port must be between 1 and 65535.')
        model()  # Fail before starting if the artifact/environment is incompatible.
        import uvicorn
        uvicorn.run(app, host='127.0.0.1', port=args.port)
        return
    if args.model_info:
        print(json.dumps(describe_model(load_bundle(args.model), args.model), indent=2, allow_nan=False))
        return
    if args.input is None:
        parser.error('--input is required, or use --model-info / --serve.')
    result = predict_file(args.input, args.model)
    output = _write_outputs(args, result)
    print(json.dumps({'output': str(output), 'model': result['model_name'], 'model_id': result['model_id'],
                      'feature_count': 5, **result['summary']}, indent=2, allow_nan=False))

if __name__ == '__main__':
    try:
        main()
    except (DataError, FileNotFoundError, OSError) as exc:
        raise SystemExit(str(exc)) from exc
