import { Component, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { ContactShadows, Environment, Html, Lightformer, Line, OrbitControls, useGLTF } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import * as THREE from 'three';
import type { AnalysisResult, ComponentSelection, Mapping, SourceRef, Subsystem } from '../../types/multisystem';
import type { SubsystemVisualState } from '../../types/visualization';
import { CAR_COUNT, CAR_LENGTH, CAR_PITCH, RAIL_AXLE_BOXES, RAIL_SIDES, TRAIN_LENGTH, carCenterX, referenceCarIds, selectedCarOrdinal, type AxleBoxAnchor, type RailSide } from '../../lib/topology';
import { REPRESENTATIVE_DOOR, completedDoorAbnormal, doorOpeningFraction, rankEmphasis, scanCarOrdinal, unitProgress } from './subsystemVisuals';
import './ReferenceTrainScene.css';

export interface ReferenceTrainSceneProps {
  subsystem: Subsystem;
  carIds: string[];
  selection: ComponentSelection;
  onSelect: (selection: ComponentSelection) => void;
  result: AnalysisResult | null;
  mapping: Mapping;
  xray: boolean;
  reducedMotion: boolean;
  fitKey: number;
  source?: SourceRef | null;
  cursorLabel?: string;
  sensorReadout?: { vibration: number | null; shock: number | null };
  visualization?: SubsystemVisualState;
}

const CYAN = '#2FD9C6';
const AMBER = '#F2A950';
const MUTED = '#7B8892';
const NO_RAYCAST = () => {};
const MODEL_URL = `${import.meta.env.BASE_URL}models/railwitness-reference-eight.glb`;

class ReferenceBoundary extends Component<{ children: ReactNode; fallback: ReactNode; onError: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onError(); }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

function supportsWebGL() {
  if (typeof document === 'undefined') return false;
  try {
    const context = document.createElement('canvas').getContext('webgl2');
    if (!context) return false;
    context.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch { return false; }
}

function scopedResult(props: ReferenceTrainSceneProps) {
  const result = props.result;
  if (!result || result.subsystem !== props.subsystem || props.source === null) return null;
  if (props.source && (props.source.fileId !== result.source.fileId || props.source.datasetId !== result.source.datasetId || props.source.subsystem !== result.source.subsystem)) return null;
  return result;
}

function resultLabel(result: AnalysisResult | null) {
  if (!result) return 'Prediction not computed';
  if (result.subsystem === 'rail') return result.prediction === 'Normal' ? 'Predicted: Normal · recording class' : `Predicted: ${result.prediction} corrugation`;
  if (result.subsystem === 'acv') return `Highest-ranked suspected carriage: ${result.rankedCars[0] ?? 'Not supplied'}`;
  if (result.subsystem === 'shm') return `Predicted cumulative fatigue damage: ${formatDamage(result.predictedDamage)}`;
  return `${result.segments.length} predicted door cycles`;
}

function formatDamage(value: number) {
  if (!Number.isFinite(value)) return 'Not available';
  return value !== 0 && (Math.abs(value) < .001 || Math.abs(value) >= 1e5) ? value.toExponential(4) : value.toPrecision(5);
}

function formatSample(value: number | null | undefined) {
  return value === null || value === undefined || !Number.isFinite(value) ? 'Not recorded' : `${value.toLocaleString('en', { maximumFractionDigits: 4 })} m/s²`;
}

function RailCallout({ anchor, source, result, cursorLabel, sensorReadout }: {
  anchor: AxleBoxAnchor;
  source?: SourceRef | null;
  result: AnalysisResult | null;
  cursorLabel?: string;
  sensorReadout?: ReferenceTrainSceneProps['sensorReadout'];
}) {
  return <div className="reference-callout reference-callout--rail">
    <div className="reference-callout__eyebrow">RECORDED CHANNELS</div>
    <strong>Car {anchor.carOrdinal} · Axle box {anchor.position}</strong>
    <span className="reference-callout__side">{anchor.side}</span>
    <div className="reference-callout__source" title={source?.fileName}>{source?.fileName ?? 'Select a recording'}</div>
    <dl>
      <div><dt>Cursor</dt><dd>{cursorLabel ?? 'Not selected'}</dd></div>
      <div><dt>Vibration</dt><dd>{formatSample(sensorReadout?.vibration)}</dd></div>
      <div><dt>Shock</dt><dd>{formatSample(sensorReadout?.shock)}</dd></div>
      <div><dt>Source columns</dt><dd>{anchor.vibrationIndex + 1}, {anchor.shockIndex + 1}</dd></div>
    </dl>
    <div className="reference-callout__prediction">{resultLabel(result)}</div>
  </div>;
}

function AxleBoxLayer({ selectedOrdinal, selection, onSelect, result, source, cursorLabel, sensorReadout, xray, visualization, reducedMotion }: {
  selectedOrdinal: number | null;
  xray: boolean;
  selection: ComponentSelection;
  onSelect: ReferenceTrainSceneProps['onSelect'];
  result: AnalysisResult | null;
  source?: SourceRef | null;
  cursorLabel?: string;
  sensorReadout?: ReferenceTrainSceneProps['sensorReadout'];
  visualization?: SubsystemVisualState;
  reducedMotion: boolean;
}) {
  const group = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    if (!group.current) return;
    const scanning = visualization?.analysisPhase === 'scanning' && !reducedMotion;
    const sweep = -TRAIN_LENGTH / 2 + unitProgress(visualization?.scanProgress ?? 0) * TRAIN_LENGTH;
    for (const node of group.current.children) {
      const active = scanning && Math.abs(node.position.x - sweep) < 8;
      const sphere = node.children[0] as THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
      sphere.scale.setScalar(active ? 1.15 + .3 * Math.sin(clock.elapsedTime * 8) : 1);
      sphere.material.opacity = active || node.userData.carOrdinal === selectedOrdinal ? 1 : .53;
    }
  });
  const railClass = result?.subsystem === 'rail' ? result.prediction : null;
  return <group ref={group} name="RailAxleBoxRegistry" userData={{ anchorCount: 64, channelCount: 128, rotationalSpeedColumn: 0 }}>
    {RAIL_AXLE_BOXES.map(anchor => {
      const visible = selectedOrdinal === anchor.carOrdinal;
      const selected = selection.kind === 'axleBox' && selection.carOrdinal === anchor.carOrdinal && selection.position === anchor.position;
      const member = railClass === anchor.side;
      return <group key={anchor.id} name={`AxleBox_C${anchor.carOrdinal}_P${anchor.position}`} position={[...anchor.worldPosition]}
        userData={{ carOrdinal: anchor.carOrdinal, position: anchor.position, side: anchor.side, vibrationIndex: anchor.vibrationIndex, shockIndex: anchor.shockIndex }}>
        <>
          <mesh renderOrder={xray ? 10 : 0} onClick={(event: ThreeEvent<MouseEvent>) => { event.stopPropagation(); onSelect({ kind: 'axleBox', carOrdinal: anchor.carOrdinal, position: anchor.position }); }}
            onPointerOver={(event: ThreeEvent<PointerEvent>) => { event.stopPropagation(); document.body.style.cursor = 'pointer'; }} onPointerOut={() => { document.body.style.cursor = ''; }}>
            <sphereGeometry args={[selected ? .18 : visible ? .125 : .095, 12, 8]} />
            <meshBasicMaterial color={source ? CYAN : MUTED} toneMapped={false} transparent opacity={visible ? 1 : .53} depthTest={!xray} depthWrite={false} />
          </mesh>
          {(selected || member) && <mesh rotation={[Math.PI / 2, 0, 0]} raycast={NO_RAYCAST}>
            <torusGeometry args={[selected ? .25 : .205, .022, 6, 20]} />
            <meshBasicMaterial color={member ? AMBER : CYAN} transparent opacity={.85} toneMapped={false} />
          </mesh>}
          {visible && <Html center position={[0, -.39, anchor.side === 'Side I' ? -.22 : .22]} zIndexRange={[20, 0]}>
            <button className={`reference-sensor-label${selected ? ' is-selected' : ''}${member ? ' is-side-member' : ''}`}
              aria-label={`Select car ${anchor.carOrdinal} axle box ${anchor.position}, ${anchor.side}`} aria-pressed={selected}
              title={`Car ${anchor.carOrdinal} / Position ${anchor.position} / ${anchor.side}${member ? ' · Member of predicted rail side; not an axle diagnosis' : ''}`}
              onClick={() => onSelect({ kind: 'axleBox', carOrdinal: anchor.carOrdinal, position: anchor.position })}>P{anchor.position}</button>
          </Html>}
          {/* Nudge the callout toward the train centre for the outermost cars so it stays inside the viewport. */}
          {selected && <Html center position={[anchor.carOrdinal <= 2 ? 1.6 : anchor.carOrdinal >= 7 ? -1.6 : 0, 1.8, anchor.side === 'Side I' ? -1.25 : 1.25]} zIndexRange={[25, 0]} style={{ pointerEvents: 'none' }}>
            <RailCallout anchor={anchor} source={source} result={result} cursorLabel={cursorLabel} sensorReadout={sensorReadout} />
          </Html>}
        </>
      </group>;
    })}
  </group>;
}

