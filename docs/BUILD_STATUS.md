# RailWitness v3 build status — subsystem visualization layer

The multisystem design follows [MULTISYSTEM_BRIEF.md](MULTISYSTEM_BRIEF.md). The current Door runtime follows the user's frozen-model integration request and [DOOR_BACKEND_INTEGRATION.md](DOOR_BACKEND_INTEGRATION.md). The original three-car prototype's fixed identity, synthetic health percentage and compulsory future-cycle verification are superseded. [COMPLETION_AUDIT.md](COMPLETION_AUDIT.md) and [TELEMETRY_CONTRACT.md](TELEMETRY_CONTRACT.md) remain historical v2 records.

## Current application

- Four independent subsystem/source-mode workspaces retain their own source selection, cursor, component selection and results.
- The original eight-car reference layout, 64 axle-box anchors, two rails, fit/focus controls, shell transparency, reduced-motion behavior and keyboard/WebGL fallback navigation remain available. Rail sides are stable in model coordinates.
- Browser-worker parsing and source inspection remain active for all subsystems, including uploaded Door fields. CSV and ACV XLSX schemas preserve raw values, actual headers, two-digit IDs, missingness, units, timestamps, validity and provenance. Worker records can be restored from original session File handles after eviction.
- **Uploaded Door prediction uses the frozen local FastAPI backend.** The browser worker and generic portable CLI reject uploaded Door prediction through the superseded browser model. ACV, Rail and SHM continue using their existing browser-side fitted artifacts; authored synthetic demos stay in the worker.
- Door retains all predicted cycles, including Normal. Cycle selection retrieves real detail, updates the cursor to its source start, and guards against stale responses. Evidence includes exact label, uncalibrated model score, signed feature contributions, recorded signals, quality warnings, empirical Normal references and advisory guidance.
- Door now has a chronological 1.5-second replay directly below the train, with illustrative sliding doors and synchronized waveform reveal. In-progress replay conceals the completed-cycle classification, score, contributions and recommendation; pause/resume and source-change cancellation preserve that boundary.
- ACV opens on the complete train, scans the eight source cars, then shows ranked emissive emphasis and exact-ID badges. Selecting a car focuses its scene and recorded peer comparison. Existing uncalibrated ranking scores are exposed without changing inference.
- Rail shows all 64 sensor nodes, documented odd/even membership, two labelled reference rails and the recording-level side result. Pooled vibration/shock and spectral evidence are derived from original samples.
- SHM ghosts the complete train without component selection. Sample-order stress replay accompanies the original numeric D, derived rainflow distribution and actual fitted-feature contributions to log(D); it does not allocate damage spatially or over time.
- Recorded traces, paired Rail channels, derived spectra, ACV comparisons, searchable fields and pins retain their established scope. Missing measurements, uncomputed results, invalid input and Normal classifications remain distinct states.
- Uploaded Door CSV downloads use exact backend bytes. The combined ZIP inserts those bytes as root-level `door_predictions.csv`, alongside successful ACV/Rail/SHM CSVs. Demo results are excluded. Door contributes the currently selected analysed stream because its schema has no file identifier.

Door and SHM physical locations are not established by the supplied sources. Door cycle numbers never become physical door IDs; the train remains an illustrative layout with physical metadata unavailable. Rail has one recording-level class, ACV one complete eight-car ranking and SHM one full-precision numeric damage value per stress file. No train-wide health percentage or unsupported component diagnosis is presented.

## Frozen Door runtime

The runtime is directly under `backend/door/`: FastAPI `app.py`, shared `door_pipeline/` code, pinned requirements, CLI, tests and `models/door_model.joblib`. The original supplied package is preserved separately under `backend/door/railwitness_door_pipeline/` for provenance. The production path is fixed; `validation_model.joblib` and environment-variable overrides are not production inference routes.

Deployment SHA-256: `077e4a21838857e4b6bb2e5d2c9b9e1c7741a84d00c52a2d41ecb2489750ea7c`. The integration copies the artifact unchanged and performs no training, hyperparameter changes or Test-based selection. Python 3.13.5 was installed in this workspace and the pinned environment is ready at `backend/door/.venv`.

All four required endpoints are implemented: upload/predict, cycle detail, CSV and ZIP. Jobs last up to one hour in process memory with a six-job limit. Expired/evicted jobs produce re-analysis guidance. Bad inputs, unavailable models and unreachable APIs produce errors; there is no synthetic or Normal fallback.

