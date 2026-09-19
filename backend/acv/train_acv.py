#!/usr/bin/env python3
"""
train_acv.py - ACV refrigerant-leak localisation (NebulaX PS3, ACV subsystem)

One file, two commands:

  python train_acv.py train   --datasets 02_Datasets [--model acv_model.joblib] [--report report.json]
  python train_acv.py predict --input FILE_OR_DIR --output DIR_OR_CSV [--model acv_model.joblib] [--details]

Task: every case file holds telemetry of the 8 cars of one train; exactly one car has a
refrigerant leak. Output = all cars ranked from most to least likely faulty.

Method (see write_up.md): a small evidence-fusion (naive-Bayes) ranker. Every car is compared
with the other cars of the SAME train at the SAME time, which cancels weather, passenger load,
set-point changes and depot/service patterns. Three evidence channels are turned into
log-likelihood ratios (LLR) and added; a soft-max over the cars of the file gives
P(car is the faulty one), because exactly one car per file is faulty.

  T  thermal deficit      - how much warmer than its peers the car runs while the train is
                            actively cooling (the direct physical effect of lost capacity)
  I  car-specific         - unit resets / manual control applied to this car alone while the
     intervention           rest of the train stays in normal centralised control
  C  circuit short-       - only when compressor telemetry exists: compressor start rate vs
     cycling                peers (low-pressure cut-out cycling)

Dependencies: numpy, pandas, joblib. python-calamine (optional) makes .xlsx reading ~10x faster;
otherwise pandas/openpyxl is used.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import json
import math
import os
import re
import sys
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd

try:
    import joblib
except ImportError:  # pragma: no cover
    joblib = None

VERSION = "1.0.0"

# ----------------------------------------------------------------------------------------------
# Configuration (all numbers that define the features; stored inside the model bundle)
# ----------------------------------------------------------------------------------------------
CONFIG = {
    "smooth_minutes": 15.0,       # rolling mean that removes the compressor on/off saw-tooth
    "demand_gate_degC": -1.0,     # use only times when the train median (indoor - setpoint) >= gate
    "min_peers": 3,               # need at least this many OTHER cars reporting at that instant
    "min_valid_minutes": 60.0,    # a car with less usable data than this is treated as 'no data'
    "td_epsilon_degC": 0.02,      # stabiliser inside the log ratio
    "iso_brief_min": 1.0,         # intervention level boundaries (minutes of car-specific action)
    "iso_sustained_min": 5.0,
    "circuit_llr_per_log_ratio": 3.0,   # LLR per unit ln(start-rate ratio) (rich telemetry only)
    "circuit_llr_clip": [-2.0, 5.0],
    "jeffreys": 0.5,              # smoothing added to every count of the intervention channel
}

CAR_RE = re.compile(r"^\s*Car\s*(\d+)\s*-\s*(.+?)\s*$", re.I)

ROLE_PATTERNS = [  # first match wins
    ("indoor",   [r"indoor.*temp", r"passenger cabin temp", r"cabin temp", r"saloon temp"]),
    ("setpoint", [r"control temperature \(cooling\)", r"target temperature value", r"cooling set"]),
    ("outdoor",  [r"outdoor.*temp", r"outside temp", r"fresh air temp", r"ambient temp"]),
    ("run_mode", [r"acv running mode", r"running mode"]),
    ("set_mode", [r"setting mode", r"acv control mode"]),
    ("valid",    [r"information valid"]),
]
COMPRESSOR_RE = re.compile(r"^compressor\s*(\d+)\s*running$", re.I)


# ----------------------------------------------------------------------------------------------
# Reading a case file (always from the file's own headers)
# ----------------------------------------------------------------------------------------------
def _read_table(path: Path) -> pd.DataFrame:
    suffix = path.suffix.lower()
    if suffix in (".csv", ".txt"):
        return pd.read_csv(path, dtype=object)
    try:
        from python_calamine import CalamineWorkbook
        wb = CalamineWorkbook.from_path(str(path))
        rows = wb.get_sheet_by_name(wb.sheet_names[0]).to_python()
        header = [str(h).strip() for h in rows[0]]
        return pd.DataFrame(rows[1:], columns=header)
    except ImportError:
        df = pd.read_excel(path, sheet_name=0, dtype=object)
        df.columns = [str(c).strip() for c in df.columns]
        return df


def _parse_times(col: pd.Series) -> pd.Series:
    """Robust timestamp parsing: Excel cells arrive as datetime objects, CSV exports as strings whose
    format may vary from row to row (e.g. a bare date at midnight)."""
    t = pd.to_datetime(col, errors="coerce")
    present = col.notna() & (col.astype(str).str.strip() != "")
    if int((t.isna() & present).sum()) > 0:          # some non-empty cells failed: retry element-wise
        try:
            t2 = pd.to_datetime(col, errors="coerce", format="mixed")
            if t2.notna().sum() > t.notna().sum():
                t = t2
        except (TypeError, ValueError):               # very old pandas parses element-wise by default
            pass
    return t


def read_case(path) -> tuple[list[str], dict[str, pd.DataFrame]]:
    """-> (car ids exactly as written in the headers, {car: DataFrame[parameter] indexed by time})."""
    path = Path(path)
    raw = _read_table(path)
    raw.columns = [str(c).strip() for c in raw.columns]
    tcol = next((c for c in raw.columns if c.lower() in ("time", "timestamp", "datetime")), None)
    if tcol is None:
        raise ValueError(f"{path.name}: no Time column found")

    def _t(x):
        if isinstance(x, _dt.datetime):
            return x
        if isinstance(x, _dt.date):
            return _dt.datetime(x.year, x.month, x.day)
        return x

    time = _parse_times(raw[tcol].map(_t))
    keep = time.notna().values
    raw, time = raw.loc[keep], time[keep]
    per_car: dict[str, dict[str, np.ndarray]] = {}
    for col in raw.columns:
        m = CAR_RE.match(col)
        if m:
            per_car.setdefault(m.group(1), {})[m.group(2)] = raw[col].values
    if not per_car:
        raise ValueError(f"{path.name}: no 'Car NN - parameter' columns found")
    index = pd.DatetimeIndex(time.values, name="time")
    data = {}
    for car, cols in per_car.items():
        df = pd.DataFrame(cols, index=index)
        df = df[~df.index.duplicated(keep="first")].sort_index()
        data[car] = df
    return sorted(data), data


def _as_text(s: pd.Series) -> pd.Series:
    return s.map(lambda v: "None" if v is None or (isinstance(v, float) and math.isnan(v)) else str(v).strip())


def roles(cars, data) -> dict[str, pd.DataFrame]:
    """Map each file's parameter names onto canonical roles -> {role: DataFrame(time x car)}."""
    found: dict[str, dict[str, pd.Series]] = {}
    for car in cars:
        for param in data[car].columns:
            p = param.lower()
            for role, pats in ROLE_PATTERNS:
                if any(re.search(x, p) for x in pats):
                    found.setdefault(role, {}).setdefault(car, data[car][param])
                    break
    index = data[cars[0]].index
    out = {}
    for role, d in found.items():
        df = pd.DataFrame(d).reindex(index=index, columns=cars)
        if role in ("indoor", "setpoint", "outdoor"):
            df = df.apply(pd.to_numeric, errors="coerce")
        else:
            df = df.apply(_as_text)
        out[role] = df
    return out


