# RailWitness: Eight-Car, Multi-Subsystem 3D Workspace

## Codex task

Update the existing RailWitness application, rather than creating a second app. Keep its premium dark interface and reusable visual components. Replace the three-car, door-only demonstration with a dataset-aligned eight-car 3D reference layout and four subsystem-specific evidence layers.

This document supersedes conflicting requirements in `railwitness_dashboard_codex_brief.md`, especially the fixed 24-door count, illustrative fleet health percentage, and compulsory next-cycle corroboration workflow. It is an implementation brief, not a claim that the application has already been modified.

Read the existing repository, package.json, train-generation script, scene components, data contracts and tests before editing. Reuse the existing stack and geometry where practical. Do not install a second rendering framework or rewrite working inference/export pipelines unnecessarily.

**Core interaction:** Select subsystem -> select/upload a recording -> run analysis -> select a relevant 3D component -> inspect its recorded fields and prediction evidence -> download the required output.

The 3D train is a navigable reference layout. It must not imply more spatial precision, shared identity, or prediction granularity than the dataset supports.

---

## 1. Source-of-truth requirements

These are requirements from the supplied documents, not visual-design assumptions.

| Subsystem | Documented data and topology | Prediction scope |
|---|---|---|
| Door | Continuous controller stream; current, voltage, back-EMF, movement-related signals, switches and position. The main kit lists 17 parameters; the separate header reference additionally names Car Type, Car Number and Door Number. Confirm the actual uploaded headers before using identity fields. | One Normal/Abnormal resistance label and start/end times per detected cycle. |
| ACV | Eight cars per case. A timestamp every 30 seconds. Car-specific parameter sets differ between files. Preserve the two-digit car identifiers exactly as written in headers. | One ordered ranking of all cars per case file. |
| Rail Corrugation | Eight cars, eight axle boxes per car: 64 axle boxes, each with vibration and shock measurements. Column 1 is the rotational-speed sensor; columns 2-129 contain 128 measurement channels. Sampling frequency 10,000 Hz; one-second recordings; vibration/shock unit m/s². | One label per recording: Normal, Side I or Side II. Not 64 axle-box diagnoses. |
| SHM | One file per equal-length dynamic-stress segment from a measurement point. File numbers are random identifiers, not chronology. All provided samples represent healthy operating conditions. The kit does not provide a usable 3D sensor-location mapping. | One numeric cumulative fatigue damage prediction per file. Not a damage map over the train. |

Sources: `Door_Subsystem_Info_Kit.md` §§2-3; `Door Data Headers.md`; `ACV_Subsystem_Info_Kit.md` §§2-3; `Rail_Corrugation_Info_Kit.md` §§2-3 and Figure 2; `SHM_Info_Kit.md` §§2-3.

The four subsystems are independent datasets. Reusing one visual train does not mean their recordings came from the same physical train or time. Source: `01_Problem_Statement_3_Specifications.md` §1.

---

## 2. Eight-car geometry and camera behaviour

### Required reference topology

Build eight individually selectable carriage objects for the ACV and Rail views. Do not stretch a three-car model to look longer or count linked car sections incorrectly.

For Rail, each carriage must expose exactly eight unique axle-box anchors with positions 1-8. This produces:

- 8 carriage objects;
- 64 axle-box anchors corresponding to 64 wheel positions;
- 128 selectable vibration/shock channels in the field registry;
- 1 recording-level rotational-speed signal;
- 2 separately addressable reference rail meshes, Side I and Side II.

To reproduce Figure 2 schematically, draw two undercarriage/bogie groups per carriage: positions 1-4 in one group, positions 5-8 in the other. Four axle lines connect the paired positions (1,2), (3,4), (5,6), (7,8). This is the proposed visual grouping of the supplied layout, not a detailed manufacturer-verified engineering model. Dimensions, roof equipment geometry, cab appearance and bogie construction remain schematic unless verified metadata is available.

