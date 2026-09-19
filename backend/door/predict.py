#!/usr/bin/env python3
"""Standalone preprocessing, inference, and cycle evidence for the frozen Door model."""
from __future__ import annotations
import argparse
import csv
from dataclasses import dataclass
from datetime import datetime
import io
import json
from pathlib import Path
import re
import time

import joblib
import numpy as np
import sklearn
from threadpoolctl import threadpool_limits

ROOT = Path(__file__).resolve().parent


LABELS = ('Normal', 'Abnormal resistance')
EPOCH = datetime(1970, 1, 1)
COLUMNS = ['current', 'voltage', 'bemf', 'opening_time', 'closing_time',
           'close_command', 'open_command', 'dcsr', 'dcsl', 'dlsr', 'dlsl',
           'opened', 'locked', 'is_opening', 'is_closing', 'position']
ORIGINAL_HEADERS = ['Datetime', 'Motor current(mA)', 'Motor Voltage(10mV)',
    'Motor electrodynamic force', 'Door opening time(.1s)', 'Door closing time(.1s)',
    'Close command', 'Open command', 'DCSR', 'DCSL', 'DLSR', 'DLSL', 'Door Opened',
    'Door Locked', 'Door is opening', 'Door is closing', 'Door leaf position']

def norm(s: str) -> str:
    return re.sub(r'[^a-z0-9]', '', s.lower().replace('\ufeff', ''))

ALIASES = {norm(k): v for k, v in zip(ORIGINAL_HEADERS, ['timestamp'] + COLUMNS)}
ALIASES.update({norm('Motor back electromotive force'): 'bemf',
                norm('Door opening time(0.1s)'): 'opening_time',
                norm('Door closing time(0.1s)'): 'closing_time'})
NATIVE_RE = re.compile(r'^(\d{4})-(\d{1,2})-(\d{1,2})-(\d{1,2})-(\d{1,2})-(\d{1,2})-(\d{1,3})$')

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
                raise ValueError('Timezone-aware input is unsupported; use the dataset\'s native clock.')
            if dt.microsecond % 1000:
                raise ValueError('Sub-millisecond timestamps are unsupported.')
        delta = dt - EPOCH
        return (delta.days * 86400 + delta.seconds) * 1000 + delta.microseconds // 1000
    except (ValueError, OverflowError) as exc:
        raise DataError(f'Invalid timestamp {s!r}: {exc}') from exc


@dataclass
class Stream:
    timestamps: list[str]
    t_ms: np.ndarray
    x: np.ndarray
    source_name: str = ''
    extra_columns: tuple[str, ...] = ()

def load_stream(source: str | Path | bytes) -> Stream:
    if isinstance(source, bytes):
        raw, name = source, 'uploaded.csv'
    else:
        path = Path(source)
        raw, name = path.read_bytes(), path.name
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
    if len(header) != len(set(norm(h) for h in header)):
        raise DataError('Duplicate column headers are not supported.')
    for c in required:
        if canonical.count(c) != 1:
            raise DataError(f'Missing or ambiguous telemetry column: {c}. Upload a raw Door stream, not a submission CSV.')
    idx = [canonical.index(c) for c in required]
    stamps, times, values = [], [], []
    for line_no, row in enumerate(reader, start=2):
        if not row or not any(s.strip() for s in row):
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
        stamps.append(stamp); times.append(t); values.append(vals)
    if len(times) < 2:
        raise DataError('At least two telemetry rows are required.')
    x = np.asarray(values, dtype=np.float64)
    if np.any(np.mean(~np.isfinite(x), axis=0) > 0.10):
        raise DataError('More than 10% of a required signal is missing. Repair the source before inference.')
    extra = tuple(h for h,c in zip(header,canonical) if c is None)
    return Stream(stamps, np.asarray(times, dtype=np.int64), x, name, extra)


@dataclass(frozen=True)
class Segment:
    lo: int
    hi: int  # exclusive row index
    start_ms: int
    end_ms: int
    start_time: str
    end_time: str


def make_segment(stream: Stream, lo: int, hi: int) -> Segment:
    return Segment(lo, hi, int(stream.t_ms[lo]), int(stream.t_ms[hi-1]),
                   stream.timestamps[lo], stream.timestamps[hi-1])


def predictions_csv(segments: list[dict]) -> str:
    output = io.StringIO(newline='')
    writer = csv.DictWriter(output, fieldnames=['start_time','end_time','prediction'], lineterminator='\n')
    writer.writeheader()
    for s in segments:
        if s['prediction'] not in LABELS:
            raise DataError('Invalid prediction label.')
        if parse_timestamp(s['end_time']) <= parse_timestamp(s['start_time']):
            raise DataError('Predicted segments must have positive duration.')
        writer.writerow({k:s[k] for k in writer.fieldnames})
    return output.getvalue()


