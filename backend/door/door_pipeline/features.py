"""Deterministic cycle features; no timestamps, cycle IDs or label-file metadata."""
from __future__ import annotations
import numpy as np
from .io import COLUMNS, Stream, Segment, DataError


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
            'raw':c,'warnings':warnings}


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
