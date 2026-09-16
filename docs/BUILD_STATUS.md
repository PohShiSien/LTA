# Build status

The original brief is preserved in `PROJECT_BRIEF.md`. Its implementation suggestions are reference material, not authorization to purchase assets or publish externally. The v2 dashboard gives each workspace a separate purpose.

## Implemented workspaces

- **Overview:** interactive train, selected-door signal, shared attention queue, current advisories and data quality, and links into investigation and verification.
- **Door Analysis:** closing-cycle heatmap; current, duration, recurrence, and coverage trends; historical and peer comparisons; assessment criteria; data integrity; and baseline provenance.
- **Verification:** original prediction record; chronological ledger of included and excluded movements; immutable first assessment and later follow-ups; scenario selection; and a separate six-scenario validation suite.
- **Engineer review:** browser-local acknowledgments, notes, and inspection observations, separate from automated assessment and hidden before their evidence cutoff.

## Domain and platform capabilities

- Deterministic telemetry for 24 doors and 37 movements per recording, including 12 historical movements before the original demonstration sequence.
- Six scenarios: recurrence, non-recurrence, missing samples, intermittent recurrence, gradual drift, and isolated spikes. Later events exercise a second door advisory and a separate sensor dropout.
- Shared predictions and quality for every door; fleet count, selected-door views, and evidence use the same records.
- Coverage, persistence, grid, metadata, timestamp, and envelope checks with explicit insufficient-evidence results.
- First eligible result retained within a reconstructed prediction; every later eligible movement retained as a follow-up.
- Observed-prefix derivation and rewind, with future preview separated from assessment. Exported evidence and reviews respect the cutoff.
- Original optimized MRT-inspired GLB with 24 selectable doors, camera controls, hover/selection indicators, semantic health states, and fallback schematic.
- Interactive signals, synthetic envelope, comparisons, synchronized cursor, preserved gaps, and accessible data tables.
- Responsive layout, keyboard controls, reduced motion, local fonts, asset generation, and Mac launcher.

## Validation

- **41 unit tests** passed: 22 replay, 17 diagnostics, and 2 local review tests.
- The six-scenario suite passes its authored first-outcome and chronology checks: two corroborated, three not corroborated, and one insufficient-evidence first result. These are fixture regressions, not field accuracy.
- **13 Chrome browser tests** passed, covering page separation, comparisons, evidence chronology, missing-data recovery, isolated spikes, fixture validation, observed-only exports, all-door advisories, local review persistence, playback/navigation, mobile layouts, and WebGL fallback.
- Strict TypeScript and the production build passed. The packaged app on port 4173 passed a three-page smoke check with no browser errors. Desktop and mobile screenshots were visually reviewed.
- Verification commands are `npm run typecheck`, `npm run build`, `npm test`, and `npm run test:e2e`.

## Deliberate boundaries

Signals and envelopes are synthetic. There is no live LTA connection, trained fault model, measured fleet baseline, or maintenance integration. Deviation and health values are illustrative; a signal signature does not certify mechanical condition.

Predictions are reconstructed from the recording and cutoff in browser memory. Engineer reviews persist only in local browser storage, with in-memory fallback. There is no shared server persistence, signed audit trail, server-enforced access cutoff, or automatic escalation to another person. The validation suite does not use independently labeled inspections and does not claim predictive accuracy.

External deployment and real-data/model integration have not been supplied as separate services. Optional interiors and multi-train simulation remain outside the application. The train model is original; provenance is documented in `public/models/README.md`.