For ACV, parse the actual identifiers from the case headers. Never reorder physical carriage objects according to leak rank. If the physical consist order is not provided, use a deterministic labelled schematic order and disclose that arrangement; car identity remains exact even when the drawn geometry/order is schematic.

For Door and SHM, the eight-car scaffold can remain a background reference, but it must not imply that those datasets establish an eight-car consist or cover every rendered component. Display `Reference layout — asset mapping not supplied` when appropriate.

Do not retain `Train 017 / NSL` or a particular operating line as a real-data identity unless the selected source establishes it. Preferred title: `Eight-car dataset reference layout`.

### Layout and navigation

Provide two levels of detail:

1. **Whole train:** eight-car overview, one compact label per car and a persistent carriage navigator.
2. **Selected carriage:** camera focuses on a car at a readable scale; reveal relevant doors, ACV context, axle boxes or verified SHM anchors.

Use a full-width viewport where possible. Keep an always-available `Fit train` action. Do not squash carriage proportions to fit eight cars into the old three-car camera bounds.

Camera presets:

| Layer | Default camera/visibility |
|---|---|
| Doors | Side-oblique; door components visible. |
| ACV | Elevated three-quarter view; car-level ACV labels above each car. |
| Rail Corrugation | Low side-oblique or top schematic; optional translucent carbody exposes axle boxes and both rails. |
| Structural Health | Neutral structural-context view; only verified measurement points receive physical anchors. |

A single `X-ray` toggle may make shells translucent. This is a visibility effect, not a stress simulation. Ghost meshes must not obstruct intended sensor picking.

---

## 3. Rail-side mapping: do not infer it from the camera

The supplied Figure 2 uses a left-pointing reference travel arrow and the following arrangement within each car:

| Position | Rail side | Visual group |
|---|---|---|
| 1 | Side I | First bogie group |
| 2 | Side II | First bogie group |
| 3 | Side I | First bogie group |
| 4 | Side II | First bogie group |
| 5 | Side I | Second bogie group |
| 6 | Side II | Second bogie group |
| 7 | Side I | Second bogie group |
| 8 | Side II | Second bogie group |

There are 32 axle boxes associated with each rail side across the eight-car reference layout.

Use stable model-local coordinates. Suggested convention, explicitly a rendering convention:

- longitudinal direction = X;
- vertical = Y;
- Side I = negative Z;
- Side II = positive Z;
- reference travel arrow = negative X;
- longitudinal positions for axle pairs, relative to carriage length L: -0.38L, -0.23L, +0.23L, +0.38L.

Rotation of the camera or reversal of an illustrative animation must never swap Side I and Side II. Label the reference direction separately from measured speed/direction; the binary speed signal alone must not be presented as proof of signed travel direction.

### Exact rail channel addressing

For 1-based car ordinal `c` in [1,8] and axle-box position `p` in [1,8], the zero-based numeric column indexes are:

```ts
function railChannelIndexes(carOrdinal: number, position: number) {
  if (!Number.isInteger(carOrdinal) || carOrdinal < 1 || carOrdinal > 8) {
    throw new RangeError("Rail car ordinal must be an integer from 1 to 8");
  }
  if (!Number.isInteger(position) || position < 1 || position > 8) {
    throw new RangeError("Axle-box position must be an integer from 1 to 8");
  }
  const vibration = 1 + 2 * ((carOrdinal - 1) * 8 + (position - 1));
  return {
    vibration,
    shock: vibration + 1,
    side: position % 2 === 1 ? "Side I" as const : "Side II" as const,
  };
}
```

Examples: Car 1 / Position 1 maps to indexes 1 and 2 (human columns 2 and 3). Car 8 / Position 8 maps to indexes 127 and 128 (human columns 128 and 129). Index 0 is the rotational-speed channel.

Only apply this mapping after the parser has validated the documented schema and handled headers explicitly. Do not silently shift channels when a file contains unexpected extra columns.

---

## 4. Rail Corrugation layer

### Represent two different things separately