function resolveDoor(mapping: Mapping, ids: string[]) {
  if (mapping.status !== 'mapped' || mapping.basis !== 'verified-metadata' || mapping.anchor.kind !== 'door') return null;
  const ordinal = ids.indexOf(mapping.anchor.carId) + 1;
  // Only an explicit, verified reference-door key resolves a physical handle.
  // Numeric controller door IDs and Left/Right switch fields do not supply a side.
  const referenceKey = /^([LR])([1-4])$/.exec(mapping.anchor.doorId);
  if (!ordinal || !referenceKey) return null;
  return { ordinal, carId: mapping.anchor.carId, doorId: mapping.anchor.doorId, side: referenceKey[1] === 'L' ? -1 : 1, x: [-3.1, -1.05, 1.05, 3.1][Number(referenceKey[2]) - 1] };
}

function MappedDoor({ mapping, ids, onSelect }: { mapping: Mapping; ids: string[]; onSelect: ReferenceTrainSceneProps['onSelect'] }) {
  const door = resolveDoor(mapping, ids);
  if (!door) return null;
  return <group name={`VerifiedDoor_${door.carId}_${door.doorId}`} position={[carCenterX(door.ordinal) + door.x, 1.94, door.side * 1.26]} rotation={[0, door.side < 0 ? Math.PI : 0, 0]}>
    <mesh onClick={(event: ThreeEvent<MouseEvent>) => { event.stopPropagation(); onSelect({ kind: 'door', carId: door.carId, doorId: door.doorId }); }}>
      <planeGeometry args={[1.10, 1.89]} />
      <meshBasicMaterial color={CYAN} transparent opacity={.18} side={THREE.DoubleSide} depthWrite={false} />
    </mesh>
    <Html center position={[0, 1.65, .1]} zIndexRange={[22, 0]}>
      <button className="reference-car-label is-selected" title={mapping.status === 'mapped' ? mapping.provenance : ''} onClick={() => onSelect({ kind: 'door', carId: door.carId, doorId: door.doorId })}>Door {door.doorId} · mapped</button>
    </Html>
  </group>;
}

function IllustrativeDoor({ visualization, reducedMotion }: Pick<ReferenceTrainSceneProps, 'visualization' | 'reducedMotion'>) {
  const left = useRef<THREE.Group>(null);
  const right = useRef<THREE.Group>(null);
  const outline = useRef<THREE.MeshBasicMaterial>(null);
  const door = visualization?.door;
  const abnormal = completedDoorAbnormal(door);
  useFrame(({ clock }) => {
    const opening = doorOpeningFraction(door, reducedMotion) * .47;
    if (left.current) left.current.position.x = -.258 - opening;
    if (right.current) right.current.position.x = .258 + opening;
    if (outline.current) outline.current.opacity = abnormal && !reducedMotion ? .65 + .2 * Math.sin(clock.elapsedTime * 4) : .78;
  });
  return <group name="IllustrativeDoorMotion" position={[carCenterX(REPRESENTATIVE_DOOR.carOrdinal) + REPRESENTATIVE_DOOR.localX, REPRESENTATIVE_DOOR.y, REPRESENTATIVE_DOOR.z]}
    userData={{ illustrative: true, physicalDoorId: null, cycleNumber: door?.cycleNumber ?? null }}>
    {/* The opaque opening covers merged static leaves without changing the reference asset. */}
    <mesh raycast={NO_RAYCAST}><boxGeometry args={[1.12, 1.87, .035]} /><meshBasicMaterial color="#05121b" /></mesh>
    <mesh position={[0, 0, .025]} raycast={NO_RAYCAST}>
      <boxGeometry args={[1.17, 1.94, .025]} /><meshBasicMaterial ref={outline} color={abnormal ? AMBER : CYAN} wireframe transparent toneMapped={false} />
    </mesh>
    {([-1, 1] as const).map(side => <group key={side} ref={side < 0 ? left : right} position={[side * .258, 0, .075]}>
      <mesh raycast={NO_RAYCAST}><boxGeometry args={[.50, 1.81, .045]} /><meshStandardMaterial color="#9aadb5" metalness={.65} roughness={.3} emissive={abnormal ? AMBER : CYAN} emissiveIntensity={door?.completed ? .16 : .05} /></mesh>
      <mesh position={[0, .36, .033]} raycast={NO_RAYCAST}><boxGeometry args={[.34, .68, .018]} /><meshStandardMaterial color="#092130" metalness={.5} roughness={.22} /></mesh>
      <mesh position={[0, -.32, .037]} raycast={NO_RAYCAST}><boxGeometry args={[.49, .09, .01]} /><meshBasicMaterial color={abnormal ? AMBER : CYAN} toneMapped={false} /></mesh>
      <mesh position={[-side * .15, -.12, .044]} raycast={NO_RAYCAST}><boxGeometry args={[.03, .16, .02]} /><meshStandardMaterial color="#d6e5e8" metalness={.8} roughness={.2} /></mesh>
    </group>)}
    {door && <Html center position={[0, 1.4, .25]} zIndexRange={[18, 0]} style={{ pointerEvents: 'none' }}><div className={`reference-door-label${abnormal ? ' is-abnormal' : ''}`}>
      <span>ILLUSTRATIVE DOOR MOTION</span><strong>Cycle {door.cycleNumber} · {door.operation === 'Unknown' ? 'Movement unavailable' : door.operation}</strong>
      <small>{door.completed ? abnormal ? 'Classified as abnormal resistance' : 'Classified as Normal' : 'Recorded movement in progress'}</small>
    </div></Html>}
  </group>;
}

