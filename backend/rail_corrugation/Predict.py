#!/usr/bin/env python3
"""
predict.py — Rail Corrugation inference.

    python predict.py --input Test --output rail_predictions.csv
    python predict.py --input Test                       # writes rail_predictions.csv next to this script
    python predict.py Test                               # positional form also accepted

Loads rail_model.joblib (default: next to this script, or --model PATH), runs every *.csv in --input through the
same self-contained feature pipeline the model was trained with, and writes a CSV in
the organisers' submission format (04_Example_Submission/rail_predictions.csv):

    file_id,prediction
    Test1.csv,Normal
    Test2.csv,Side I
    ...

`file_id` is the source file name including its extension; `prediction` is exactly one of Normal / Side I / Side II.
Pass --probabilities to also write <output stem>_with_probabilities.csv with per-class probabilities for the app.
"""
import os
import argparse
import csv
from pathlib import Path
from joblib import load

# ---------------------------------------------------------------------------------------------
# rail_pipeline (inlined so this file is self-contained; identical to rail_pipeline.py)
# ---------------------------------------------------------------------------------------------
import io
import re
import glob
import numpy as np
import pandas as pd
from scipy import signal, stats

FS, N_TEETH, WHEEL_DIAM = 10_000, 90, 0.85
SIDE_I_POS = {1, 3, 5, 7}
BANDS = [(0, 50), (50, 110), (110, 250), (250, 500), (500, 1000), (1000, 5000)]
PEAK_WIN = (20, 500)
CLASS_ORDER = ["Normal", "Side I", "Side II"]
MOVING_KMH = 5.0                      # files slower than this are treated as stationary
COL_RE = re.compile(r"(Vibration|Shock) of bearing in position (\d) of car (\d)")

# per-sensor quantities that are baseline-corrected (all strictly positive)
SENSOR_FEATS = ["rms", "peak", "kurt", "crest", "spec_peakiness"] + [f"band_{lo}_{hi}" for lo, hi in BANDS]

# ----------------------------------------------------------------------------- parsing / IO

def parse_columns(columns):
    """Describe every sensor column: name, type (vib/shock), position, car, side."""
    rows = []
    for c in columns:
        m = COL_RE.fullmatch(c)
        if m:
            typ, pos, car = m.group(1), int(m.group(2)), int(m.group(3))
            rows.append(dict(name=c, type="vib" if typ == "Vibration" else "shock",
                             position=pos, car=car, side="I" if pos in SIDE_I_POS else "II"))
    df = pd.DataFrame(rows)
    if len(df) != 128:
        raise ValueError(f"Expected 128 sensor columns, found {len(df)}")
    expected = {(typ, car, position) for typ in ('vib', 'shock') for car in range(1, 9) for position in range(1, 9)}
    if set(zip(df['type'], df['car'], df['position'])) != expected:
        raise ValueError('Rail requires one vibration and one shock column for every bearing position 1–8 in cars 1–8.')
    return df


def load_recording(source):
    """Read the native speed + 128-sensor CSV without changing the trained preprocessing."""
    expected = ['Rotating speed'] + [f'{kind} of bearing in position {position} of car {car}'
        for car in range(1, 9) for position in range(1, 9) for kind in ('Vibration', 'Shock')]
    try:
        raw = source if isinstance(source, bytes) else Path(source).read_bytes()
        first = next(csv.reader([raw.split(b'\n', 1)[0].decode('utf-8-sig')]), [])
        try:
            headerless = bool(first) and all(np.isfinite(float(value)) for value in first)
        except ValueError:
            headerless = False
        df = pd.read_csv(io.BytesIO(raw), header=None if headerless else 0)
    except (pd.errors.ParserError, pd.errors.EmptyDataError, UnicodeError, csv.Error) as exc:
        raise ValueError('Upload a non-empty Rail CSV containing Rotating speed and 128 bearing sensor columns.') from exc
    normal = lambda value: ' '.join(str(value).lower().split())
    if len(df.columns) != 129 or (not headerless and list(map(normal, df.columns)) != list(map(normal, expected))):
        raise ValueError('Rail requires Rotating speed followed by all 128 vibration/shock bearing columns in documented car/position order.')
    if not df.index.equals(pd.RangeIndex(len(df))):
        raise ValueError('Rail sample rows must contain exactly 129 values; check for extra columns.')
    df.columns = expected
    parse_columns(df.columns)
    if len(df) < 1024:
        raise ValueError('Rail requires at least 1024 samples for spectral analysis; upload the complete 10000-row recording.')
    try:
        values = df.to_numpy(dtype=np.float64)
    except (TypeError, ValueError) as exc:
        raise ValueError('Rail samples must all be numeric.') from exc
    if not np.isfinite(values).all():
        raise ValueError('Rail samples must all be finite numbers with no missing values.')
    if not np.isin(values[:, 0], [0, 1]).all():
        raise ValueError('Rotating speed must contain the original 0/1 wheel-sensor samples.')
    return df


