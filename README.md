# RailWitness

A train-door diagnostics prototype with three distinct workspaces: **identify attention → investigate history → verify predictions**.

Built from [the project brief](docs/PROJECT_BRIEF.md). All telemetry is explicitly synthetic; no LTA connection or trained model is claimed.

## Run

Requires Node.js **22.12 or later** and npm.

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:5173**. On this Mac, you can also double-click **Start RailWitness.command**; it uses the workspace's local Node runtime if Node is not installed globally.

```sh
npm run build       # strict TypeScript check and production bundle
npm run preview     # serve the production bundle locally
npm test            # domain, diagnostics, and review-store tests
npm run test:e2e    # browser integration tests
```

Install the test browser once with `npx playwright install chromium`. If Chrome is already installed, use `PLAYWRIGHT_CHANNEL=chrome npm run test:e2e`. The browser suite starts a local server when necessary.

## Try the workflow

1. Overview opens on **Train 017 / Door D07**, at **14:19:22**. The current peaks at **4.2 A**, versus the **2.8–3.5 A** expected healthy envelope at 60–80% closure.
2. Open **Door Analysis**. Nine observed closing movements provide initial history. Select a heatmap row, compare its signal with a previous cycle or peer door, and inspect coverage, persistence criteria, and baseline provenance.
3. Open **Verification** to inspect the prediction as issued and its chronological evidence ledger. Step through the ineligible opening, then reveal the closing movement at **14:21:03**. Its 4.1 A peak reproduces the signature.
4. Continue revealing movements. The first assessment stays fixed while later assessments accumulate separately. Rewind to see only records available at the earlier cutoff.
5. Select another synthetic recording to explore clearance, missing samples, intermittent recurrence, gradual drift, or isolated spikes. **Run validation suite** checks all six fixtures separately from the active replay.
6. In Door Analysis, save an acknowledgment, note, or inspection observation. **Export evidence** downloads the selected door's observed telemetry, prediction/assessment record, and eligible review entries as JSON.

## Implemented

| Workspace | Purpose | Main capabilities |
| --- | --- | --- |
| **Overview** | What needs attention? | Selectable 3D train, shared door advisory queue, latest signal and assessment |
| **Door Analysis** | Is the behavior changing? | Closing-cycle heatmap, trends, comparisons, decision criteria, data quality, provenance, engineer review |
| **Verification** | What was known, and what happened next? | Frozen prediction, movement eligibility ledger, first result and follow-ups, chronological replay, separate fixture validation |

The deterministic adapter supplies **24 doors, 37 movements, and six scenarios**. Twelve earlier healthy movements add historical context without changing the original demonstration timestamps. Later movements exercise a second door advisory and a sensor dropout.

Shared per-door records distinguish corroborated, not corroborated, and insufficient-evidence assessments. Evaluation checks sample coverage, consecutive excess, excess proportion, identities, chronology, travel grid, and envelope integrity. A tall isolated spike cannot pass the persistence criteria.

The original GLB train supports 24 selectable doors, camera focus and controls, keyboard access, semantic status colors, and a schematic fallback. Charts provide authored synthetic envelopes, historical or peer comparisons, synchronized cursors, visible gaps, and accessible sample tables. Layouts support mobile screens and reduced motion.

Replay, prediction records, and **observed-only JSON exports** respect the active cutoff, including when future preview is enabled. Engineer reviews are saved in this browser when local storage is available, with in-memory fallback. Reviews made against later evidence are hidden on rewind and do not alter automated assessments.

## Project map

```text
src/App.tsx                     Navigation, replay state, review storage, JSON export
src/pages/Overview.tsx          Train, shared attention queue, current signal
src/pages/DoorAnalysis.tsx      Historical investigation and assessment criteria
src/pages/Verification.tsx      Prediction audit, evidence ledger, fixture suite
src/styles.css                  Shared dashboard design and responsive layouts
src/components/train/           GLB scene, door interaction, camera, fallback
src/components/telemetry/        Interactive waveform and comparison
src/components/railwitness/      Prediction card and local engineer review
src/components/replay/           Chronological replay controls
src/data/mockTelemetry.ts        Deterministic synthetic telemetry adapter
src/lib/replay.ts                Evidence quality, per-door predictions, replay
src/lib/diagnostics.ts           Observed history, baseline metadata, fixture suite
src/lib/reviewStore.ts           Review validation and evidence-cutoff filtering
src/types/railwitness.ts         Model-agnostic typed contracts
scripts/generate-train.mjs       Reproducible original GLB generator
tests/                          Domain and browser verification
```

## Data and assets

See [TELEMETRY_CONTRACT.md](docs/TELEMETRY_CONTRACT.md) for API shapes, evaluation criteria, missing-sample semantics, and the future-data boundary. The frontend consumes typed observed samples and healthy envelopes; replace the fixture adapter and supply authoritative backend predictions/evidence when an actual model API exists.

The healthy envelope is **authored synthetic data**, not a fitted percentile distribution. Health and deviation indices are illustrative, and signature recurrence does not confirm a mechanical fault. Recommendations defer to the applicable maintenance procedure.

The six-scenario suite verifies authored fixture outcomes and chronology rules; its pass rate is **not predictive accuracy**. Prediction records are reconstructed in browser memory, and engineer reviews remain local. There is no server persistence, signed audit trail, or server-enforced future-data access boundary.

The train is original project geometry, without external model assets or operator branding. See [model provenance](public/models/README.md). Fontsource distributes DM Sans and IBM Plex Mono under the open font licenses retained in `public/licenses/`. All fonts, geometry, and lighting are served locally; the app needs no external assets at runtime.

Regenerate the train with `node scripts/generate-train.mjs`. The production app is static and can be hosted from `dist/`; no credentials or server backend are required for the demo.

The train renderer loads separately from the application shell. Door Analysis and Verification remain usable without WebGL.

## Scope

This completes the brief's dashboard/demo build, including its must-have features. A real LTA feed, trained diagnostic model, operational validation, and deployment to an external hosting account require data/services that were not supplied. Optional multi-train, train-interior, and maintenance-scheduling features are intentionally outside this focused three-view prototype.