The 97-feature logistic pipeline, learned preprocessing and 451.9955751995809 ms acquisition-gap threshold are frozen. Normal reference curves are empirical 5th/50th/95th current percentiles, separate for inferred Open/Close and aligned by normalized elapsed cycle time. They are descriptive, not calibrated prediction intervals or classifier thresholds. Scores are uncalibrated model outputs, not failure probabilities.

## Model evidence and boundaries

| Subsystem | Training inputs | Internal validation |
| --- | --- | --- |
| Door — frozen supplied model | 110 labelled cycles in the supplied deployment fit | Selected specification fitted on first 88 cycles, checked on final 22: IoU-weighted F1 1.000, 15 Normal and 7 Abnormal exact matches. Same-source, gap-separated format only. |
| Rail | 272 files: 234 Normal, 14 Side I, 24 Side II | 55-file holdout: accuracy 0.9636, balanced accuracy 0.7778, macro F1 0.8264. Minority support is small. |
| SHM | 64 healthy-condition files | 16-file holdout: MAPE 4.15%, derived score 0.95848. No fault-classification or remaining-life evidence. |
| ACV | Six eight-car cases | Leave-one-case-out rank-decay 0.95833; top-1 4/6. Small heterogeneous sample, no calibrated probabilities. |

These are internal development results, not organiser Test scores or operational validation. Current Door provenance is in the supplied model report and holdout report linked by [TRAINED_MODELS.md](TRAINED_MODELS.md). The old Door entry in [model-validation.json](model-validation.json) describes the superseded browser model; that JSON remains current for the other three subsystems.

## Subsystem visualization verification — 18 September 2026

- `npm run typecheck` and `npm run build` pass. The existing Vite warning about the large 3D renderer chunk remains; no new dependency was added.
- **145 Vitest tests pass**, including all three full-file Python/browser parity cases enabled with `RAILWITNESS_DATASETS`. No tests were skipped in this run.
- **All 22 Playwright browser tests pass together in Chrome**, including the supplied Door Test recording and full rich ACV workbook. New checks cover cycle markers/direction, completed-only reveal, pause/resume, automatic advance, source-change cancellation, exact ACV ranks and peer selection, Rail side groups, fixed numeric SHM output, stress replay and reduced motion.
- SSR checks verify the actual fallback scene for Side I, Side II and Normal, exact ACV identifiers/ranks, descending rank emphasis, unlocated SHM values, scanning and stale-source exclusion. Derived-evidence tests verify recorded ACV validity/coverage, known-frequency Rail spectra, exact rainflow moments and reconstruction of SHM log-damage contributions.
- Desktop (1440px) and mobile (390px) Chrome visual checks cover all four scene treatments with no page errors or document overflow. Mobile ACV badges no longer overlap; clipped duplicate Rail overlays are suppressed while the keyboard controls and full inspector remain available.
- The frozen Door model SHA-256 remains `077e4a21838857e4b6bb2e5d2c9b9e1c7741a84d00c52a2d41ecb2489750ea7c`. The supplied Test still yields 38 cycles, 30 Normal and 8 Abnormal resistance with all 6253 rows covered; exports retain exact backend bytes.
- Presentation hardware/GPU performance and browsers other than Chrome still need a demo rehearsal. See [SUBSYSTEM_VISUALIZATIONS.md](SUBSYSTEM_VISUALIZATIONS.md) for assumptions and the file list.

## Frozen Door integration baseline — verified before the visualization update