**Measurement layer:** axle-box markers show sensor identity and a selected recorded or calculated quantity.

**Prediction layer:** the two reference rails show the recording-level class returned by the model.

Selecting an axle box opens a small anchored callout and the evidence inspector:

```text
CAR <ordinal> · AXLE BOX <position> · <Side I / Side II>
Selected recording: <exact filename>
Cursor: <elapsed time within recording>
Vibration: <sample value> m/s²
Shock: <sample value> m/s²
Source columns: <actual columns>

Recording-level prediction: <Normal / Side I / Side II>
```

Clicking a car should reveal all eight axle-box positions. Clicking a sensor should synchronize the raw trace and any available spectral evidence. Derived RMS, peaks or spectral-band energy must be explicitly labelled as derived features, with the calculation interval and correct units. A waveform peak or RMS value is not automatically the feature that caused the model's decision.

### Class display

| Model output | Reference-rail display |
|---|---|
| Normal | `Predicted: Normal`; both rails represented as normal under the dataset's label definition. Do not declare every train component healthy. |
| Side I | Highlight reference rail Side I and show `Predicted: Side I corrugation`. Side II is normal under the selected class definition. |
| Side II | Highlight reference rail Side II and show `Predicted: Side II corrugation`. Side I is normal under the selected class definition. |

These are model predictions, not manually verified findings. Do not add a `Both sides` submitted class: it is not part of the specified three-class output.

Sensors on the predicted side may receive a matching outline to indicate membership, but do not paint them as broken bearings or independently classified defects. An optional metric-colour overlay must have its own numeric legend and remain visually distinct from the class highlight.

Highlighting a whole schematic rail denotes the predicted side for this recording, not a claim that a measured defect extends along that entire physical stretch. There is no supported station-level or GPS localisation in the supplied recording specification.

The recording class stays fixed while the user scrubs its waveform unless a separately implemented, clearly labelled windowed model actually produces time-local predictions. Never animate a file-level class as if it were new per-sample inference.

---

## 5. Structural Health layer

### Always show the scored result at file scope

For every analysed stress file, display:

```text
STRUCTURAL HEALTH · <exact filename>
Predicted cumulative fatigue damage: <model output>
Scope: this recording / stress segment
Measurement-point identity: <verified ID or not supplied>
Physical location: <verified mapping or not supplied>
```

Use appropriate numeric precision and scientific notation for small outputs. Preserve full precision in export. Display the defined damage quantity, not a percent-health conversion, failure probability, or remaining-life estimate. Do not clip values to [0,1] merely to fit a progress bar.

### Physical mapping has three states

1. **Verified location:** metadata identifies the monitored component/point and its relationship to the model. Anchor the numeric callout there, with mapping provenance accessible.
2. **Named point, no physical mapping:** display the point identifier in the structural-context inspector, but do not put it on a guessed bogie or car.
3. **No point/location metadata:** show an unlocated recording card within the 3D workspace, visually detached from specific geometry. Label it `Measurement location not supplied`.

Default to state 3 for the supplied documentation alone. Although the kit discusses carbodies and bogie frames in its background, it does not identify a particular uploaded file's physical sensor anchor.

### Multiple files

Keep a file selector with one value per file. Selection updates the trace, predicted value and verified anchor, if one exists.

Do not assign `test03.csv` to Car 03. Do not map sixteen test files to sixteen drawn bogies because their counts happen to match. Do not show all files as simultaneous sensors unless metadata establishes that relationship.

Do not sum randomly numbered files into train-wide lifetime damage, show a chronological accumulation chart based on file numbering, or interpolate a continuous red/green stress field across the body from one scalar. The kit says numbering is random and the samples represent healthy operating conditions.

A spatial damage heatmap is outside this MVP unless verified multiple-point geometry and appropriately scoped estimates become available. One label at a known measurement point is enough.

---

## 6. ACV layer

Show one car-level ACV summary per carriage. A small hovering icon above the car is a schematic anchor, not proof of a roof-mounted sensor or an identified refrigerant pipe.

