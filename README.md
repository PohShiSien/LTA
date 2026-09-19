# JagaRail / RailWitness

RailWitness displays uploaded rail recordings and runs externally trained models. Training happens in teammates' own projects; this repository contains the app, prediction scripts, and saved deployment models.

**Current flow:** upload test CSVs or ACV XLSX files → automatically run the selected subsystem's local Python model → view predictions and supporting evidence → download CSV/ZIP output.

Door, ACV, Rail corrugation, and Structural health inference are integrated. There are no placeholder backend packages, synthetic demo results, or in-app training tools.

## Run locally

Requires Node.js 22.12+ and Python compatible with the frozen Door model. Python 3.13.5 was used for the existing environment.

Install dependencies once, from the repository root:

```sh
npm ci
python3.13 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements.txt
```

If `backend/.venv` already exists, reuse it and run the dependency-install command again after pulling updated model integrations. The requirements include pandas, Rail's XGBoost 3.4.1 runtime, and python-calamine for ACV Excel uploads. On a fresh macOS installation, XGBoost also needs OpenMP (`brew install libomp` if Homebrew is available). This workspace's existing environment has been configured to reuse scikit-learn's bundled OpenMP library.

Start the backend:

```sh
backend/.venv/bin/python -B -m uvicorn app:app \
  --app-dir backend --host 127.0.0.1 --port 8000
```

Start the webpage in a second terminal:

```sh
npm run dev
```

Open **http://127.0.0.1:5173**. Keep both terminals running while analysing recordings. One backend serves all four models. Restart it after changing backend code or replacing a model. The API documentation is at **http://127.0.0.1:8000/docs**.

On this workspace, `export PATH="$PWD/.tools/node/bin:$PATH"` makes the bundled Node available if needed. `Start RailWitness.command` starts the webpage. Set `VITE_API_URL` as shown in `.env.local.example` only if the backend address differs, then restart Vite. The previous `VITE_DOOR_API_URL` setting remains supported. Localhost and 127.0.0.1 origins on any port are supported, including Vite's alternate ports. `RAILWITNESS_CORS_ORIGINS` configures additional frontend origins.

## Use the app

1. On Home, upload files, confirm their subsystem assignments, and select **Analyse selected systems**. Door, Rail, and SHM use CSV; ACV accepts XLSX or CSV case files. The eight-step guided tour explains the real controls and returns to a clean Home on finish or skip.
2. The queued files run through their supplied backend models automatically. Further workspace uploads also run automatically; **Run again** and **Analyse all** remain available for retries. Progress and errors stay scoped to their subsystem; completed progress cards clear after a short delay.
3. Inspect the actual prediction, next-step recommendation, and **Why?** evidence dialog. The train focuses the available finding: an unlocated Door cycle, a predicted Rail side, or the highest-ranked ACV car. Door uses one representative cabin. ACV's interior face shows relative model rank (red for rank 1, green for ranks 2–8), not verified health. SHM retains stress playback and offers an explicitly illustrative X-ray structure.
4. **CSV** downloads the selected recording's output. For ACV, Rail and SHM, **All results CSV** and **predictions.zip** export the whole loaded set once every recording has been analysed. Combined exports require distinct filenames; remove or rename duplicate sources first. Door ZIP exports its selected recording's cycles.

| Model | Input | Output |
| --- | --- | --- |
| Door | Controller CSV | One label per detected cycle: `Normal` or `Abnormal resistance` |
| ACV | Case XLSX or CSV with a Time column and eight car IDs | All eight cars ranked for refrigerant-leak inspection |
| Rail corrugation | One-second CSV: 10,000 rows and 129 channels | One label per file: `Normal`, `Side I`, or `Side II` |
| Structural health | One numeric stress column, with an optional header | One cumulative damage estimate per file, using the supplied calibrated rainflow model |

Rail and SHM downloads use `file_id,prediction`, with the original filename. Their ZIPs contain `rail_predictions.csv` or `shm_predictions.csv` respectively. The model's preprocessing runs in Python; uploaded test data never trains or changes a model.

The displayed Rail label is the script's final weighted classification; SHM shows the full returned numeric prediction. Before displaying an ACV, Rail or SHM result, the app verifies the source filename, row count, and SHA-256 against the uploaded file. Rail side highlights describe the recording's model result, not a diagnosed car or bearing. Raw class scores and SHM's fifth range moment remain available under Model details.

Signal measurements describe the selected channel across all original samples. Rail vibration/shock RMS and peak remove the channel mean, matching that part of the model's preprocessing; SHM shows stress RMS and range. State codes show the selected sample rather than RMS. Numeric coverage is reported with the calculation scope, and optional stress playback uses the actual selected sample rather than an approximated chart point.

