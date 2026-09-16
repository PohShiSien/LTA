# Telemetry and verification contract

RailWitness runs on deterministic synthetic telemetry. It has no live LTA connection, measured train data, trained anomaly model, or operational maintenance integration. Assessments demonstrate signal investigation and prediction review; they do not establish mechanical condition.

## Data and adapter boundary

`src/types/railwitness.ts` defines telemetry, assessment, prediction, and replay interfaces. `src/data/mockTelemetry.ts` produces fixtures; `src/lib/replay.ts` evaluates observed movements; `src/lib/diagnostics.ts` supplies history, provenance, and the separate synthetic validation suite.

Each `TelemetryCycle` contains:

- `id`: stable, unique movement identifier.
- `timestamp`: movement completion time in Unix milliseconds. Every sample must have been observed by this instant.
- `timestampLabel`: Singapore local time for display.
- `direction`: `open` or `close`.
- `label`: neutral movement description.
- `telemetry`: map from door ID to `DoorTelemetryPoint[]`.

Each point includes `timestamp`, `cycleId`, `doorId`, `direction`, `travelPct`, `current`, `expectedMedian`, `expectedLower`, and `expectedUpper`. Current and bounds use amperes; travel uses 0–100 percent. `current: null` means missing telemetry, never zero current. Charts preserve these gaps.

The envelope is an authored synthetic reference, not an empirically measured quantile distribution. `getBaselineProvenance()` reports version `RW-SYN-1.0`, source, method, units, travel grid, interval, and criteria. The evaluator requires a 2% travel grid. Production adapters would need compatible resampling, unit validation, and actual baseline provenance; this is not a general-purpose ingestion service.

## Synthetic recordings

Each of six recordings has 24 doors (`D01`–`D24`) across three cars and **37 chronological movements**. Each door/movement has 51 samples, including nulls for fixture dropouts. Values are deterministic.

The 12 healthy historical movements `H001`–`H012` precede the original demonstration sequence. Original `C001`–`C009` identifiers, timestamps, and signals are retained for the original three scenarios. The main sequence now extends through `C025`.

The initial cursor is zero-based index **16**, `C005`, completed at **14:19:22**. Nine closing movements are visible for historical comparison. In the original three scenarios, `D07` peaks at 4.2 A between 60% and 80% travel against a 2.8–3.5 A envelope and 3.15 A median: 20% above the upper bound.

`C006` at **14:20:37** is an opening movement and cannot assess a closing prediction. The first eligible movement is `C007` at **14:21:03**, zero-based index **18**.

| Scenario | First closing evidence | First assessment | Later behavior |
| --- | --- | --- | --- |
| `corroborated` | Persistent excess, 4.1 A peak | `corroborated` | Excess continues |
| `not_corroborated` | Within envelope | `not_corroborated` | Remains within envelope |
| `insufficient_evidence` | Missing 58–82% travel samples | `insufficient_evidence` | Second gap retained; recurring evidence at `C011` |
| `intermittent` | Within envelope | `not_corroborated` | Alternating recurrence and non-recurrence |
| `drift` | Sustained increasing current | `corroborated` | Current rises progressively |
| `isolated_spike` | One 5.4 A interval spike | `not_corroborated` | Spikes fail persistence criteria |

The original three scenarios are identical through `C006`. Gradual drift intentionally differs earlier because its observed history is part of that scenario. Choosing a scenario changes fixture data, not evaluator rules.

All recordings also contain a `D12` signature from `C013` onward and a complete `D19` sample dropout at `C017`. These exercise independent fleet advisories and data quality for a door without a prediction.

## Evidence integrity and criteria

`evaluateTrace(points)` examines the default 60–80% interval. `evaluateCycleTrace(cycle, doorId)` also binds samples to the enclosing movement and is used for predictions, fleet status, and history.

Integrity checks require:

- Finite, nonnegative current, with explicit nulls treated as missing.
- Valid, ordered envelope bounds with the median inside.
- Consistent door, cycle, and direction metadata.
- Strictly increasing sample timestamps; no sample later than completion when cycle context is supplied.
- Unique, increasing travel positions on the 2% grid from 0% to 100%.
- Unique movement IDs and chronological completion times in observed history.

Duplicate coordinates are deduplicated for coverage and flagged as an integrity error. Invalid metadata, chronology, grid, or envelope prevents assessment even when current is elevated.

A complete interval has 11 samples. `sufficientEvidence` requires at least 80% valid interval coverage and no integrity errors. A small gap can produce a warning while leaving enough coverage to assess. `signaturePresent` also requires at least three consecutive samples above the upper envelope and exceedances in at least 60% of valid observed interval samples.