/**
 * Illustrative carriage-interior reveal for ACV. The train model has no separate door meshes, so a
 * procedural sliding panel overlays the existing car shell; the face shown behind it is chosen AFTER
 * the fact from the model's own ranking (rank === 1 => red/uncomfortable face, otherwise green/comfortable).
 * The face never feeds back into `rank` and is not itself evidence — it only restates what the uploaded
 * dataset and model already produced.
 */
function AcvCarriageInterior({ ordinal, rank, reducedMotion }: { ordinal: number; rank: number; reducedMotion: boolean }) {
  const left = useRef<THREE.Group>(null);
  const right = useRef<THREE.Group>(null);
  const mountTime = useRef<number | null>(null);
  useFrame(({ clock }) => {
    if (mountTime.current === null) mountTime.current = clock.elapsedTime;
    const elapsed = clock.elapsedTime - mountTime.current;
    const openness = reducedMotion ? 1 : unitProgress(elapsed / 0.9);
    const slide = openness * 0.7;
    if (left.current) left.current.position.x = -0.34 - slide;
    if (right.current) right.current.position.x = 0.34 + slide;
  });
  const suspected = rank === 1;
  const tint = suspected ? AMBER : CYAN;
  return <group name={`AcvCarriageInterior_C${ordinal}`} position={[carCenterX(ordinal), 0, 1.34]} userData={{ illustrative: true, passengerData: false }}>
    {/* The face floats in the open air just outside the doorway (z well in front of the doors and the
        car shell) rather than being tucked behind the sliding leaves. A recessed placement kept getting
        clipped by the shell/doors from one angle or another; floating it clear of all other geometry is
        what actually keeps it visible and un-occluded from every camera angle. */}
    <Html center position={[0, 2.75, .95]} zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
      <div className={`reference-passenger-face ${suspected ? 'is-alert' : 'is-ok'}`} aria-hidden="true">
        <svg viewBox="0 0 100 100" width="88" height="88">
          <circle cx="50" cy="50" r="46" className="face" />
          <circle cx="34" cy="42" r="6" className="eye" /><circle cx="66" cy="42" r="6" className="eye" />
          {suspected ? <path d="M30 68 Q50 52 70 68" className="mouth" /> : <path d="M30 60 Q50 80 70 60" className="mouth" />}
        </svg>
      </div>
    </Html>
    <mesh position={[0, 1.85, -.3]} raycast={NO_RAYCAST}><boxGeometry args={[3.4, 2.35, .5]} /><meshStandardMaterial color="#122029" roughness={.9} side={THREE.DoubleSide} /></mesh>
    <group ref={left} position={[-.34, 1.9, .15]}><mesh raycast={NO_RAYCAST}><boxGeometry args={[.64, 2.3, .09]} /><meshStandardMaterial color="#233241" metalness={.35} roughness={.5} emissive={tint} emissiveIntensity={.16} side={THREE.DoubleSide} /></mesh></group>
    <group ref={right} position={[.34, 1.9, .15]}><mesh raycast={NO_RAYCAST}><boxGeometry args={[.64, 2.3, .09]} /><meshStandardMaterial color="#233241" metalness={.35} roughness={.5} emissive={tint} emissiveIntensity={.16} side={THREE.DoubleSide} /></mesh></group>
    <Html center position={[0, 4.6, .95]} zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
      <div className="reference-passenger-note"><strong>{rank ? `Ranked #${rank} of 8` : 'Not ranked'}</strong>Face colour reflects the predicted ACV condition — not observed occupancy data</div>
    </Html>
  </group>;
}

function AnalysisSweep({ visualization, reducedMotion }: Pick<ReferenceTrainSceneProps, 'visualization' | 'reducedMotion'>) {
  if (reducedMotion || visualization?.analysisPhase !== 'scanning') return null;
  const x = -TRAIN_LENGTH / 2 + unitProgress(visualization.scanProgress) * TRAIN_LENGTH;
  return <group name="AnalysisProgressSweep" position={[x, 1.7, 0]} userData={{ illustrative: true }}>
    <mesh rotation={[0, Math.PI / 2, 0]} raycast={NO_RAYCAST}><planeGeometry args={[3.8, 3.5]} /><meshBasicMaterial color={CYAN} transparent opacity={.10} side={THREE.DoubleSide} depthWrite={false} toneMapped={false} /></mesh>
    <Line points={[[0,-1.55,-1.8],[0,1.75,-1.8],[0,1.75,1.8],[0,-1.55,1.8]]} color={CYAN} transparent opacity={.65} lineWidth={1.5} raycast={NO_RAYCAST} />
  </group>;
}

/**
 * Lightweight schematic mechanical detail (bogies, axles, wheels, chassis beams) revealed through the
 * translucent shell in Structural Health's x-ray view. The reference model itself has no internal
 * geometry, so this is explanatory scaffolding, not a verified engineering structure or a damage map:
 * the SHM prediction never highlights a component here unless the uploaded data genuinely maps to one.
 */
function StructuralInternals() {
  const bogieOffset = CAR_LENGTH * .29;
  return <group name="StructuralInternalsSchematic" userData={{ illustrative: true, schematic: true, engineeringAccuracy: false }}>
    {Array.from({ length: CAR_COUNT }, (_, index) => index + 1).map(ordinal => {
      const cx = carCenterX(ordinal);
      return <group key={ordinal} name={`SchematicUndercarriage_C${ordinal}`}>
        {[-bogieOffset, bogieOffset].map((bx, bi) => <group key={bi} position={[cx + bx, .58, 0]}>
          <mesh raycast={NO_RAYCAST}><boxGeometry args={[1.55, .2, 1.95]} /><meshStandardMaterial color="#4C6070" emissive={CYAN} emissiveIntensity={.06} metalness={.6} roughness={.4} transparent opacity={.92} /></mesh>
          <mesh position={[0, .16, 0]} raycast={NO_RAYCAST}><boxGeometry args={[.5, .22, .5]} /><meshStandardMaterial color="#5E7488" emissive={CYAN} emissiveIntensity={.08} metalness={.65} roughness={.35} transparent opacity={.92} /></mesh>
          {[-.55, .55].map((ax, ai) => <group key={ai} position={[ax, -.16, 0]}>
            <mesh rotation={[0, 0, Math.PI / 2]} raycast={NO_RAYCAST}><cylinderGeometry args={[.065, .065, 1.95, 10]} /><meshStandardMaterial color="#B4C0C9" metalness={.8} roughness={.3} /></mesh>
            {[-1, 1].map(side => <mesh key={side} position={[0, 0, side * .97]} rotation={[0, 0, Math.PI / 2]} raycast={NO_RAYCAST}><cylinderGeometry args={[.42, .42, .16, 16]} /><meshStandardMaterial color="#39495A" emissive={CYAN} emissiveIntensity={.1} metalness={.5} roughness={.5} /></mesh>)}
          </group>)}
        </group>)}
      </group>;
    })}
    {[-1.15, 1.15].map(z => <mesh key={z} position={[0, .74, z]} raycast={NO_RAYCAST}><boxGeometry args={[TRAIN_LENGTH + 2, .16, .13]} /><meshStandardMaterial color="#6F8598" emissive={CYAN} emissiveIntensity={.07} metalness={.55} roughness={.4} transparent opacity={.88} /></mesh>)}
    {Array.from({ length: CAR_COUNT + 1 }, (_, index) => -TRAIN_LENGTH / 2 + index * CAR_PITCH).map(x => <mesh key={x} position={[x, .95, 0]} raycast={NO_RAYCAST}><boxGeometry args={[.12, .55, 2.3]} /><meshStandardMaterial color="#5E7488" emissive={CYAN} emissiveIntensity={.06} metalness={.5} roughness={.45} transparent opacity={.8} /></mesh>)}
  </group>;
}

