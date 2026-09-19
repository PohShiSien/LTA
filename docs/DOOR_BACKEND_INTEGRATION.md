# Door inference integration

Door is the currently integrated prediction model. The React app sends the original uploaded CSV to `backend/app.py`, which calls the preprocessing and frozen-model inference in `backend/door/predict.py`. The browser parses the same source for field inspection and charts. Neither path trains a model.

## Runtime files

| File under `backend/door/` | Purpose |
| --- | --- |
| `predict.py` | Input validation, fixed segmentation, feature extraction, model execution, and command-line entry |
| `door_model.joblib` | Trained deployment artifact, including fitted preprocessing and reference arrays |
| `door_predictions.csv` | Generated output of a local CLI run; not model input or a source for the UI |

The API lives in `backend/app.py`, pinned dependencies in `backend/requirements.txt`, and the local Python environment in `backend/.venv`. The prediction script contains the complete Door pipeline, so no additional Python package is needed inside `backend/door/`.

The saved model contains its metadata, including feature names, segmentation settings, training provenance, and software versions. The API reads this information from the artifact; no separate metadata JSON is required. Its preprocessing and parameters must remain compatible with the pinned environment.

Development checks and their extra dependencies live outside the backend in `tests/door/`. They are not needed to run inference.

The active artifact's SHA-256 is `077e4a21838857e4b6bb2e5d2c9b9e1c7741a84d00c52a2d41ecb2489750ea7c`. It uses scikit-learn 1.8.0 and was tested under Python 3.13.5. There is no alternate validation-model path or training command in the app.

Start it from the repository root with:

```sh
backend/.venv/bin/python -B -m uvicorn app:app \
  --app-dir backend --host 127.0.0.1 --port 8000
```

The frontend defaults to `http://127.0.0.1:8000`; `VITE_DOOR_API_URL` can override it. Restart Vite after changing that environment variable. `-B` prevents Python bytecode cache files from appearing beside the prediction script.

## API and retained analyses

| Method and path | Purpose |
| --- | --- |
| `GET /api/health` | Service health |
| `GET /api/door/model` | Loaded model information |
| `POST /api/door/predict` | Multipart `file` containing the original CSV; return a job and all cycles |
| `GET /api/door/jobs/{job_id}/cycles/{cycle_index}` | Return a selected cycle's signals, references, and model contributions |
| `GET /api/door/jobs/{job_id}/predictions.csv` | Download exact CSV bytes |
| `GET /api/door/jobs/{job_id}/predictions.zip` | Download the same CSV at the ZIP root |

Uploads are limited to 25 MiB and must contain the 17 required controller fields. Missing or ambiguous fields, malformed values, unsupported timestamps, and duplicate/backward timestamps are rejected. Returned source-row bounds are zero-based and inclusive. Native timestamp strings are preserved.

Successful jobs remain in memory for up to one hour, with at most six jobs retained. Restart, expiry, and eviction require re-analysis. The service may use temporary upload files but does not intentionally retain raw datasets. Invalid input returns 422, oversized uploads 413, unavailable models 503, and expired jobs 404. Failures do not become Normal predictions.

ACV, Rail, and SHM currently have no backend implementation here. Their app tabs inspect uploaded fields and traces while awaiting the teammates' models; SHM also provides stress playback. Each future integration must preserve the teammate's preprocessing and verify the real model's output before enabling analysis.

## Predictions and evidence

The frozen segmenter starts a new cycle after a timestamp gap greater than **451.9955751995809 ms**. It retains each segment's actual first and last sample and extracts the original 97 model features. Stored median imputation, constant-column removal, scaling, and logistic regression execute without fitting against the uploaded test recording.

Limited missing-value gaps are interpolated within a cycle and reported as warnings. More than 10% missing in a required signal, globally or within a cycle, is rejected. No interpolation crosses a cycle boundary.

Current arrives at the frontend already converted from mA to A, and voltage from source 10 mV units to V. Position and back-EMF remain explicitly raw. The waveform axis is **Elapsed cycle time (%)**. Normal references are empirical 5th/50th/95th percentiles, separately for Open/Close; they are not calibrated prediction intervals.

The model score is uncalibrated. Signed feature contributions explain the model's logistic decision, not a specific failed mechanical component. The source does not establish physical door identity, and the animated opening is illustrative. No future-failure forecast or health percentage is inferred.

The export schema is exactly:

```csv
start_time,end_time,prediction
```

It includes every detected cycle with `Normal` or `Abnormal resistance`. The frontend downloads the CSV or ZIP directly from the selected Door job. The ZIP contains that job's `door_predictions.csv`; the browser does not assemble combined subsystem exports.

## Regression fixture and CLI

`tests/fixtures/door/door_predictions.csv` is the expected output for the optional supplied-recording regression check. It is test evidence, not a template used to generate predictions. Its SHA-256 is `2f94f8f5e2ccd6bce223a7c2f9fd2c7b974aa17cbce3d7bc3521dd100d7a079b`.

For that specific 6253-row recording, the reference contains 38 cycles: 30 Normal and 8 Abnormal resistance. Those counts are predictions for that input, not ground-truth accuracy or hardcoded application behavior.

The CLI executes the same model as the webpage. `--input` is required; `--output` is optional and defaults to `backend/door/door_predictions.csv`, beside the script:

```sh
backend/.venv/bin/python -B backend/door/predict.py \
  --input /path/to/Door/Test.csv
```

Pass `--output /path/to/door_predictions.csv` to choose another destination. Each CLI run writes that output file; it is ignored by Git at its default location. The API performs fresh inference for each uploaded recording and retains its own job-specific output in memory. It does not read the local generated CSV. ZIP downloads are provided by the API.

For automated checks and the optional local Test recording path, see [README.md](../README.md#checks).