@dataclass
class GapSegmenter:
    threshold_ms: float = 200.0
    nominal_step_ms: float = 20.0
    max_training_within_gap_ms: float = 20.0
    min_training_between_gap_ms: float = 10000.0
    min_training_rows: int = 2
    max_training_rows: int = 1000000

    def predict(self, stream: Stream) -> list[Segment]:
        boundaries = np.r_[0, np.flatnonzero(np.diff(stream.t_ms) > self.threshold_ms)+1, len(stream.t_ms)]
        result = []
        for lo,hi in zip(boundaries[:-1],boundaries[1:]):
            if hi-lo < 2:
                raise DataError('A gap-delimited block has fewer than two rows. Check incomplete/missing telemetry; it was not silently dropped.')
            result.append(make_segment(stream, int(lo), int(hi)))
        return result


def clean_cycle(stream: Stream, segment: Segment) -> tuple[np.ndarray, list[str]]:
    x = stream.x[segment.lo:segment.hi].copy()
    t = (stream.t_ms[segment.lo:segment.hi]-segment.start_ms)/1000.0
    warnings = []
    for j,c in enumerate(COLUMNS):
        valid = np.isfinite(x[:,j])
        if valid.mean() < .9:
            raise DataError(f'{segment.start_time}: more than 10% of {c} is missing within this cycle.')
        if not valid.all():
            x[:,j] = np.interp(t,t[valid],x[valid,j])
            warnings.append(f'{c}: {int((~valid).sum())} missing samples interpolated within this cycle only.')
    return x, warnings


def cycle_signals(stream: Stream, segment: Segment) -> dict:
    x, warnings = clean_cycle(stream, segment)
    t = (stream.t_ms[segment.lo:segment.hi]-segment.start_ms)/1000.0
    c = {name:x[:,j] for j,name in enumerate(COLUMNS)}
    pos = c['position']; delta = pos[-1]-pos[0]
    # Raw position units are unspecified. This is within-cycle normalised travel, not millimetres.
    if abs(delta) > max(1.0, .2*np.ptp(pos)):
        op = 'Open' if delta > 0 else 'Close'
        progress = np.clip((pos-pos[0])/delta,0,1)
    else:
        op = 'Open' if np.mean(c['open_command']) >= np.mean(c['close_command']) else 'Close'
        progress = t/max(t[-1],1e-9)
        warnings.append('Incomplete/low-net-travel cycle: progress falls back to normalised elapsed time.')
    current = c['current']/1000.0
    voltage = c['voltage']*.01
    speed = np.gradient(pos,t)
    return {'t':t,'current':current,'voltage':voltage,'bemf':c['bemf'],
            'position':pos,'speed':speed,'progress':progress,'operation':op,
            'warnings':warnings}


def describe(prefix: str, values: np.ndarray, out: dict) -> None:
    if len(values)==0:
        for name in ['mean','std','q10','median','q90','max','rms']:
            out[f'{prefix}_{name}'] = np.nan
        return
    q10,med,q90 = np.quantile(values,[.1,.5,.9])
    for name,v in [('mean',np.mean(values)),('std',np.std(values)),('q10',q10),
                   ('median',med),('q90',q90),('max',np.max(values)),
                   ('rms',np.sqrt(np.mean(values**2)))]:
        out[f'{prefix}_{name}']=float(v)


