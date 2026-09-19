# RailWitness

RailWitness displays uploaded rail recordings and runs externally trained models. Training happens in teammates' own projects; this repository contains the app, the Door inference runtime, and its saved deployment model.

**Current flow:** upload a Door test CSV → local Python model → cycle predictions and evidence in the webpage → CSV/ZIP download.

Door inference is integrated. ACV, Rail corrugation, and Structural health currently support uploaded recording inspection; their trained models will be supplied and integrated by teammates. There are no placeholder backend packages, synthetic demo results, or in-app training tools.

## Run locally

Requires Node.js 22.12+ and Python compatible with the frozen Door model. Python 3.13.5 was used for the existing environment.

Install dependencies once, from the repository root:

```sh
npm ci
python3.13 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements.txt
```

If `backend/.venv` already exists, reuse it.

Start the backend:

```sh
backend/.venv/bin/python -B -m uvicorn app:app \
  --app-dir backend --host 127.0.0.1 --port 8000
```

Start the webpage in a second terminal:

```sh
npm run dev
```

Open **http://127.0.0.1:5173**. Keep both terminals running while analysing Door recordings. The API documentation is at **http://127.0.0.1:8000/docs**.

On this workspace, `export PATH="$PWD/.tools/node/bin:$PATH"` makes the bundled Node available if needed. `Start RailWitness.command` starts the webpage. Set `VITE_DOOR_API_URL` as shown in `.env.local.example` only if the backend address differs, then restart Vite. `RAILWITNESS_CORS_ORIGINS` configures additional frontend origins.

## Use the app

1. Choose a subsystem and upload its test recording. Door, Rail, and SHM use CSV; the ACV inspector also accepts XLSX.
2. For Door, select Run analysis.
3. Select a cycle to inspect recorded signals, its prediction, model contributions, reference curves, and warnings. Replay shows representative Open/Close movement and reveals the existing classification after completion.
4. Download the selected Door analysis as the backend-generated CSV or ZIP.

The 3D train is an illustrative reference layout. Door cycles are recording-local observations, not physical door numbers. ACV, Rail, and SHM tabs inspect uploaded fields and signal traces only; SHM also offers stress playback. Reduce motion and keyboard navigation remain available.

Door downloads contain `start_time,end_time,prediction`, with all detected cycles and the exact labels `Normal` or `Abnormal resistance`. The CSV and ZIP are downloaded directly from the selected backend job; the ZIP contains that job's `door_predictions.csv`. Backend jobs expire after one hour, eviction, or a server restart; re-run analysis if a job expires.

## Files to work on

```text
src/                              React interface, upload parsing, charts, and 3D view
backend/app.py                    Door upload, evidence, and download API
backend/requirements.txt          Pinned runtime dependencies
backend/door/predict.py           Complete preprocessing and frozen-model inference
backend/door/door_model.joblib    Trained deployment model
backend/door/door_predictions.csv Generated local prediction output
tests/                            Development checks and expected-output fixtures
tests/door/                       Door API, preprocessing, model, and CLI checks
docs/DOOR_BACKEND_INTEGRATION.md   Runtime contract and model file explanation
```

`backend/door/` contains just the prediction script, trained model, and generated CSV. The script includes Door preprocessing and can run from Terminal or be called by the API. The local CSV is generated output, never a model input; the UI displays the uploaded recording's API result and downloads that job's output, rather than reading this file. Generated output and the Python environment are ignored by Git.

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
PYTHONDONTWRITEBYTECODE=1 backend/.venv/bin/python -m pytest tests/door -q
```

Browser tests can use installed Chrome with `PLAYWRIGHT_CHANNEL=chrome`, or Chromium installed using `npx playwright install chromium`. Playwright starts the frontend and Door backend when needed. `RAILWITNESS_DOOR_PYTHON` selects a different compatible interpreter.

Optional real-recording checks use `DOOR_ACCEPTANCE_CSV=/path/to/Test.csv` for Python and `RAILWITNESS_DOOR_TEST_CSV=/path/to/Test.csv` for browser tests. Full organiser recordings and local environments are not committed. See [Door integration notes](docs/DOOR_BACKEND_INTEGRATION.md) for the model contract, evidence semantics, and CLI command.
