# RailWitness Dashboard — Codex Build Brief

## 1. Product Goal

Build a futuristic, visually striking maintenance dashboard for **RailWitness**, an AI-assisted Singapore MRT train-door anomaly detection and verification system.

RailWitness does **not** just flag anomalies. It follows this workflow:

**Detect → Make a timestamped prediction → Wait for unseen evidence → Verify → Recommend action**

The dashboard should make that logic immediately understandable to a judge in under 30 seconds.

---

## 2. Core User

**Primary user:** Rail maintenance engineer / fleet engineer

The user needs to answer three questions quickly:

1. **Which train door looks abnormal?**
2. **What exactly is abnormal about it?**
3. **Was the model's prediction subsequently corroborated by the next eligible movement?**

---

## 3. Dashboard Structure

### A. Hero / Fleet Overview

Main visual centerpiece:

- Large **interactive 3D Singapore MRT train model**
- Dark, premium, futuristic environment
- Train should occupy ~50–65% of the visible screen on load
- User can rotate slightly, pan minimally, and zoom
- Individual door zones should be selectable
- Healthy doors use subtle cyan/teal indicators
- Suspected anomaly door pulses amber/orange
- Corroborated high-priority anomaly pulses red
- Selected door should visually isolate/glow

Beside the train:

- Train ID
- Line / fleet
- Current health state
- Number of monitored doors
- Active advisories
- Last data update

Example:

```text
TRAIN 017
North-South Line

SYSTEM HEALTH        92%
ACTIVE ADVISORIES     1
DOORS MONITORED      24
LAST TELEMETRY       14:21:03
```

Do not clutter this area with many secondary metrics.

---

### B. Door Detail Panel

When a door is selected, open a detail panel.

Show:

- Door ID
- Current state: `NORMAL`, `CANDIDATE ANOMALY`, `CORROBORATED`, `UNCONFIRMED`
- Current anomaly score
- Current movement direction
- Current / selected cycle timestamp

Most important chart:

### Observed vs Expected Healthy Envelope

Plot:

- Actual motor-current trace
- Median expected healthy trace
- 5th–95th percentile healthy envelope
- Highlight the exact anomalous region

Example interpretation:

```text
Expected healthy current at 60–80% closure:
2.8–3.5 A

Observed:
4.2 A

Deviation:
+20% above expected upper envelope
```

The dashboard should communicate the physics of the signal, not just an opaque AI score.

---

### C. RailWitness Verification Card

This is the **signature product feature** and should be visually prominent.

When an anomaly appears:

```text
RAILWITNESS PREDICTION

Suspected pattern:
Persistent abnormal resistance during late-stage door closure

Prediction issued:
14:19:22

Expected next evidence:
Excess motor current should recur at 60–80% door travel
during the next eligible closing movement.

Verification status:
AWAITING NEXT CYCLE
```

When the next movement occurs, transition to:

```text
PREDICTION CORROBORATED

Expected signature:
Current > learned healthy envelope at 60–80% closure

Observed:
4.1 A vs expected maximum 3.5 A

Result:
Signature reproduced

Recommended action:
Inspect Door D07 under the applicable maintenance procedure.
```

Other states:

- **NOT CORROBORATED**
- **INSUFFICIENT EVIDENCE**

Important wording:

- Never say the train is “safe”
- Never claim a mechanical component is definitely faulty unless verified
- RailWitness is advisory only

---

### D. Chronological Replay / Demo Mode

Include a **Replay Mode** designed specifically for the hackathon pitch.

Controls:

- Play / pause
- Step to next cycle
- Scrub timeline
- “Hide future data” mode
- Reveal next cycle button

Desired demo flow:

1. Replay telemetry chronologically.
2. Stop when anomaly is detected.
3. Show the model’s prediction **before future data is visible**.
4. Judge clicks **Reveal Next Cycle**.
5. Animate the next waveform.
6. Show whether the prediction was corroborated.
7. Surface the final maintenance recommendation.

This is the major “wow moment”.

---

## 4. Recommended Visual Direction

### Overall style

Aim for:

**Cyber-physical control room × premium automotive HUD × railway digital twin**

Avoid:

- Generic SaaS dashboard
- Excessive cards
- Rainbow gradients everywhere
- Gamer-style neon overload
- Dense enterprise tables on the landing view

### Palette

Use a very dark navy / black base.

Suggested semantic colors:

- Background: near-black / navy
- Primary accent: electric cyan
- Secondary accent: teal
- Warning: amber
- Critical / corroborated: red
- Normal: cyan/green
- Main text: soft white
- Secondary text: desaturated blue-gray

Use glow sparingly and only around important interactive or anomaly states.

### Materials

Recommended:

- translucent glass panels
- subtle borders
- soft background blur
- faint grid / scan-line texture
- low-opacity radial gradients
- restrained bloom around train indicators

### Motion

Use subtle motion only:

- slow camera drift / idle train rotation
- pulsing anomaly markers
- waveform reveal animation
- smooth transition between doors
- short scan sweep when RailWitness performs verification

Do not animate every metric.

---

## 5. Recommended Front-End Stack

### Core framework

Recommended:

- **React**
- **TypeScript**
- **Vite** or **Next.js**
- **Tailwind CSS**
- **Framer Motion** for 2D UI transitions

### 3D stack — preferred

Use:

- `three`
- `@react-three/fiber`
- `@react-three/drei`
- `@react-three/postprocessing`

Why:

- gives full programmatic control over the MRT model
- easy to bind door meshes to application state
- easy to highlight or animate individual doors
- integrates naturally with React
- supports GLB / glTF assets
- can add bloom, environment lighting, outlines, camera control and annotations

Load MRT models as `.glb` / `.gltf`.

Three.js officially recommends glTF for runtime 3D assets because it is compact and supports meshes, materials, animation, lights and cameras.

### Optional visual prototyping tool

**Spline** is a strong option if the team wants to create or polish the 3D hero scene quickly.

Spline supports:

- interactive 3D scenes
- browser-based editing
- lights
- materials
- animation
- particles
- React / Next.js export
- JavaScript APIs for manipulating objects and listening to events

Possible workflow:

1. Create / import MRT train in Blender
2. Export `.glb`
3. Polish lighting / environment in Spline
4. Either embed Spline directly or export for React
5. Use React application state to control train highlighting

For the final technical dashboard, React Three Fiber is still preferable if individual train components need rich dynamic interaction.

---

## 6. 3D MRT Asset Strategy

### Best practical option

Do **not** spend the hackathon building a train model from scratch.

Acquire an existing legal 3D asset, simplify it, then customize it.

Potential sources found during research:

### Option A — Sketchfab Singapore MRT cabin

A downloadable Singapore MRT cabin model exists on Sketchfab under **CC Attribution**.

Pros:

- recognizable Singapore MRT context
- free
- downloadable

Cons:

- very high polygon count (~893k triangles)
- primarily a cabin model rather than necessarily the perfect exterior
- MUST be optimized before use

Workflow:

- download
- import into Blender
- decimate / retopologize aggressively
- remove unnecessary interior geometry
- separate door meshes
- export optimized `.glb`

### Option B — TurboSquid Singapore MRT train

There is a low-cost Singapore MRT train model with interior and platform doors.

Important:

- current listing states **Editorial Uses Only**
- verify the exact license before using it in a competition prototype or public submission

Do not use it blindly.

### Option C — Build a stylized MRT-inspired digital twin

If licensing becomes messy, make a **stylized MRT-inspired train**, rather than copying protected branding exactly.

This may actually fit the dashboard aesthetic better:

- recognizable Singapore rail silhouette
- clean geometry
- configurable doors
- lightweight
- fully controlled by the team
- easier to animate

Use Blender or Spline.

---

## 7. 3D Implementation Requirements

The MRT model should expose selectable door objects.

Suggested naming:

```text
Train
 ├── Car01
 │    ├── Door_L_01
 │    ├── Door_R_01
 │    ├── Door_L_02
 │    └── Door_R_02
 ├── Car02
 ...
```

App state maps each door to:

```ts
type DoorHealth = {
  id: string;
  status:
    | "normal"
    | "candidate"
    | "awaiting_verification"
    | "corroborated"
    | "not_corroborated"
    | "insufficient_evidence";
  anomalyScore: number;
  lastUpdated: string;
};
```

