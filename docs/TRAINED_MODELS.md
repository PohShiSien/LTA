# Recorded-data models and reproducibility

Uploaded **Door** inference uses the supplied frozen logistic-regression pipeline in `backend/door/models/door_model.joblib`, executed by the local FastAPI service. **ACV, Rail and SHM** continue using the fitted JSON artifacts in `src/data/modelArtifacts.json` and browser inference in `src/lib/inference.ts`. The browser and generic CLI reject uploaded Door inference through the old portable model; see [DOOR_BACKEND_INTEGRATION.md](DOOR_BACKEND_INTEGRATION.md).

All deployment models originate from supplied training inputs and published training labels. No model was retrained during the frozen Door integration. Missing models, unsupported schemas, unavailable APIs and absent required signals produce errors, never synthetic replacement predictions. The separately labelled synthetic workspace is an authored fixture and remains excluded from uploaded-data ZIPs.

## Validation results

| Subsystem | Validation design | Result | Main limitation |
| --- | --- | --- | --- |
| Door — supplied frozen logistic regression | First 88 cycles for development; final 22 cycles (89–110) reserved; development selection used four expanding folds with one purged cycle | IoU-weighted F1 **1.000**; 22 exact-boundary correct matches, including 15 Normal and 7 Abnormal | One source stream and only seven held-out abnormalities; segmentation relies on acquisition gaps; no physical-door holdout |
| Rail | Stratified 217-file development / 55-file validation split, seed 1809; model choice by four-fold CV inside development only | Accuracy **0.9636**; balanced accuracy **0.7778**; macro F1 **0.8264** | Validation has 47 Normal, 3 Side I and 5 Side II files; random file separation does not establish unseen-route generalization |
| SHM | Random 48-file development / 16-file validation split, seed 1809 | MAPE **0.04152** (4.15%); `max(0, 1−MAPE)` **0.95848**; MAE **0.006550** | Healthy operating conditions only; no structural-fault or remaining-life validation |
| ACV | Six leave-one-case-out folds; each case's eight cars remain together | Mean rank-decay score **0.95833**; top-ranked true car **4/6** cases | Six heterogeneous cases cannot establish broad reliability or calibrated probabilities |

These are internal development results, not organiser Test scores, operational acceptance evidence or accuracy on uploaded files. The supplied Door deployment model was already fitted on all 110 labelled training cycles after its reserved check; the integrated app loads that artifact unchanged. The existing other models were also fitted on their available labelled training inputs after validation. The Rail baseline had been inspected on the same 55-file validation split before the later development-only forest comparison, so that split is documented development evidence rather than an untouched external benchmark.

Current Door model evidence is in the supplied [MODEL_REPORT.md](../backend/door/railwitness_door_pipeline/MODEL_REPORT.md), [final_holdout.json](../backend/door/railwitness_door_pipeline/reports/final_holdout.json) and [model metadata](../backend/door/models/model_metadata.json). [model-validation.json](model-validation.json) remains the record for ACV/Rail/SHM; its older Door entry describes the superseded browser model and is not the current Door claim. Test labels were not available. Unlabelled Test inputs were used only for inference and integration checks, never for training or model selection.

## Model contracts

### Door

The supported input is the supplied gap-separated controller stream with 17 required fields. Native non-padded timestamps are preserved. The final native field denotes integer milliseconds. Extra headers do not enter the classifier or establish a verified physical asset identity; every returned `asset_id` is null.

The frozen split threshold is **451.9955751995809 ms**, learned from the geometric mean of the largest within-cycle training interval (20 ms) and smallest between-cycle gap (10,215 ms). A gap above this threshold starts a new segment. No segment count, Test boundary or label is hardcoded. Every source row belongs to exactly one accepted cycle; isolated one-row segments are rejected. This detector is not validated for arbitrary uninterrupted telemetry or interleaved physical doors.

The supplied pipeline extracts **97 cycle features**: inferred operation, duration and position movement; whole-cycle and moving-region statistics for current, voltage, back-EMF and absolute speed; integrals and travel-normalized summaries; low-speed fraction; and five fixed position bins. Absolute timestamps, cycle IDs, filenames, preceding/following gaps, physical IDs and opening/closing-time controller settings are excluded. Its learned preprocessing uses median imputation, zero-variance filtering (96 active features in deployment) and standard scaling before L2 logistic regression with `C=0.1`.