After inference:

- keep the eight cars in their stable reference order;
- show a rank badge for each car;
- emphasize the highest-ranked suspect without declaring the remaining seven verified healthy;
- show `Most likely leaking car: <exact identifier>`;
- provide the complete ranking in the inspector and export.

Ranking is not a calibrated probability or measured leak rate. Do not show a pressure measurement, refrigerant level or leak location unless it is actually present and interpreted in that file's schema.

The inspector must discover available fields from each file, including setting/running modes, cooling/heating control temperatures, indoor/outdoor average temperatures, load-halved and information-valid flags where supplied. Preserve richer-case fields rather than silently dropping them because they are absent from the basic schema. Show raw code values where their meaning is undocumented.

Use a metric selector to compare one numeric field across the eight cars at a chosen timestamp. Missing data must appear as `Not recorded` or `Invalid`, not as zero. Show the time and validity state next to a displayed measurement. Do not confuse a per-timestamp field with the ranking derived from the full case.

---

## 7. Door layer

Keep the existing selectable-door interaction, but only bind a recording to a physical car/door when the actual file and verified mapping support it.

The main kit's 17-field schema does not establish the additional car/door identity fields in the separate header list. Therefore do not infer that the current hardcoded D01-D24 correspond to the actual data.

Where identity or door-side mapping is unavailable, provide a `Door stream — location unmapped` representative door inspector. Other rendered doors stay neutral/unmapped. Do not multiply the same recording across every door or infer a monitored-door count from visible geometry.

Fields accessible from the selected door/stream:

- current, voltage and back-EMF;
- opening/closing time fields;
- open/close commands;
- DCSR, DCSL, DLSR and DLSL;
- opened, locked, opening and closing states;
- door leaf position;
- timestamp and any actual identity fields.

The switch labels Left/Right refer to the door-controller switches in the header reference; do not equate them with the train's Side I/Side II rail labels.

Unit conversions must be explicit: current in mA may display in A by dividing by 1000; voltage in 10 mV units may display in V by multiplying by 0.01; 0.1-second fields convert to seconds by multiplying by 0.1. Preserve the raw value and raw unit in the inspector. Do not invent position/back-EMF units absent from metadata.

Results are tied to predicted cycles and their start/end times. No additional future-cycle verification is required before exporting a classified segment. In genuine real-data mode, synthetic healthy envelopes from the original prototype must be removed or visibly separated; use a learned envelope only when an actual fitted model provides it.

---

## 8. All recorded fields accessible, not all labels visible at once

Use three levels of disclosure:

**Overview:** eight car labels and the selected subsystem's concise result.

**Hover/selection:** a component's identity plus one to three relevant values.

**Pinned inspector:** searchable access to every available source field for that component or recording, selectable traces, units, validity, raw values and derived-feature descriptions.

For Rail, expose both channels at every axle box and the separate speed signal. For ACV, dynamically list the selected car's available columns. For Door, expose the controller fields. For SHM, expose the actual stress-file schema after inspection; do not assume it matches Door or Rail.

Keep only a few floating callouts active. Provide a `Pin field` action and a `Metric` selector, rather than drawing 128 permanent text boxes around the wheels. Charts and 2D tables are precision views linked to the 3D selection, not competing dashboards.

Each field must distinguish:

- `Recorded`: raw telemetry from the file;
- `Derived`: calculated feature such as RMS;
- `Predicted`: actual model output;
- `Metadata`: identity, mapping and acquisition context.

A missing field, an uncomputed prediction and a Normal prediction are three different UI states.

---

## 9. Provenance and state model

Every visual value must carry a source recording and scope. Use file identity together with dataset/subsystem identity to avoid collisions such as a Door `Test.csv` overwriting another subsystem's `Test.csv`.

Illustrative contracts to adapt to the existing app:

```ts
type Subsystem = "door" | "acv" | "rail" | "shm";
type RailClass = "Normal" | "Side I" | "Side II";
type ValueKind = "recorded" | "derived" | "predicted" | "metadata";

type SourceRef = {
  datasetId: string;
  subsystem: Subsystem;
  fileId: string;
  recordId?: string; // For example, a detected door cycle.
};

type PhysicalAnchor =
  | { kind: "car"; carId: string }
  | { kind: "door"; carId: string; doorId: string }
  | { kind: "axleBox"; carOrdinal: number; position: number }
  | { kind: "railSide"; side: "Side I" | "Side II" }
  | { kind: "measurementPoint"; pointId: string; meshKey: string };

type Mapping =
  | {
      status: "mapped";
      anchor: PhysicalAnchor;
      provenance: string;
      basis: "dataset-schema" | "verified-metadata";
    }
  | { status: "unmapped"; reason: string };

type DisplayField = {
  source: SourceRef;
  fieldKey: string;
  originalHeader: string;
  label: string;
  kind: ValueKind;
  scope: "sample" | "cycle" | "car-case" | "recording";
  rawUnit: string | null;
  displayUnit: string | null;
  mapping: Mapping;
};

type RailResult = {
  source: SourceRef;
  scope: "recording";
  prediction: RailClass;
};

type ShmResult = {
  source: SourceRef;
  scope: "recording";
  predictedDamage: number;
  mapping: Mapping;
};
```

`mapped` means that the logical component association is established; the drawn geometry can still be schematic. Keep that distinction visible.

Maintain selected file, time cursor, model version and prediction independently for each subsystem. Default to one active subsystem layer. Switching layers must remove the previous layer's sensor states and labels. A summary of several analysed files may exist outside the train, but it must not imply a simultaneous train-wide snapshot.

Uploaded-source mode and synthetic-demo mode must be visually separate. Never fill absent model results with demo values.

---

## 10. Visual and implementation direction

Retain the dark navy/graphite shell, metallic train material, restrained cyan accents and clean typography. Use amber for predicted anomalies/suspects, a neutral grey for unmapped or missing data, and text labels as well as colour. SHM damage magnitude is a numeric quantity, not automatically an alarm category.

Prefer component isolation and camera transitions over extra animation. No cracks, simulated deformation, smoke, exaggerated bouncing or visible leaking refrigerant unless explicitly labelled as non-data illustrative animation; they are unnecessary for this MVP.

Use the existing React Three Fiber/Three.js stack if present:

- React Three Fiber pointer handlers for component selection.
- Drei `Html` for small labels attached to scene anchors.
- Drei `Bounds`/`useBounds` for fitting eight cars and focusing a selected car.
- Shared geometry and Three.js `InstancedMesh`, or Drei `Instances`, for repeated wheels/markers where profiling justifies it.

Do not blindly upgrade dependencies. Match the installed React/R3F versions and test within the current project. HTML labels still have a DOM cost even when the geometry is instanced.

For high-frequency recordings, render traces and animated readouts at an appropriate display rate; do not attempt 10,000 React state updates per second. Display downsampling must not silently alter inference inputs. Preserve peaks appropriately in plot summaries and allow examination of raw samples.

Keep critical result text available when WebGL fails. Provide keyboard-accessible car/sensor selection through the navigator and inspector, a reduced-motion option, and readable labels on the demo laptop.

---

## 11. Suggested implementation sequence

1. Audit the existing scene generator, hardcoded car/door counts, data contracts and synthetic fixtures.
2. Implement a reusable eight-car topology and exact 64-anchor rail registry. Add mapping tests before cosmetic changes.
3. Add whole-train/car-focus navigation and the two reference rails.
4. Implement subsystem-specific source selection and layer switching.
5. Connect rail raw channels to anchors, then recording-level predictions to rail-side highlights.
6. Add ACV car rankings and dynamically discovered per-car fields.
7. Add SHM per-file numeric result cards with the default unmapped state.
8. Adapt Door to actual segment predictions and verified identity only.
9. Connect every result to existing inference and exact CSV export. Mock adapters may support development but must stay labelled.
10. Test camera usability, provenance, missing data, schema variation and rendering performance; then polish lighting and transitions.

