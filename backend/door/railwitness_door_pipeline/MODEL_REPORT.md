# RailWitness Door — model and validation report

## 1. What was built

A complete implementation of the supplied Door task: detect every open/close cycle in a continuous input CSV, classify each cycle as **Normal** or **Abnormal resistance**, and export `start_time,end_time,prediction`.

The system is not a forecast of future failure and does not require recurrence in a later cycle. It analyses complete recorded movements. It contains a trained model, reproducible training and inference scripts, a local upload/results/download app, a dashboard API, and automated tests.

Source roles were kept separate:

- `Train(1).csv`: labelled development telemetry, using the separate answer file.
- `Train_Segments_Answer(1).csv`: the only classification/boundary ground truth used.
- `Test(1).csv`: unlabelled inference input, not a training or model-selection input.
- The four `*_predictions(2).csv` files: illustrative submission formats only; not labels and not training data. The Door example was additionally used to verify that the app rejects a submission CSV mistakenly uploaded as raw telemetry.
- `Door_Subsystem_Info_Kit(2).md`: task, timestamp conventions and evaluation formula.
- `Door Data Headers(2).md`: column descriptions and units, checked against actual CSV headers.
- `01_Problem_Statement_3_Specifications(2).md`: app, video and prediction-ZIP deliverables.

All observations below are computed from the supplied data or resulting model runs unless explicitly identified as implementation choices or external documentation.

## 2. Observed data properties

| Property | Observed value |
|---|---:|
| Training sensor rows | 18,036 |
| Actual CSV columns | 17 |
| Labelled cycles | 110 |
| Normal cycles | 80 |
| Abnormal-resistance cycles | 30 |
| Normal Open / Close | 40 / 40 |
| Abnormal Open / Close | 15 / 15 |
| Within-cycle sampling interval | Exactly 20 ms; 50 Hz |
| Between-cycle gaps | 10,215–58,823 ms |
| Training rows per cycle | 137–190 |
| Missing training sensor values | 0 |
| Exact duplicate full sensor cycles, timestamps excluded | 0 |
| Explicit car/door/run identifiers | Absent |

The answer rows reconcile exactly with all 18,036 sensor rows, without unlabelled idle rows or overlap. The relevant supervised sample count is **110 cycles**, not 18,036 independently labelled observations. Common acquisition sessions and near-duplicate movements may still create dependence; an exact-duplicate check does not prove independence.

The separate header-reference document mentions asset identifiers, but the actual supplied CSV does not contain them. The API therefore uses local recording identifiers such as `cycle_011` and returns `asset_id: null`.

## 3. Parsing and units

Native timestamps are parsed into integer milliseconds using their seven components. The last native field is an integer number of milliseconds: `...-92` means 92 ms, not 0.92 seconds. Outputs preserve the original timestamp text. Input rows must already be strictly chronological; the loader rejects duplicates/backward timestamps instead of silently sorting potentially interleaved assets.

Current is converted from mA to A by dividing by 1,000. Voltage values are in 10 mV units and are multiplied by 0.01 to obtain V. Position and back-EMF remain explicitly labelled raw values because their physical units are not supplied. Opening/closing-time setting fields are deliberately excluded as classifier features.

Strict validation catches missing required columns, ambiguous duplicate headers, malformed numeric fields, infinity and inappropriate prediction/answer files. Small gaps in sensor values may be interpolated within an individual completed cycle, with warnings; more than 10% missing in a required signal, globally or within a cycle, is rejected. There is no interpolation across a detected cycle boundary. This is offline interpolation, not a claim of causal real-time processing.

## 4. Segmentation: learn the clearly separated timing regimes

The supplied data has a clean distinction between within-cycle sampling and gaps between cycles. The segmenter learns this distinction from the training subset of each fold:

```text
largest within-cycle gap = max training within-cycle delta-t
smallest between-cycle gap = min gap between adjacent labelled training cycles
threshold = sqrt(largest within-cycle gap × smallest between-cycle gap)
```

