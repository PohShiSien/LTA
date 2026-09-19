# Eight-car reference geometry

`railwitness-reference-eight.glb` is the active multi-subsystem reference asset.
It contains original procedural geometry, supplied as a ready-to-load asset.
The app uses this GLB directly; no geometry-generation step is required.

It contains eight distinct carriage groups (`ReferenceCar01`–`ReferenceCar08`),
each with two schematic bogies, four axle lines and eight wheel positions.
All cars retain the same proportions; an earlier three-car asset is not stretched.
Car bodies, cabs, dimensions and roof equipment are schematic rather than a
manufacturer-verified model. No operator, operating line or physical consist
identity is established by this asset.

The wheel-pair X offsets are −0.38L, −0.23L, +0.23L and +0.38L, matching the
reference grouping in Rail Corrugation Info Kit §2.1 / Figure 2. These offsets
are a drawing convention; the documented identities are car ordinals 1–8 and
axle-box positions 1–8. Odd positions are Side I (model-local negative Z), even
positions are Side II (positive Z), and the reference arrow points negative X.
The runtime adds 64 named sensor anchors and two separately addressable rails.
The exact 128-channel indexing, with rotational speed separately at index 0,
lives in `src/lib/topology.ts` and is covered by `tests/topology.test.ts`.

There are no third-party meshes, downloaded textures, operator logos, remote HDR
maps or external buffer dependencies in this asset. Materials and lighting are
created locally. The source figure is used to interpret topology; its image is
not redistributed in the application.

Car ordering for ACV is a stable, labelled schematic order of the exact IDs in
a case file. Door and SHM streams are unlocated
by default; the reference geometry does not establish their physical mapping.