def _step_minutes(index: pd.DatetimeIndex) -> float:
    d = pd.Series(index).diff().dt.total_seconds().dropna()
    return float(d.median()) / 60.0 if len(d) else 0.5


def _loo_median(df: pd.DataFrame) -> pd.DataFrame:
    return pd.DataFrame({c: df.drop(columns=c).median(axis=1) for c in df.columns})


# ----------------------------------------------------------------------------------------------
# Channel T - thermal deficit against peers
# ----------------------------------------------------------------------------------------------
def thermal_deficit(cars, R, cfg, return_series=False, strict=True):
    """Peer-relative cooling deficit of every car. strict=False drops the cooling-mode filter and the
    demand gate; it is only used as a fall-back when a file has (almost) no samples in a cooling mode."""
    idx = R["indoor"].index
    step = _step_minutes(idx)
    ind, sp = R["indoor"], R["setpoint"]
    ok = (ind > 0) & (sp > 0)                       # 0.0 is what an invalid unit reports
    if "run_mode" in R and strict:
        ok &= R["run_mode"].apply(lambda s: s.str.contains("cooling", case=False))
    if "valid" in R:
        ok &= R["valid"].apply(lambda s: s.str.lower() == "valid")
    ind, sp = ind.where(ok), sp.where(ok)
    err = ind - sp                                  # control error of each car
    raw = ind - _loo_median(ind)                    # warmer than the other cars ...
    cor = err - _loo_median(err)                    # ... and further above its OWN set-point than they are
    dev = np.minimum(raw, cor)                      # both must hold -> set-point offsets cannot fake a deficit
    dev = dev.where(ok.sum(axis=1) >= cfg["min_peers"] + 1, axis=0)
    win = f"{int(round(cfg['smooth_minutes'] * 60))}s"
    minper = max(3, int(math.ceil(5.0 / step)))
    dev_s = dev.rolling(win, min_periods=minper).mean()
    demand = err.median(axis=1).rolling(win, min_periods=minper).mean()
    if strict:
        dev_s = dev_s.where(demand >= cfg["demand_gate_degC"], axis=0)
    outdoor = None
    if "outdoor" in R:
        o = R["outdoor"]
        outdoor = o.where(o > 0).median(axis=1).rolling(win, min_periods=minper).mean()
    rows = {}
    for c in cars:
        x = dev_s[c].dropna()
        minutes = len(x) * step
        if minutes < cfg["min_valid_minutes"]:
            rows[c] = dict(valid_minutes=minutes, TD=np.nan, frac_gt_0p5=np.nan, peak_q95=np.nan, load_slope=np.nan)
            continue
        slope = np.nan
        if outdoor is not None:
            o = outdoor.reindex(x.index)
            m = o.notna().values
            if m.sum() > 200 and float(o[m].std()) > 0.5:
                slope = float(np.polyfit(o[m].values, x[m].values, 1)[0])
        rows[c] = dict(valid_minutes=minutes, TD=float(x.clip(lower=0).mean()),
                       frac_gt_0p5=float((x > 0.5).mean()), peak_q95=float(x.quantile(0.95)), load_slope=slope)
    out = pd.DataFrame(rows).T
    td = out["TD"].astype(float)
    if strict and td.notna().sum() < 3:             # e.g. a file recorded outside the cooling season
        return thermal_deficit(cars, R, cfg, return_series=return_series, strict=False)
    eps = cfg["td_epsilon_degC"]
    if td.notna().sum() >= 3:
        out["T"] = np.log((td + eps) / (np.nanmedian(td) + eps))
    else:
        out["T"] = np.where(td.notna(), 0.0, np.nan)
    return (out, dev_s) if return_series else out