function VerifiedMeasurementPoint({ mapping, result, onSelect }: { mapping: Mapping; result: AnalysisResult | null; onSelect: ReferenceTrainSceneProps['onSelect'] }) {
  const { scene } = useGLTF(MODEL_URL);
  const point = useMemo(() => {
    if (mapping.status !== 'mapped' || mapping.basis !== 'verified-metadata' || mapping.anchor.kind !== 'measurementPoint') return null;
    const mesh = scene.getObjectByName(mapping.anchor.meshKey);
    if (!mesh) return null;
    scene.updateMatrixWorld(true);
    return { position: new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3()), pointId: mapping.anchor.pointId, provenance: mapping.provenance };
  }, [scene, mapping]);
  if (!point) return null;
  return <group name={`VerifiedMeasurementPoint_${point.pointId}`} position={point.position}>
    <mesh onClick={(event: ThreeEvent<MouseEvent>) => { event.stopPropagation(); onSelect({ kind: 'recording' }); }}><sphereGeometry args={[.14, 12, 8]} /><meshBasicMaterial color={CYAN} /></mesh>
    <Html center position={[0, 1.15, 0]} zIndexRange={[22, 0]}><button className="reference-point-label" title={point.provenance} onClick={() => onSelect({ kind: 'recording' })}><span>Verified point · {point.pointId}</span><strong>{result?.subsystem === 'shm' ? formatDamage(result.predictedDamage) : 'Not analysed'}</strong></button></Html>
  </group>;
}

function ReferenceGeometry({ ids, subsystem, selectedOrdinal, onSelect, result, xray, onReady, visualization, reducedMotion }: {
  ids: string[]; subsystem: Subsystem; selectedOrdinal: number | null; onSelect: ReferenceTrainSceneProps['onSelect']; result: AnalysisResult | null; xray: boolean; onReady: () => void;
  visualization?: SubsystemVisualState; reducedMotion: boolean;
}) {
  const { scene } = useGLTF(MODEL_URL);
  const frames = useRef(0);
  const [hoveredCar, setHoveredCar] = useState<number | null>(null);
  const model = useMemo(() => {
    const clone = scene.clone(true);
    clone.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      object.material = Array.isArray(object.material) ? object.material.map(material => material.clone()) : object.material.clone();
      object.castShadow = true;
      object.receiveShadow = true;
    });
    const root = clone.getObjectByName('RailWitness_Eight_Car_Reference')!;
    return { root, cars: root.children.filter(object => Number.isInteger(object.userData.carOrdinal)), links: root.children.filter(object => !Number.isInteger(object.userData.carOrdinal)) };
  }, [scene]);
  useEffect(() => {
    for (const car of [...model.cars, ...model.links]) {
      car.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return;
        const shell = object.userData.role === 'shell';
        const material = object.material as THREE.MeshStandardMaterial;
        // Structural Health's x-ray is now toggle-able like every other subsystem: opaque by default, translucent (with internals) only when X-ray is checked.
        const ghost = subsystem === 'shm' ? xray : (xray && shell);
        material.transparent = ghost;
        material.opacity = ghost ? subsystem === 'shm' ? shell ? .17 : .25 : .13 : 1;
        material.depthWrite = !ghost;
        material.needsUpdate = true;
        object.castShadow = !ghost;
        // Transparent shells do not swallow sensor events; labels remain selectable.
        object.raycast = xray || subsystem === 'shm' || subsystem === 'door' ? NO_RAYCAST : THREE.Mesh.prototype.raycast;
      });
    }
  }, [model, xray, subsystem]);
  useEffect(() => () => {
    document.body.style.cursor = '';
    [...model.cars, ...model.links].forEach(part => part.traverse(object => {
      if (object instanceof THREE.Mesh) {
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach(material => material.dispose());
      }
    }));
  }, [model]);
  const glow = useMemo(() => new THREE.Color(CYAN), []);
  useFrame((_, delta) => {
    if (++frames.current === 2) onReady();
    const scanningCar = reducedMotion ? 0 : scanCarOrdinal(visualization);
    for (const car of model.cars) {
      const ordinal = car.userData.carOrdinal as number;
      const rank = result?.subsystem === 'acv' ? result.rankedCars.indexOf(ids[ordinal - 1]) + 1 : 0;
      const stress = subsystem === 'shm' && visualization?.stress;
      const intensity = stress ? .1 + (reducedMotion ? 0 : unitProgress(stress.amplitude) * .42) : rankEmphasis(rank) || (scanningCar === ordinal ? .4 : 0);
      glow.set(rank > 0 && rank <= 3 ? AMBER : CYAN);
      car.traverse(object => {
        if (!(object instanceof THREE.Mesh) || object.userData.role !== 'shell') return;
        const material = object.material as THREE.MeshStandardMaterial;
        if (material.name === 'lamp' || material.name === 'tail') return;
        material.emissive.lerp(glow, reducedMotion ? 1 : Math.min(1, delta * 6));
        material.emissiveIntensity = THREE.MathUtils.damp(material.emissiveIntensity, intensity, reducedMotion ? 1000 : 7, delta);
      });
    }
  });
  return <group name="EightCarReferenceConsist" userData={{ carCount: CAR_COUNT, schematic: true }}>
    {model.cars.map((car, index) => {
      const ordinal = index + 1;
      const selected = selectedOrdinal === ordinal;
      const rank = result?.subsystem === 'acv' ? result.rankedCars.indexOf(ids[index]) + 1 : 0;
      // Door has no reliable physical car identity at all, so the reference geometry is scaled down to a
      // single representative cabin rather than implying seven other specific, located cars.
      if (subsystem === 'door' && ordinal !== REPRESENTATIVE_DOOR.carOrdinal) return null;
      return <group key={car.uuid}>
        <primitive object={car}
          onPointerOver={(event: ThreeEvent<PointerEvent>) => { event.stopPropagation(); setHoveredCar(ordinal); document.body.style.cursor = 'pointer'; }}
          onPointerOut={() => { setHoveredCar(null); document.body.style.cursor = ''; }}
          onClick={(event: ThreeEvent<MouseEvent>) => { event.stopPropagation(); onSelect({ kind: 'car', ordinal, carId: ids[index] }); }}
        />
        {(subsystem === 'acv' || subsystem === 'rail') && <Html center position={[carCenterX(ordinal), 4.04, 0]} zIndexRange={[15, 0]}>
          <button className={`reference-car-label${selected || hoveredCar === ordinal ? ' is-selected' : ''}${rank > 0 ? ` is-ranked is-rank-${rank}` : ''}${!reducedMotion && scanCarOrdinal(visualization) === ordinal ? ' is-scanning' : ''}`}
            data-rank={rank || undefined}
            aria-label={`Focus car ${ids[index]}`} aria-pressed={selected} title={`Car ${ids[index]} · schematic order ${ordinal}${rank > 0 ? ` · ACV case rank ${rank}` : ''}`}
            onClick={() => onSelect({ kind: 'car', ordinal, carId: ids[index] })}>
            <span>CAR {ids[index]}</span>{subsystem === 'acv' && <b>{rank > 0 ? `#${rank}` : 'ACV'}</b>}
          </button>
        </Html>}
        {subsystem === 'acv' && rank > 0 && <mesh position={[carCenterX(ordinal), 3.57, 0]} raycast={NO_RAYCAST}>
          <boxGeometry args={[7.8, .025, 1.3]} /><meshBasicMaterial color={rank <= 3 ? AMBER : CYAN} transparent opacity={rankEmphasis(rank)} depthWrite={false} toneMapped={false} />
        </mesh>}
        {selected && <Line points={[[carCenterX(ordinal)-4.6,.015,-1.6],[carCenterX(ordinal)+4.6,.015,-1.6],[carCenterX(ordinal)+4.6,.015,1.6],[carCenterX(ordinal)-4.6,.015,1.6],[carCenterX(ordinal)-4.6,.015,-1.6]]} color={CYAN} transparent opacity={.45} lineWidth={1} raycast={NO_RAYCAST} />}
      </group>;
    })}
    {subsystem !== 'door' && model.links.map(link => <primitive key={link.uuid} object={link} />)}
  </group>;
}