def extract_one(stream: Stream, s: Segment) -> dict[str,float]:
    a=cycle_signals(stream,s); t=a['t']; p=a['progress']; cur=a['current']; v=a['voltage']
    pos=a['position']; sp=np.abs(a['speed']); f={}
    f['is_open']=float(a['operation']=='Open')
    f['duration_s']=float(t[-1]); f['travel_raw_units']=float(np.ptp(pos))
    f['position_net_change']=float(pos[-1]-pos[0]); f['position_total_variation']=float(np.abs(np.diff(pos)).sum())
    for name in ['current','voltage','bemf']:
        describe(name,a[name],f)
    describe('abs_speed',sp,f)
    middle=(p>=.1)&(p<=.9)
    for name in ['current','voltage','bemf']:
        describe(f'moving_{name}',a[name][middle],f)
    describe('moving_abs_speed',sp[middle],f)
    f['charge_abs_As']=float(np.trapezoid(np.abs(cur),t))
    f['electrical_energy_abs_J']=float(np.trapezoid(np.abs(cur*v),t))
    f['charge_per_travel']=f['charge_abs_As']/max(np.ptp(pos),1.0)
    f['energy_per_travel']=f['electrical_energy_abs_J']/max(np.ptp(pos),1.0)
    f['current_diff_rms']=float(np.sqrt(np.mean(np.diff(cur)**2)))
    f['moving_stall_fraction']=float(np.mean(sp[middle]<.01*max(np.max(sp),1))) if middle.any() else np.nan
    # Fixed travel bins distinguish motion-phase current from normal end-stop/holding peaks.
    for k in range(5):
        mask=(p>=k/5)&(p<(k+1)/5) if k<4 else (p>=.8)&(p<=1)
        for name in ['current','voltage','bemf']:
            f[f'phase{k}_{name}_mean']=float(np.mean(a[name][mask])) if mask.any() else np.nan
        f[f'phase{k}_current_q90']=float(np.quantile(cur[mask],.9)) if mask.any() else np.nan
        f[f'phase{k}_speed_mean']=float(np.mean(sp[mask])) if mask.any() else np.nan
        f[f'phase{k}_time_fraction']=float(np.mean(mask))
    # Deliberately exclude opening/closing-time setting fields, absolute clocks, inter-cycle gaps,
    # n_rows labels, segment IDs, and missing physical asset identifiers.
    return f


def feature_matrix(stream: Stream, segments: list[Segment]) -> tuple[np.ndarray,list[str]]:
    rows=[extract_one(stream,s) for s in segments]
    if not rows:
        raise DataError('No cycles were detected.')
    names=list(rows[0])
    X=np.array([[r[n] for n in names] for r in rows],dtype=np.float64)
    if np.isinf(X).any():
        raise DataError('Infinite engineered features; inspect input units and values.')
    return X,names


def load_bundle(path: str | Path) -> dict:
    path=Path(path)
    if not path.is_file():
        raise DataError(f'Model not found at {path}. Restore the supplied door_model.joblib deployment artifact beside predict.py.')
    # Only load a local, trusted model artifact. The API never accepts uploaded model files.
    bundle=joblib.load(path)
    if bundle.get('format_version') != 1:
        raise DataError('Unsupported model format.')
    if bundle['versions']['sklearn']!=sklearn.__version__:
        raise DataError(f'Model uses scikit-learn {bundle["versions"]["sklearn"]}; installed version is {sklearn.__version__}. Install the pinned backend/requirements.txt dependencies.')
    return bundle


def predict_stream(bundle: dict, stream: Stream) -> tuple[dict,list[Segment],np.ndarray]:
    tick=time.perf_counter()
    segmenter=GapSegmenter(**bundle['segmenter'])
    segments=segmenter.predict(stream)
    X,names=feature_matrix(stream,segments)
    if names!=bundle['feature_names']:
        raise DataError('Feature schema does not match the frozen model; restore the matching supplied runtime code.')
    model=bundle['classifier']; pred=model.predict(X)
    scores=model.predict_proba(X)[:,list(model.classes_).index(1)]
    results=[]; global_warnings=[]
    if stream.extra_columns:
        global_warnings.append('Extra columns ignored: '+', '.join(stream.extra_columns)+'. Asset identities are not inferred from them.')
    for i,(s,label,score) in enumerate(zip(segments,pred,scores)):
        a=cycle_signals(stream,s); warnings=list(a['warnings'])
        gaps=np.diff(stream.t_ms[s.lo:s.hi])
        if np.any(gaps!=segmenter.nominal_step_ms):
            warnings.append('Within-cycle sampling differs from training; feature reliability needs review.')
        if not segmenter.min_training_rows <= s.hi-s.lo <= segmenter.max_training_rows:
            warnings.append('Cycle length falls outside training range; check incomplete or merged cycles.')
        results.append({'cycle_index':i,'cycle_id':f'cycle_{i+1:03d}',
            'start_index':s.lo,'end_index':s.hi-1,
            'start_time':s.start_time,'end_time':s.end_time,'prediction':LABELS[int(label)],
            'operation_inferred':a['operation'],'abnormal_model_score':float(score),
            'score_description':'Uncalibrated classifier output; not a probability of mechanical failure.',
            'duration_s':(s.end_ms-s.start_ms)/1000.,'n_rows':s.hi-s.lo,
            'mean_current_A':float(np.mean(a['current'])),'peak_current_A':float(np.max(a['current'])),
            'data_quality_warnings':warnings,'asset_id':None,
            'recommendation':('Review this abnormal-resistance cycle and follow the applicable inspection procedure.' if label else
                'No abnormal-resistance signature classified in this cycle; this is not a safety clearance.')})
    summary={'rows':len(stream.t_ms),'cycles':len(segments),
             'normal':int(np.sum(pred==0)),'abnormal_resistance':int(np.sum(pred==1)),
             'source_start':stream.timestamps[0],'source_end':stream.timestamps[-1],
             'inference_seconds':round(time.perf_counter()-tick,4)}
    response={'model_name':bundle['model_name'],'model_id':bundle['model_id'],'source_name':stream.source_name,
              'mode':'offline_completed_cycle_analysis','summary':summary,'segments':results,
              'warnings':global_warnings+['Dataset has no car/door identifiers; cycle IDs are not physical door IDs.',
                'Gap segmentation is validated for the supplied recording format, not arbitrary uninterrupted live telemetry.',
                'Advisory only. No train control, safety clearance or future-failure prediction.']}
    return response,segments,X