# ----------------------------------------------------------------------------------------------
# Channel I - car-specific intervention (unit reset / manual control on ONE car only)
# ----------------------------------------------------------------------------------------------
def intervention(cars, R, cfg) -> pd.DataFrame:
    if "set_mode" not in R:
        return pd.DataFrame({"iso_manual_min": np.nan, "iso_reset_min": np.nan, "I_minutes": np.nan}, index=cars)
    sm = R["set_mode"].apply(lambda s: s.str.lower())
    rm = R["run_mode"].apply(lambda s: s.str.lower()) if "run_mode" in R else sm
    step = _step_minutes(sm.index)
    live = sm != "none"
    inv = (sm == "invalid") | (rm == "invalid")
    if "valid" in R:
        inv |= R["valid"].apply(lambda s: s.str.lower() == "invalid")
    man = sm.apply(lambda s: s.str.contains("manual")) & ~inv
    cen = sm.apply(lambda s: s.str.contains("centralized|centralised")) & ~inv
    rows = {}
    for c in cars:
        oth = [k for k in cars if k != c]
        n_live = live[oth].sum(axis=1)
        enough = n_live >= cfg["min_peers"]
        others_central = (cen[oth].sum(axis=1) == n_live) & enough      # nobody else is being touched
        others_valid = ((live[oth] & ~inv[oth]).sum(axis=1) == n_live) & enough
        iso_man = float((man[c] & others_central).sum() * step)
        iso_rst = float((inv[c] & others_valid).sum() * step)
        rows[c] = dict(iso_manual_min=iso_man, iso_reset_min=iso_rst, I_minutes=iso_man + iso_rst)
    return pd.DataFrame(rows).T