function ReferenceRails({ subsystem, result, selection, onSelect }: Pick<ReferenceTrainSceneProps, 'subsystem' | 'result' | 'selection' | 'onSelect'>) {
  return <group name="ReferenceRails" userData={{ scope: 'recording', localisation: 'side-only' }}>
    {RAIL_SIDES.map(({ side, z }) => {
      const predicted = subsystem === 'rail' && result?.subsystem === 'rail' && result.prediction === side;
      const selected = selection.kind === 'railSide' && selection.side === side;
      return <group key={side}>
      <mesh name={side === 'Side I' ? 'RailSide_I' : 'RailSide_II'} position={[0, subsystem === 'rail' ? .22 : .015, z]}
        userData={{ side, predictionScope: 'recording' }}
        onClick={(event: ThreeEvent<MouseEvent>) => { if (subsystem !== 'rail') return; event.stopPropagation(); onSelect({ kind: 'railSide', side }); }}
        onPointerOver={(event: ThreeEvent<PointerEvent>) => { if (subsystem !== 'rail') return; event.stopPropagation(); document.body.style.cursor = 'pointer'; }} onPointerOut={() => { document.body.style.cursor = ''; }}>
        {/* Rail Corrugation makes the rails themselves the primary visual subject; other subsystems keep them as subtle context. */}
        <boxGeometry args={subsystem === 'rail' ? [TRAIN_LENGTH + 9, .46, predicted || selected ? .42 : .34] : [TRAIN_LENGTH + 9, .10, predicted || selected ? .13 : .08]} />
        <meshStandardMaterial color={predicted ? AMBER : selected ? CYAN : '#536875'} emissive={predicted ? AMBER : selected ? CYAN : '#000000'} emissiveIntensity={predicted ? .48 : selected ? .25 : 0} metalness={.7} roughness={.3} />
      </mesh>
      {predicted && <Line points={Array.from({ length: 241 }, (_, index) => [-TRAIN_LENGTH / 2 + index / 240 * TRAIN_LENGTH, subsystem === 'rail' ? .46 : .10, z + Math.sin(index * .62) * .055] as [number, number, number])}
        color={AMBER} transparent opacity={.67} lineWidth={subsystem === 'rail' ? 2 : 1.25} raycast={NO_RAYCAST} />}
      {subsystem === 'rail' && <Html center position={[-TRAIN_LENGTH / 2 - (side === 'Side I' ? 5.4 : 2.6), side === 'Side I' ? 1.95 : .55, z * 1.7]} zIndexRange={[12, 0]}><button className={`reference-rail-label${predicted ? ' is-predicted' : ''}`} onClick={() => onSelect({ kind: 'railSide', side })} aria-label={`Focus ${side} rail`}>{side.toUpperCase()}</button></Html>}
      </group>;
    })}
  </group>;
}

function ReferenceDirection({ selectedOrdinal }: { selectedOrdinal: number | null }) {
  const origin = useMemo(() => new THREE.Vector3(0, 0, 0), []);
  const direction = useMemo(() => new THREE.Vector3(-1, 0, 0), []);
  return <group name="ReferenceTravelDirection" position={[selectedOrdinal ? carCenterX(selectedOrdinal) + 1.8 : 4, .045, 3.5]} userData={{ direction: '-X', kind: 'metadata', measuredDirection: false }}>
    <arrowHelper args={[direction, origin, selectedOrdinal ? 3.6 : 8, '#426779', .6, .30]} />
  </group>;
}

function ReferenceEnvironment() {
  const sleepers = useMemo(() => Array.from({ length: 80 }, (_, index) => index - 39.5), []);
  return <>
    <ambientLight intensity={.55} />
    <hemisphereLight color="#d9ecff" groundColor="#17222b" intensity={1.3} />
    <directionalLight position={[-14, 25, 17]} intensity={2.6} color="#e4edf7" castShadow shadow-mapSize={[1024,1024]} shadow-camera-left={-48} shadow-camera-right={48} shadow-camera-top={15} shadow-camera-bottom={-15} shadow-bias={-.0003} />
    <directionalLight position={[14, 10, -18]} intensity={1.5} color="#76b2c5" />
    <Environment resolution={128} frames={1}>
      <Lightformer intensity={3.5} position={[0,12,-2]} rotation={[Math.PI/2,0,0]} scale={[90,6,1]} />
      <Lightformer intensity={2.3} position={[0,6,14]} rotation={[0,Math.PI,0]} scale={[88,3,1]} />
      <Lightformer intensity={1.4} color="#94b9d1" position={[0,7,-14]} scale={[80,3,1]} />
    </Environment>
    <mesh rotation={[-Math.PI/2,0,0]} position={[0,-.10,0]} raycast={NO_RAYCAST}><planeGeometry args={[300,240]} /><meshBasicMaterial color="#081016" toneMapped={false} /></mesh>
    <gridHelper args={[160,80,'#19313c','#142832']} position={[0,-.076,0]} material-transparent material-opacity={.25} />
    {sleepers.map(x => <mesh key={x} position={[x,-.043,0]} raycast={NO_RAYCAST}><boxGeometry args={[.13,.025,2.5]} /><meshStandardMaterial color="#21343e" roughness={.9} /></mesh>)}
    <ContactShadows position={[0,-.06,0]} opacity={.4} scale={100} blur={1.7} far={5} resolution={512} frames={1} color="#00080d" />
  </>;
}

