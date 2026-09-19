#!/usr/bin/env python3
"""Run the supplied ACV refrigerant-leak ranker; no training or artifact updates.

python predict.py --input CASE_OR_FOLDER --output FOLDER_OR_CSV [--details] [--zip]
Each case is assumed to contain exactly one faulty car among eight cars.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import math
import re
import sys
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd

import joblib
from python_calamine import CalamineWorkbook

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
        try:
            return pd.read_csv(path, dtype=object)
        except (pd.errors.ParserError, pd.errors.EmptyDataError) as exc:
            raise ValueError("Upload a non-empty ACV recording with consistent CSV columns.") from exc
    try:
        with CalamineWorkbook.from_path(str(path)) as wb:
            if len(wb.sheet_names) != 1:
                raise ValueError("Use a workbook containing one recording worksheet.")
            rows = wb.get_sheet_by_name(wb.sheet_names[0]).to_python()
        if not rows:
            raise ValueError("The workbook is empty.")
        return pd.DataFrame(rows[1:], columns=[str(h).strip() for h in rows[0]])
    except Exception as exc:
        raise ValueError(f"Cannot read this ACV workbook: {exc}") from exc


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


def read_case(path, metadata=None) -> tuple[list[str], dict[str, pd.DataFrame]]:
    """-> (car ids exactly as written in the headers, {car: DataFrame[parameter] indexed by time})."""
    path = Path(path)
    raw = _read_table(path)
    raw = raw.replace(r"^\s*$", np.nan, regex=True).dropna(how="all")
    raw.columns = [str(c).strip() for c in raw.columns]
    if not len(raw):
        raise ValueError("Upload a non-empty ACV recording.")
    if not raw.columns.is_unique or any(not c for c in raw.columns):
        raise ValueError("Source headers must be nonempty and unique.")
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
    dropped = int((~keep).sum())
    duplicates = int(time[keep].duplicated(keep="first").sum())
    if metadata is not None:
        metadata.update(rows=len(raw), dropped_timestamp_rows=dropped,
                        duplicate_timestamp_rows=duplicates, analysed_rows=len(raw)-dropped-duplicates)
    raw, time = raw.loc[keep], time[keep]
    if time.nunique() < 2:
        raise ValueError("At least two distinct valid timestamps are required.")
    per_car: dict[str, dict[str, np.ndarray]] = {}
    for col in raw.columns:
        m = CAR_RE.match(col)
        if m:
            per_car.setdefault(m.group(1), {})[m.group(2)] = raw[col].values
    if not per_car:
        raise ValueError(f"{path.name}: no 'Car NN - parameter' columns found")
    if len(per_car) != 8 or any(not re.fullmatch(r'\d{2}', car) for car in per_car):
        raise ValueError("ACV requires eight distinct two-digit car IDs in the source headers.")
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
def thermal_deficit(cars, R, cfg, return_series=False, strict=True, metadata=None):
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
        if metadata is not None:
            metadata['relaxed_cooling_filter'] = True
        return thermal_deficit(cars, R, cfg, return_series=return_series, strict=False, metadata=metadata)
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
def extract_features(path, cfg, return_series=False, metadata=None):
    cars, data = read_case(path, metadata)
    R = roles(cars, data)
    if "indoor" not in R or "setpoint" not in R:
        raise ValueError(f"{Path(path).name}: indoor-temperature / cooling set-point columns not recognised")
    th, series = thermal_deficit(cars, R, cfg, return_series=True, metadata=metadata)
    f = pd.concat([th, intervention(cars, R, cfg), circuit_short_cycling(cars, data)], axis=1)
    f["has_data"] = f["TD"].notna()
    f["I_level"] = [intervention_level(v, cfg) if h else "unobserved" for v, h in zip(f["I_minutes"], f["has_data"])]
    f.index.name = "car"
    return (f, series) if return_series else f


# ----------------------------------------------------------------------------------------------
# Model: fit the log-likelihood ratios, score a file
# ----------------------------------------------------------------------------------------------
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


def load_bundle(path):
    bundle = joblib.load(path)
    if not isinstance(bundle, dict) or bundle.get('model') != 'acv-leak-evidence-fusion':
        raise ValueError('Unsupported ACV model schema.')
    cfg, params = bundle['config'], bundle['params']
    for key in ('smooth_minutes', 'min_peers', 'min_valid_minutes', 'td_epsilon_degC'):
        if not np.isfinite(cfg[key]) or cfg[key] <= 0:
            raise ValueError(f'Invalid ACV configuration: {key}.')
    for key in ('demand_gate_degC', 'iso_brief_min', 'iso_sustained_min'):
        if not np.isfinite(cfg[key]):
            raise ValueError(f'Invalid ACV configuration: {key}.')
    values = [params['T']['slope'], params['T']['midpoint'], params['C']['llr_per_log_ratio'],
              *params['C']['clip'], *params['I']['llr'].values()]
    if not np.isfinite(values).all() or len(params['C']['clip']) != 2:
        raise ValueError('Invalid ACV scoring parameters.')
    return bundle


def predict_file(path, bundle, return_series=False, metadata=None):
    f, series = extract_features(path, bundle["config"], return_series=True, metadata=metadata)
    if not f['has_data'].any():
        raise ValueError(f"No car has at least {bundle['config']['min_valid_minutes']:g} usable thermal minutes; a reliable ranking cannot be produced.")
    sc = score_file(f, bundle["params"])
    if not np.isfinite(sc['probability']).all() or not np.isfinite(sc.loc[sc['has_data'], 'llr_total']).all():
        raise ValueError('ACV model returned non-finite scores.')
    return (ranked_cars(sc), sc, series) if return_series else (ranked_cars(sc), sc)


def daily_deficit(series: pd.DataFrame) -> pd.DataFrame:
    """Mean positive peer deviation per service day (day boundary 03:00) - shows how the deficit develops."""
    day = (series.index - pd.Timedelta(hours=3)).date
    return series.clip(lower=0).groupby(day).mean()


def cmd_predict(args) -> int:
    bundle = load_bundle(args.model)
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
    parser = argparse.ArgumentParser(description="Rank eight ACV cars using the supplied model")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True, help="folder or .csv path")
    parser.add_argument("--model", default=str(Path(__file__).with_name("acv_model.joblib")))
    parser.add_argument("--details", action="store_true")
    parser.add_argument("--zip", action="store_true")
    return cmd_predict(parser.parse_args(argv))


if __name__ == "__main__":
    sys.exit(main())
