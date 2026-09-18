#!/usr/bin/env python3
"""Train, select, validate once, and refit. No Test.csv argument exists by design."""
from __future__ import annotations
import argparse
from collections import Counter
from datetime import datetime, timezone
import csv
import hashlib
import json
from pathlib import Path
import platform
import time
import joblib
import numpy as np
import scipy
import sklearn
from sklearn.base import clone
from sklearn.model_selection import TimeSeriesSplit
from sklearn.metrics import confusion_matrix, precision_score, recall_score, f1_score, accuracy_score
from threadpoolctl import threadpool_limits
from door_pipeline.io import load_stream, read_answers, LABELS, DataError, predictions_csv
from door_pipeline.segmentation import GapSegmenter
from door_pipeline.features import feature_matrix
from door_pipeline.metrics import score_segments
from door_pipeline.models import candidates
from door_pipeline.runtime import build_reference

ROOT=Path(__file__).resolve().parent

def dump(path: Path, obj) -> None:
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(obj,indent=2,allow_nan=False),encoding='utf-8')


def prediction_rows(segments,pred):
    return [{'start_time':s.start_time,'end_time':s.end_time,'prediction':LABELS[int(p)]} for s,p in zip(segments,pred)]


def classification_metrics(y,p):
    return {'accuracy':float(accuracy_score(y,p)),
            'abnormal_precision':float(precision_score(y,p,zero_division=0)),
            'abnormal_recall':float(recall_score(y,p,zero_division=0)),
            'abnormal_f1':float(f1_score(y,p,zero_division=0)),
            'confusion_matrix_normal_abnormal':confusion_matrix(y,p,labels=[0,1]).tolist()}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--train',required=True,type=Path)
    parser.add_argument('--labels',required=True,type=Path)
    parser.add_argument('--output-dir',type=Path,default=ROOT)
    parser.add_argument('--holdout-fraction',type=float,default=.2)
    args=parser.parse_args()
    if not .1<=args.holdout_fraction<=.35: parser.error('Use a holdout fraction between .1 and .35.')
    out=args.output_dir; reports=out/'reports'; models=out/'models'
    reports.mkdir(parents=True,exist_ok=True); models.mkdir(parents=True,exist_ok=True)
    stream=load_stream(args.train); segments,y,truth=read_answers(args.labels,stream)
    n=len(segments); cut=int(np.floor(n*(1-args.holdout_fraction)))
    if cut<35 or n-cut<5: raise DataError('Too few complete cycles for the declared four-fold development / final-holdout protocol.')
    # Full-label class totals are audit information only. No test data or example predictions enter this script.
    hashes=[hashlib.sha256(stream.x[s.lo:s.hi].tobytes()).hexdigest() for s in segments]
    if len(set(hashes))!=len(hashes):
        raise DataError('Exact duplicate sensor cycles found: use grouped/purged splitting before reporting validation.')
    Xdev,names=feature_matrix(stream,segments[:cut])
    templates=candidates(); folds=[]; oof={name:[] for name in templates}; scores={name:[] for name in templates}
    for fold,(tr,va) in enumerate(TimeSeriesSplit(n_splits=4,gap=1).split(Xdev),start=1):
        if len(set(y[tr]))<2: raise DataError('A development training fold has one class; revise the split before modelling.')
        segger=GapSegmenter().fit(stream,[segments[i] for i in tr])
        # Validation boundaries are used ONLY to define a contiguous held-out stream and to score.
        # Actual inference calls the segmenter with raw telemetry, not answer-file boundaries.
        sub=stream.subset(segments[va[0]].lo,segments[va[-1]].hi)
        detected=segger.predict(sub); Xv,cols=feature_matrix(sub,detected)
        gt=[truth[i] for i in va]
        timing=score_segments(gt,prediction_rows(detected,np.zeros(len(detected))),ignore_labels=True)
        folds.append({'fold':fold,'training_cycles_1based':[int(tr[0]+1),int(tr[-1]+1)],
                      'validation_cycles_1based':[int(va[0]+1),int(va[-1]+1)],'purged_cycles':1,
                      'segmentation_iou_f1':timing['iou_weighted_f1'],'segmenter':segger.to_dict()})
        for name,template in templates.items():
            tick=time.perf_counter(); model=clone(template).fit(Xdev[tr],y[tr]); pred=model.predict(Xv)
            rows=prediction_rows(detected,pred); metric=score_segments(gt,rows)
            record={'fold':fold,'score':metric['iou_weighted_f1'],'n_truth':len(gt),'n_predicted':len(rows),
                    'sum_iou':metric['sum_iou'],'fit_and_predict_seconds':round(time.perf_counter()-tick,4)}
            # Per-class metrics only where timing is exactly one-to-one (true in this supplied dataset).
            if timing['iou_weighted_f1']==1.0: record.update(classification_metrics(y[va],pred))
            scores[name].append(record)
            for j,row in enumerate(rows):
                oof[name].append({'fold':fold,**row})
        print(f'Completed development fold {fold}/4',flush=True)
    benchmark=[]
    for name,recs in scores.items():
        credit=sum(r['sum_iou'] for r in recs); denom=sum(r['n_truth']+r['n_predicted'] for r in recs)
        benchmark.append({'model':name,'pooled_development_iou_f1':2*credit/denom,
                          'mean_fold_iou_f1':float(np.mean([r['score'] for r in recs])),
                          'std_fold_iou_f1':float(np.std([r['score'] for r in recs])),
                          'folds':recs})
    # Predeclared tie-break: candidate order prefers simpler models (logistic before SVM/ensembles).
    best=max(r['pooled_development_iou_f1'] for r in benchmark)
    winner=next(r['model'] for r in benchmark if abs(r['pooled_development_iou_f1']-best)<1e-12)
    selection={'selected_model':winner,'criterion':'Maximum pooled development IoU-weighted F1; exact ties broken by fixed simplicity order in models.py.',
               'selected_before_final_holdout':True,'benchmark':benchmark,'folds':folds,
               'note':'Cycle-order expanding windows; unequal clock durations. Scores estimate per-cycle performance, not equal-time exposure rates.'}
    dump(reports/'model_selection.json',selection)
    print('Selected before final validation:',winner,flush=True)
    seg_dev=GapSegmenter().fit(stream,segments[:cut])
    model_dev=clone(templates[winner]).fit(Xdev,y[:cut])
    versions={'python':platform.python_version(),'numpy':np.__version__,'scipy':scipy.__version__,'sklearn':sklearn.__version__,'joblib':joblib.__version__}
    # Save the pre-holdout artifact so the 22-cycle result can be reproduced without using a refitted model.
    dev_bundle={'format_version':1,'model_name':winner,'model_id':'development-only',
                'versions':versions,'classifier':model_dev,'segmenter':seg_dev.to_dict(),'feature_names':names,
                'normal_reference':build_reference(stream,segments[:cut],y[:cut]),'training_cycles':cut}
    joblib.dump(dev_bundle,models/'validation_model.joblib',compress=3)
    sub=stream.subset(segments[cut].lo,segments[-1].hi)
    detected=seg_dev.predict(sub); Xh,cols=feature_matrix(sub,detected); pred=model_dev.predict(Xh)
    final_rows=prediction_rows(detected,pred)
    final_score=score_segments(truth[cut:],final_rows)
    timing=score_segments(truth[cut:],final_rows,ignore_labels=True)
    final={'model':winner,'holdout_cycles_1based':[cut+1,n],'training_cycles':cut,
           'holdout_cycles':n-cut,'holdout_labels':dict(Counter(LABELS[int(v)] for v in y[cut:])),
           'primary_score':final_score,'timing_only_score':timing,
           'model_specification_changed_after_holdout':False,'deployment_refit_on_all_labels':True,'test_score':None}
    if timing['iou_weighted_f1']==1.: final['classification']=classification_metrics(y[cut:],pred)
    dump(reports/'final_holdout.json',final)
    (reports/'validation_predictions.csv').write_text(predictions_csv(final_rows),encoding='utf-8')
    # Save split indices for reproducibility, not copies of raw training telemetry.
    dump(reports/'split_manifest.json',{'development_segments_1based':list(range(1,cut+1)),
         'final_holdout_segments_1based':list(range(cut+1,n+1)),'development_folds':folds})
    with (reports/'model_comparison.csv').open('w',newline='') as f:
        w=csv.DictWriter(f,fieldnames=['model','pooled_development_iou_f1','mean_fold_iou_f1','std_fold_iou_f1']);w.writeheader()
        for r in benchmark:w.writerow({k:r[k] for k in w.fieldnames})
    with (reports/'development_oof_predictions.csv').open('w',newline='') as f:
        w=csv.DictWriter(f,fieldnames=['model','fold','start_time','end_time','prediction']);w.writeheader()
        for name,rows in oof.items():
            for row in rows:w.writerow({'model':name,**row})
    # Refit the selected specification on all labelled training cycles for the final test submission.
    # This is allowed AFTER honest validation; the deployment model is not used to report holdout performance.
    Xall,cols=feature_matrix(stream,segments)
    model=clone(templates[winner]).fit(Xall,y); segger=GapSegmenter().fit(stream,segments)
    manifest={'train_filename':args.train.name,'labels_filename':args.labels.name,
              'train_sha256':hashlib.sha256(args.train.read_bytes()).hexdigest(),
              'labels_sha256':hashlib.sha256(args.labels.read_bytes()).hexdigest(),
              'seed':42,'generated_at_utc':datetime.now(timezone.utc).isoformat(),
              'test_used_for_training_or_selection':False,'example_submissions_used_for_training':False,
              'versions':versions}
    model_id=hashlib.sha256((manifest['train_sha256']+winner+json.dumps(names)).encode()).hexdigest()[:16]
    bundle={'format_version':1,'model_id':model_id,'model_name':winner,'classifier':model,'segmenter':segger.to_dict(),
            'feature_names':names,'normal_reference':build_reference(stream,segments,y),'versions':versions,
            'training_cycles':n,'manifest':manifest}
    joblib.dump(bundle,models/'door_model.joblib',compress=3)
    dump(models/'model_metadata.json',{k:v for k,v in bundle.items() if k not in ('classifier','normal_reference')})
    dt=np.diff(stream.t_ms); boundary_idx=np.array([s.lo-1 for s in segments[1:]])
    within=np.delete(dt,boundary_idx); between=dt[boundary_idx]
    audit={'train_rows':len(stream.t_ms),'train_columns':len(stream.x[0])+1,'labelled_cycles':n,
           'class_counts':dict(Counter(LABELS[int(v)] for v in y)),
           'operation_status_counts':dict(Counter(r['operation']+' / '+r['status'] for r in truth)),
           'within_cycle_sample_intervals_ms':np.unique(within).tolist(),
           'between_cycle_gaps_ms_min_max':[int(np.min(between)),int(np.max(between))],
           'exact_duplicate_sensor_cycles':len(hashes)-len(set(hashes)),
           'missing_sensor_values':int(np.isnan(stream.x).sum()),'asset_identifiers_present':False,
           'engineered_features':len(names),'effective_features_after_constant_removal':int(model.named_steps['variance'].get_support().sum()),
           'timestamps_preserved':True,'all_ground_truth_rows_reconciled':True,
           'limits':['Only 110 labelled cycles.','No car/door/run identifiers, so unseen-door/run validation is impossible.',
                     'No exact duplicate cycles found; near-duplicates or common acquisition sessions remain possible.',
                     'Timing-gap rule exploits the documented supplied-stream format and needs redesign for an uninterrupted live feed.',
                     'No test ground truth available.','Classifier outputs are uncalibrated.','No future-failure or next-cycle forecast is trained.']}
    dump(reports/'data_audit.json',audit); dump(reports/'run_manifest.json',manifest)
    if hasattr(model.named_steps['classifier'],'coef_'):
        keep=model.named_steps['variance'].get_support(); active=np.array(names)[keep]; weights=model.named_steps['classifier'].coef_[0]
        order=np.argsort(np.abs(weights))[::-1]
        dump(reports/'feature_coefficients.json',[{'feature':str(active[j]),'standardised_coefficient':float(weights[j])} for j in order])
    print(json.dumps({'model':winner,'development_score':best,'final_holdout_score':final_score['iou_weighted_f1'],
                      'final_holdout_classification':final.get('classification'), 'trained_artifact':str(models/'door_model.joblib')},indent=2),flush=True)

if __name__=='__main__':
    try:
        with threadpool_limits(limits=1):main()
    except (DataError,FileNotFoundError) as e:
        raise SystemExit(str(e))