interface CameraGoal { position: THREE.Vector3; target: THREE.Vector3; focusOrdinal: number | null; active: boolean; snap: boolean }
function ReferenceCamera({ subsystem, selection, ids, fitKey, reducedMotion, visualization }: {
  subsystem: Subsystem; selection: ComponentSelection; ids: string[]; fitKey: number; reducedMotion: boolean;
  visualization?: SubsystemVisualState;
}) {
  const controls = useRef<OrbitControlsImpl>(null);
  const { camera, size } = useThree();
  // Only one door cabin is ever modelled, so the camera stays pinned there regardless of stray car selections.
  const focusOrdinal = subsystem === 'shm' ? null : subsystem === 'door' ? REPRESENTATIVE_DOOR.carOrdinal : selectedCarOrdinal(selection, ids);
  const fit = useRef(fitKey);
  const initialised = useRef(false);
  const goal = useRef<CameraGoal>({ position: new THREE.Vector3(-25,22,80), target: new THREE.Vector3(0,1.5,0), focusOrdinal: null, active: false, snap: true });
  const setGoal = (ordinal: number | null) => {
    if (!(camera instanceof THREE.PerspectiveCamera)) return;
    // Rail Corrugation's whole-train overview: fitting all eight cars edge-to-edge forces a distant, high
    // camera regardless of angle, so the rails read as thin lines no matter how large the geometry is. A
    // hand-placed low shot near one end, looking down the line, gives the (enlarged) rails real perspective
    // presence in the foreground while the receding cars still supply train context.
    if (subsystem === 'rail' && ordinal === null && selection.kind === 'recording') {
      // Kept just inside OrbitControls' maxPolarAngle so the tween settles here instead of being pulled back up.
      const position = new THREE.Vector3(carCenterX(1) - 5, 3.6, 3.4);
      const target = new THREE.Vector3(carCenterX(5), .4, 0);
      goal.current = { position, target, focusOrdinal: null, active: true, snap: !initialised.current };
      return;
    }
    // Doors have no reliable physical car/door identity, so there is no "whole train" view worth showing:
    // even with nothing selected yet, stay tightly framed on the single representative cabin.
    if (subsystem === 'door' && ordinal === null) {
      const doorTarget = new THREE.Vector3(carCenterX(REPRESENTATIVE_DOOR.carOrdinal) + REPRESENTATIVE_DOOR.localX, 1.75, 1.2);
      const position = doorTarget.clone().add(new THREE.Vector3(-3.4, 1.9, 6.2));
      goal.current = { position, target: doorTarget, focusOrdinal: REPRESENTATIVE_DOOR.carOrdinal, active: true, snap: !initialised.current };
      return;
    }
    const side = (ordinal && selection.kind === 'axleBox' && selection.position % 2 === 1) || (selection.kind === 'railSide' && selection.side === 'Side I') ? -1 : 1;
    // Rail Corrugation drops the camera toward rail height so the (enlarged) rails read as the primary subject.
    const elevation = subsystem === 'acv' ? .54 : subsystem === 'rail' ? (ordinal ? .16 : .12) : subsystem === 'door' ? .29 : .40;
    const direction = new THREE.Vector3(ordinal ? -.48 : -.16, elevation, side).normalize();
    // A small longitudinal offset balances perspective without changing carriage proportions.
    const target = new THREE.Vector3(ordinal ? carCenterX(ordinal) : -2.6, subsystem === 'rail' ? (ordinal ? .5 : .45) : 1.6, 0);
    const halfLength = ordinal ? CAR_LENGTH / 2 + .9 : TRAIN_LENGTH / 2 + .95;
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0,1,0), direction).normalize();
    const up = new THREE.Vector3().crossVectors(direction, right).normalize();
    const tanY = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const tanX = tanY * size.width / Math.max(size.height,1);
    // A smaller vertical extent (rails + lower carriage body, not the full roofline) lets the rail view sit noticeably closer.
    const verticalExtent: [number, number] = subsystem === 'rail' ? [-.35, 1.5] : [-1.85, 3.5];
    let distance = 10;
    for (const x of [-halfLength, halfLength]) for (const y of verticalExtent) for (const z of [-2.3,2.3]) {
      const point = new THREE.Vector3(ordinal ? x : x - target.x,y,z);
      distance = Math.max(distance, point.dot(direction) + Math.abs(point.dot(right)) / (tanX * (ordinal ? .88 : .92)), point.dot(direction) + Math.abs(point.dot(up)) / (tanY * .76));
    }
    goal.current = { position: target.clone().addScaledVector(direction, distance), target, focusOrdinal: ordinal, active: true, snap: !initialised.current };
  };
  useEffect(() => { setGoal(focusOrdinal); }, [selection, focusOrdinal, subsystem, size.width, size.height]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (subsystem !== 'door' || !visualization?.door) return;
    const target = new THREE.Vector3(carCenterX(REPRESENTATIVE_DOOR.carOrdinal) + REPRESENTATIVE_DOOR.localX, 1.8, 1.2);
    goal.current = { position: target.clone().add(new THREE.Vector3(-2.1, 1.6, Math.max(7, 5.3 * size.height / Math.max(size.width, 1)))), target, focusOrdinal: REPRESENTATIVE_DOOR.carOrdinal, active: true, snap: !initialised.current };
  }, [subsystem, visualization?.door?.cycleNumber, size.width, size.height]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (fit.current !== fitKey) { fit.current = fitKey; setGoal(null); }
  }, [fitKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useFrame((_, delta) => {
    const control = controls.current;
    if (!control) return;
    if (goal.current.active) {
      const alpha = reducedMotion || goal.current.snap ? 1 : 1 - Math.exp(-Math.min(delta,.1) * 4.2);
      camera.position.lerp(goal.current.position, alpha);
      control.target.lerp(goal.current.target, alpha);
      control.update();
      initialised.current = true;
      if (camera.position.distanceTo(goal.current.position) < .025 && control.target.distanceTo(goal.current.target) < .01) goal.current.active = false;
    } else {
      const center = goal.current.focusOrdinal ? carCenterX(goal.current.focusOrdinal) : 0;
      const range = goal.current.focusOrdinal ? 5 : 10;
      control.target.x = THREE.MathUtils.clamp(control.target.x, center - range, center + range);
      control.target.y = THREE.MathUtils.clamp(control.target.y,.25,3.5);
      control.target.z = THREE.MathUtils.clamp(control.target.z,-2,2);
    }
  });
  return <OrbitControls ref={controls} makeDefault target={[0,1.6,0]} enableDamping={!reducedMotion} dampingFactor={.08} minDistance={subsystem === 'door' ? 5 : 9} maxDistance={240}
    minPolarAngle={Math.PI*.19} maxPolarAngle={Math.PI*.48} minAzimuthAngle={-Math.PI+.04} maxAzimuthAngle={Math.PI-.04}
    panSpeed={.35} rotateSpeed={.4} zoomSpeed={.65} onStart={() => { goal.current.active = false; }} />;
}

