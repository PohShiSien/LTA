# RailWitness — complete Door prediction pipeline

A trained, reproducible **segmentation + abnormal-resistance classification** pipeline for the supplied LTA/NebulaX Door dataset. Includes a local upload/results/download app, a FastAPI integration API, model comparison, an implementation of the published scoring formula, tests, and actual predictions for the uploaded Test file.

**This is completed-cycle condition classification, not future-failure forecasting.** It does not control equipment or certify a train safe.

## Quick start: use the already-trained model

Unzip this package. Open a terminal in `railwitness_door_pipeline` (the folder containing this README and `app.py`). Use Python 3.13 to most closely match the tested environment (Python 3.13.5).

```bash
python3 --version
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python -m uvicorn app:app --host 127.0.0.1 --port 8000
```

Open this address in a browser:

```text
http://127.0.0.1:8000
```

Click **Choose CSV** and upload the raw `Test(1).csv` file. The model detects the cycles, classifies all of them, displays real signal evidence, and offers **Download CSV** and **Submission ZIP**. No retraining or cloud API key is required. Initial dependency installation requires network access; inference and the app work locally afterward, with no external fonts, charts, model downloads or CDNs.

To stop the server, press **Control+C** in its terminal. To start it again later, activate `.venv` and rerun the uvicorn command. Commands above do not change your global Git identity or workplace Git configuration.

The supplied inference output is **38 detected cycles: 30 predicted Normal and 8 predicted Abnormal resistance**. The organisers' Test labels are unavailable, so this is not a verified test accuracy result.

## What was actually trained and measured

| Item | Result |
|---|---:|
| Training sensor rows | 18,036 |
| Labelled training cycles | 110 |
| Training classes | 80 Normal; 30 Abnormal resistance |
| Engineered cycle features | 97; 96 nonconstant in the deployment fit |
| Development portion | First 88 cycles |
| Model comparison | 7 candidates; 4 expanding-window development folds |
| Selected model | Regularised logistic regression |
| Pooled development IoU-weighted F1 | 1.0000 across 68 out-of-fold cycles |
| Reserved final internal validation | Last 22 cycles; 15 Normal, 7 Abnormal |
| Reserved validation IoU-weighted F1 | 1.0000 |
| Deployment fit | Same selected model specification refitted on all 110 labelled cycles |
| Official Test score | **Unknown** |

SVM, Random Forest and Extra Trees tied with logistic regression during development. The simpler logistic model won the predefined tie-break. No hyperparameter search was performed on Test, and no model specification was changed after the final internal validation. A perfect 22-cycle internal result is not evidence of perfect performance on new doors, new trains or deployment telemetry.

See **MODEL_REPORT.md** for the full methodology, comparisons, assumptions and limitations.

## How it works

```text
Raw continuous CSV
    → strict header, numeric and timestamp validation
    → cycle boundaries from a training-fitted timestamp-gap rule
    → current/voltage unit conversion and 97 whole-cycle / movement-phase features
    → training-fitted imputation, constant-feature removal and scaling
    → regularised logistic classification of every cycle
    → exact three-column prediction CSV + optional evidence JSON
```

In Train, samples within a cycle are exactly 20 ms apart and inter-cycle gaps exceed 10 seconds. The deployed gap threshold is about 452 ms, learned from Train alone. This clean separation reconstructs the documented cycles without using Test labels. A later label is never required to classify a current completed cycle.

The chart's reference band is an **empirical normal-training summary**, not quantile gradient boosting, a calibrated prediction interval, or the classifier's decision rule. Whole-cycle feature extraction and descriptive references are offline; do not present the app as an early live warning system.

## Files

```text
railwitness_door_pipeline/
├── README.md
├── MODEL_REPORT.md
├── app.py                       # Local HTML app + FastAPI API
├── train.py                     # Audit, development comparison, final check, deployment refit
├── predict.py                   # Reproducible raw-stream → prediction CSV
├── evaluate.py                  # Published greedy same-label IoU-weighted F1
├── requirements.txt
├── requirements-dev.txt
├── door_pipeline/
│   ├── io.py                    # Timestamp/schema validation, labels, CSV output
│   ├── segmentation.py          # Training-fitted cycle-gap detector
│   ├── features.py              # Cycle-level and movement-phase features
│   ├── models.py                # Seven fixed candidates and score extraction
│   ├── runtime.py               # Shared inference + descriptive evidence
│   └── metrics.py               # Local implementation of the scoring formula
├── models/
│   ├── door_model.joblib        # Deployment model trained on all 110 cycles
│   ├── validation_model.joblib  # 88-cycle model, retained for validation reproducibility
│   └── model_metadata.json
├── static/                      # Offline HTML/CSS/JS upload/results/download app
├── integration/
│   ├── CODEX_INTEGRATION.md      # Instructions for the existing React/3D dashboard
│   └── railwitnessDoorClient.ts  # Typed client adapter
├── outputs/
│   ├── door_predictions.csv     # Real Test predictions generated through the running app
│   ├── predictions.zip          # Exactly one door_predictions.csv at ZIP root
│   └── test_analysis.json       # Predictions, uncalibrated scores, data-quality notes
├── reports/                     # Audit, model comparison, splits, predictions, test receipts
└── tests/                       # Synthetic unit and API integration tests
```