def sorted_csvs(folder):
    """CSV files in natural order (Test1, Test2, ..., Test10)."""
    return sorted(glob.glob(os.path.join(folder, "*.csv")),
                  key=lambda p: [int(x) if x.isdigit() else x for x in re.split(r"(\d+)", os.path.basename(p))])


def speed_kmh(speed_col):
    """Train speed from the 0/1 toothed-wheel sensor: count transitions over the file."""
    s = np.asarray(speed_col)
    transitions = np.count_nonzero(np.diff(s) != 0)
    revs_per_s = transitions / (2 * N_TEETH) / (len(s) / FS)
    return revs_per_s * np.pi * WHEEL_DIAM * 3.6

# ----------------------------------------------------------------------------- per-sensor extraction

def per_sensor_table(df, col_meta=None):
    """One row per sensor (128 rows) with time-domain + spectral quantities for a single file."""
    if col_meta is None:
        col_meta = parse_columns(df.columns)
    X = df[col_meta["name"]].values.astype(np.float64)
    X = X - X.mean(axis=0, keepdims=True)                          # remove DC offset
    freqs, psd = signal.welch(X, fs=FS, nperseg=1024, axis=0)      # (513, 128)

    rms = np.sqrt((X ** 2).mean(axis=0))
    peak = np.abs(X).max(axis=0)
    out = col_meta[["type", "side", "car", "position"]].copy()
    out["rms"] = rms
    out["peak"] = peak
    out["kurt"] = stats.kurtosis(X, axis=0, fisher=False)
    out["crest"] = peak / (rms + 1e-12)
    for lo, hi in BANDS:
        m = (freqs >= lo) & (freqs < hi)
        out[f"band_{lo}_{hi}"] = psd[m].sum(axis=0)
    m = (freqs >= PEAK_WIN[0]) & (freqs < PEAK_WIN[1])
    out["spec_peakiness"] = psd[m].max(axis=0) / (psd[m].mean(axis=0) + 1e-12)
    out["dom_freq"] = freqs[m][np.argmax(psd[m], axis=0)]        # EDA only, not baseline-corrected
    return out


def extract_file(path, col_meta=None):
    df = load_recording(path)
    t = per_sensor_table(df, col_meta)
    t.insert(0, "file_id", os.path.basename(path))
    t.insert(1, "speed_kmh", speed_kmh(df.iloc[:, 0].values))
    return t


def extract_folder(folder, n_jobs=-1, verbose=0):
    from joblib import Parallel, delayed
    files = sorted_csvs(folder)
    if not files:
        raise FileNotFoundError(f"No CSV files in {folder}")
    col_meta = parse_columns(pd.read_csv(files[0], nrows=1).columns)
    parts = Parallel(n_jobs=n_jobs, verbose=verbose)(delayed(extract_file)(p, col_meta) for p in files)
    return pd.concat(parts, ignore_index=True)

# ----------------------------------------------------------------------------- feature building