These features, preprocessing, coefficients, hyperparameters, gap threshold and reference arrays were not changed during integration. The deployment artifact's SHA-256 is `077e4a21838857e4b6bb2e5d2c9b9e1c7741a84d00c52a2d41ecb2489750ea7c`. The API and Door CLI load only `backend/door/models/door_model.joblib`; the supplied validation artifact is never selected. Runtime dependencies are pinned separately in `backend/door/requirements.txt`, tested with Python 3.13.5 and scikit-learn 1.8.0.

Every detected cycle is exported as exactly `Normal` or `Abnormal resistance`, including Normal cycles, with its original start/end timestamp text. The uncalibrated classifier score is not a failure probability. Signed logistic feature contributions explain the decision: positive toward Abnormal resistance, negative toward Normal. They do not identify a faulty mechanical component.

Current is converted by the backend from mA to A once; voltage from source 10 mV units to V once. Position/back-EMF units remain explicitly raw. Limited missing values use the supplied within-cycle interpolation with warnings; over 10% missing in any required signal globally or within a cycle is rejected. No interpolation crosses a detected boundary.

The Normal training reference is an empirical 5th/50th/95th current-percentile summary at 101 **normalized elapsed-time** points, separately for inferred Open/Close. Each group contains 40 Normal training cycles. It is descriptive evidence, not quantile gradient boosting, a calibrated prediction interval or the classifier threshold. The chart's time axis must not be relabelled as physical travel percentage. No future-cycle verification or physical door mapping is inferred.

### Rail corrugation

Input has exactly 129 numeric columns: rotational-speed channel followed by the documented 128 vibration/shock channels. The parser validates channel ordering before associating them with axle-box anchors. Full 10,000-sample recordings are used; display downsampling does not affect inference.

For every measurement channel, the model receives mean, population standard deviation, RMS, absolute peak, mean absolute value, adjacent-difference RMS, adjacent mean absolute difference, and zero-crossing fraction. It also receives mean, maximum and standard deviation of those channel features within each stable Side I/Side II and vibration/shock group, plus speed-channel summary statistics. There are 1,128 features. No filename, car ordinal label, route identifier, or random record number is used as a numeric predictive feature.

The shipped model is a 160-tree `RandomForestClassifier` using `class_weight='balanced_subsample'` and `max_features=0.5`. The label “Balanced Random Forest” in the artifact refers to class weighting, not minority-class undersampling. It was selected over two Extra Trees configurations by four-fold development balanced accuracy. The only outputs are `Normal`, `Side I`, or `Side II`, once per recording. This does not provide 64 independent bearing diagnoses, signed vehicle direction, station coordinates, or a per-sample class.

### Structural health

The supported supplied schema is one stress-value column without a header. A verified single-channel header is also accepted by the parser. Multiple stress channels require a separately verified adapter/model. Units and physical locations remain unknown unless supplied as verified metadata.

Features are whole-signal moments, absolute central moments of orders 3–5, and rainflow turning-point range moments of orders 1–5. Absolute feature magnitudes are transformed with `log1p`; a standardized ridge model learns the natural logarithm of labelled cumulative damage. Inference exponentiates the learned output and preserves its floating-point value. Nothing clips it to [0,1] or turns it into a health percentage.

Rainflow features describe the observed waveform; no assumed material S–N coefficients or guessed sensor locations are introduced. The model learns the relationship to the supplied damage targets. Random file identifiers are excluded, and files are never summed into train-wide lifetime damage.

### ACV

The model discovers the eight exact two-digit car identifiers from each file's `Car NN - parameter` headers. It uses aliases for indoor temperature, cooling/target temperature, outdoor temperature, running mode and information-valid state, covering both basic and rich supplied case schemas. Other recorded fields remain available in the inspector even when they are not predictive features.

Known valid flags (`Valid`, `1`, `true`) admit temperature observations; unknown/invalid flag values do not. When the richer schema supplies no information-valid column, finite temperature observations are used without claiming a verified validity state. Missing numeric inputs are not silently converted into measured zero values. Empty aggregate channels have a zero feature encoding plus observation-coverage features; this is a learned-model input convention, not a raw measurement shown to users. Entirely absent required indoor/target columns are unsupported. A case with no valid indoor observations for any car is rejected.

