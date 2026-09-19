# JagaRail branding kit

JagaRail (formerly developed under the working name RailWitness) is an independent hackathon
diagnostic tool, not an operational LTA product. This document defines the design tokens and usage
rules that back the visual design. All colour, type, spacing, radius and motion values live in
[`src/styles/tokens.css`](../src/styles/tokens.css) as CSS custom properties — components consume the
tokens (`var(--status-healthy)`, `var(--text-body-lg)`, etc.) and must not hardcode hex colours, pixel
font sizes, or ad-hoc spacing.

## Product identity

- **Name:** JagaRail — "jaga" (to watch over / guard) + "rail": watching over the line.
- **Tagline:** Evidence in Context
- **Character:** calm, precise, readable, trustworthy, engineering-focused — a premium dark inspection
  tool a judge can read at a glance, not a developer console.
- **Mark:** a shield (protection) enclosing a monitored rail line — a signal dot above two rail ties
  (`src/components/brand/Logo.tsx`, also the favicon). Original artwork; no LTA iconography.
- **Navigation rule:** the wordmark/mark always returns to the Home (Upload + Select analyses) page. It
  never deep-links into a subsystem — see `SubsystemWorkspace.tsx`'s `.ms-brand` handler.
- **Avoid:** neon accents, glass/blur effects, dense terminal-style grids, decorative animation that
  distracts from the result, pure-black backgrounds, low-contrast grey-on-grey text, and anything
  implying this is an official LTA operational system.

## Palette and semantic usage — dark engineering theme

| Token | Value | Use |
| --- | --- | --- |
| `--bg-main` | `#0F1720` | Page canvas |
| `--bg-card` | `#17212B` | Cards, panels, upload areas |
| `--bg-elevated` | `#1D2935` | Raised panels — the 3D viewport stage, its schematic fallback |
| `--bg-sunken` | `#121A22` | Recessed sub-panels inside a card (table headers, metadata rows) |
| `--brand-dark` | `#0B1220` | Sidebar / navigation only |
| `--text-primary` | `#F3F4F6` | Primary text |
| `--text-secondary` | `#C7CDD4` | Secondary text |
| `--text-muted` | `#8B96A3` | Tertiary / metadata text |
| `--status-healthy` | `#20A4A9` | Explicitly Normal conditions, primary actions, links |
| `--status-warning` | `#D08A2E` | Review states — paired with a dark ochre-tinted background and a brighter `-strong` text variant, never plain ochre text on a card |
| `--status-critical` | `#D64545` | Fault-related findings and blocking errors only |
| `--status-neutral` | `#8B96A3` | Unknown / unavailable — never rendered as healthy-green |

Each status colour ships as a trio: the base (borders/icons/fills), a `-strong` variant (brighter, for
text sitting on that colour's own dark tint — dark-mode text needs to get *lighter* than the base to
stay legible, the inverse of a light theme), and a `-tint` (a low-opacity wash of the base colour used
as a card/badge background, e.g. `--status-healthy-tint: rgba(32,164,169,.16)`).

**Colour semantics stay separated regardless of theme:**
- *Predicted condition* (e.g. Abnormal resistance, Side I) is not the same as *severity*.
- *Confidence/model score* is shown only when the model genuinely exposes one.
- *Successful processing* is a pipeline fact and is never restyled as "healthy train."
- A carriage ranking, an axle-box highlight, or an x-ray internal is never presented as a confirmed
  physical diagnosis unless the uploaded dataset/model genuinely supports that location or severity.
- Every status colour is paired with a text label and/or icon — colour is never the only signal.

## Typography

- **Headings:** Lato (`--font-heading`), 700–800 weight.
- **Body, controls, charts:** Inter (`--font-body`).
- **Technical identifiers:** IBM Plex Mono (`--font-mono`), with `font-variant-numeric: tabular-nums` on
  the shared `.mono` utility for aligned figures.

The scale sits one step below the workspace's initial redesign pass — still far above the original
~8–11px interface, comfortably readable at normal browser zoom, never used to cram more onto one screen:

| Token | Size | Use |
| --- | --- | --- |
| `--text-display` | 32–40px (clamp) | Landing page title |
| `--text-page-title` | 26–32px (clamp) | Subsystem page title |
| `--text-section` | 21–24px (clamp) | Section headings |
| `--text-card-heading` | ~19px | Card headings |
| `--text-body-lg` | 16px | Primary body / explanations |
| `--text-nav` | 15px | Sidebar navigation |
| `--text-control` / `--text-chart` | 15px | Buttons, inputs, dropdowns, chart ticks/legends/tooltips |
| `--text-meta` | 14px | Secondary metadata |
| `--text-small` | 13px | Absolute floor — nothing meaningful renders smaller |
| `--text-numeric-lg` | 32–42px (clamp) | Primary numeric result (e.g. fatigue damage) |