function ContextLoss({ onLost }: { onLost: () => void }) {
  const { gl } = useThree();
  useEffect(() => {
    const canvas = gl.domElement;
    const lost = (event: Event) => { event.preventDefault(); onLost(); };
    const prevent = (event: Event) => event.preventDefault();
    canvas.addEventListener('webglcontextlost',lost);
    canvas.addEventListener('contextmenu',prevent);
    return () => { canvas.removeEventListener('webglcontextlost',lost); canvas.removeEventListener('contextmenu',prevent); };
  }, [gl,onLost]);
  return null;
}

function DetachedRecording({ subsystem, mapping, source, result, ids, onSelect }: Pick<ReferenceTrainSceneProps,'subsystem'|'mapping'|'source'|'result'|'onSelect'> & { ids: string[] }) {
  if (subsystem !== 'door' && subsystem !== 'shm') return null;
  if (subsystem === 'door' && resolveDoor(mapping, ids)) return null;
  if (subsystem === 'shm' && mapping.status === 'mapped' && mapping.basis === 'verified-metadata' && mapping.anchor.kind === 'measurementPoint') {
    // A known point name alone is not proof that its mesh key resolves.
    return <button className="reference-detached" onClick={() => onSelect({kind:'recording'})}><span className="reference-detached__eyebrow">STRUCTURAL RECORDING</span><strong>{mapping.anchor.pointId}</strong><span>Verified mapping supplied · inspect mapping provenance</span><span className="reference-detached__source">{source?.fileName ?? 'Select a recording'}</span></button>;
  }
  return <button className="reference-detached" onClick={() => onSelect({kind:'recording'})} aria-label={subsystem === 'door' ? 'Inspect unmapped door stream' : 'Inspect unlocated stress recording'}>
    <span className="reference-detached__icon" aria-hidden="true">{subsystem === 'door' ? '▥' : '◇'}</span>
    <span className="reference-detached__eyebrow">{subsystem === 'door' ? 'DOOR RECORDING' : 'STRUCTURAL RECORDING'}</span>
    <strong>{subsystem === 'door' ? 'Illustrative door motion' : 'Measurement location not supplied'}</strong>
    <span>{subsystem === 'door' ? 'Physical door identity unavailable' : 'Uniform stress pulse · explanatory, not a measured spatial distribution'}</span>
    <span className="reference-detached__source">{source?.fileName ?? 'Select a recording'}</span>
    {result?.subsystem === 'shm' && <span className="reference-detached__damage">Predicted damage <b>{formatDamage(result.predictedDamage)}</b><small>This recording / stress segment</small></span>}
    <span className="reference-detached__action">Inspect source fields <span aria-hidden="true">↗</span></span>
  </button>;
}

function ReferenceFallback({ ids, selectedOrdinal, ...props }: ReferenceTrainSceneProps & { ids: string[]; selectedOrdinal: number | null }) {
  const result = scopedResult(props);
  const prediction = result?.subsystem === 'rail' ? result.prediction : null;
  const door = props.visualization?.door;
  const opening = doorOpeningFraction(door, props.reducedMotion);
  const focusedCar = scanCarOrdinal(props.visualization);
  return <div className="reference-fallback" role="group" aria-label="Eight-car reference schematic">
    <div className="reference-fallback__heading"><span>INTERACTIVE REFERENCE SCHEMATIC</span><small>3D unavailable · component selection remains available</small></div>
    <div className="reference-fallback__cars">{ids.map((id,index) => {
      const rank = result?.subsystem === 'acv' ? result.rankedCars.indexOf(id) + 1 : 0;
      return <button type="button" key={id} aria-label={`Focus car ${id}`} aria-pressed={selectedOrdinal === index+1} disabled={props.subsystem === 'shm' || props.subsystem === 'door'} className={`reference-fallback__car${selectedOrdinal === index+1 ? ' is-selected' : ''}${rank > 0 ? ` is-ranked is-rank-${rank}` : ''}${!props.reducedMotion && focusedCar === index + 1 ? ' is-scanning' : ''}`} data-rank={rank || undefined} style={{ '--rank-strength': rankEmphasis(rank) } as CSSProperties} onClick={()=>props.onSelect({kind:'car',carId:id,ordinal:index+1})}><span>{props.subsystem === 'door' || props.subsystem === 'shm' ? 'REFERENCE' : `CAR ${id}`}</span><i /><small>{rank>0 ? `ACV rank #${rank}` : props.subsystem === 'shm' ? 'Unlocated' : 'Reference'}</small></button>;
    })}</div>
    {props.subsystem === 'door' && door && <div className={`reference-fallback__door${completedDoorAbnormal(door) ? ' is-abnormal' : ''}`} aria-label={`Illustrative ${door.operation} movement, cycle ${door.cycleNumber}`} style={{ '--door-opening': `${opening * 37}px` } as CSSProperties}>
      <div className="reference-fallback__door-frame"><i /><i /></div><span>Cycle {door.cycleNumber} · {door.operation}<small>{door.completed ? `Classified as ${door.prediction}` : 'Recorded movement in progress'}</small></span>
    </div>}
    {props.subsystem === 'rail' && <div className="reference-fallback__sensor-strip" role="img" aria-label="64 reference sensor nodes, eight per carriage">{ids.map((id,index) => <div key={id}>{RAIL_AXLE_BOXES.filter(anchor => anchor.carOrdinal === index + 1).map(anchor => <i key={anchor.id} className={`${prediction === anchor.side ? 'is-side-member ' : ''}${!props.reducedMotion && focusedCar === index + 1 ? 'is-scanning' : ''}`} title={`Car ${id} · P${anchor.position} · ${anchor.side}`} />)}</div>)}</div>}
    {props.subsystem === 'rail' && <div className="reference-fallback__rails">{RAIL_SIDES.map(({side})=><button key={side} className={prediction===side ? 'is-predicted' : ''} onClick={()=>props.onSelect({kind:'railSide',side})} aria-label={`Select reference rail ${side}`}><i />{side}<i /></button>)}</div>}
    {props.subsystem === 'rail' && selectedOrdinal && <div className="reference-fallback__axles" role="group" aria-label={`Car ${selectedOrdinal} axle boxes`}>
      {(['Side I','Side II'] as RailSide[]).map(side=><div key={side}><span>{side}</span>{RAIL_AXLE_BOXES.filter(anchor=>anchor.carOrdinal===selectedOrdinal&&anchor.side===side).map(anchor=><button key={anchor.id} aria-label={`Select car ${anchor.carOrdinal} axle box ${anchor.position}, ${anchor.side}`} aria-pressed={props.selection.kind==='axleBox'&&props.selection.position===anchor.position} className={`${prediction===side?'is-side-member ':''}${props.selection.kind==='axleBox'&&props.selection.position===anchor.position?'is-selected':''}`} onClick={()=>props.onSelect({kind:'axleBox',carOrdinal:anchor.carOrdinal,position:anchor.position})}>P{anchor.position}</button>)}</div>)}
    </div>}
    {props.subsystem==='rail'&&props.selection.kind==='axleBox'&&<div className="reference-fallback__callout"><RailCallout anchor={RAIL_AXLE_BOXES[(props.selection.carOrdinal-1)*8+props.selection.position-1]} source={props.source} result={result} cursorLabel={props.cursorLabel} sensorReadout={props.sensorReadout}/></div>}
    {(props.subsystem === 'door' || props.subsystem === 'shm') && <DetachedRecording subsystem={props.subsystem} mapping={props.mapping} source={props.source} result={result} ids={ids} onSelect={props.onSelect} />}
  </div>;
}