- **Typecheck and production build passed** on the final integrated application. Vite retains its existing large 3D-renderer chunk warning; it is not a build failure.
- **113 Vitest tests passed**, plus **three full-file ACV/Rail/SHM parity checks** enabled with the external dataset path. The normal unit command skips those three external-data-dependent cases; they were also run successfully in this integration.
- **All 16 browser tests passed together in Chrome**, with actual Door acceptance and the full 483-field ACV workbook enabled. Coverage includes backend upload/conversion, all-cycle rendering, exact CSV bytes inside the combined flat ZIP, expired-job errors, failed re-analysis clearing stale predictions, late cycle replies, upload/analysis locking, all three browser models, demos, source isolation and WebGL fallback.
- The cycle evidence panel was visually verified at 1440px and 390px with exact backend sample values, current/voltage/raw-position views, keyboard sample navigation, an actual short-cycle warning, and no document overflow or browser errors.
- **46 integrated backend pytest tests passed** with the external acceptance recording enabled; the original supplied package's **35 tests passed** independently.
- The integrated running service accepted the full supplied Door `Test.csv`, whose bytes match the original package receipt's `Test(1).csv`. It returned **38 cycles: 30 Normal and 8 Abnormal resistance**, with all **6253 source rows covered exactly once**.
- Every one of the 38 cycle detail endpoints was checked. API CSV bytes matched the supplied frozen-pipeline output byte-for-byte, and the ZIP had exactly one root-level `door_predictions.csv` containing those bytes.
- A separate valid three-row stream produced one cycle; runtime counts are input-dependent. Added safeguards check frozen model identity, source row indices, recorded unit conversions, reference arrays, expired and evicted jobs, model errors, upload bounds and local CORS.
- A dependency-level AnyIO deprecation warning is the only warning from the passing backend suite. No model bytes or original source-package files were changed by integration.

The [acceptance receipt](../backend/door/reports/integration_acceptance.json) records model/source/output hashes and live HTTP checks. The 30/8 counts are predictions, not ground-truth labels, and no organiser Test accuracy is available.

Frontend checks cover client routing and response conversion, cycle detail loading, stale-request protection, backend-byte CSV/ZIP export, failure/expiry behavior and continued worker/demo behavior. Use the commands below for the integrated app; the earlier browser-only v3 counts are not the current backend-integration verification record.

## Running and reproducing

Requirements: Node.js 22.12+, Python 3.11+ (tested 3.13.5), and a modern browser. The system Python 3.9 on this development machine cannot install the pinned backend requirements. See [README.md](../README.md#run-locally) for the existing local interpreter paths.

Backend, in one terminal:

```sh
cd backend/door
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python -m uvicorn app:app --host 127.0.0.1 --port 8000
```

Frontend, from the repository root in another terminal:

```sh
npm ci
npm run dev
```

Open `http://127.0.0.1:5173`. Optional `.env.local` configuration is based on `.env.local.example` and is ignored by Git. `Start RailWitness.command` launches the frontend; the backend is a separate process.

Verification:

```sh
npm run typecheck
npm run build
npm test
npm run test:e2e
```

Playwright starts both servers if needed. Install Chromium with `npx playwright install chromium`, or use `PLAYWRIGHT_CHANNEL=chrome`. Its Python path defaults to `backend/door/.venv/bin/python`; use `RAILWITNESS_DOOR_PYTHON` for another compatible environment. `RAILWITNESS_DOOR_TEST_CSV=/path/to/Test.csv` enables the supplied-recording browser case. The optional rich ACV case uses `RAILWITNESS_HEAVY_XLSX=1 RAILWITNESS_DATA_ROOT=/path/to/02_Datasets`.

Backend acceptance, from `backend/door` with its environment active:

```sh
python -m pip install -r requirements-dev.txt
DOOR_ACCEPTANCE_CSV=/path/to/Test.csv python -m pytest -q
```

Use `backend/door/predict.py` for frozen Door CLI inference. `scripts/predict.py` remains the ACV/Rail/SHM portable CLI. The optional `RAILWITNESS_DATASETS=/path/to/02_Datasets npm test -- tests/inference.integration.test.ts` suite now compares only those three browser models with their Python implementation. Inference consistency checks on unlabelled inputs do not measure predictive accuracy.

## Packaging and deliberate boundaries

`npm run build` produces the static frontend. Uploaded Door inference additionally requires the Python service and deployment artifact. A later official submission must include those runtime files under `<Team Name>/app/backend/door/`, with the frontend, startup instructions, video and prediction ZIP arranged according to the official package structure. Optional validation artifacts can go under `Optional_Items/Door/model/`.

Exclude `.venv`, `.tools`, `node_modules`, raw organiser datasets, local environment files, keys and credentials. Do not copy the entire retained source package or development repository blindly into the compulsory app. Its validation model is optional evidence, not the production artifact.

No live LTA connection, shared fleet identity, maintenance integration, safety certification or cross-subsystem timeline is claimed. The backend is a local development service without production authentication or deployment monitoring. Results are advisory, and exported artifacts are not signed audit records. Work remains on `integration/frozen-door-model`; no merge to `main` is performed.
