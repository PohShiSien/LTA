# Subsystem visualization layer

The existing React/Vite workspace and eight-car reference train now share a small display-state contract, `src/types/visualization.ts`. This contract controls explanatory animation only. Frozen Door inference, the three browser model pipelines, source identity, and prediction export formats remain authoritative.

## Changed files

- Door: `src/components/door/DoorReplayTimeline.tsx`, `DoorMotionVisual.tsx`, `DoorReplay.css`, `DoorCycleEvidence.tsx/.css`; `src/lib/doorReplay.ts`, `useDoorReplay.ts`.
- ACV: `src/components/acv/AcvCarRanking.tsx`, `AcvPeerComparison.tsx`, `AcvEvidence.css`.
- Rail: `src/components/rail/RailEvidencePanel.tsx/.css`.
- SHM: `src/components/shm/StressReplay.tsx`, `FatigueDamagePanel.tsx`, `DamageContributionChart.tsx`, `ShmEvidence.css`.
- Train: `src/components/train/ReferenceTrainScene.tsx/.css`, `subsystemVisuals.ts`.
- Shared integration: `src/components/workspace/AnalysisResultSummary.tsx`, `src/pages/SubsystemWorkspace.tsx/.css`, `src/types/visualization.ts`, `src/types/multisystem.ts`, `src/lib/useWorkspaceMotion.ts`, `src/lib/visualEvidence.ts`, `src/lib/workerClient.ts`, `src/workers/analysis.worker.ts`.
- Existing output metadata: `src/lib/inference.ts` exposes the already-computed ACV scores; `src/data/subsystemDemos.ts` exposes its authored Door movement flags. No model parameter or frozen artifact changes.
- Tests: `tests/doorReplay.test.ts`, `trainVisuals.test.ts`, `trainSceneRendering.test.ts`, `visualEvidence.test.ts`, `inference.test.ts`, `tests/browser/subsystem-visuals.spec.ts`, and the elapsed-axis assertion in `tests/browser/door-backend.spec.ts`.
- Documentation: `README.md`, `docs/BUILD_STATUS.md`, and this guide. Earlier frozen-backend integration changes already present in the worktree are retained.

## Door: completed movements in chronological replay

Uploaded cycles retain the backend's original timestamps, source row bounds, inferred Open/Close movement, and exact labels. The backend validates strictly increasing source timestamps, so source row order is chronological. The replay compresses each movement to 1.5 seconds and holds its completed classification briefly before advancing. It waits for the selected cycle's evidence before starting movement. Changing source or job cancels playback; cycle details remain protected by the existing request abort and identity checks. Controls sit directly below the 3D view; an expandable movement detail offers the compact 2D illustration.

One progress value drives the representative door, waveform reveal, timeline progress, and source-sample cursor. During an unfinished movement the selected classification, model score, contributions, and recommendation are concealed. The batch result table is concealed during playback so it cannot reveal the answer early. Direct inspection of an already completed cycle displays its existing classification immediately.

The representative opening is illustrative. Its geometric displacement is a display of inferred movement and elapsed cycle progress, not a calibrated physical position measurement. No recorded cycle is assigned to a physical door. Current and voltage retain the backend's supplied A and V units. Reference curves are empirical Normal training-cycle percentiles and use **Elapsed cycle time (%)**.

Synthetic recordings retain separate authored predictions and exports. Their Open/Close display metadata comes from their authored movement flags; uploaded inference never uses these fixtures.

## ACV: relative ranking across eight source cars

Car identifiers come directly from the recording. A brief scan precedes the settled rank badges; ranks 1–3 receive decreasing amber emphasis and lower ranks remain neutral. Selecting a car connects its train focus to the peer evidence view.

The visualization exposes ranking scores already calculated by the existing model; it does not recalculate inference or calibrate these scores. Temperature, cooling residual, response, and coverage comparisons are derived separately from recorded fields. Missing or invalid observations remain unavailable. Descriptive comparisons do not claim to be causal model explanations.

## Rail: recording-level side evidence

The train retains 64 reference axle-box nodes: positions 1/3/5/7 belong to Side I and 2/4/6/8 to Side II on every car. A predicted side highlights its reference rail. Normal highlights neither side as faulty. Sensor activity and the scan are illustrative; they do not diagnose individual bearings or locate a geographic track section.

The supplemental evidence compares recorded vibration and shock by side and exposes spectral context where sufficient valid samples exist. The original trace/spectrum inspector remains available for exact source-channel inspection.

## SHM: one file-level damage value

The whole train becomes a translucent structural reference. No physical component is highlighted without verified mapping. Stress playback follows recorded sample order; when no acquisition clock exists it uses sample indices, not invented timestamps or filename order. The pulse expresses signal magnitude uniformly and is not a measured spatial stress field.

The numeric damage estimate is retained at full precision. Rainflow distributions are derived from the original stress samples. Where model terms are shown they explain the regression's log-damage output, not additive allocations of damage to time intervals or components. No health percentage or remaining-life conversion is made.

## Accessibility and verification

The operating system's reduced-motion preference and the workspace's Reduce motion control suppress camera sweeps, repeated pulses, and CSS motion. Timeline and car/side controls remain keyboard operable. Text labels accompany ranks, sides, classifications, and selection. The existing schematic fallback preserves the interactions when WebGL is unavailable.

Run `npm run typecheck`, `npm run build`, `npm test`, and `npm run test:e2e`. The browser suite includes the existing inference/export regressions and the new subsystem visualization checks. Full supplied-data checks require the dataset environment variables documented in the README. A final demo rehearsal on the presentation computer remains useful for GPU rendering and preferred animation pacing.

Final verification on 18 September 2026: typecheck and build passed; **145 Vitest tests passed** with the full-file parity cases enabled; **22 browser tests passed** with the supplied Door acceptance and rich ACV workbook enabled. No tests were skipped in these runs. Chrome layouts were checked at 1440px and 390px without page errors or horizontal overflow. The Vite 3D chunk-size warning remains. Other browser engines and the final presentation hardware were not tested.