def cycle_detail(bundle: dict, stream: Stream, segment: Segment, feature_row: np.ndarray) -> dict:
    a=cycle_signals(stream,segment)
    # Preserve all sample extrema at this dataset's small cycle lengths. Display decimation only
    # for unusually long uploads; feature extraction above always used the full cycle.
    n=len(a['t']); indices=np.arange(n) if n<=1500 else np.unique(np.linspace(0,n-1,1500).astype(int))
    points=[{'elapsed_s':float(a['t'][j]),'elapsed_fraction':float(a['t'][j]/a['t'][-1]),
             'travel_fraction':float(a['progress'][j]),'current_A':float(a['current'][j]),
             'voltage_V':float(a['voltage'][j]),'bemf_raw':float(a['bemf'][j]),
             'position_raw':float(a['position'][j])} for j in indices]
    model=bundle['classifier']; names=bundle['feature_names']; explanations=[]
    classifier=model.named_steps['classifier']
    transformed=model[:-1].transform(feature_row.reshape(1,-1))[0]
    keep=model.named_steps['variance'].get_support()
    active=np.array(names)[keep]; contributions=transformed*classifier.coef_[0]
    order=np.argsort(np.abs(contributions))[::-1][:8]
    for j in order:
        k=names.index(str(active[j])); val=feature_row[k]
        explanations.append({'feature':str(active[j]),'value':float(val) if np.isfinite(val) else None,
          'log_odds_contribution':float(contributions[j]),
          'direction':'toward Abnormal resistance' if contributions[j]>0 else 'toward Normal'})
    explanation_method='Largest signed feature contributions to the logistic log-odds; correlated features share influence. These are model explanations, not mechanical causes.'
    intercept=float(classifier.intercept_[0])
    feats={k:float(v) if np.isfinite(v) else None for k,v in zip(names,feature_row)}
    return {'points':points,'display_downsampled':n>1500,'reference':bundle['normal_reference']['by_operation'].get(a['operation']),
            'reference_method':bundle['normal_reference']['method'],'reference_limitation':bundle['normal_reference']['limitation'],
            'features':feats,'explanations':explanations,'explanation_method':explanation_method,'model_intercept':intercept,
            'units':{'current':'A (source mA / 1000)','voltage':'V (source 10 mV units × 0.01)',
                     'bemf':'raw; source units unspecified','position':'raw; source units unspecified'}}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True, help='Raw, continuous Door CSV')
    parser.add_argument('--output', type=Path, default=ROOT/'door_predictions.csv',
                        help='Output CSV path or directory; defaults to door_predictions.csv beside this script')
    args = parser.parse_args()
    output = args.output
    if output.is_dir() or output.suffix.lower() != '.csv':
        output = output/'door_predictions.csv'
    protected = {args.input.resolve(), (ROOT/'door_model.joblib').resolve(), Path(__file__).resolve()}
    if args.output.resolve() in protected or output.resolve() in protected:
        raise DataError('Output must not overwrite the input stream, frozen model, or prediction script.')
    bundle = load_bundle(ROOT/'door_model.joblib')
    stream = load_stream(args.input)
    with threadpool_limits(limits=1):
        result, _, _ = predict_stream(bundle, stream)
    output.parent.mkdir(parents=True, exist_ok=True)
    raw = predictions_csv(result['segments']).encode('utf-8')
    output.write_bytes(raw)
    print(json.dumps({'output':str(output), 'model':result['model_name'], **result['summary']}, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (DataError, FileNotFoundError) as exc:
        raise SystemExit(str(exc)) from exc
