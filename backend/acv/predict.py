#!/usr/bin/env python3
"""predict.py --input <case file or folder> --output <folder or .csv> [--details] [--zip]

Thin wrapper around `train_acv.py predict` (the interface named in the ACV info kit). It looks for
acv_model.joblib next to this file or in ../model/ unless --model is given."""
import sys
from pathlib import Path

import train_acv

here = Path(__file__).resolve().parent
args = ["predict", *sys.argv[1:]]
if "--model" not in sys.argv:
    model = next((p for p in (here / "acv_model.joblib", here.parent / "model" / "acv_model.joblib") if p.exists()), None)
    if model is not None:
        args += ["--model", str(model)]
sys.exit(train_acv.main(args))