SHM colours the reference train using three provisional display bands: green below 0.33, yellow from 0.33 to below 0.67, and red at 0.67 or above. A legend beside the train shows the ranges and current result; it moves below the train on smaller screens. The colour represents the whole recording, not a localised fault. These are display thresholds, not model-validated engineering limits. The model can exceed 1; such values remain red and retain their exact value in the UI and exports. Missing or failed analysis leaves the train neutral. The cutoffs are defined together in `SHM_RISK_BANDS` in `src/components/train/subsystemVisuals.ts`.

ACV preserves the script's complete ranking and the exact two-digit car IDs. Its downloads use `file_id,ranked_cars` with IDs joined by `|`, and ZIP contains `acv_predictions.csv`. The model assumes exactly one leaking car per case; its relative model scores are conditional on that assumption, not calibrated failure probabilities. Thermal deficit and usable thermal minutes help interpret the ranking. Missing evidence stays unavailable, and input cleaning or limited-data warnings remain visible. Selecting a ranked car opens that car's source measurements; the train keeps its original schematic order.

The 3D train is an illustrative reference layout. Door cycles are recording-local observations, not physical door numbers. Rail predictions apply to the recording and rail side, rather than identifying a failed bearing. SHM file numbers do not identify a car or establish chronology, and its damage estimate is not a health percentage. Reduce motion and keyboard navigation remain available.

Door downloads contain `start_time,end_time,prediction`, with all detected cycles and the exact labels `Normal` or `Abnormal resistance`. The CSV and ZIP are downloaded directly from the selected backend job; the ZIP contains that job's `door_predictions.csv`. Backend jobs expire after one hour, eviction, or a server restart; re-run analysis if a job expires. Door retains up to six detailed jobs; ACV, Rail and SHM retain up to 200 lightweight results together, enough for the supplied test sets.

## Files to work on

```text
src/                              React interface, upload parsing, charts, and 3D view
backend/app.py                    Shared upload, model execution, and download API
backend/requirements.txt          Pinned runtime dependencies
backend/door/predict.py           Complete preprocessing and frozen-model inference
backend/door/door_model.joblib    Trained deployment model
backend/door/door_predictions.csv Generated local prediction output
backend/acv/                      predict.py, acv_model.joblib, acv_predictions.csv
backend/rail_corrugation/         Predict.py, rail_model.joblib, rail_predictions.csv
backend/shm/                      predict.py, shm_model.joblib, shm_predictions.csv
tests/                            Development checks and expected-output fixtures
tests/door/                       Door API, preprocessing, model, and CLI checks
tests/test_model_uploads.py       ACV/Rail/SHM API, validation, and export checks
docs/DOOR_BACKEND_INTEGRATION.md   Runtime contract and model file explanation
```

Each model folder contains its prediction script, trained model, and local output CSV. Scripts include preprocessing and can run from Terminal or be called by the API. Local CSVs are output snapshots, never model inputs. Website analyses create fresh results in backend memory and leave those files unchanged. Downloads are saved by the browser. The local Python environment and Door's generated CSV are ignored by Git.

The app sends each original file to `POST /api/door/predict`, `POST /api/acv/predict`, `POST /api/rail/predict`, or `POST /api/shm/predict`. ACV, Rail and SHM combined exports use `POST /api/{subsystem}/export` with the selected job IDs. Uploads are limited to 25 MiB per file. Raw uploads are processed locally and are not intentionally retained; temporary upload storage may be used while processing.

Teammates should deliver the trained artifact, inference/preprocessing code, exact dependency versions, and an expected test output; training scripts and notebooks stay in their external projects.

The current train asset and its source notes live in `public/models/`. The app loads the included GLB directly; no asset-generation script is required.

## Checks

These are development checks. The webpage and backend do not import `tests/`, and running the app does not require installing the Python test dependencies.

```sh
npm run typecheck
npm run build
npm test
npm run test:e2e
backend/.venv/bin/python -m pip install -r tests/door/requirements.txt
PYTHONDONTWRITEBYTECODE=1 backend/.venv/bin/python -m pytest tests/door tests/test_model_uploads.py -q
```

Browser tests can use installed Chrome with `PLAYWRIGHT_CHANNEL=chrome`, or Chromium installed using `npx playwright install chromium`. Playwright starts the frontend and shared backend when needed. `RAILWITNESS_DOOR_PYTHON` selects a different compatible interpreter.

Optional full ACV browser verification uses `RAILWITNESS_DATA_ROOT=/path/to/02_Datasets` and runs when `ACV/Test/acv_test_case.xlsx` is available; it compares the UI and downloads with the supplied `backend/acv/acv_predictions.csv`. Optional real-recording checks use `DOOR_ACCEPTANCE_CSV=/path/to/Test.csv` for Python and `RAILWITNESS_DOOR_TEST_CSV=/path/to/Test.csv` for browser tests. Full organiser recordings and local environments are not committed. See [Door integration notes](docs/DOOR_BACKEND_INTEGRATION.md) for the model contract, evidence semantics, and CLI command.
