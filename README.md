# RailWitness

An eight-car reference workspace for **four independent rail datasets**: Door, ACV, Rail Corrugation and Structural Health. Select a subsystem, upload a recording, run its trained model, inspect source fields alongside the 3D reference layout, and download the required predictions.

Version 3 follows [MULTISYSTEM_BRIEF.md](docs/MULTISYSTEM_BRIEF.md), which supersedes the earlier door-only demonstration. The visual train is schematic: it does not establish a shared physical train, operator, operating line, sensor location, or synchronized timeline across datasets.

## Run locally

Requires **Node.js 22.12 or later**, npm, and a current browser with JavaScript and Web Worker support. WebGL enables the interactive train; predictions and keyboard-accessible reference controls remain available without WebGL. Python is **not required to use the dashboard**.

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:5173**. On macOS, **Start RailWitness.command** starts the same server and can use `.tools/node/bin/node` when that local runtime is present.

```sh
npm run typecheck
npm run build
npm run preview
npm test
npm run test:e2e
```

Install the browser-test runtime once with `npx playwright install chromium`, or use installed Chrome with `PLAYWRIGHT_CHANNEL=chrome npm run test:e2e`. The test runner starts the development server when needed. The production app is served as static files from `dist/`; there is no inference backend, API key, or account dependency.

## Use the workspace

1. Choose **Doors**, **ACV**, **Rail corrugation**, or **Structural health**.
2. In **Uploaded sources**, upload the matching CSV recording; ACV also accepts the supplied XLSX cases. Multiple files can be selected.
3. Select **Run analysis**, or **Analyse all** for loaded recordings in that subsystem. Missing or unsupported inputs produce an error instead of substitute predictions.
4. Select a car or axle box using the 3D view or persistent navigator. **Fit train**, **X-ray**, and reduced-motion controls keep the reference layout usable. Door/SHM recordings without verified mapping remain unlocated.
5. Inspect the sample cursor or enter an exact sample number, use the metric selector, searchable source fields, raw units, validity, provenance and pinned readings. Rail offers paired vibration/shock traces and derived spectral evidence. ACV compares the same available field across eight cars.
6. Download the selected result as **CSV**, or collect uploaded results in **predictions.zip**.

Files are parsed and analysed **locally in a browser worker**. Full recorded samples feed inference; plot summaries reduce drawing work without replacing model inputs. Sources and results belong to the current browser session, not a shared server archive. Large XLSX cases can take longer and consume substantial memory. Inactive full-resolution records are evicted from the worker and restored from the session's original File handles when selected again.

**Synthetic demo** is a separate, labelled mode with authored fixture results, separate sessions and demo CSV filenames. These results never substitute for uploaded inference and never enter the uploaded-data ZIP.

## Dataset scope and outputs

| Layer | Recorded input and mapping | Prediction |
| --- | --- | --- |
| Door | Continuous controller stream; current, voltage, back-EMF, timings, commands, switches and position. Physical identity is used only when supplied and verified. | One `Normal` / `Abnormal resistance` label and start/end times per detected cycle |
| ACV | Actual per-car headers, including richer schemas; exact two-digit IDs remain in stable schematic order | One ordered ranking containing all eight car IDs |
| Rail | Eight cars, eight axle boxes each, 128 vibration/shock channels and one speed channel | One recording-level `Normal`, `Side I`, or `Side II` class |
| SHM | One dynamic-stress segment per file; random filenames convey neither chronology nor physical location | One full-precision cumulative fatigue damage value per file |

The eight-car model exposes 64 axle-box anchors and two reference rail meshes. Odd positions belong to Side I and even positions to Side II regardless of camera rotation. Rail highlighting represents the **recording-level** output; it neither diagnoses each bearing nor locates a defect along a physical track.

ACV rank is not a calibrated probability or leak rate. SHM damage is not percentage health, remaining life, or train-wide accumulation, and is not clipped to [0,1]. Door exports classified segments directly; it does not require the former synthetic next-cycle verification or invent a healthy envelope.

```text
door_predictions.csv: start_time,end_time,prediction
acv_predictions.csv:  file_id,ranked_cars
rail_predictions.csv: file_id,prediction
shm_predictions.csv:  file_id,prediction
```