def intervention_level(minutes: float, cfg) -> str:
    if minutes is None or (isinstance(minutes, float) and math.isnan(minutes)):
        return "unobserved"
    if minutes >= cfg["iso_sustained_min"]:
        return "sustained"
    if minutes >= cfg["iso_brief_min"]:
        return "brief"
    return "none"


# ----------------------------------------------------------------------------------------------
# Channel C - compressor short-cycling (only if the file carries compressor telemetry)
# ----------------------------------------------------------------------------------------------
def circuit_short_cycling(cars, data) -> pd.DataFrame:
    starts: dict[str, dict[str, float]] = {}
    for c in cars:
        for param in data[c].columns:
            m = COMPRESSOR_RE.match(param.strip())
            if not m:
                continue
            x = pd.to_numeric(data[c][param], errors="coerce")
            if x.notna().sum() < 100:
                continue
            on = (x > 0.5).astype(float).where(x.notna())
            starts.setdefault(m.group(1), {})[c] = float((on.diff() == 1).sum())
    rows = {c: dict(start_ratio=np.nan, C=np.nan) for c in cars}
    for circuit, d in starts.items():
        if len(d) < 3:
            continue
        for c, n in d.items():
            peers = [v for k, v in d.items() if k != c]
            ratio = (n + 1.0) / (float(np.median(peers)) + 1.0)
            if math.isnan(rows[c]["start_ratio"]) or ratio > rows[c]["start_ratio"]:
                rows[c] = dict(start_ratio=ratio, C=math.log(ratio))
    return pd.DataFrame(rows).T


# ----------------------------------------------------------------------------------------------
# Features of one file
# ----------------------------------------------------------------------------------------------
def extract_features(path, cfg=CONFIG, return_series=False):
    cars, data = read_case(path)
    R = roles(cars, data)
    if "indoor" not in R or "setpoint" not in R:
        raise ValueError(f"{Path(path).name}: indoor-temperature / cooling set-point columns not recognised")
    th, series = thermal_deficit(cars, R, cfg, return_series=True)
    f = pd.concat([th, intervention(cars, R, cfg), circuit_short_cycling(cars, data)], axis=1)
    f["has_data"] = f["TD"].notna()
    f["I_level"] = [intervention_level(v, cfg) if h else "unobserved" for v, h in zip(f["I_minutes"], f["has_data"])]
    f.index.name = "car"
    return (f, series) if return_series else f


# ----------------------------------------------------------------------------------------------
# Model: fit the log-likelihood ratios, score a file
# ----------------------------------------------------------------------------------------------
LEVELS = ["none", "brief", "sustained"]


def fit_params(feature_tables: dict[str, pd.DataFrame], labels: dict[str, str], cfg=CONFIG) -> dict:
    tF, tH = [], []
    cF = {k: 0 for k in LEVELS}
    cH = {k: 0 for k in LEVELS}
    for fn, f in feature_tables.items():
        truth = labels[fn]
        for car, r in f.iterrows():
            if not r["has_data"]:
                continue
            (tF if car == truth else tH).append(float(r["T"]))
            if r["I_level"] in LEVELS:
                (cF if car == truth else cH)[r["I_level"]] += 1
    tF, tH = np.array(tF), np.array(tH)
    muF, muH = float(tF.mean()), float(tH.mean())
    pooled = float((((tF - muF) ** 2).sum() + ((tH - muH) ** 2).sum()) / max(len(tF) + len(tH) - 2, 1))
    j = cfg["jeffreys"]
    nF, nH = sum(cF.values()), sum(cH.values())
    llr_I = {k: math.log(((cF[k] + j) / (nF + j * len(LEVELS))) / ((cH[k] + j) / (nH + j * len(LEVELS)))) for k in LEVELS}
    return {
        "T": {"mu_faulty": muF, "mu_healthy": muH, "pooled_var": pooled,
              "slope": (muF - muH) / pooled, "midpoint": 0.5 * (muF + muH),
              "n_faulty": int(len(tF)), "n_healthy": int(len(tH))},
        "I": {"llr": llr_I, "counts_faulty": cF, "counts_healthy": cH},
        "C": {"llr_per_log_ratio": cfg["circuit_llr_per_log_ratio"], "clip": cfg["circuit_llr_clip"]},
    }