`TraceEvaluation` exposes coverage, observed/required/excess sample counts, `maxConsecutiveExcess`, `excessFraction` (0–1), readable `qualityIssues`, peak, deviation, and envelope values. Isolated spikes are described as exceedances that failed persistence, rather than within-envelope observations. Missing or invalid evidence gives `insufficient_evidence`, not a negative assessment.

The illustrative anomaly score is `round(clamp(excessFraction × 65 + max(0, peakRelativeExcess) × 100 + meanNormalizedMedianDeviation × 4, 0, 99))`, with median deviations normalized by envelope width. It is not probability, confidence, or a maintenance threshold.

Illustrative system health subtracts 0.09 times the sum of original candidate scores for active door advisories, clamped to 0–100. Quality advisories without candidates contribute no candidate score. This is not measured fleet health or a safety assessment; the attention queue exposes quality issues separately.

## Shared predictions and chronological assessments

`getReplaySnapshot(cycles, index)` selects the observed prefix before deriving `visibleCycles`, `predictions`, and `doors`. `predictions` contains records for every door with a qualifying observed signature. Singular `prediction` is a compatibility convenience: `D07` when present, otherwise the first available prediction.

The first qualifying closing signature for a door creates a prediction with fixed ID, issue time, issuing cycle, door, target direction, interval, description, and expected condition. Issue time is movement completion, after the samples exist. Initially status is `awaiting`, `attempts` is empty, and no verification evidence exists.

Subsequent openings are excluded. Every subsequent eligible closing movement produces a `VerificationEvidence` with cycle, timestamp, direction, evaluation, `status`, and summary, including insufficient-evidence attempts.

- `verification`, `status`, `observedEvidence`, and `recommendation` retain the **first eligible assessment**.
- `attempts` preserves every eligible assessment in order, including the first.
- `latestAttempt` identifies the latest eligible assessment. Follow-ups never overwrite the first result.

`DoorHealth.status` follows the latest eligible assessment, or candidate/awaiting state before one exists. Insufficient current-movement quality takes precedence so a dropout appears immediately. `dataQuality` and `qualityIssues` describe the current movement independently of the prediction. `advisoryCount` includes every door whose status is neither `normal` nor `not_corroborated`, including quality cases without predictions.

Consumers must label first and latest assessments correctly. A latest summary uses `latestAttempt.summary`, rather than original `observedEvidence` or recommendation.

Rewinding reconstructs the observed prefix: later attempts disappear, and predictions disappear before issue. Future preview does not advance the cutoff or assess predictions. Playback reveals one movement at a time and pauses when any door issues a prediction or completes its first assessment.

This is an in-memory reconstruction, not a signed or server-persisted audit trail. The browser controls interface visibility; it does not provide a server-enforced access boundary.

## Historical diagnostics and validation

`getDoorHistory(visibleCycles, doorId)` returns `{ cycle, evaluation, durationMs }[]` for both directions from the supplied observed prefix. Door Analysis filters closing movements. Duration is the difference between first and last timestamps only for complete 0–100% movements with valid chronology; otherwise it is null. History does not fetch future movements.

`runValidationSuite()` is an explicit, separate full-fixture regression run. It neither uses nor modifies active replay state. It evaluates each recording through successive prefixes and checks the expected first outcome, data cutoff, fixed prediction details, and preserved first assessment. Reports include first-result counts, per-scenario checks, follow-up counts, and time to first assessment.

Expected results are authored fixture assertions. Six passing cases are not model accuracy, precision, recall, or real-fault validation. The report labels its full-fixture scope separately from the active observed ledger.

## Browser-local engineer review

Acknowledgments, notes, and inspection observations are separate `ReviewEvent` records in `src/lib/reviewStore.ts`. Each has a scenario/case key, wall-clock creation time, and the replay movement/time through which evidence was visible when recorded. Inspection observations can be `issue_observed`, `no_issue_observed`, or `inconclusive`.

Reviews use this browser's local storage when available, with in-memory fallback. They are not sent to a server or other engineers. `visibleReviews()` includes only the current case's records whose `evidenceThrough` is at or before the replay cutoff. Rewind hides reviews made against later evidence; advancing restores visibility. Exports apply the same cutoff.

Reviews do not change automated assessments or become verified inspection truth for accuracy metrics. Predictions are reconstructed on replay; review persistence is browser-local.

## Interpretation and tests

Corroboration means a predicted current signature recurred, not a confirmed mechanical fault. Non-recurrence does not establish mechanical condition. Recommendations defer to applicable maintenance procedures.

`tests/replay.test.ts` covers fixture chronology, initial outcomes, fixed assertions, quality, rewind, and playback. `tests/diagnostics.test.ts` covers history cutoff, provenance, malformed evidence, independent advisories, recovery follow-ups, and six regression fixtures. `tests/reviewStore.test.ts` covers review parsing and cutoff visibility. Browser coverage is tracked in `tests/browser/dashboard.spec.ts`.