The final deployment values are:

```text
max within-cycle interval:       20 ms
min between-cycle gap:       10,215 ms
learned split threshold:       451.995575 ms
```

A new cycle starts after a timestamp gap above the threshold. Each segment's boundaries are its first and last recorded timestamps. Its start/end are not shortened merely because a motor-current peak ends or a command flag changes. No expected number of Test segments is hardcoded.

Every development validation block and the final reserved validation block achieved exact boundary recovery, with timing-only IoU-weighted F1 of 1.0. These are held-out raw-stream predictions, not classification scores computed using pre-supplied validation-cycle cuts. Ground-truth boundaries define whole-cycle partition edges and evaluate detections; the inference function itself receives only telemetry.

**Scope limitation:** this is valid for the organiser's documented gap-separated format. A real controller feed with idle records, long within-cycle telemetry dropouts, interleaved doors or uninterrupted movement transitions needs a different, validated event-boundary model. The current implementation is not demonstrated to solve those cases. It rejects isolated single-row blocks, and warns about unusual sampling or cycle lengths rather than silently deleting them.

## 5. Features: motion context, not just a current peak

The classifier receives **97 cycle-level features**:

- Duration; signed position change; position range and total variation; inferred direction.
- Whole-cycle current, voltage, back-EMF and absolute position-speed summaries: mean, standard deviation, 10th percentile, median, 90th percentile, maximum and root mean square.
- The same signal summaries during the middle 10–90% of normalized door travel.
- Absolute current integral, absolute electrical-energy proxy, each normalized by travel where applicable; current-change magnitude and a low-speed fraction.
- Five fixed 20%-travel bins, with current/voltage/back-EMF means, current 90th percentile, average speed and occupancy fraction.

One constant feature is removed in the all-training deployment fit, leaving 96 active features. Feature preprocessing is learned inside each training fold: median imputation, constant-column removal and, for logistic regression/SVM, standard scaling.

Absolute timestamps, recording order, cycle IDs, preceding/following inter-cycle gaps, label-file status/operation, label `n_rows`, physical IDs and controller opening/closing-time settings are **not** classifier inputs. Duration is measured from the actual detected telemetry segment, not copied from a label row.

Direction is inferred from signed position travel, with command-based fallback when net travel is insufficient. It is informational and helps feature context; it is not an additional submitted label. The native position unit is not assumed to be millimetres.

The global coefficient ranking in the final fit is led by motion-region current statistics, including `moving_current_q90`, `moving_current_rms` and `moving_current_mean`. This supports an interpretable current-versus-movement representation but does not prove any particular mechanical cause.

## 6. Validation protocol

The last **22 cycles (89–110)** were reserved for the final internal check before candidate comparison. The first **88 cycles** were used for development. There were 65 Normal and 23 Abnormal cycles in development; the final check contained 15 Normal and 7 Abnormal.

Within development, four expanding cycle-order folds were used, with one purged cycle between each fit and validation block:

| Fold | Training cycles | Purged cycle | Validation cycles |
|---|---|---|---|
| 1 | 1–19 | 20 | 21–37 |
| 2 | 1–36 | 37 | 38–54 |
| 3 | 1–53 | 54 | 55–71 |
| 4 | 1–70 | 71 | 72–88 |

There are 68 distinct out-of-fold validation cycles. Each validation recording block goes through raw-stream segmentation, feature extraction and classification. Every fitted segmenter, imputer, scaler and classifier uses only that fold's training portion. All seven candidate specifications and the simplicity tie-break are fixed in `door_pipeline/models.py`.

These folds contain equal numbers of cycles, not equal clock durations. The irregular inter-cycle gaps make equal-duration time-series interpretations inappropriate. No timestamp or prior/following-cycle features enter classification.

Because car, door and source-run identities are unavailable, this is **not** leave-one-door-out or leave-one-train-out validation. The source recording's construction may also limit what chronological order represents. Do not infer demonstrated future-degradation prediction from this split.

## 7. Model comparison and selection