Per-car features summarize indoor temperature, indoor-minus-target residual, cooling-mode residual, indoor-minus-outdoor residual, and deviation from the contemporaneous peer-car residual. Coverage and mode fractions are included. Both absolute summaries and case-relative summaries are supplied to a 200-tree shallow Extra Trees classifier. Adjacent differences describe consecutive recorded observations, not a time-normalized derivative; inference assumes no universal 30-second cadence. This matters because the rich supplied case has different actual timestamp spacing.

The learned internal positive-class vote is used only to order all eight source IDs. It is not shown as a calibrated probability, measured leak rate, or certainty that lower-ranked cars are healthy. Identical scores use the exact car ID for a deterministic tie break. Geometry order never follows rank.

## Existing non-Door training code

The portable ACV/Rail/SHM implementation was trained under Python 3.9.6 with `scripts/requirements-training.txt`. `scripts/train-models.py` remains historical/reproduction code; no training is needed to run the dashboard, API or CLI. Model caches live in `.tools/model-cache` and are not submission runtime dependencies.

The original supplied Door training/evaluation package is retained for provenance. Its 88-cycle validation artifact and reports explain the internal evaluation; its already-fitted 110-cycle deployment artifact is the one copied into the app runtime. Do not retrain or replace that frozen artifact as part of this integration. Old portable Door data/code is not an alternate production inference route.

## Command-line inference

Door uses the same fixed frozen artifact as the API, without training or label files:

```sh
backend/door/.venv/bin/python backend/door/predict.py \
  --input /path/to/02_Datasets/Door/Test.csv \
  --output /tmp/railwitness-door/door_predictions.csv \
  --zip /tmp/railwitness-door/predictions.zip
```

ACV, Rail and SHM retain the portable JSON CLI and its separately installed environment:

```sh
.tools/ml/bin/python scripts/predict.py \
  --subsystem rail \
  --input /path/to/02_Datasets/Rail_Corrugation/Test \
  --output /tmp/railwitness-predictions
```

Other supported generic-CLI values are `acv` and `shm`; `door` produces an instruction to use the frozen backend CLI. Input may be one supported file or a directory. Directory mode ignores filenames containing “label” or “answer”; select the intended input directory explicitly.

Exact CSV contracts remain Door `start_time,end_time,prediction`, ACV `file_id,ranked_cars`, and Rail/SHM `file_id,prediction`. SHM retains round-trippable numeric precision. The generic CLI's optional `--diagnostics` exports feature details outside the scored CSV. Uploaded Door frontend exports instead fetch backend-generated CSV bytes directly, including for the combined flat ZIP.

## Verification

The frozen backend's original 35 pytest tests passed independently. The integrated suite passed **46 tests** with the optional actual-recording acceptance check enabled. Tests cover original parsing, features, scoring and CLI/API parity, plus fixed artifact identity, contiguous row coverage, exact signal units/reference arrays, expiry/eviction, failures, upload limits and CORS.

A live HTTP run on the supplied `Test.csv` returned **38 cycles: 30 Normal and 8 Abnormal resistance**, covering all **6253** source rows exactly once. The file is byte-identical to the supplied package's `Test(1).csv` receipt. Every detail endpoint was checked; returned CSV bytes match the supplied pipeline output exactly, and the ZIP has only the same `door_predictions.csv` at its root. These are predicted classes, not Test ground truth. See [integration_acceptance.json](../backend/door/reports/integration_acceptance.json).

```sh
cd backend/door
source .venv/bin/activate
DOOR_ACCEPTANCE_CSV=/path/to/Test.csv python -m pytest -q
```

For ACV/Rail/SHM, the optional actual-file suite compares browser and portable Python features/predictions on complete unlabelled files:

```sh
RAILWITNESS_DATASETS=/path/to/02_Datasets npm test -- tests/inference.integration.test.ts
```

Door no longer participates in browser-model parity; its client/adapter/export tests and live Python API/browser integration replace that path. Frontend browser acceptance can include the supplied Door file using `RAILWITNESS_DOOR_TEST_CSV=/path/to/Test.csv npm run test:e2e`. Test pass rates establish implementation consistency, not predictive accuracy or organiser Test performance.