export function ReferenceTrainScene(props: ReferenceTrainSceneProps) {
  const [available,setAvailable] = useState(supportsWebGL);
  const [ready,setReady] = useState(false);
  const ids = useMemo(()=>referenceCarIds(props.subsystem==='acv'||props.subsystem==='rail' ? props.carIds : []),[props.carIds,props.subsystem]);
  const selectedOrdinal = props.subsystem === 'shm' || props.subsystem === 'door' ? null : selectedCarOrdinal(props.selection,ids);
  const result = props.visualization?.analysisPhase === 'scanning' ? null : scopedResult(props);
  const source = props.source ?? result?.source;
  const fallback = <ReferenceFallback {...props} result={result} source={source} ids={ids} selectedOrdinal={selectedOrdinal}/>;
  const railClass = result?.subsystem==='rail' ? result.prediction : null;
  const mappedContext = props.subsystem==='acv'||props.subsystem==='rail';
  const phase = props.visualization?.analysisPhase ?? (result ? 'settled' : 'idle');
  const door = props.visualization?.door;
  const sceneStatus = phase === 'scanning' ? `Reviewing recorded evidence · visual scan ${Math.round(unitProgress(props.visualization?.scanProgress ?? 0) * 100)}%` : props.subsystem === 'acv' && result ? 'Scan complete · relative leak-likelihood ranking' : railClass === 'Normal' ? 'No corrugation signature detected' : railClass ? `Corrugation signature detected — ${railClass}` : props.subsystem === 'door' && door ? door.completed ? `Cycle ${door.cycleNumber} · classified as ${door.prediction}` : `Cycle ${door.cycleNumber} · replaying recorded movement` : props.subsystem === 'shm' ? 'Structural reference · physical sensor location unavailable' : 'Select a recording to analyse';
  return <div className="reference-train-scene" role="group" aria-label="Eight-car dataset reference layout" data-ready={!available||ready} data-renderer={available?'webgl':'schematic'} data-car-count={8} data-axle-box-count={props.subsystem==='rail'?64:0} data-layer={props.subsystem} data-selected-car={selectedOrdinal??''} data-rail-class={railClass??'uncomputed'} data-analysis-phase={phase} data-reduced-motion={props.reducedMotion} data-door-completed={door?.completed ?? false}
    style={{ '--stress-amplitude': props.reducedMotion ? 0 : unitProgress(props.visualization?.stress?.amplitude ?? 0) } as CSSProperties}>
    <div className={`reference-scene-status${phase === 'scanning' ? ' is-scanning' : ''}${(railClass && railClass !== 'Normal') || completedDoorAbnormal(door) ? ' is-amber' : ''}`}><i /><span>{sceneStatus}</span></div>
    <div className="reference-train-stage">
      {available ? <ReferenceBoundary fallback={fallback} onError={()=>setAvailable(false)}><Suspense fallback={<div className="reference-loading"><i/>Loading eight-car reference geometry</div>}>
        <Canvas shadows dpr={[1,1.5]} camera={{position:[-25,22,80],fov:35,near:.1,far:500}} gl={{antialias:true,alpha:true,powerPreference:'high-performance'}}>
          <fog attach="fog" args={['#081016',180,350]}/>
          <ContextLoss onLost={()=>setAvailable(false)}/>
          <ReferenceEnvironment/>
          <ReferenceDirection selectedOrdinal={selectedOrdinal}/>
          <ReferenceRails subsystem={props.subsystem} result={result} selection={props.selection} onSelect={props.onSelect}/>
          <ReferenceGeometry ids={ids} subsystem={props.subsystem} selectedOrdinal={selectedOrdinal} onSelect={props.onSelect} result={result} xray={props.xray} visualization={props.visualization} reducedMotion={props.reducedMotion} onReady={()=>setReady(true)}/>
          {(props.subsystem === 'acv' || props.subsystem === 'rail') && <AnalysisSweep visualization={props.visualization} reducedMotion={props.reducedMotion} />}
          {props.subsystem==='rail'&&<AxleBoxLayer xray={props.xray} selectedOrdinal={selectedOrdinal} selection={props.selection} onSelect={props.onSelect} result={result} source={source} cursorLabel={props.cursorLabel} sensorReadout={props.sensorReadout} visualization={props.visualization} reducedMotion={props.reducedMotion}/>}
          {props.subsystem==='acv'&&selectedOrdinal&&result?.subsystem==='acv'&&<AcvCarriageInterior ordinal={selectedOrdinal} rank={result.rankedCars.indexOf(ids[selectedOrdinal-1])+1} reducedMotion={props.reducedMotion}/>}
          {props.subsystem==='door'&&<MappedDoor mapping={props.mapping} ids={ids} onSelect={props.onSelect}/>}
          {props.subsystem==='door'&&!resolveDoor(props.mapping, ids)&&<IllustrativeDoor visualization={props.visualization} reducedMotion={props.reducedMotion} />}
          {props.subsystem==='shm'&&props.xray&&<StructuralInternals/>}
          {props.subsystem==='shm'&&<VerifiedMeasurementPoint mapping={props.mapping} result={result} onSelect={props.onSelect}/>}
          <ReferenceCamera subsystem={props.subsystem} selection={props.selection} ids={ids} fitKey={props.fitKey} reducedMotion={props.reducedMotion} visualization={props.visualization}/>
        </Canvas>
      </Suspense></ReferenceBoundary> : fallback}
      <div className="reference-vignette" aria-hidden="true"/>
    </div>
    {available && <DetachedRecording subsystem={props.subsystem} mapping={props.mapping} source={source} result={result} ids={ids} onSelect={props.onSelect}/>}
    <div className="reference-scene-caption"><span>{mappedContext ? props.subsystem==='acv' ? props.source && props.carIds.length === 8 ? 'Stable schematic car order · identity from case headers' : 'No case selected · schematic car placeholders' : 'Figure 2 reference · 8 cars / 64 axle boxes' : props.subsystem==='shm' ? (props.xray ? 'X-ray internals are illustrative scaffolding, not verified engineering geometry' : 'Normal view · check X-ray to reveal illustrative internal structure') : 'Reference layout — asset mapping not supplied'}</span><span>Reference travel −X · schematic dimensions</span></div>
    {props.subsystem==='rail'&&<div className="reference-rail-key" role="group" aria-label="Recording-level reference rails">
      {RAIL_SIDES.map(({side})=><button key={side} className={railClass===side?'is-predicted':''} onClick={()=>props.onSelect({kind:'railSide',side})} aria-label={`Select reference rail ${side}`} aria-pressed={props.selection.kind==='railSide'&&props.selection.side===side}><i/>{side}<small>{side==='Side I'?'−Z / odd positions':'+Z / even positions'}</small></button>)}
      <span>{railClass && railClass!=='Normal' ? 'Illustrative rail-side highlight · recording-level class, no exact track location' : railClass==='Normal' ? 'Normal is the recording class; not a component-health assessment.' : 'Reference rails · prediction not computed'}</span>
    </div>}
  </div>;
}

export default ReferenceTrainScene;
