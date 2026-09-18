# RailWitness

An eight-car reference workspace for **four independent rail datasets**: Door, ACV, Rail Corrugation and Structural Health. Upload a recording, run its model, inspect source fields alongside the 3D reference layout, and download the required predictions.

**Uploaded Door predictions now use the supplied frozen Python/FastAPI model.** ACV, Rail and SHM inference remains in the browser worker. Synthetic demo mode remains a separate authored demonstration. The visual train is schematic and does not establish a shared physical train or synchronized timeline across datasets.

The multisystem design follows [MULTISYSTEM_BRIEF.md](docs/MULTISYSTEM_BRIEF.md); the current Door integration is documented in [DOOR_BACKEND_INTEGRATION.md](docs/DOOR_BACKEND_INTEGRATION.md). The [subsystem visualization guide](docs/SUBSYSTEM_VISUALIZATIONS.md) explains the replay, ranking, rail-side and fatigue views.

## Run locally

Requires **Node.js 22.12+** and **Python 3.11+**; the frozen Door runtime was tested with **Python 3.13.5**. Keep the exact inference dependencies in `backend/door/requirements.txt`, including scikit-learn 1.8.0. The system Python 3.9 on this development machine is too old for those packages.

Start the backend in one terminal:

```sh
cd backend/door
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python -m uvicorn app:app --host 127.0.0.1 --port 8000
```

Use `python3.13` in place of `python3` if needed. On this workspace, the environment is already installed, so activating `backend/door/.venv` is sufficient. Its source interpreter is `.tools/python/cpython-3.13.5-macos-aarch64-none/bin/python3.13`.

Start the frontend in another terminal, from the repository root:

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:5173**. The API is at **http://127.0.0.1:8000**, with interactive endpoint documentation at `/docs`. On this workspace, add `export PATH="$PWD/.tools/node/bin:$PATH"` if Node is not on your PATH. `Start RailWitness.command` starts the frontend; start the Door backend separately.

The default API address needs no configuration. To change it, copy `.env.local.example` to `.env.local`, edit `VITE_DOOR_API_URL`, and restart Vite. `.env.local` is ignored by Git. The backend allows the local frontend origins on ports 5173 and 3000; `RAILWITNESS_CORS_ORIGINS` accepts a comma-separated list if the frontend origin changes. No API key or account is required.

`npm run build` produces frontend static assets in `dist/`. Uploaded Door inference also requires the Python service and its bundled deployment model; serving `dist/` alone is insufficient for that workflow. WebGL enables the interactive train; source inspection, predictions and keyboard reference navigation remain available without it.

## Use the workspace

1. Choose **Doors**, **ACV**, **Rail corrugation**, or **Structural health**.
2. In **Uploaded sources**, upload a matching CSV recording; ACV also accepts the supplied XLSX cases. Multiple files can be selected.
3. Select **Run analysis**, or **Analyse all** for loaded recordings in that subsystem. Unsupported inputs and backend failures produce visible errors, without substitute predictions.
4. For Door, select any classified cycle, including Normal cycles. The evidence panel fetches that recorded cycle, moves the source cursor to its start, and shows the exact label, uncalibrated model score, feature contributions, quality warnings, recorded signals and an advisory recommendation.
5. Use the 3D view or persistent navigator, **Fit train**, **X-ray**, sample cursor, metric selector, searchable fields, raw values, units, provenance and pinned readings. Rail has paired vibration/shock traces and spectra; ACV compares the same field across eight cars.
6. Download the selected result as **CSV**, or collect successful uploaded results in **predictions.zip**.

For a visual walkthrough, use Door's **Play** control to replay each recorded movement in 1.5 seconds, with its classification revealed at completion. ACV scans all eight source cars and settles into relative rank emphasis; select a car to compare recorded cooling evidence. Rail shows all axle-box groups and highlights the predicted reference rail side. SHM ghosts the full structural reference and replays the stress trace alongside the precise file-level damage estimate. **Reduce motion** also follows the operating system preference. The keyboard-accessible schematic retains these meanings when WebGL is unavailable.