def score_file(f: pd.DataFrame, params: dict) -> pd.DataFrame:
    out = f.copy()
    pT, pI, pC = params["T"], params["I"], params["C"]
    out["llr_T"] = [pT["slope"] * (t - pT["midpoint"]) if h else np.nan for t, h in zip(out["T"], out["has_data"])]
    out["llr_I"] = [pI["llr"].get(lv, 0.0) if h else np.nan for lv, h in zip(out["I_level"], out["has_data"])]
    lo, hi = pC["clip"]
    out["llr_C"] = [float(np.clip(pC["llr_per_log_ratio"] * c, lo, hi)) if (h and not pd.isna(c)) else (0.0 if h else np.nan)
                    for c, h in zip(out["C"], out["has_data"])]
    out["llr_total"] = out[["llr_T", "llr_I", "llr_C"]].sum(axis=1, min_count=1)
    s = out["llr_total"].astype(float)
    if s.notna().any():
        z = np.exp(s - np.nanmax(s))
        out["probability"] = (z / np.nansum(z)).fillna(0.0)
    else:
        out["probability"] = 1.0 / len(out)
    order = sorted(out.index, key=lambda c: (-(out.at[c, "llr_total"] if out.at[c, "has_data"] else -1e9), c))
    out["rank"] = [order.index(c) + 1 for c in out.index]
    return out


def ranked_cars(scored: pd.DataFrame) -> list[str]:
    return list(scored.sort_values("rank").index)


def rank_decay_score(order: list[str], truth: str) -> float:
    n = len(order)
    return (n - order.index(truth)) / n if truth in order else 0.0


