# RailWitness original MRT-inspired exterior

`railwitness-mrt.glb` is an original procedural model authored for this project.
It contains no downloaded meshes, images, operator logos, or other third-party
visual assets. It is a stylized metro exterior rather than an engineering model
of a specific fleet. The red stripe is an original generic livery treatment.

Regenerate it from the project root:

```sh
node scripts/generate-train.mjs
```

The generator merges static geometry into ten material groups. The React scene
adds 24 independently selectable door zones with semantic health indicators.
Cars are numbered front to rear; doors 01–04 on each car face away from the
initial camera, and doors 05–08 face toward it. D07 is initially visible.

Runtime environment lighting is generated locally with Three.js geometry.
No remote HDR maps, textures, font assets, or model services are needed.