The browser worker retains parsing and visualization for all four subsystems. For uploaded Door analysis, the original CSV is additionally sent to the configured local Python backend. Jobs are held in memory for up to one hour, with a maximum of six jobs; expiry, eviction or a server restart requires re-analysis. Upload handling may use temporary local files, but the service does not intentionally persist raw datasets. Other subsystem files stay in the browser. Large ACV workbooks can consume substantial memory; evicted worker records are restored from original File handles held by the current browser session.

**Synthetic demo** has separate sessions, explicit labels and demo CSV filenames. It continues to use the worker and authored fixture results, and never enters the uploaded-data ZIP.

## Dataset scope and outputs

| Layer | Input and mapping | Prediction |
| --- | --- | --- |
| Door | Controller stream with 17 required telemetry fields; no reliable physical car/door identity | Every detected cycle, with native start/end timestamps and `Normal` / `Abnormal resistance` |
| ACV | Actual per-car headers and exact two-digit IDs in stable schematic order | Complete ranking of all eight source car IDs |
| Rail | Eight cars, eight axle boxes each, 128 vibration/shock channels and one speed channel | One recording-level `Normal`, `Side I`, or `Side II` class |
| SHM | One stress segment per file; random names do not identify physical locations | One full-precision cumulative fatigue damage value |

Door cycles are recording-local observations, never physical door numbers. The scene states that it is an illustrative layout with physical asset metadata unavailable. There is no next-cycle verification requirement, health percentage, specific-component diagnosis or probability-of-failure claim. Normal training references show empirical 5th/50th/95th current percentiles, separately for inferred Open/Close, against **Elapsed cycle time (%)**; they are descriptive references, not calibrated prediction intervals or classifier thresholds.

The train exposes 64 axle-box anchors and two reference rails. Odd positions belong to Side I and even positions to Side II regardless of camera rotation. Rail output does not diagnose individual bearings. ACV rank is not a leak probability or leak rate. SHM damage is not percentage health or remaining life and is not clipped to [0,1].

```text
door_predictions.csv: start_time,end_time,prediction
acv_predictions.csv:  file_id,ranked_cars
rail_predictions.csv: file_id,prediction
shm_predictions.csv:  file_id,prediction
```

Uploaded Door downloads use **the backend-generated CSV bytes**, including when inserted into the combined ZIP. React does not regenerate those rows. ACV rankings use `|` between exact IDs. The ZIP is flat and includes only successfully analysed subsystems. Door contributes the currently selected analysed stream because its required format has no file identifier; other subsystem files retain separate `file_id` rows. Remove conflicting same-name sources before exporting.

## Model evidence

| Subsystem | Internal validation | Result |
| --- | --- | --- |
| Door — frozen logistic regression | Reserved final 22 training cycles; fit on the preceding 88 | IoU-weighted F1 **1.000**; 15 Normal and 7 Abnormal matches with exact boundaries |
| Rail | 55 stratified files; selection within development folds | Accuracy **0.9636**; balanced accuracy **0.7778**; macro F1 **0.8264** |
| SHM | 16 randomly held-out files | MAPE **4.15%**; derived score **0.95848** |
| ACV | Six leave-one-case-out folds | Mean rank-decay **0.95833**; top-1 **4/6** |

These are internal development results, **not organiser Test scores or operational validation**. The supplied deployment Door model was previously fitted on all 110 labelled training cycles after model selection; this integration does not retrain it or alter its parameters. Its 97-feature extraction, preprocessing and gap threshold remain frozen. See [TRAINED_MODELS.md](docs/TRAINED_MODELS.md) for model contracts and limitations.

The integrated backend reproduced **38 cycles: 30 Normal and 8 Abnormal resistance**, covering all **6253** rows exactly once, on the supplied Test recording. The local `Test.csv` is byte-identical to the package receipt's `Test(1).csv`. These are expected predictions, not ground-truth labels. CSV bytes match the supplied frozen-pipeline output exactly; the [acceptance receipt](backend/door/reports/integration_acceptance.json) records hashes and checks.

## Checks and command-line inference

From the repository root:

```sh
npm run typecheck
npm run build
npm test
npm run test:e2e
```

Install Chromium once with `npx playwright install chromium`, or use installed Chrome with `PLAYWRIGHT_CHANNEL=chrome npm run test:e2e`. Playwright starts **both** local servers when needed and expects `backend/door/.venv/bin/python`; `RAILWITNESS_DOOR_PYTHON` can select another compatible interpreter. Set `RAILWITNESS_DOOR_TEST_CSV=/path/to/Test.csv` to enable the real Door recording browser acceptance case. The optional large-workbook case uses `RAILWITNESS_HEAVY_XLSX=1 RAILWITNESS_DATA_ROOT=/path/to/02_Datasets`.

Backend tests, from `backend/door`:

```sh
source .venv/bin/activate
python -m pip install -r requirements-dev.txt
python -m pytest -q
DOOR_ACCEPTANCE_CSV=/path/to/Test.csv python -m pytest -q
```

The acceptance environment variable enables the external supplied-recording check; raw organiser data is not stored in this repository. The current backend suite passes 46 tests when it is enabled. The untouched supplied package's original 35 tests were also run separately.

Door CLI inference uses the same fixed deployment artifact as the API:

```sh
backend/door/.venv/bin/python backend/door/predict.py \
  --input /path/to/Door/Test.csv \
  --output /tmp/railwitness-door/door_predictions.csv \
  --zip /tmp/railwitness-door/predictions.zip
```

ACV/Rail/SHM retain `scripts/predict.py` and their separate optional Python environment (`scripts/requirements-training.txt`, tested with Python 3.9.6). For example:

```sh
.tools/ml/bin/python scripts/predict.py \
  --subsystem rail \
  --input /path/to/Rail_Corrugation/Test \
  --output /tmp/railwitness-predictions
RAILWITNESS_DATASETS=/path/to/02_Datasets npm test -- tests/inference.integration.test.ts
```

The generic CLI rejects Door. Its parity checks now cover ACV, Rail and SHM; Door parity and download checks use the frozen backend. Such checks establish implementation consistency, not prediction accuracy on unlabelled Test inputs.

## Runtime and submission files

```text
src/pages/SubsystemWorkspace.tsx           Source sessions and analysis routing
src/lib/railwitnessDoorClient.ts           Typed API requests and backend CSV bytes
src/components/door/                      Recorded Door evidence interface
src/workers/analysis.worker.ts            Parsing, inspection, demos, ACV/Rail/SHM inference
src/lib/inference.ts                      Portable ACV/Rail/SHM models; uploaded Door rejected
src/lib/exportPredictions.ts              Exact prediction CSV and flat ZIP handling
backend/door/app.py                       Local FastAPI service
backend/door/door_pipeline/                Frozen feature/inference runtime
backend/door/models/door_model.joblib      Required deployment model
backend/door/models/model_metadata.json   Supplied model metadata
backend/door/requirements.txt             Pinned backend dependencies
backend/door/predict.py                   Frozen Door command-line inference
```

Keep development in this repository. A later official package can place the runnable frontend **and** `backend/door` runtime/model under `<Team Name>/app/`, with `demo_video.mp4` and `predictions.zip` beside `app/` and optional validation evidence under `Optional_Items/`. Do not copy the entire development repository indiscriminately: exclude `.venv`, `.tools`, `node_modules`, raw organiser datasets, `.env.local`, keys and credentials. The original supplied package is retained in `backend/door/railwitness_door_pipeline/` for reference; its validation model is not a deployment dependency. [DOOR_BACKEND_INTEGRATION.md](docs/DOOR_BACKEND_INTEGRATION.md) details this boundary.

The eight-car model is original geometry; see [asset provenance](public/models/REFERENCE_EIGHT.md). Regenerate it with `npm run model:generate`. [BUILD_STATUS.md](docs/BUILD_STATUS.md) records current verification. The original [project brief](docs/PROJECT_BRIEF.md), [v2 audit](docs/COMPLETION_AUDIT.md), and [synthetic telemetry contract](docs/TELEMETRY_CONTRACT.md) remain historical records.
