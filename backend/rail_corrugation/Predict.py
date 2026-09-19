#!/usr/bin/env python3
"""
predict.py — Rail Corrugation inference.

    python predict.py --input Test --output rail_predictions.csv
    python predict.py --input Test                       # writes rail_predictions.csv next to this script
    python predict.py Test                               # positional form also accepted

Loads rail_model.joblib (default: next to this script, or --model PATH), runs every *.csv in --input through the
same feature pipeline the model was trained with (rail_pipeline.py must sit next to this script), and writes a CSV in
the organisers' submission format (04_Example_Submission/rail_predictions.csv):

    file_id,prediction
    Test1.csv,Normal
    Test2.csv,Side I
    ...

`file_id` is the source file name including its extension; `prediction` is exactly one of Normal / Side I / Side II.
Pass --probabilities to also write <output stem>_with_probabilities.csv with per-class probabilities for the app.
"""
import os
import sys
import argparse
import warnings
import pandas as pd
from joblib import load

# ---------------------------------------------------------------------------------------------
# rail_pipeline (inlined so this file is self-contained; identical to rail_pipeline.py)
# ---------------------------------------------------------------------------------------------
import os
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
        m = COL_RE.search(c)
        if m:
            typ, pos, car = m.group(1), int(m.group(2)), int(m.group(3))
            rows.append(dict(name=c, type="vib" if typ == "Vibration" else "shock",
                             position=pos, car=car, side="I" if pos in SIDE_I_POS else "II"))
    df = pd.DataFrame(rows)
    if len(df) != 128:
        raise ValueError(f"Expected 128 sensor columns, found {len(df)}")
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
    df = pd.read_csv(path)
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

# ----------------------------------------------------------------------------- baselines

def fit_baseline(sensor_df, normal_file_ids):
    """Speed-agnostic baseline: per-sensor median of each quantity over moving Normal files."""
    m = sensor_df["file_id"].isin(normal_file_ids) & (sensor_df["speed_kmh"] >= MOVING_KMH)
    return sensor_df[m].groupby(["type", "side", "car", "position"])[SENSOR_FEATS].median()


def fit_baseline_speed(sensor_df, normal_file_ids):
    """Speed-adjusted baseline. On moving Normal files, for each quantity q:
           log q = a[sensor] + b[type, q] * log(speed_kmh)
    b: one pooled slope per (sensor type, quantity) across the 64 sensors of that type.
    a: one intercept per sensor (keeps the per-sensor gain correction).
    Returns {"slope": DataFrame[type x quantity], "intercept": DataFrame[sensor x quantity]}."""
    key = ["type", "side", "car", "position"]
    m = sensor_df["file_id"].isin(normal_file_ids) & (sensor_df["speed_kmh"] >= MOVING_KMH)
    d = sensor_df[m].copy()
    d["ls"] = np.log(d["speed_kmh"])
    L = np.log(d[SENSOR_FEATS] + 1e-12)
    Lc = L - L.groupby([d[k] for k in key]).transform("mean")           # within-sensor demeaning
    lsc = d["ls"] - d.groupby(key)["ls"].transform("mean")
    slope = {}
    for typ, idx in d.groupby("type").groups.items():
        denom = (lsc.loc[idx] ** 2).sum()
        slope[typ] = (Lc.loc[idx].mul(lsc.loc[idx], axis=0).sum() / denom) if denom > 0 \
            else pd.Series(0.0, index=SENSOR_FEATS)
    slope = pd.DataFrame(slope).T
    b = d["type"].map(slope.to_dict("index")).apply(pd.Series)[SENSOR_FEATS]
    resid = L - b.mul(d["ls"], axis=0)
    intercept = resid.groupby([d[k] for k in key]).median()
    return {"slope": slope, "intercept": intercept}

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
    proba = bundle["model"].predict_proba(X)
    pred = (proba * bundle.get("class_scale", np.ones(proba.shape[1]))).argmax(1)
    out = pd.DataFrame({"file_id": F.index, "prediction": [bundle["class_order"][i] for i in pred]})
    for i, c in enumerate(bundle["class_order"]):
        out[f"p_{c}"] = proba[:, i].round(4)
    return out.reset_index(drop=True)

# ---------------------------------------------------------------------------------------------
rp = sys.modules[__name__]        # the code above plays the role of the rail_pipeline module
# ---------------------------------------------------------------------------------------------

warnings.filterwarnings("ignore")
HERE = os.path.dirname(os.path.abspath(__file__))
SUBMISSION_COLUMNS = ["file_id", "prediction"]
VALID_LABELS = {"Normal", "Side I", "Side II"}


def predict_folder(input_dir, bundle, n_jobs=-1):
    files = rp.sorted_csvs(input_dir)
    if not files:
        raise SystemExit(f"No .csv files found in {input_dir}")
    sensor = rp.extract_folder(input_dir, n_jobs=n_jobs)
    pred = rp.predict_sensor_table(sensor, bundle)
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
        raise SystemExit(f"model not found: {a.model}  (run rail_corrugation_train.py first, or pass --model)")
    bundle = load(a.model)
    print(f"model: {bundle.get('model_name')} | {len(bundle['feature_cols'])} features | baseline: {bundle.get('baseline_kind')} "
          f"| Side I weight: {bundle.get('class_scale', [1, 1, 1])[1]} | trained {bundle.get('created', '?')}")

    files = rp.sorted_csvs(input_dir)
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
