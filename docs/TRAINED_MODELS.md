# Recorded-data models and reproducibility

The uploaded-data workflow uses fitted models in `src/data/modelArtifacts.json`. These were trained from the supplied PS3 **training files and published training labels only**. Browser inference executes the same learned JSON trees or regression coefficients in `src/lib/inference.ts`; it does not require a model server, account, or Python runtime. A missing model, unsupported schema, or missing required numeric signal produces an error, never a synthetic replacement.

The separate synthetic workspace demonstration is an authored fixture. Its results do not establish model performance and must remain excluded from uploaded-data exports.

## Validation results

| Subsystem | Validation design | Result | Main limitation |
| --- | --- | --- | --- |
| Door | Initial 77 chronological cycles for fitting; final 33 held out | IoU-weighted F1 **1.000**; macro F1 **1.000**; all validation boundaries exact | Only one source training stream; segmentation relies on its inter-cycle recording gaps |
| Rail | Stratified 217-file development / 55-file validation split, seed 1809; model choice by four-fold CV inside development only | Accuracy **0.9636**; balanced accuracy **0.7778**; macro F1 **0.8264** | Validation has 47 Normal, 3 Side I and 5 Side II files; random file separation does not establish unseen-route generalization |
| SHM | Random 48-file development / 16-file validation split, seed 1809 | MAPE **0.04152** (4.15%); `max(0, 1−MAPE)` **0.95848**; MAE **0.006550** | Healthy operating conditions only; no structural-fault or remaining-life validation |
| ACV | Six leave-one-case-out folds; each case's eight cars remain together | Mean rank-decay score **0.95833**; top-ranked true car **4/6** cases | Six heterogeneous cases are far too few to claim broad reliability or calibrated probabilities |

These are internal development validation results, not organiser-held-out test scores, operational acceptance evidence, or accuracy on uploaded files. Final shipping models are refitted on all available labelled training inputs after validation. The Rail baseline was initially inspected on the same 55-file validation split; the later forest choice used only development-fold scores. This validation set is therefore documented development evidence, not a pristine external benchmark.

Exact scores, split filenames and Rail development-fold comparisons are recorded in `docs/model-validation.json`. No test labels were available or used. The supplied unlabelled test inputs were subsequently used only to verify parser/CLI/browser interoperability and output shape.

## Model contracts

### Door

Input is a continuous controller stream with the documented 17 fields. Native non-padded timestamps are preserved in output. Extra identity columns do not enter the classifier; the adapter must provide the required controller headers.

The segmentation threshold is five times the median adjacent-sample interval in the initial development prefix, approximately 0.1 seconds. A timestamp gap above this threshold starts a new segment. This automatically recovered all 110 labelled training segments, including the 33 held-out segments, without consulting their boundaries at inference time. It is not a universal door-cycle detector: a continuously sampled stream without inter-cycle gaps needs a different segmenter.

A 120-tree Extra Trees classifier uses duration, sample count, summary statistics for current, voltage, back-EMF, opening/closing timing and flags, position, and current summaries over five normalized position intervals. Its two classes are exactly `Normal` and `Abnormal resistance`. Full-precision native start/end timestamps accompany each classified segment. No healthy envelope or future-cycle corroboration is invented.

When boundaries are exact, predicted and true segment counts match, and the intervals are disjoint, IoU-weighted F1 equals the fraction of correctly labelled segments. The training script checks these boundary conditions before reporting that metric; it does not substitute ordinary accuracy for arbitrary imperfect segmentation.

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

## Reproducing training

The recorded implementation was trained under Python 3.9.6 with the pinned packages in `scripts/requirements-training.txt`:

```bash
python3 -m venv .tools/ml
.tools/ml/bin/python -m pip install -r scripts/requirements-training.txt
.tools/ml/bin/python scripts/train-models.py --datasets /path/to/02_Datasets
```

The script reads only labelled training inputs. `--only door`, `--only rail`, `--only shm`, or `--only acv` refits one subsystem. It writes the portable JSON artifact, validation report, and a compact model-output parity fixture. Feature caches live under `.tools/model-cache`; changing feature code requires deleting the corresponding cache or advancing its version before retraining. The first pass reads several gigabytes of rail recordings; subsequent passes reuse unchanged full-recording feature caches.

## Command-line inference

The CLI uses the same trained JSON artifacts and feature definitions as browser inference; it never trains or reads label files:

```bash
.tools/ml/bin/python scripts/predict.py \
  --subsystem door \
  --input /path/to/02_Datasets/Door/Test.csv \
  --output /tmp/railwitness-predictions

.tools/ml/bin/python scripts/predict.py \
  --subsystem rail \
  --input /path/to/02_Datasets/Rail_Corrugation/Test \
  --output /tmp/railwitness-predictions
```

Other subsystem values are `acv` and `shm`; input can be one supported file or a directory. Directory mode ignores filenames containing “label” or “answer”. Select the intended held-out/input directory explicitly; the CLI does not guess whether other recordings in a chosen directory belong in a submission.

The output file is `<subsystem>_predictions.csv` with the required exact columns: Door `start_time,end_time,prediction`; ACV `file_id,ranked_cars`; Rail/SHM `file_id,prediction`. SHM values retain Python's round-trippable numeric precision. Optional `--diagnostics /path/features.json` writes feature/output details for cross-runtime comparison, outside the scored CSV.

## Verification

`tests/inference.test.ts` verifies Python-to-TypeScript feature parity for all four subsystems, portable fitted-model output parity, absence of damage clipping, exact car IDs, missing-input rejection, and filename-independent SHM predictions.

The optional actual-file integration suite runs the Python CLI and browser inference against the same complete unlabelled source files:

```bash
RAILWITNESS_DATASETS=/path/to/02_Datasets npm test -- tests/inference.integration.test.ts
```

It passed for Door `Test.csv` (38 predicted segments), Rail `Test1.csv` (10,000 × 129 recorded values), SHM `test01.csv` (over 500,000 stress samples), and ACV `acv_test_case.xlsx` (all eight exact car IDs). It compares full feature vectors and predictions across runtimes. Those checks establish implementation consistency, not test-set predictive accuracy.
