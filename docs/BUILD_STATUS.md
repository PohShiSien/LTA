# RailWitness v3 build status

The governing brief is [MULTISYSTEM_BRIEF.md](MULTISYSTEM_BRIEF.md). It supersedes the original three-car prototype's fixed identity, 24-door count, synthetic health index, and compulsory future-cycle verification. The earlier [completion audit](COMPLETION_AUDIT.md) and [synthetic telemetry contract](TELEMETRY_CONTRACT.md) are historical v2 documents.

## Current application

- Four independent subsystem workspaces: Door, ACV, Rail Corrugation and Structural Health. Source selection, sample cursor, model result and component selection remain scoped to their own subsystem and source mode.
- An original eight-car reference layout, 64 axle-box anchors, two separately identified rails, carriage navigation, fit/focus controls and shell transparency. Rail numbering and side associations follow stable coordinates rather than camera position.
- CSV ingestion and ACV XLSX ingestion, including rich case schemas. Exact headers, two-digit IDs, full raw rows, missing values and actual timestamps are preserved. The inspector exposes every source field with units, conversions, validity and mapping provenance.
- Browser-worker parsing, full-recording inference and signal inspection. Plot summaries and spectra are derived evidence. Worker memory is bounded by eviction; current-session original files restore evicted records when needed.
- Actual fitted models for all four subsystems, packaged as JSON. Browser use requires no Python or inference server. Unsupported inputs fail explicitly; synthetic fixtures never replace uploaded-data predictions.
- Correct result scope: Door classified segments; ACV complete eight-car ranking; Rail one fixed recording class; SHM one numeric damage value per stress segment. No file-level output is presented as per-sample inference.
- Searchable fields, metric selection, raw/display value distinction, limited pins, recorded traces, paired rail channels, spectral evidence and per-timestamp ACV comparisons. Missing measurements, invalid values, uncomputed predictions and Normal predictions are distinct states.
- Exact CSV and flat `predictions.zip` outputs. Demo exports stay separate and are excluded from uploaded ZIPs. Door ZIP output uses the currently selected analysed stream because the required CSV contains no file identifier.

The supplied sources establish no Door/SHM physical location. Those recordings remain unlocated. Random SHM filenames neither define chronology nor identify cars/bogies; no spatial damage heatmap or lifetime sum is implemented. Geometry remains schematic even where the dataset establishes logical channel associations.

## Trained-model evidence

Only published training labels are used. Final models are refitted on all labelled training inputs after validation; unknown test labels are never read.

| Subsystem | Training inputs | Validation result and boundary |
| --- | --- | --- |
| Door | 110 labelled cycles | Final 33 chronological cycles: IoU-weighted F1 1.000 with exact boundaries. Gap-based segmentation is specific to the acquisition pattern. |
| Rail | 272 files: 234 Normal, 14 Side I, 24 Side II | Stratified 55-file holdout: accuracy 0.9636, balanced accuracy 0.7778, macro F1 0.8264. Model selection uses development-only CV; minority support is small. |
| SHM | 64 healthy-condition files | Random 16-file holdout: MAPE 4.15%, derived score 0.95848. No fault-classification or remaining-life evidence. |
| ACV | Six eight-car cases | Leave-one-case-out rank-decay 0.95833; top-1 4/6. Small heterogeneous sample, no calibrated probabilities. |

[TRAINED_MODELS.md](TRAINED_MODELS.md) documents features, training, missing-input handling, limitations and the distinction between development validation and external test performance. [model-validation.json](model-validation.json) records exact metrics, split files and Rail model selection.

## Final verification — 18 September 2026

- Thirteen focused inference tests passed: Python/browser feature parity for all four subsystems, fitted-model output parity, Door timestamps, exact ACV IDs, no probability field, no SHM clipping/filename dependence, and invalid-input rejection.
- Four actual-file integration tests passed: complete Door `Test.csv`, Rail `Test1.csv`, SHM `test01.csv`, and ACV `acv_test_case.xlsx`. Python CLI and browser features/predictions match. Door produced 38 segments; Rail retained 10,000 × 129 values; SHM retained over 500,000 samples.
- The final application passes strict TypeScript compilation and the Vite production build. The 3D renderer remains a lazy-loaded chunk; Vite reports its size warning (about 291 KB gzip), not a build failure.
- The unit suite passes 92 tests: 48 current multisystem tests (parsers, exports, topology, inference and signal inspection) plus 44 retained v2 regression tests. The four optional actual-file tests also pass separately with the supplied dataset path.
- All ten current Chrome browser cases pass together, including the optional full 33 MB ACV workbook: all 22,262 rows and 483 fields load and run the fitted ranking model. Tests cover exact CSV/ZIP exports, demo exclusion, invalid-input recovery, same-name source isolation, source removal, cache eviction/rehydration, multi-file output, C3/P5 addressing, fixed recording classes during scrubbing, ACV metric/pin identity, and WebGL fallback.
- All four layers were visually checked at desktop and 390-pixel mobile widths with no page errors or horizontal overflow. The whole-train fit shows eight proportional cars; selected-car focus exposes its sensor controls.
- A production-build browser smoke uploaded the complete SHM test01.csv, ran its fitted model, selected raw sample 20, downloaded shm_predictions.csv, and loaded the WebGL asset with no console/page errors. Empty ACV context correctly shows schematic placeholders and an overview.
- Reproduce the heavy browser case with `PLAYWRIGHT_CHANNEL=chrome RAILWITNESS_HEAVY_XLSX=1 RAILWITNESS_DATA_ROOT=/path/to/02_Datasets npm run test:e2e`. The normal browser suite runs nine cases and skips that local-data-dependent tenth case.

Actual-file parity uses unlabelled inputs to check implementation consistency. Its pass rate is not predictive accuracy.

## Running and reproducing

The dashboard requires Node.js 22.12+ for local development/build and a modern browser with Web Worker support. WebGL supplies geometry; critical results and reference navigation remain available without it. `npm ci` followed by `npm run dev` serves the app locally. `npm run build` produces static files.

Optional Python training and CLI:

```sh
python3 -m venv .tools/ml
.tools/ml/bin/python -m pip install -r scripts/requirements-training.txt
.tools/ml/bin/python scripts/train-models.py --datasets /path/to/02_Datasets
.tools/ml/bin/python scripts/predict.py --subsystem shm --input /path/to/SHM/Test --output /tmp/predictions
```

The CLI uses the same learned JSON artifacts and exact formats. Regenerate the original eight-car model with `npm run model:generate`; provenance is in [REFERENCE_EIGHT.md](../public/models/REFERENCE_EIGHT.md).

## Deliberate boundaries

No live LTA connection, fixed train/operator identity, maintenance integration, shared server archive, mechanical certification, or assumed cross-subsystem timeline is claimed. Browser sessions and exports are local artifacts rather than signed audit records. Rail Normal is a dataset class, ACV ranking does not certify lower-ranked cars, and SHM damage is neither percentage health nor remaining life.

Synthetic mode is explicitly labelled and separately exported. Old door-only modules/documents remain for reference and regression coverage; `src/App.tsx` mounts the multisystem v3 workspace.