On hover:

- slightly increase emissive intensity
- show Door ID tooltip

On click:

- move camera toward selected door
- outline selected geometry
- open signal panel

---

## 8. 3D Effects

Use restrained effects.

Recommended:

### Environment lighting

Use `Environment` from Drei.

Create metallic / premium reflections without manually creating complex lighting.

### Bloom

Use `Bloom` from `@react-three/postprocessing`.

Apply only to:

- anomaly marker
- train edge accents
- scan line
- selected door

Do not bloom the entire scene.

### Contact shadows

Use subtle `ContactShadows` to anchor the train.

### Camera

Use:

- slight perspective
- low-angle 3/4 front view
- constrained OrbitControls

Prevent users from getting lost under / inside the model during demo.

### Optional holographic effect

Add:

- faint wireframe duplicate of the train
- low-opacity scanning plane
- animated emissive strip along selected car

Keep it subtle.

---

## 9. Charts

Recommended packages:

- **Recharts** for speed and React integration

or

- **Apache ECharts** if more control is needed

Primary waveform must support:

- observed current
- median expected current
- upper / lower quantiles
- highlighted anomaly region
- synchronized cursor
- next-cycle overlay

Do not use a generic bar chart for this signal.

---

## 10. Dashboard Pages

Keep only three top-level views.

### 1. `Overview`

Main judging/demo screen.

Contains:

- 3D MRT
- fleet/train health
- active anomaly
- RailWitness state
- compact current waveform

### 2. `Door Analysis`

Contains:

- enlarged waveform
- expected envelope
- anomaly region
- prediction
- verification evidence
- event timeline

### 3. `Replay`

Pitch/demo experience.

Contains:

- chronological replay
- hide-future-data mode
- prediction freeze
- reveal next cycle
- verification animation

Do not add more pages unless needed.

---

## 11. Suggested Screen Layout

Desktop-first.

```text
┌───────────────────────────────────────────────────────────────┐
│ RAILWITNESS        Train 017 • NSL             ● LIVE       │
├───────────────────────────────────────────────────────────────┤
│                                                               │
│        3D MRT TRAIN                    SYSTEM STATUS           │
│                                                               │
│        [ interactive ]                 Health 92%             │
│        [ train model ]                 Advisories 1           │
│                                        Doors 24               │
│                                                               │
├──────────────────────────────────────┬────────────────────────┤
│ OBSERVED VS EXPECTED                 │ RAILWITNESS            │
│                                      │                        │
│ waveform + quantile envelope         │ Prediction             │
│                                      │ Verification           │
│                                      │ Recommendation         │
├──────────────────────────────────────┴────────────────────────┤
│ ◀ 14:18       ▶ NEXT CYCLE       REVEAL FUTURE DATA          │
└───────────────────────────────────────────────────────────────┘
```

---

## 12. Demo Data Shape

Until real LTA data is available, build the UI around mocked data using an interface like:

```ts
type DoorTelemetryPoint = {
  timestamp: number;
  cycleId: string;
  doorId: string;
  direction: "open" | "close";
  travelPct: number;
  current: number;
  expectedMedian: number;
  expectedLower: number;
  expectedUpper: number;
};

type RailWitnessPrediction = {
  predictionId: string;
  issuedAt: number;
  doorId: string;
  description: string;
  targetDirection: "open" | "close";
  regionStartPct: number;
  regionEndPct: number;
  expectedCondition: string;
  status:
    | "awaiting"
    | "corroborated"
    | "not_corroborated"
    | "insufficient_evidence";
  observedEvidence?: string;
  recommendation?: string;
};
```

Build components so mocked data can later be replaced with the actual model API without redesigning the interface.

---

## 13. Suggested Component Structure