def corrected_per_car(sensor_df, baseline):
    """Baseline-corrected log levels averaged over the 4 sensors of each (file, type, car, side).
    Returns (level, tilt): per-car overall level (mean of both sides) and per-car tilt (Side II - Side I)."""
    key = ["type", "side", "car", "position"]
    if isinstance(baseline, dict):                                        # speed-adjusted
        d = sensor_df.merge(baseline["intercept"].add_suffix("_bl").reset_index(), on=key, how="left")
        ls = np.log(d["speed_kmh"].clip(lower=MOVING_KMH))
        b = d["type"].map(baseline["slope"].to_dict("index")).apply(pd.Series)[SENSOR_FEATS]
        for f in SENSOR_FEATS:
            d[f] = np.log(d[f] + 1e-12) - d[f + "_bl"] - b[f].values * ls.values
    else:                                                                 # speed-agnostic
        d = sensor_df.merge(baseline.add_suffix("_bl").reset_index(), on=key, how="left")
        for f in SENSOR_FEATS:
            d[f] = np.log((d[f] + 1e-12) / (d[f + "_bl"] + 1e-12))
    g = d.groupby(["file_id", "type", "car", "side"])[SENSOR_FEATS].mean().unstack("side")
    lvl_I, lvl_II = g.xs("I", axis=1, level=1), g.xs("II", axis=1, level=1)
    return (lvl_I + lvl_II) / 2, lvl_II - lvl_I


LEVEL_VIB   = {"rms": ["max", "mean"], "band_50_110": ["max", "mean"], "band_110_250": ["max"], "band_250_500": ["max"]}
TILT_VIB    = {"rms": ["max", "min", "mean"], "band_50_110": ["max", "min", "mean"], "band_110_250": ["max", "min"]}
TILT_SHOCK  = {"peak": ["max", "min", "mean"], "band_110_250": ["max", "min"], "band_1000_5000": ["max", "min"], "kurt": ["max", "min"]}
LEVEL_SHOCK = {"peak": ["max"]}


def _signed_extreme(s):
    """Per-car tilt values -> the single most-tilted car, keeping its sign."""
    return s.iloc[np.argmax(np.abs(s.values))]


def build_features(sensor_df, baseline, include_speed=True):
    """Per-sensor table + baseline -> one row of 27 (26 without speed) features per file.

    lvl_*   : overall level, mean of both sides per car, then max/mean over the 8 cars   (fault vs normal)
    tilt_*  : Side II - Side I per car, then max/min/mean over cars                       (which side)
    tilt_*_extreme : the single most-tilted car, sign kept
    """
    level, tilt = corrected_per_car(sensor_df, baseline)
    out = {}

    def add(tbl, typ, spec, prefix):
        t = tbl.xs(typ, level="type")
        grp = t.groupby("file_id")
        for feat, stats_ in spec.items():
            for s in stats_:
                out[f"{prefix}_{feat}_{s}_{typ}"] = getattr(grp[feat], s)()

    add(level, "vib", LEVEL_VIB, "lvl")
    add(level, "shock", LEVEL_SHOCK, "lvl")
    add(tilt, "vib", TILT_VIB, "tilt")
    add(tilt, "shock", TILT_SHOCK, "tilt")
    out["tilt_rms_extreme_vib"] = tilt.xs("vib", level="type").groupby("file_id")["rms"].apply(_signed_extreme)
    out["tilt_peak_extreme_shock"] = tilt.xs("shock", level="type").groupby("file_id")["peak"].apply(_signed_extreme)
    feats = pd.DataFrame(out)
    if include_speed:
        feats = feats.join(sensor_df.groupby("file_id")["speed_kmh"].first())
    return feats.reset_index()

# ----------------------------------------------------------------------------- inference helper