ACV rankings use `|` between exact source IDs. `predictions.zip` contains only generated prediction CSVs at its top level: no recordings, directories, or demo results. For Door, the ZIP includes the **currently selected analysed stream**, because its required format has no file identifier column. Other uploaded subsystem files retain individual `file_id` rows. Changed recordings with the same filename remain distinct in the workspace; duplicate output names must be resolved using **Remove selected recording** before ZIP export.

## Trained models and limitations

The browser ships fitted trees/regression coefficients trained solely on published training inputs and labels. Uploading and predicting requires no configuration or source-code edits. Details appear within each result and in [TRAINED_MODELS.md](docs/TRAINED_MODELS.md).

| Subsystem | Internal validation | Result |
| --- | --- | --- |
| Door | Final 33 chronological cycles held out | IoU-weighted F1 **1.000**; exact boundaries |
| Rail | 55 stratified files held out; model selection inside development folds | Accuracy **0.9636**; balanced accuracy **0.7778**; macro F1 **0.8264** |
| SHM | 16 randomly held-out stress files | MAPE **4.15%**; derived score **0.95848** |
| ACV | Six leave-one-case-out folds | Mean rank-decay **0.95833**; top-1 **4/6** |

These are development results, **not organiser test scores or operational validation**. Door relies on the supplied stream's inter-cycle gaps. Rail validation contains only three Side I and five Side II files. SHM training covers healthy conditions only. ACV has only six labelled cases. No real-time LTA connection, fleet-health score, mechanical certification, or maintenance integration is claimed. See [model-validation.json](docs/model-validation.json) for exact splits and metrics.

## Offline training and CLI

Python is optional for retraining or command-line inference. The tested environment is Python 3.9.6 with pinned dependencies:

```sh
python3 -m venv .tools/ml
.tools/ml/bin/python -m pip install -r scripts/requirements-training.txt
.tools/ml/bin/python scripts/train-models.py --datasets /path/to/02_Datasets

.tools/ml/bin/python scripts/predict.py \
  --subsystem rail \
  --input /path/to/02_Datasets/Rail_Corrugation/Test \
  --output /tmp/railwitness-predictions
```

`--subsystem` accepts `door`, `acv`, `rail`, or `shm`. Input may be one recording or a directory. The CLI uses the same trained artifacts and CSV contracts; it never retrains or reads label files during inference.

Run optional full-recording Python/browser parity checks against a local dataset copy:

```sh
RAILWITNESS_DATASETS=/path/to/02_Datasets npm test -- tests/inference.integration.test.ts
```

The browser suite also has an optional full rich-workbook check: `PLAYWRIGHT_CHANNEL=chrome RAILWITNESS_HEAVY_XLSX=1 RAILWITNESS_DATA_ROOT=/path/to/02_Datasets npm run test:e2e`.

These parity checks compare features and predictions on complete actual files for all four subsystems. Their pass rate establishes implementation consistency, not predictive accuracy on unlabelled test files.

## Project map

```text
src/pages/SubsystemWorkspace.tsx       Independent source sessions and evidence inspector
src/components/train/ReferenceTrainScene.tsx  Eight-car model and camera
src/components/telemetry/RecordingTrace.tsx   Recorded traces and spectrum
src/types/multisystem.ts              Scoped sources, fields, mappings and results
src/workers/analysis.worker.ts        Local parsing, inference and inspection
src/lib/recordings.ts                 CSV/XLSX schemas, units and validity
src/lib/topology.ts                   Rail channel registry and side mapping
src/lib/inference.ts                  Portable trained-model runtime
src/lib/exportPredictions.ts          Exact CSV and flat ZIP contracts
src/data/modelArtifacts.json          Fitted models and validation metadata
src/data/subsystemDemos.ts            Separate authored demonstration fixtures
scripts/train-models.py               Supervised training and validation
scripts/predict.py                    Recorded-data CLI inference
scripts/generate-reference-train.mjs   Original eight-car geometry
```

The model is original project geometry; see [eight-car provenance](public/models/REFERENCE_EIGHT.md). Fonts and asset licences remain local. Regenerate geometry with `npm run model:generate`.

[BUILD_STATUS.md](docs/BUILD_STATUS.md) describes v3. The original [project brief](docs/PROJECT_BRIEF.md), [v2 completion audit](docs/COMPLETION_AUDIT.md), and [synthetic telemetry contract](docs/TELEMETRY_CONTRACT.md) remain historical records, not current data/model claims.