No component sets a raw pixel `font-size`; every rule references a token.

## Spacing, surfaces, radius, motion

Unchanged from the initial redesign: `--space-1`…`--space-16` spacing scale; `--radius-sm` 8px
(buttons/inputs), `--radius-md` 12px (cards/panels), `--radius-lg` 16px (hero surfaces); `--shadow-card`
for resting cards and `--shadow-elevated` for dialogs/toasts/the tour panel — on a dark theme these lean
on opacity and blur rather than colour to read as "lifted." Motion tokens (`--motion-fast/base/slow`,
`--motion-camera` ≈900ms) collapse to `0ms` under `prefers-reduced-motion: reduce`, and components also
read the in-app "Reduce motion" toggle to skip camera sweeps, passenger-door animation and looping scans.

## Buttons, forms, status badges

- Primary button: `--status-healthy` fill, white text, `--radius-sm`.
- Secondary button: `--bg-card` fill, `--border-default` border, `--text-primary`.
- Inputs/selects: `--bg-card` fill, `--border-default` border, `--text-control` size, visible `<label>`
  text. `color-scheme: dark` is set on `:root` so native controls (scrollbars, `<select>` popups,
  checkboxes) render dark by default.
- Status badges (`.ms-kind`) use a tinted dark background + border + label, e.g. `predicted` (ochre
  tint), `derived` (violet tint), `metadata` (neutral tint) — kind is always spelled out, never
  colour-only.

## Charts

Observed signal = solid teal line; derived/reference bands = a lighter violet (`#B9A6F0`/`#C2AEF2`),
dashed, tuned specifically for legibility on the dark card background; predicted/selected segment =
ochre. Each subsystem keeps its own independent time/sample cursor; the four datasets are never merged
onto a shared timeline.

## The 3D reference viewport

The viewport itself uses `--bg-elevated` (lighter than the page, distinct from the surrounding card) so
it reads as a raised inspection panel, while the fog/floor inside stay near-black for depth — a deliberate
"looking into an instrument" contrast against the flatter dark UI chrome around it.

**Rail Corrugation:** the two reference rails are drawn substantially larger (from a thin `0.10 × 0.08`
strip to a `0.46 × 0.34–0.42` box) and the camera drops to a low, close, near-rail elevation with a
tighter vertical fit window — the rails become the dominant visual subject while enough of the lower
carriage body stays in frame for context. Manual rotate/zoom resume immediately once the auto-frame
settles; `OrbitControls`' own polar-angle clamp was checked against the new low elevation so it never
fights the camera tween.

**Structural Health (x-ray):** `StructuralInternals` adds schematic bogies, axle/wheel assemblies and
longitudinal chassis beams under each car, visible through the always-translucent SHM shell. This is
explicitly labelled illustrative scaffolding (`userData.engineeringAccuracy = false`, and the scene
caption reads "X-ray internals are illustrative scaffolding, not verified engineering geometry") — no
component here is ever marked as the actual damaged part unless the uploaded SHM data/model genuinely
maps to one, which it currently does not (SHM produces one file-level number, no location).

**ACV carriage interior:** the model's own ranking (`result.rankedCars`) decides which carriage opens and
which face shows — a red/uncomfortable face only for the single rank-1 (suspected) carriage, a
green/comfortable face otherwise. The face is a small inline SVG (a circle plus eyes/mouth, coloured with
`--status-healthy`/`--status-critical`) rendered as a camera-facing HTML overlay anchored inside the opened
carriage, in front of a dark recess backdrop, alongside procedural sliding door leaves. The data flow is
one-directional and enforced by the component's own props: `AcvCarriageInterior` receives `rank` computed
from the already-finished model output; nothing in the face-rendering path can write back to that ranking.
UI copy says "Face colour reflects the predicted ACV condition" — never that passengers "detected" or
"measured" anything. No character artwork or photography is used, by design — avoids any third-party
character/likeness or IP concern.

## Logo assets

- `src/components/brand/Logo.tsx` exports `LogoMark` (the shield + rail mark) and `Wordmark` (mark +
  "JagaRail" + optional tagline), reused in the sidebar and the landing page.

## Asset checklist

**Not supplied / not used:**
- No official LTA logo/brand asset was supplied or used; JagaRail's own mark is the only logo in the
  product.
- No passenger character artwork is used. An earlier pass used two supplied character-group PNGs, then a
  pair of frame grabs from a copyrighted children's TV franchise were proposed as a replacement and
  declined over IP/trademark risk; the carriage interior now uses a simple original SVG face (green/red,
  matching the app's own status colours) instead, with no third-party imagery at all.

**Optional polish (not implemented, non-blocking):**
- A dedicated favicon/social-preview raster fallback beyond the current SVG favicon.
- Real separate door meshes on the reference 3D model (Doors and ACV both use procedural overlay panels
  layered on the existing car shell).
