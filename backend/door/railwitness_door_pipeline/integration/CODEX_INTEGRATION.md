# Codex integration brief — real Door inference in the existing RailWitness dashboard

## Goal

Connect the existing React/TypeScript/Vite RailWitness dashboard to this working Python Door pipeline. Preserve its current 3D model, layout, branding and navigation. Do not build a new ML model in JavaScript and do not replace the real outputs with mock values.

The backend is already trained. `models/door_model.joblib` is the deployment artifact. `models/validation_model.joblib` is for reproducing internal validation only; do not serve it for final test predictions.

## Repository placement

Place the contents of this package in `backend/door/` inside the existing repository. Keep the directory structure intact. Keep raw organiser datasets outside the code repository or in an ignored local `data/` directory. Never commit `.venv`, API keys, work credentials or raw datasets.

Run the backend from its own directory:

```bash
cd backend/door
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python -m uvicorn app:app --host 127.0.0.1 --port 8000
```

The exact pretrained environment used Python 3.13.5 and the package versions in requirements.txt. The API CORS defaults allow localhost/127.0.0.1 ports 5173 and 3000. Override the comma-separated `RAILWITNESS_CORS_ORIGINS` environment variable for another frontend origin. Keep this prototype local; it has no production authentication.

Copy `railwitnessDoorClient.ts` to the frontend, for example `src/lib/railwitnessDoorClient.ts`:

```ts
import { createDoorClient } from './railwitnessDoorClient';
const doorClient = createDoorClient(import.meta.env.VITE_DOOR_API_URL ?? 'http://127.0.0.1:8000');
```

`VITE_DOOR_API_URL` is a public backend URL, not a secret. No cloud/API keys are required.

## Required user journey

1. Select Door analysis.
2. Upload a raw Door CSV (`Test(1).csv` or `Test.csv`).
3. POST the file to `/api/door/predict` as multipart form field **file**.
4. Show detected-cycle count, Normal count, Abnormal resistance count and source filename.
5. Populate the cycle selector with **every** returned segment, not only abnormalities.
6. Select a cycle and GET `/api/door/jobs/{job_id}/cycles/{cycle_index}`.
7. Render its real signals and explanatory reference.
8. Provide CSV and ZIP downloads from the backend's returned download URLs.

Example calls:

```ts
const analysis = await doorClient.analyse(file);
setAnalysis(analysis);
const first = analysis.segments.find(x => x.prediction === 'Abnormal resistance')
  ?? analysis.segments[0];
const detail = await doorClient.cycle(analysis.job_id, first.cycle_index);
setSelectedCycle(detail);
// Link href values must point to the backend, not the frontend's origin:
const csvHref = doorClient.downloadUrl(analysis.downloads.csv);
const zipHref = doorClient.downloadUrl(analysis.downloads.zip);
```

Use AbortController or a request ID when switching cycles so stale responses cannot replace the latest selection. Disable the upload button while a run is active. Show API validation messages to the user. The job cache expires after an hour, on process restart, or when older jobs are evicted; an expired job requires a new upload.

## Exact data mapping

| Existing concept | Real data mapping / required change |
|---|---|
| Selected door | Selected **recorded cycle**. There is no physical door ID in these files. |
| Door ID `D07` | Do not infer it from `cycle_007`. `asset_id` is null. |
| Actual current | `detail.points[].current_A`; already converted from mA. Do not divide again. |
| Voltage | `detail.points[].voltage_V`; already multiplied by 0.01. |
| Position | `position_raw`; source does not specify millimetres. |
| Expected range | `reference.lower_A/median_A/upper_A`, aligned on `elapsed_fraction`. |
| Chart x-axis | **Normalised elapsed cycle time (%)** for observed-vs-reference comparison. |
| Travel fraction | `travel_fraction` can support a separate position/travel plot. Do not align the elapsed-time reference to travel percent. |
| Anomaly label | Exact `prediction`: `Normal` or `Abnormal resistance`. |
| Confidence | `abnormal_model_score`, labelled **uncalibrated model score**, not failure probability. |
| Evidence card | `recommendation`, actual signal, `explanations`, and quality warnings. |
| Next-cycle witness test | Remove from real-data mode. This model classifies completed cycles; it does not forecast the next movement. |
| 92% health | Remove; no validated composite health percentage exists. |
| Replay | Retrospective replay of recorded movements, not live connectivity. |

The normal reference is the empirical 5th/50th/95th percentile of normal training curves, separately for inferred Open/Close. It is **not** quantile gradient boosting, not a calibrated 90% predictive interval, and not the classifier decision rule. An excursion outside the band does not alone define the class.

## 3D model

Retain it as an explicitly illustrative schematic. These CSVs lack `Car Number` and `Door Number`; the source headers—not the earlier demo assumptions—determine what can be mapped. A selected recording may animate a generic door only if the UI says "illustrative location; physical asset metadata unavailable." Do not count 38 detected cycles as 38 doors. No real train/line identity is established by these files.

## Explanations

`log_odds_contribution` is the signed standardized-feature contribution to the logistic model. Positive moves toward Abnormal resistance; negative moves toward Normal. Render a few strongest contributions and let engineers view the signal. These are model attributions, not proof of a specific mechanical cause. Do not create an LLM diagnosis or claim a failed bearing/roller.

## Downloads

`predictions.csv` endpoint downloads the exact filename `door_predictions.csv`, with:

```csv
start_time,end_time,prediction
```

`predictions.zip` contains that one CSV at its root. Do not modify timestamps, rename label values, drop Normal cycles, add `file_id`, or build a separate fake frontend prediction file. The submitted CSV must be the one generated through the app.

## Acceptance checks

On the supplied `Test(1).csv`, the frozen included model returns **38 cycles: 30 predicted Normal and 8 predicted Abnormal resistance**. These are predictions, not verified test labels. All 6,253 rows belong to exactly one detected segment. Three short cycles carry quality warnings; do not discard them automatically.

Model metadata says 110 training cycles, 97 engineered features, and `logistic_regression`. The result reflects the uploaded file, not a hardcoded count. Uploading a submission example instead of telemetry returns an actionable error. Downloading the CSV from React must give identical bytes to `outputs/door_predictions.csv` for this exact Test input and model.

The included simple HTML app already exercises the API and can serve as a debugging reference; it need not replace the existing 3D dashboard.