# ----------------------------------------------------------------------------------------------
# train / predict
# ----------------------------------------------------------------------------------------------
def _sha256(path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _find_acv_dir(datasets: Path) -> Path:
    for cand in (datasets / "ACV", datasets):
        if (cand / "Train_Labels.csv").exists():
            return cand
    raise FileNotFoundError(f"Train_Labels.csv not found under {datasets}")


def cmd_train(args) -> int:
    acv = _find_acv_dir(Path(args.datasets))
    lab = pd.read_csv(acv / "Train_Labels.csv", dtype=str)
    labels = {r["filename"].strip(): r["faulty_car"].strip().zfill(2) for _, r in lab.iterrows()}
    tables, manifest = {}, {}
    for fn in sorted(labels):
        p = acv / "Train" / fn
        print(f"[train] features  {fn}", flush=True)
        tables[fn] = extract_features(p, CONFIG)
        manifest[fn] = {"sha256": _sha256(p), "faulty_car": labels[fn]}

    # leave-one-case-out: the held-out file never touches the parameters that score it
    loco = {}
    for held in sorted(labels):
        params = fit_params({k: v for k, v in tables.items() if k != held}, labels, CONFIG)
        sc = score_file(tables[held], params)
        order = ranked_cars(sc)
        loco[held] = {"truth": labels[held], "ranked_cars": "|".join(order), "rank_of_truth": order.index(labels[held]) + 1,
                      "score": rank_decay_score(order, labels[held]), "probability_of_truth": float(sc.at[labels[held], "probability"])}
    # ablations (also leave-one-case-out)
    def _loco_variant(use):
        res = []
        for held in sorted(labels):
            params = fit_params({k: v for k, v in tables.items() if k != held}, labels, CONFIG)
            sc = score_file(tables[held], params)
            tot = sum(sc[f"llr_{ch}"].fillna(0.0) for ch in use)
            tot = tot.where(sc["has_data"], -1e9)
            t = tot[labels[held]]                      # expected rank if ties were broken at random
            rank = (tot > t + 1e-12).sum() + 1 + ((abs(tot - t) <= 1e-12).sum() - 1) / 2.0
            res.append((len(tot) - (rank - 1)) / len(tot))
        return float(np.mean(res))
    ablation = {"+".join(u): _loco_variant(u) for u in (["T"], ["I"], ["T", "I"], ["T", "I", "C"])}

    params = fit_params(tables, labels, CONFIG)
    insample = {fn: ranked_cars(score_file(tables[fn], params)).index(labels[fn]) + 1 for fn in labels}
    bundle = {
        "model": "acv-leak-evidence-fusion", "version": VERSION, "config": CONFIG, "params": params,
        "browser_artifact": {"config": CONFIG, "params": params},      # plain numbers: enough to re-implement scoring
        "validation": {"leave_one_case_out": loco, "loco_mean_score": float(np.mean([v["score"] for v in loco.values()])),
                       "loco_top1": int(sum(v["rank_of_truth"] == 1 for v in loco.values())), "n_cases": len(loco),
                       "ablation_loco_mean_score": ablation, "in_sample_rank_of_truth": insample},
        "feature_tables": {fn: t.reset_index().to_dict(orient="records") for fn, t in tables.items()},
        "manifest": manifest,
        "versions": {"python": sys.version.split()[0], "numpy": np.__version__, "pandas": pd.__version__},
        "trained_at": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
    }
    blob = json.dumps({"config": CONFIG, "params": params}, sort_keys=True).encode()
    bundle["model_id"] = hashlib.sha256(blob).hexdigest()[:16]
    model_path = Path(args.model)
    model_path.parent.mkdir(parents=True, exist_ok=True)
    if joblib is None:
        raise RuntimeError("joblib is required to save the model")
    joblib.dump(bundle, model_path)
    print(f"[train] model {bundle['model_id']} -> {model_path}")
    for fn, v in loco.items():
        print(f"[train] LOCO {fn}: truth {v['truth']} rank {v['rank_of_truth']} score {v['score']:.3f} P={v['probability_of_truth']:.3f}  {v['ranked_cars']}")
    print(f"[train] LOCO mean rank-decay score {bundle['validation']['loco_mean_score']:.4f}  top-1 {bundle['validation']['loco_top1']}/{len(loco)}")
    print(f"[train] ablation (LOCO mean score): {ablation}")
    if args.report:
        rep = {k: bundle[k] for k in ("model", "version", "model_id", "config", "params", "validation", "manifest", "versions", "trained_at")}
        Path(args.report).write_text(json.dumps(rep, indent=2, default=float))
        print(f"[train] report -> {args.report}")
    return 0


def _explain(car: str, r: pd.Series) -> str:
    bits = []
    if not r["has_data"]:
        return "no usable telemetry for this car - ranked last"
    bits.append(f"runs {r['TD']:.2f} degC warmer than its peers on average while cooling ({100 * r['frac_gt_0p5']:.0f}% of the time >0.5 degC)")
    if r["I_level"] in ("brief", "sustained"):
        bits.append(f"{r['I_minutes']:.1f} min of car-specific reset/manual control ({r['I_level']})")
    if not pd.isna(r.get("start_ratio", np.nan)):
        bits.append(f"compressor starts {r['start_ratio']:.1f}x the peer median")
    return "; ".join(bits)


def predict_file(path, bundle, return_series=False):
    f, series = extract_features(path, bundle["config"], return_series=True)
    sc = score_file(f, bundle["params"])
    return (ranked_cars(sc), sc, series) if return_series else (ranked_cars(sc), sc)


def daily_deficit(series: pd.DataFrame) -> pd.DataFrame:
    """Mean positive peer deviation per service day (day boundary 03:00) - shows how the deficit develops."""
    day = (series.index - pd.Timedelta(hours=3)).date
    return series.clip(lower=0).groupby(day).mean()


def cmd_predict(args) -> int:
    if joblib is None:
        raise RuntimeError("joblib is required to load the model")
    bundle = joblib.load(args.model)
    inp = Path(args.input)
    own = ("acv_predictions", "acv_prediction_details", "acv_peer_deviation_")
    files = sorted(p for p in inp.iterdir() if p.suffix.lower() in (".xlsx", ".xlsm", ".xls", ".csv")
                   and not p.name.startswith("~$") and not p.name.startswith(own)) if inp.is_dir() else [inp]
    if not files:
        raise FileNotFoundError(f"no case files in {inp}")
    out = Path(args.output)
    csv_path = out if out.suffix.lower() == ".csv" else out / "acv_predictions.csv"
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    rows, details = [], {}
    series_out = {}
    for p in files:
        try:
            order, sc, series = predict_file(p, bundle, return_series=True)
        except Exception as exc:                       # one unreadable file must not lose the whole batch
            print(f"[predict] SKIPPED {p.name}: {exc}", file=sys.stderr)
            continue
        series_out[p.name] = series
        rows.append({"file_id": p.name, "ranked_cars": "|".join(order)})
        cols = ["rank", "probability", "llr_total", "llr_T", "llr_I", "llr_C", "TD", "T", "frac_gt_0p5", "peak_q95", "load_slope",
                "iso_manual_min", "iso_reset_min", "I_minutes", "I_level", "start_ratio", "valid_minutes", "has_data"]
        d = sc.sort_values("rank")[cols].copy()
        d["explanation"] = [_explain(c, sc.loc[c]) for c in d.index]
        details[p.name] = d
        print(f"[predict] {p.name}: {'|'.join(order)}   (P top = {float(sc['probability'].max()):.2f})")
    if not rows:
        raise RuntimeError("no case file could be processed")
    pd.DataFrame(rows, columns=["file_id", "ranked_cars"]).to_csv(csv_path, index=False, lineterminator="\n")
    print(f"[predict] wrote {csv_path}")
    if args.details:
        dpath = csv_path.with_name("acv_prediction_details.json")
        payload = {"model_id": bundle.get("model_id"), "files": {}}
        for k, v in details.items():
            dd = daily_deficit(series_out[k]).round(4)
            payload["files"][k] = {"cars": json.loads(v.reset_index().to_json(orient="records")),
                                   "daily_deficit_degC": {str(d): {c: (None if pd.isna(x) else float(x)) for c, x in r.items()} for d, r in dd.iterrows()}}
        dpath.write_text(json.dumps(payload, indent=2))
        print(f"[predict] wrote {dpath}")
        for k, ser in series_out.items():                 # 5-minute peer-deviation series, handy for charts
            spath = csv_path.with_name(f"acv_peer_deviation_{Path(k).stem}.csv")
            ser.resample("5min").mean().dropna(how="all").round(3).to_csv(spath)
            print(f"[predict] wrote {spath}")
    if args.zip:
        zpath = csv_path.with_name("predictions.zip")
        with zipfile.ZipFile(zpath, "a" if zpath.exists() else "w", zipfile.ZIP_DEFLATED) as z:
            if csv_path.name in z.namelist():
                print(f"[predict] {zpath.name} already contains {csv_path.name}; delete the zip first to replace it")
            else:
                z.write(csv_path, arcname=csv_path.name)
                print(f"[predict] added to {zpath}")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="ACV refrigerant-leak localisation (rank the cars of a train)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("train", help="fit the evidence model on 02_Datasets/ACV and validate leave-one-case-out")
    t.add_argument("--datasets", required=True, help="path to 02_Datasets (or to its ACV folder)")
    t.add_argument("--model", default="acv_model.joblib")
    t.add_argument("--report", default=None, help="optional JSON report (parameters + validation)")
    t.set_defaults(func=cmd_train)
    p = sub.add_parser("predict", help="rank the cars of one case file or of every case file in a folder")
    p.add_argument("--input", required=True)
    p.add_argument("--output", required=True, help="folder (acv_predictions.csv is created inside) or a .csv path")
    p.add_argument("--model", default="acv_model.joblib")
    p.add_argument("--details", action="store_true", help="also write per-car evidence as JSON")
    p.add_argument("--zip", action="store_true", help="add acv_predictions.csv to predictions.zip next to it")
    p.set_defaults(func=cmd_predict)
    args = ap.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