Primary selection criterion: **pooled development IoU-weighted F1**, not plain accuracy. Each pipeline was run on the same four held-out raw-stream blocks.

| Candidate | Configuration summary | Pooled development score |
|---|---|---:|
| Majority baseline | Most frequent training class | 0.764706 |
| Decision stump | One split; learned feature/threshold | 0.985294 |
| **Logistic regression** | **L2 regularization, C=0.1, scaled features** | **1.000000** |
| RBF SVM | C=1, gamma=scale, scaled features | 1.000000 |
| Random Forest | 300 trees, depth 6, minimum leaf 2 | 1.000000 |
| Extra Trees | 400 trees, depth 8, minimum leaf 2 | 1.000000 |
| Gradient Boosting | 150 trees, learning rate 0.04, depth 2, minimum leaf 3 | 0.985294 |

**Selected: logistic regression.** It tied for the top result, so the predefined preference for the simpler interpretable classifier chose it over the SVM/ensembles. This comparison does not establish that logistic regression universally dominates those methods. No exhaustive hyperparameter search or statistical difference between tied models is claimed.

The selected pipeline uses the normal binary decision threshold of 0.5, with no tuning against Test predictions. Its `abnormal_model_score` is an **uncalibrated classifier output**, not an estimated probability that the physical door will fail.

Quantile gradient boosting was not retained as the core method: this is a labelled cycle-classification task and the simpler supervised approach performed strongly on the available development data. Quantile regression was not experimentally benchmarked in this run; no superiority claim against a fitted quantile pipeline is made. Deep sequence models were not benchmarked either.

## 8. Final reserved internal check

After saving the model selection, the selected specification was trained on cycles 1–88 and applied to raw telemetry from cycles 89–110.

| Measure | Result |
|---|---:|
| True / predicted segments | 22 / 22 |
| Exact-boundary, correctly labelled matches | 22 |
| Sum of matched IoU | 22.0 |
| **Published-formula IoU-weighted F1** | **1.0000** |
| Timing-only diagnostic | 1.0000 |
| Abnormal precision / recall | 1.0000 / 1.0000 |
| Correct Normal / Abnormal labels | 15 / 7 |

Confusion matrix (rows actual, columns predicted; order Normal, Abnormal):

```text
[[15, 0],
 [ 0, 7]]
```

This is an encouraging result on **only 22 same-source cycles and seven abnormalities**. It is not 100% demonstrated operational accuracy, not evidence of zero future false alarms, and not the organiser's hidden Test score.

`models/validation_model.joblib` preserves the 88-cycle artifact. `reports/validation_predictions.csv` preserves its outputs. The selected specification was subsequently refitted on all 110 training cycles for the deployment model. That deployment fit was not used to calculate this holdout score. The post-holdout refit is not a hyperparameter change or retuning of the selected specification.

## 9. Scoring implementation

The local scorer follows the supplied Info Kit: compute continuous-time IoU; consider only same-label pairs with positive overlap; greedily match highest IoU first; allow at most one match per prediction and truth interval.

```text
credit = sum of IoU across matched pairs
soft_precision = credit / number of predictions
soft_recall = credit / number of truth segments
IoU-weighted F1 = 2 × credit / (number of predictions + number of truth segments)
```

Intervals use the published subtraction formula, without an inclusive-sample `+1`. Wrong labels receive no overlap credit. Missing, additional and sloppily bounded segments are penalised. Normal cycles must be submitted as well as Abnormal cycles.

This is an implementation of the published specification, not the unavailable organisers' `judge_leaderboard.py` executable. The document does not specify tie-breaking for exactly equal IoUs; this implementation uses stable truth/prediction index order. The produced nonoverlapping exact-boundary validation segments do not depend on this ambiguity.

## 10. Actual Test inference and app-generated outputs

After model selection and the final internal check, the deployment model was applied to the supplied unlabelled Test stream through the **running app's multipart upload endpoint**. Its CSV and ZIP were then retrieved from the app's download routes.