```text
src/
├── components/
│   ├── train/
│   │   ├── TrainScene.tsx
│   │   ├── MRTModel.tsx
│   │   ├── DoorMarker.tsx
│   │   ├── TrainCameraController.tsx
│   │   └── TrainEnvironment.tsx
│   │
│   ├── telemetry/
│   │   ├── SignalChart.tsx
│   │   ├── AnomalyRegion.tsx
│   │   └── CycleComparison.tsx
│   │
│   ├── railwitness/
│   │   ├── PredictionCard.tsx
│   │   ├── VerificationResult.tsx
│   │   └── RecommendationCard.tsx
│   │
│   ├── replay/
│   │   ├── ReplayTimeline.tsx
│   │   ├── RevealFutureButton.tsx
│   │   └── DemoController.tsx
│   │
│   └── ui/
│       ├── Metric.tsx
│       ├── GlassPanel.tsx
│       ├── StatusPill.tsx
│       └── Header.tsx
│
├── data/
│   └── mockTelemetry.ts
│
├── types/
│   └── railwitness.ts
│
├── pages/
│   ├── Overview.tsx
│   ├── DoorAnalysis.tsx
│   └── Replay.tsx
│
└── App.tsx
```

---

## 14. Critical UX Principles

1. **3D is functional, not decorative.**
   Clicking a door must update the actual analysis.

2. **One primary story at a time.**
   The first screen should focus on the currently selected anomaly.

3. **Show evidence, not AI theatre.**
   Never rely only on “AI confidence”.

4. **Preserve chronology.**
   The replay must clearly distinguish what the model knew before and after the next cycle.

5. **Do not overwhelm the judge.**
   The system should be understandable without reading documentation.

6. **Use the future reveal as the hero interaction.**
   This is the most memorable part of RailWitness.

---

## 15. MVP Priority

### Must have

- Working futuristic dashboard shell
- Interactive 3D train
- Selectable door
- Healthy vs anomaly visual state
- Real waveform chart
- Expected quantile envelope
- RailWitness prediction card
- Reveal-next-cycle flow
- Corroborated / uncorroborated result

### Nice to have

- Camera fly-to selected door
- Animated scanning effect
- Smooth waveform drawing animation
- Train interior view
- Multiple trains

### Do NOT prioritize

- Chatbot
- Full maintenance scheduling
- Entire Singapore rail network
- Passenger-facing UI
- Autonomous train control
- Large digital-twin simulation
- Dozens of fault categories

---

## 16. Suggested First Build Sequence for Codex

### Phase 1

Create React + TypeScript project.

Install:

```bash
npm install three @react-three/fiber @react-three/drei
npm install @react-three/postprocessing
npm install recharts
npm install framer-motion
npm install lucide-react
```

Use Tailwind if already configured.

### Phase 2

Build the static dashboard layout first.

### Phase 3

Add placeholder 3D train geometry if no MRT model is available yet.

The prototype can initially use 3 rectangular train cars with explicitly modeled door meshes.

### Phase 4

Make doors selectable and connect them to mocked health state.

### Phase 5

Implement SignalChart with:

- actual signal
- expected median
- quantile area
- anomaly highlight

### Phase 6

Implement RailWitness prediction state machine:

```text
NORMAL
  ↓
CANDIDATE
  ↓
AWAITING VERIFICATION
  ↓
┌──────────────────┐
CORROBORATED       NOT CORROBORATED
```

### Phase 7

Implement Replay mode and future-data reveal.

### Phase 8

Swap placeholder train for optimized MRT `.glb`.

### Phase 9

Add final visual polish:

- environment map
- bloom
- subtle motion
- camera transitions
- responsive resizing

---

## 17. Product One-Liner

**RailWitness turns an unexplained train-door anomaly into a testable prediction, then uses the next ordinary door movement to verify whether the issue deserves investigation.**

---

## 18. Technical Positioning

The model layer may eventually use **Quantile Gradient Boosting** to estimate context-dependent healthy signal envelopes, but the dashboard must remain model-agnostic.

The front end should accept:

- healthy envelope
- observed signal
- anomaly interval
- prediction object
- verification object

from an API.

This allows the ML team to benchmark:

- statistical thresholds
- Isolation Forest
- Quantile Gradient Boosting
- XGBoost
- Autoencoder / sequential models

without rebuilding the UI.

---

## 19. Licensing / Asset Reminder

Before submitting:

- verify the license for any 3D asset used
- retain attribution where required
- do not assume a model that is visible online is free for competition/public use
- prefer a custom or permissively licensed MRT-inspired model if rights are unclear