No new chatbot, live-network map, global health score, maintenance scheduler or autonomous control feature is needed.

---

## 12. Acceptance tests

### Geometry and mapping

- ACV and Rail reference layouts contain exactly eight selectable car objects.
- Rail has exactly 64 unique axle-box anchors, 8 per car, and two separate rail-side meshes.
- Every vibration/shock channel maps exactly once; speed is not assigned to all wheels as separate sensors.
- Channel endpoint tests pass: C1/P1 -> [1,2], C8/P8 -> [127,128], using zero-based indexes.
- Odd positions are always Side I; even positions are always Side II, including after a 180-degree camera orbit.
- Car selection fits the relevant carriage; `Fit train` restores visibility of all eight without clipping.

### Prediction semantics

- A Rail Side I output highlights Side I and displays one file-level result. It does not generate 32 independent faulty-axle diagnoses.
- Normal means the selected rail-recording class, not overall train safety.
- An ACV ranking does not reorder geometry, remove leading zeros from source IDs, or label all lower-ranked cars verified healthy.
- SHM displays one numeric value per file. An unmapped file highlights no specific component.
- Random SHM filenames are not mapped to car/bogie numbers, sorted as time, or summed into lifetime damage.
- No SHM damage heatmap appears without verified spatial measurement-point data.
- Door without identity metadata does not get assigned to a hardcoded D07.

### Fields, state and provenance

- Every visible value can be traced to subsystem, dataset, filename and applicable sample/window/cycle.
- Selecting C3/P5 opens C3/P5 channels, not the nearest-looking mesh's data.
- Raw values, derived features and predictions have distinguishable labels.
- Unknown mode codes and unknown units remain explicitly unknown.
- Missing channels are grey/unknown, not zero or Normal.
- Subsystem/file switching does not retain stale labels from another source.
- Different recording durations and timestamps are not synchronized into a fictitious shared timeline.
- The full source-field inspector remains usable without placing every field on the 3D canvas.

### Export and workflow

- Selecting a subsystem, uploading actual supported input, running its model and downloading its result works without code editing.
- Door export retains start_time,end_time,prediction; ACV export retains file_id,ranked_cars; Rail and SHM retain file_id,prediction.
- Additional display metrics do not replace the scored outputs or change their granularity.
- `predictions.zip` contains only the generated prediction CSVs at its top level.
- Synthetic results never enter uploaded-data inference exports as a fallback.

---

## 13. Reference documents and verified implementation resources

### User-supplied sources

- `01_Problem_Statement_3_Specifications.md`: independent subsystem framing, compulsory app workflow, exact exports.
- `Rail_Corrugation_Info_Kit.md` §2.1 and Figure 2: eight-car layout, axle-box numbering, side correspondence, channel ordering and acquisition units; §3: recording-level three-class prediction.
- `ACV_Subsystem_Info_Kit.md` §§2-3: eight cars, variable parameter sets, exact car identifiers and ranking output.
- `Door_Subsystem_Info_Kit.md` §§2-3 plus `Door Data Headers.md`: cycle-level outputs, recorded controller fields, units and unresolved identity-schema difference.
- `SHM_Info_Kit.md` §§2-3: per-file stress segment, random numbering, healthy samples and numeric output. Its general background is not an actual sensor-coordinate manifest.

### Official software documentation

- React Three Fiber events: https://r3f.docs.pmnd.rs/tutorials/events-and-interaction
- Drei HTML labels: https://drei.docs.pmnd.rs/misc/html
- Drei Bounds: https://drei.docs.pmnd.rs/staging/bounds
- Three.js InstancedMesh: https://threejs.org/docs/pages/InstancedMesh.html
- Drei Instances: https://drei.docs.pmnd.rs/performances/instances

These resources support implementation capabilities. They do not establish train topology or dataset semantics; use the supplied subsystem kits for those.