| Property | Observed output |
|---|---:|
| Test sensor rows | 6,253 |
| Predicted cycles | 38 |
| Predicted Normal | 30 |
| Predicted Abnormal resistance | 8 |
| Rows covered by detected segments | All 6,253, exactly once |
| Ground-truth Test labels | Not available |
| Official Test IoU-weighted F1 | Unknown |

Three Test cycles (12, 28 and 35) have 136, 135 and 135 rows respectively, slightly below the training minimum of 137. They are retained in predictions and surfaced with a cycle-length warning. Such warnings are not proof of an incomplete cycle or a classification error; there are no Test labels to establish that. No model or threshold was changed in response to these warnings.

A measured run spent roughly 0.10 seconds in segmentation/features/classification on this execution environment, excluding HTTP upload/parsing and model-load costs. This is not a guaranteed laptop latency or a benchmark against other systems.

`reports/app_test_run_receipt.json` records source/model/output hashes and how the output was produced. `outputs/predictions.zip` has exactly one root-level entry, `door_predictions.csv`. It contains all 38 predictions, not an example template. Neither the raw dataset nor the four example submissions is packaged into the development delivery.

## 11. Evidence interface and integration

The app visualises real current, voltage, position and back-EMF. For current it can overlay separately computed normal Open/Close training references: empirical 5th/50th/95th percentiles at 101 normalized elapsed-time points. The deployment reference uses 40 normal opening and 40 normal closing cycles.

This is a **descriptive empirical reference**, not a conditional quantile-boosting model, calibrated prediction interval or classifier threshold. The plotting x-axis is normalized elapsed time; it must not be relabelled as physical travel percentage. The classifier's travel-bin features use normalized position, a separate quantity.

Local logistic explanations show the largest signed standardized-feature contributions to the decision log-odds. They are model attributions, not diagnoses of bearings, rollers or obstruction type. Physical car/door identity is explicitly unavailable. Recommendations remain read-only and advisory.

The same inference function is called by the app and CLI. The TypeScript adapter and Codex brief support connection to the existing 3D dashboard without rewriting it. The app remains a local prototype without production authentication, safety certification or deployment monitoring.

## 12. Reproducibility and checks

Training uses seed 42 and a single computational thread for the measured comparison. Data/model metadata and training-file SHA-256 hashes are retained. The environment was Python 3.13.5, NumPy 2.3.5, SciPy 1.17.0, scikit-learn 1.8.0 and joblib 1.5.3; other direct requirements are pinned.

Automated tests cover parsing, units, feature construction, scoring, model reload, API downloads and CLI/API agreement. Live HTTP testing additionally covers the real Test stream. Chromium DOM interaction and responsive layout were checked with a live-API bridge because direct browser localhost navigation was restricted in this environment. Native browser download navigation was not tested; the actual HTTP download content was validated.

Use `README.md` for commands, `reports/model_selection.json` for per-fold results, `reports/split_manifest.json` for the exact split, and `reports/final_holdout.json` for final metrics. The original datasets stay with the user and are needed to rerun training.

## 13. Sources and what they establish

The user-provided Door Info Kit defines the task (§§1–3), stream schema (§2.2), output fields (§3) and greedy IoU-weighted F1 (§4). The user-provided top-level PS3 specification defines the app/video/ZIP requirements (§4.1) and warns that examples are placeholders. These are the authoritative task sources; the computed metrics in this report are our own executed results.

External implementation references consulted (official documentation; package versions in this project are pinned independently of the latest documentation):

- scikit-learn LogisticRegression: https://scikit-learn.org/stable/modules/generated/sklearn.linear_model.LogisticRegression.html
- scikit-learn TimeSeriesSplit: https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.TimeSeriesSplit.html
- scikit-learn model persistence and trusted/version-matched artifacts: https://scikit-learn.org/stable/model_persistence.html
- FastAPI multipart file upload: https://fastapi.tiangolo.com/tutorial/request-files/

No public source, external label set or example-submission label was used to classify the supplied Test cycles.
