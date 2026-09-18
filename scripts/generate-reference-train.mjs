/**
 * RailWitness eight-car reference consist. Original schematic geometry.
 * Rebuild with `node scripts/generate-reference-train.mjs` after installing dependencies.
 * Static surfaces are merged by material; selectable doors are added by React.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

// GLTFExporter uses the browser FileReader API for its final binary assembly.
globalThis.FileReader = class {
  async readAsArrayBuffer(blob) {
    this.result = await blob.arrayBuffer();
    this.onloadend?.();
  }
  async readAsDataURL(blob) {
    this.result = `data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}`;
    this.onloadend?.();
  }
};

const palette = {
  aluminium: { color: '#afb8bd', metalness: .72, roughness: .3 },
  roof: { color: '#75818b', metalness: .72, roughness: .39 },
  frame: { color: '#293641', metalness: .7, roughness: .42 },
  window: { color: '#071723', metalness: .45, roughness: .16 },
  reflection: { color: '#345064', metalness: .7, roughness: .24 },
  livery: { color: '#d83c41', metalness: .4, roughness: .31 },
  rubber: { color: '#0e141c', metalness: .1, roughness: .78 },
  wheel: { color: '#35414a', metalness: .88, roughness: .35 },
  lamp: { color: '#d5f5ec', emissive: '#c0e4d9', emissiveIntensity: 1.1 },
  tail: { color: '#d74c48', emissive: '#a71916', emissiveIntensity: .65 },
};
const createBuckets = () => Object.fromEntries(Object.keys(palette).map(key => [key, []]));
let buckets = createBuckets();
const materials = Object.fromEntries(Object.entries(palette).map(([name, values]) => {
  const material = new THREE.MeshStandardMaterial({ ...values, side: THREE.DoubleSide });
  material.name = name;
  return [name, material];
}));
const train = new THREE.Group();
train.name = 'RailWitness_Eight_Car_Reference';
train.userData = { author: 'RailWitness project', license: 'Original project geometry; no third-party visual assets', schematic: true, carCount: 8, axleBoxesPerCar: 8, referenceTravel: '-X', sideI: '-Z', sideII: '+Z' };
function flushGeometry(group, prefix) {
  for (const [name, geometries] of Object.entries(buckets)) {
    if (!geometries.length) continue;
    const merged = mergeVertices(mergeGeometries(geometries, false));
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, materials[name]);
    mesh.name = `${prefix}_${name}`;
    mesh.userData = { role: ['wheel', 'rubber'].includes(name) ? 'running-gear' : 'shell' };
    group.add(mesh);
  }
  buckets = createBuckets();
}

const transform = new THREE.Matrix4();
function add(geometry, material, position, rotation = [0, 0, 0]) {
  transform.compose(new THREE.Vector3(...position), new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)), new THREE.Vector3(1, 1, 1));
  geometry.applyMatrix4(transform);
  // All static geometry has the same attributes before merging.
  if (geometry.index) geometry = geometry.toNonIndexed();
  geometry.deleteAttribute('uv');
  buckets[material].push(geometry);
}
function box(w, h, d, material, x, y, z, rotation) {
  add(new THREE.BoxGeometry(w, h, d), material, [x, y, z], rotation);
}
function cylinder(radius, depth, material, x, y, z, rotation = [Math.PI / 2, 0, 0], segments = 16) {
  add(new THREE.CylinderGeometry(radius, radius, depth, segments), material, [x, y, z], rotation);
}
function bodyShape() {
  const s = new THREE.Shape();
  s.moveTo(-.99, .82);
  s.lineTo(-1.12, 1.01);
  s.lineTo(-1.12, 2.71);
  s.quadraticCurveTo(-1.10, 3.00, -.87, 3.13);
  s.lineTo(.87, 3.13);
  s.quadraticCurveTo(1.10, 3.00, 1.12, 2.71);
  s.lineTo(1.12, 1.01);
  s.lineTo(.99, .82);
  s.closePath();
  return s;
}
function frontPanel(x, sign, material, bottom, top, halfBottom, halfTop) {
  const vertices = new Float32Array([
    x, bottom, -halfBottom, x, bottom, halfBottom, x + sign * .10, top, halfTop,
    x, bottom, -halfBottom, x + sign * .10, top, halfTop, x + sign * .10, top, -halfTop,
  ]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
  geo.computeVertexNormals();
  add(geo, material, [0, 0, 0]);
}

for (let car = 0; car < 8; car++) {
  const cx = 0;
  add(new THREE.ExtrudeGeometry(bodyShape(), { depth: 9, bevelEnabled: false, curveSegments: 6, steps: 1 }), 'aluminium', [cx - 4.5, 0, 0], [0, Math.PI / 2, 0]);
  box(8.80, .18, 1.82, 'roof', cx, 3.12, 0);
  box(8.75, .25, 1.93, 'frame', cx, .79, 0);
  box(7.90, .30, 1.53, 'rubber', cx, .63, 0);
  // A narrow scarlet waist stripe, original livery without operator branding.
  for (const side of [-1, 1]) {
    box(8.90, .12, .025, 'livery', cx, 1.62, side * 1.134);
    box(8.84, .028, .022, 'frame', cx, 2.85, side * 1.101);
    box(8.85, .035, .024, 'roof', cx, 1.01, side * 1.103);
    for (const wx of [-4.14, -2.075, 0, 2.075, 4.14]) {
      const width = Math.abs(wx) > 4 ? .48 : .87;
      box(width + .09, .78, .035, 'frame', cx + wx, 2.29, side * 1.132);
      box(width, .685, .045, 'window', cx + wx, 2.30, side * 1.154);
      box(width - .03, .025, .008, 'reflection', cx + wx, 2.60, side * 1.181);
      box(width - .07, .01, .008, 'reflection', cx + wx, 1.99, side * 1.181);
    }
    // Four physical double-leaf door assemblies per side. The application adds
    // individually named interaction planes over these static, merged surfaces.
    for (const dx of [-3.1, -1.05, 1.05, 3.1]) {
      box(1.075, 1.86, .035, 'frame', cx + dx, 1.94, side * 1.151);
      for (const leaf of [-1, 1]) {
        box(.496, 1.78, .035, 'aluminium', cx + dx + leaf * .258, 1.94, side * 1.178);
        box(.380, .78, .015, 'frame', cx + dx + leaf * .258, 2.30, side * 1.20);
        box(.328, .685, .019, 'window', cx + dx + leaf * .258, 2.30, side * 1.214);
        box(.30, .023, .008, 'reflection', cx + dx + leaf * .258, 2.60, side * 1.227);
        box(.493, .12, .015, 'livery', cx + dx + leaf * .258, 1.62, side * 1.201);
        box(.05, .13, .026, 'frame', cx + dx + leaf * .08, 1.77, side * 1.210);
      }
      box(1.08, .046, .10, 'roof', cx + dx, 1.008, side * 1.18);
    }
    // Tiny access panels, handrail seams and sill finish make the scale legible.
    for (const px of [-2.07, 0, 2.07]) {
      box(.55, .19, .012, 'roof', cx + px, 1.16, side * 1.13);
      box(.49, .14, .014, 'aluminium', cx + px, 1.16, side * 1.14);
    }
  }
  // Rooftop climate equipment, grills, antennae, and inset vents.
  for (const ax of [-2.25, 2.25]) {
    box(1.75, .20, 1.12, 'roof', cx + ax, 3.28, 0);
    box(1.48, .065, .93, 'frame', cx + ax, 3.415, 0);
    for (let fin = 0; fin < 11; fin++) {
      box(.033, .018, .82, 'roof', cx + ax - .64 + fin * .128, 3.457, 0);
    }
  }
  box(1.25, .085, .83, 'roof', cx, 3.255, 0);
  for (let vent = 0; vent < 7; vent++) box(.03, .011, .68, 'frame', cx - .36 + vent * .12, 3.302, 0);
  cylinder(.05, .25, 'frame', cx - 3.75, 3.36, 0, [0, 0, 0], 8);
  // Two bogies with wheel rims, axle cores, brake housings and suspension.
  for (const bx of [-2.745, 2.745]) {
    box(1.76, .31, 1.44, 'frame', cx + bx, .50, 0);
    for (const axle of [-.675, .675]) {
      cylinder(.075, 1.90, 'wheel', cx + bx + axle, .39, 0);
      for (const side of [-1, 1]) {
        cylinder(.34, .16, 'rubber', cx + bx + axle, .40, side * .90);
        cylinder(.27, .17, 'wheel', cx + bx + axle, .40, side * .91);
        cylinder(.115, .19, 'frame', cx + bx + axle, .40, side * .93);
        box(.29, .19, .12, 'roof', cx + bx + axle, .44, side * 1.04);
      }
    }
  }
// Slanted dark cab masks, divided windscreens, headlamps and couplers.
if (car === 0 || car === 7) {
  const end = car === 0 ? -1 : 1;
  const x = end * 4.508;
  const inward = -end;
  frontPanel(x, inward, 'frame', 1.65, 2.98, .96, .83);
  frontPanel(x + end * .025, inward, 'window', 1.98, 2.86, .82, .73);
  box(.05, .88, .032, 'frame', x + inward * .055, 2.42, 0, [0, 0, end * -.115]);
  box(.055, .115, 1.65, 'livery', x + end * .04, 1.72, 0);
  for (const side of [-1, 1]) {
    box(.08, .17, .34, 'frame', x, 1.32, side * .69);
    box(.085, .092, .22, end === -1 ? 'lamp' : 'tail', x + end * .046, 1.33, side * .69);
    box(.038, .022, .41, 'roof', x + end * .048, 2.085, side * .38, [end * -.1, 0, 0]);
  }
  box(.28, .23, .46, 'frame', x + end * .12, .81, 0);
  box(.12, .15, .27, 'wheel', x + end * .29, .81, 0);
}

  const carriage = new THREE.Group();
  carriage.name = `ReferenceCar${String(car + 1).padStart(2, '0')}`;
  carriage.userData = { carOrdinal: car + 1, geometry: 'schematic', axleBoxCount: 8 };
  carriage.position.x = (car - 3.5) * 9.5;
  flushGeometry(carriage, carriage.name);
  train.add(carriage);
}
// Flexible gangways and couplers between eight separately addressable cars.
for (const gap of [-28.5, -19, -9.5, 0, 9.5, 19, 28.5]) {
  box(.47, 1.82, 1.48, 'rubber', gap, 1.80, 0);
  for (let rib = 0; rib < 5; rib++) {
    const x = gap - .19 + rib * .095;
    box(.033, 1.83, 1.60, 'frame', x, 1.80, 0);
  }
  box(.68, .12, .30, 'wheel', gap, .68, 0);
}

flushGeometry(train, 'Gangway');
const exporter = new GLTFExporter();
const buffer = await exporter.parseAsync(train, { binary: true, onlyVisible: true });
const destination = path.resolve('public/models/railwitness-reference-eight.glb');
await fs.mkdir(path.dirname(destination), { recursive: true });
await fs.writeFile(destination, Buffer.from(buffer));
console.log(`Wrote original eight-car reference: ${(buffer.byteLength / 1024).toFixed(1)} KB, 8 separate car groups, 64 wheel positions.`);
