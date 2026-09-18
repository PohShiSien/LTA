"""Shared inference used by the command line and the upload/download application."""
from __future__ import annotations
from pathlib import Path
import hashlib
import json
import time
import joblib
import numpy as np
import sklearn
from .io import Stream, Segment, LABELS, load_stream, DataError
from .segmentation import GapSegmenter
from .features import feature_matrix, cycle_signals
from .models import abnormal_score


def build_reference(stream: Stream, segments: list[Segment], y: np.ndarray) -> dict:
    grid=np.linspace(0,1,101); groups={'Open':[],'Close':[]}
    for s,label in zip(segments,y):
        if label!=0: continue
        a=cycle_signals(stream,s)
        groups[a['operation']].append(np.interp(grid,a['t']/a['t'][-1],a['current']))
    out={}
    for op,arrays in groups.items():
        if arrays:
            q=np.quantile(np.array(arrays),[.05,.5,.95],axis=0)
            out[op]={'elapsed_fraction':grid.tolist(),'lower_A':q[0].tolist(),
                     'median_A':q[1].tolist(),'upper_A':q[2].tolist(),'n_normal_training_cycles':len(arrays)}
    return {'method':'Empirical 5th/50th/95th percentiles of normal training cycles, aligned by normalised elapsed time.',
            'limitation':'Descriptive reference only; not a calibrated prediction interval or the classifier decision rule.',
            'by_operation':out}


def load_bundle(path: str | Path) -> dict:
    path=Path(path)
    if not path.is_file():
        raise DataError(f'Model not found at {path}. Use the included models/door_model.joblib or run train.py.')
    # Only load a local, trusted model artifact. The API never accepts uploaded model files.
    bundle=joblib.load(path)
    if bundle.get('format_version') != 1:
        raise DataError('Unsupported model format.')
    if bundle['versions']['sklearn']!=sklearn.__version__:
        raise DataError(f'Model uses scikit-learn {bundle["versions"]["sklearn"]}; installed version is {sklearn.__version__}. Install requirements.txt or retrain.')
    return bundle


def predict_stream(bundle: dict, stream: Stream) -> tuple[dict,list[Segment],np.ndarray]:
    tick=time.perf_counter()
    segmenter=GapSegmenter(**bundle['segmenter'])
    segments=segmenter.predict(stream)
    X,names=feature_matrix(stream,segments)
    if names!=bundle['feature_names']:
        raise DataError('Feature schema does not match model; use the matching code or retrain.')
    model=bundle['classifier']; pred=model.predict(X); scores=abnormal_score(model,X)
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
    if hasattr(classifier,'coef_'):
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
    else:
        explanation_method='Local additive explanation unavailable for this selected model; inspect signals and cycle-level features.'
        intercept=None
    feats={k:float(v) if np.isfinite(v) else None for k,v in zip(names,feature_row)}
    return {'points':points,'display_downsampled':n>1500,'reference':bundle['normal_reference']['by_operation'].get(a['operation']),
            'reference_method':bundle['normal_reference']['method'],'reference_limitation':bundle['normal_reference']['limitation'],
            'features':feats,'explanations':explanations,'explanation_method':explanation_method,'model_intercept':intercept,
            'units':{'current':'A (source mA / 1000)','voltage':'V (source 10 mV units × 0.01)',
                     'bemf':'raw; source units unspecified','position':'raw; source units unspecified'}}