def predict_sensor_table(sensor_df, bundle):
    """Apply a trained bundle to a per-sensor table. Returns DataFrame[file_id, prediction, p_<class>...]."""
    F = build_features(sensor_df, bundle["baseline"], include_speed=bundle.get("include_speed", True)).set_index("file_id")
    X = F.loc[:, bundle["feature_cols"]].values
    if not np.isfinite(X).all():
        raise ValueError('Rail features are not finite; check for constant or invalid bearing signals.')
    proba = bundle["model"].predict_proba(X)
    pred = (proba * bundle.get("class_scale", np.ones(proba.shape[1]))).argmax(1)
    out = pd.DataFrame({"file_id": F.index, "prediction": [bundle["class_order"][i] for i in pred]})
    for i, c in enumerate(bundle["class_order"]):
        out[f"p_{c}"] = proba[:, i].round(4)
    return out.reset_index(drop=True)

HERE = os.path.dirname(os.path.abspath(__file__))
SUBMISSION_COLUMNS = ["file_id", "prediction"]
VALID_LABELS = {"Normal", "Side I", "Side II"}


def predict_folder(input_dir, bundle, n_jobs=-1):
    files = sorted_csvs(input_dir)
    if not files:
        raise SystemExit(f"No .csv files found in {input_dir}")
    sensor = extract_folder(input_dir, n_jobs=n_jobs)
    pred = predict_sensor_table(sensor, bundle)
    # keep the folder's natural file order (Test1, Test2, ..., Test10)
    order = {os.path.basename(f): i for i, f in enumerate(files)}
    return pred.sort_values("file_id", key=lambda s: s.map(order)).reset_index(drop=True)


def validate(pred, files):
    assert list(pred.columns[:2]) == SUBMISSION_COLUMNS, "wrong columns"
    assert set(pred["prediction"]) <= VALID_LABELS, f"unexpected labels: {set(pred['prediction']) - VALID_LABELS}"
    expected = [os.path.basename(f) for f in files]
    missing = set(expected) - set(pred["file_id"])
    assert not missing, f"no prediction for: {sorted(missing)}"
    assert pred["file_id"].is_unique, "duplicate file_id rows"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input_pos", nargs="?", help="folder of .csv files (positional alternative to --input)")
    ap.add_argument("--input", "-i", help="folder of .csv files to predict")
    ap.add_argument("--output", "-o", default=None, help="output CSV path (default: rail_predictions.csv next to this script)")
    ap.add_argument("--model", "-m", default=os.path.join(HERE, "rail_model.joblib"))
    ap.add_argument("--probabilities", action="store_true", help="also write per-class probabilities")
    ap.add_argument("--n-jobs", type=int, default=-1)
    a = ap.parse_args()

    input_dir = a.input or a.input_pos
    if not input_dir or not os.path.isdir(input_dir):
        ap.error("give the folder of CSV files via --input FOLDER (or as a positional argument)")
    output = a.output or os.path.join(HERE, "rail_predictions.csv")
    if os.path.isdir(output):
        output = os.path.join(output, "rail_predictions.csv")

    if not os.path.exists(a.model):
        raise SystemExit(f"model not found: {a.model}  (restore the supplied rail_model.joblib, or pass --model)")
    bundle = load(a.model)
    print(f"model: {bundle.get('model_name')} | {len(bundle['feature_cols'])} features | baseline: {bundle.get('baseline_kind')} "
          f"| Side I weight: {bundle.get('class_scale', [1, 1, 1])[1]} | trained {bundle.get('created', '?')}")

    files = sorted_csvs(input_dir)
    print(f"predicting {len(files)} files from {input_dir} ...")
    pred = predict_folder(input_dir, bundle, n_jobs=a.n_jobs)
    validate(pred, files)

    os.makedirs(os.path.dirname(os.path.abspath(output)), exist_ok=True)
    pred[SUBMISSION_COLUMNS].to_csv(output, index=False)
    print(f"wrote {output}")
    if a.probabilities:
        pth = os.path.splitext(output)[0] + "_with_probabilities.csv"
        pred.to_csv(pth, index=False); print(f"wrote {pth}")
    print(pred["prediction"].value_counts().to_string())


if __name__ == "__main__":
    main()