Raw Train/Test files, the organiser's example submissions and the demo video are **not** included. Derived reference curves in the model and derived predictions/reports are included.

## Reproduce training and validation

Put your original training files in an ignored local `data/` folder, keeping them out of the submission ZIP. Then run:

```bash
python train.py \
  --train "data/Train(1).csv" \
  --labels "data/Train_Segments_Answer(1).csv"
```

The exact parentheses in the original uploaded filenames are fine; the quotes matter in a shell. Standard filenames `Train.csv` and `Train_Segments_Answer.csv` work too. Restart the API after retraining so it loads the new model.

The script takes **no Test path**. It reserves the final 20% of cycles, compares candidates only on the first 80%, saves the selection, runs the final check, and refits the selected specification on all training cycles. Use `--output-dir alternative_run` to avoid overwriting the bundled model/reports while experimenting.

Do not repeatedly tune to improve the same 22-cycle final check and then keep calling it untouched. After inspecting that result, further experiments need new validation or must be labelled exploratory.

## Command-line inference

The CLI calls the same core inference as the app:

```bash
python predict.py \
  --input "data/Test(1).csv" \
  --output outputs/door_predictions.csv \
  --details outputs/test_analysis.json \
  --zip outputs/predictions.zip
```

`--output` also accepts a directory and then writes `door_predictions.csv` inside it. `--model` defaults to the included deployment model. The CSV preserves native timestamps and contains only:

```csv
start_time,end_time,prediction
```

Both Normal and Abnormal resistance cycles are included. Do not replace these outputs with any `*_predictions(2).csv` example file.

## Recompute the reported final validation score

```bash
python evaluate.py \
  --truth "data/Train_Segments_Answer(1).csv" \
  --truth-start-cycle 89 \
  --truth-end-cycle 110 \
  --predictions reports/validation_predictions.csv
```

This evaluates only the last 22 answer rows against predictions made by the 88-cycle validation model. Evaluating all 110 truth rows against those 22 predictions would measure a different quantity.

The scorer reproduces the published formula, not an unseen copy of the organisers' executable. It uses continuous-time IoU, matching only same-label positive overlaps, greedy descending IoU, and one-to-one assignments.

## Tests

```bash
python -m pip install -r requirements-dev.txt
python -m pytest -q
```

The package's tests use original synthetic fixtures, not embedded copies of the hackathon data. They exercise native-millisecond handling, column mapping, malformed inputs, unit conversion, segmentation, feature invariance to absolute time, missing values, scoring edge cases, model reload, app downloads and CLI/API agreement. See `reports/test_results.txt` for the executed result.

The uploaded real Test stream was also POSTed to the running FastAPI app and its CSV and ZIP downloaded. `reports/app_test_run_receipt.json` records the source, model and output hashes. Browser DOM interaction was checked using Chromium with a live-API bridge because this execution environment blocks direct browser navigation to localhost; native browser download navigation was not verified here. HTTP download bytes and archive contents were verified.

## Existing React dashboard

Use `integration/CODEX_INTEGRATION.md` and `integration/railwitnessDoorClient.ts`. Start the Python backend alongside Vite. Keep the current dashboard, replace its mock data layer, and use the backend's exported CSV/ZIP.

API endpoints:

```text
GET  /api/health
GET  /api/door/model
POST /api/door/predict                         multipart field: file
GET  /api/door/jobs/{job_id}/cycles/{index}     zero-based cycle index
GET  /api/door/jobs/{job_id}/predictions.csv
GET  /api/door/jobs/{job_id}/predictions.zip
GET  /docs                                    generated API documentation
```

No car or physical door IDs are present in the actual 17-column files. Never map `cycle_007` to `D07` or label 38 cycles as 38 doors. A 3D location can only be illustrative until genuine asset metadata is supplied.

## Submission

The supplied top-level specification requires a working app, a screen-recorded demonstration of at most three minutes, and a `predictions.zip` generated through that app. The included ZIP was generated using this app's actual HTTP upload and download routes. For your final workflow/video, upload Test through your own running interface and download it again so the demonstration matches the submitted application.

`predictions.zip` contains only `door_predictions.csv` at its root. Put it in your correctly named team folder alongside the app and your own video. Do not submit the whole development ZIP as if it were `predictions.zip`; it contains code/reports rather than only the scored CSV.

## Security and scope

Keep the service bound to `127.0.0.1`; this local prototype has no authentication and is not a production deployment. It deliberately accepts only raw CSVs, not uploaded model files. Only load trusted `.joblib` artifacts, because Python model deserialization is not safe for untrusted files. The loader checks the scikit-learn version; install the pinned environment or retrain rather than ignoring a version mismatch.

The app caches up to six jobs in local memory, for at most one hour. Upload handling may use temporary local files; there is no intended persistent dataset storage. Do not expose work data or credentials to a public host.

Normal means that this classifier did not identify abnormal resistance in that completed cycle. It does not mean the train is safe. Abnormal resistance is not a diagnosis of a specific component or a prediction of when a failure will occur.
