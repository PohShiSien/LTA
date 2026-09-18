#!/usr/bin/env python3
"""Score predictions with the Door Info Kit's disclosed greedy IoU-weighted F1."""
from __future__ import annotations
import argparse
import csv
import json
from pathlib import Path
from door_pipeline.io import DataError, LABELS, parse_timestamp
from door_pipeline.metrics import score_segments

def load_rows(path: Path, truth: bool) -> list[dict]:
    with path.open(encoding='utf-8-sig', newline='') as f:
        rows = list(csv.DictReader(f))
    for row in rows:
        label = row.get('status') if truth else row.get('prediction')
        if label not in LABELS:
            raise DataError(f'{path.name}: invalid or missing label.')
        if parse_timestamp(row['end_time']) <= parse_timestamp(row['start_time']):
            raise DataError(f'{path.name}: segment has nonpositive duration.')
    return rows

def main() -> None:
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--truth',type=Path,required=True)
    p.add_argument('--predictions',type=Path,required=True)
    p.add_argument('--truth-start-cycle',type=int,default=1,help='1-based; use 89 for the included final validation predictions')
    p.add_argument('--truth-end-cycle',type=int,help='Inclusive; defaults to the end of the answer file')
    p.add_argument('--output',type=Path)
    args=p.parse_args()
    truth=load_rows(args.truth,True)
    end=args.truth_end_cycle or len(truth)
    if not 1<=args.truth_start_cycle<=end<=len(truth):
        raise DataError('Invalid truth cycle range.')
    truth=truth[args.truth_start_cycle-1:end]
    pred=load_rows(args.predictions,False)
    result={'scorer':'Local implementation of the published formula, not the organisers\' executable.',
            'primary':score_segments(truth,pred),'timing_only_diagnostic':score_segments(truth,pred,ignore_labels=True)}
    text=json.dumps(result,indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(text,encoding='utf-8')
    print(text)

if __name__=='__main__':
    try:main()
    except (DataError,FileNotFoundError,KeyError) as exc:raise SystemExit(str(exc)) from exc
