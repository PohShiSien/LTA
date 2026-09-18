"""Local implementation of the disclosed greedy same-label IoU-weighted F1.
Not the organisers' undisclosed judge_leaderboard.py executable.
"""
from __future__ import annotations
from .io import parse_timestamp


def iou(a: tuple[int,int], b: tuple[int,int]) -> float:
    inter=max(0,min(a[1],b[1])-max(a[0],b[0]))
    union=(a[1]-a[0])+(b[1]-b[0])-inter
    return inter/union if union>0 else 0.0


def score_segments(truth: list[dict], predicted: list[dict], ignore_labels: bool=False) -> dict:
    ta=[(parse_timestamp(r['start_time']),parse_timestamp(r['end_time'])) for r in truth]
    pa=[(parse_timestamp(r['start_time']),parse_timestamp(r['end_time'])) for r in predicted]
    pairs=[]
    for ti,t in enumerate(truth):
        label=t.get('status',t.get('prediction'))
        for pi,p in enumerate(predicted):
            if ignore_labels or label==p['prediction']:
                overlap=iou(ta[ti],pa[pi])
                if overlap>0: pairs.append((overlap,ti,pi))
    # Stable index tie-breaking; the published spec does not state its own tie-breaking rule.
    pairs.sort(key=lambda z:(-z[0],z[1],z[2]))
    used_t,used_p=set(),set(); matches=[]
    for overlap,ti,pi in pairs:
        if ti not in used_t and pi not in used_p:
            used_t.add(ti); used_p.add(pi); matches.append({'truth_index':ti,'prediction_index':pi,'iou':overlap})
    credit=sum(m['iou'] for m in matches)
    precision=credit/len(predicted) if predicted else 0.
    recall=credit/len(truth) if truth else 0.
    score=2*credit/(len(truth)+len(predicted)) if truth or predicted else 0.
    return {'iou_weighted_f1':score,'soft_precision':precision,'soft_recall':recall,
            'n_truth':len(truth),'n_predicted':len(predicted),'n_matched':len(matches),
            'sum_iou':credit,'missed':len(truth)-len(matches),'unmatched_predictions':len(predicted)-len(matches),
            'matches':matches}
