import { Component, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { ContactShadows, Environment, Html, Lightformer, Line, OrbitControls, useGLTF } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import * as THREE from 'three';
import type { ComponentSelection, SourceRef, Subsystem } from '../../types/multisystem';
import type { SubsystemVisualState } from '../../types/visualization';
import { CAR_COUNT, CAR_LENGTH, CAR_PITCH, RAIL_AXLE_BOXES, RAIL_SIDES, TRAIN_LENGTH, carCenterX, referenceCarIds, selectedCarOrdinal, type AxleBoxAnchor, type RailSide } from '../../lib/topology';
import { REPRESENTATIVE_DOOR, SHM_RISK_BANDS, completedDoorAbnormal, doorOpeningFraction, shmRiskBand, unitProgress } from './subsystemVisuals';
import './ReferenceTrainScene.css';

export interface ReferenceTrainSceneProps {
  subsystem: Subsystem;
  carIds: string[];
  selection: ComponentSelection;
  onSelect: (selection: ComponentSelection) => void;
  xray: boolean;
  reducedMotion: boolean;
  fitKey: number;
  source?: SourceRef | null;
  cursorLabel?: string;
  sensorReadout?: { vibration: number | null; shock: number | null };
  visualization?: SubsystemVisualState;
}

const CYAN = '#67cbbf';
const AMBER = '#f0b361';
const MUTED = '#6e8796';
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

function formatSample(value: number | null | undefined) {
  return value === null || value === undefined || !Number.isFinite(value) ? 'Not recorded' : `${value.toLocaleString('en', { maximumFractionDigits: 4 })} m/s²`;
}

function RailCallout({ anchor, source, cursorLabel, sensorReadout }: {
  anchor: AxleBoxAnchor;
  source?: SourceRef | null;
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
  </div>;
}

function AxleBoxLayer({ selectedOrdinal, selection, onSelect, source, cursorLabel, sensorReadout, xray }: {
  selectedOrdinal: number | null;
  xray: boolean;
  selection: ComponentSelection;
  onSelect: ReferenceTrainSceneProps['onSelect'];
  source?: SourceRef | null;
  cursorLabel?: string;
  sensorReadout?: ReferenceTrainSceneProps['sensorReadout'];
}) {
  return <group name="RailAxleBoxRegistry" userData={{ anchorCount: 64, channelCount: 128, rotationalSpeedColumn: 0 }}>
    {RAIL_AXLE_BOXES.map(anchor => {
      const visible = selectedOrdinal === anchor.carOrdinal;
      const selected = selection.kind === 'axleBox' && selection.carOrdinal === anchor.carOrdinal && selection.position === anchor.position;
      return <group key={anchor.id} name={`AxleBox_C${anchor.carOrdinal}_P${anchor.position}`} position={[...anchor.worldPosition]}
        userData={{ carOrdinal: anchor.carOrdinal, position: anchor.position, side: anchor.side, vibrationIndex: anchor.vibrationIndex, shockIndex: anchor.shockIndex }}>
        <>
          <mesh renderOrder={xray ? 10 : 0} onClick={(event: ThreeEvent<MouseEvent>) => { event.stopPropagation(); onSelect({ kind: 'axleBox', carOrdinal: anchor.carOrdinal, position: anchor.position }); }}
            onPointerOver={(event: ThreeEvent<PointerEvent>) => { event.stopPropagation(); document.body.style.cursor = 'pointer'; }} onPointerOut={() => { document.body.style.cursor = ''; }}>
            <sphereGeometry args={[selected ? .18 : visible ? .125 : .095, 12, 8]} />
            <meshBasicMaterial color={source ? CYAN : MUTED} toneMapped={false} transparent opacity={visible ? 1 : .53} depthTest={!xray} depthWrite={false} />
          </mesh>
          {selected && <mesh rotation={[Math.PI / 2, 0, 0]} raycast={NO_RAYCAST}>
            <torusGeometry args={[.25, .022, 6, 20]} />
            <meshBasicMaterial color={CYAN} transparent opacity={.85} toneMapped={false} />
          </mesh>}
          {visible && <Html center position={[0, -.39, anchor.side === 'Side I' ? -.22 : .22]} zIndexRange={[20, 0]}>
            <button className={`reference-sensor-label${selected ? ' is-selected' : ''}`}
              aria-label={`Select car ${anchor.carOrdinal} axle box ${anchor.position}, ${anchor.side}`} aria-pressed={selected}
              title={`Car ${anchor.carOrdinal} / Position ${anchor.position} / ${anchor.side}`}
              onClick={() => onSelect({ kind: 'axleBox', carOrdinal: anchor.carOrdinal, position: anchor.position })}>P{anchor.position}</button>
          </Html>}
          {selected && <Html center position={[0, 1.8, anchor.side === 'Side I' ? -1.25 : 1.25]} zIndexRange={[25, 0]} style={{ pointerEvents: 'none' }}>
            <RailCallout anchor={anchor} source={source} cursorLabel={cursorLabel} sensorReadout={sensorReadout} />
          </Html>}
        </>
      </group>;
    })}
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

function AcvRankFace({ rank }: { rank: number }) {
  const suspected = rank === 1;
  return <div className={`reference-passenger-face ${suspected ? 'is-alert' : 'is-ok'}`} aria-hidden="true">
    <svg viewBox="0 0 100 100" width="88" height="88">
      <circle cx="50" cy="50" r="46" className="face" />
      <circle cx="34" cy="42" r="6" className="eye" /><circle cx="66" cy="42" r="6" className="eye" />
      {suspected ? <path d="M30 68 Q50 52 70 68" className="mouth" /> : <path d="M30 60 Q50 80 70 60" className="mouth" />}
    </svg>
  </div>;
}

function AcvCarriageInterior({ ordinal, carId, rank, reducedMotion }: { ordinal: number; carId: string; rank: number; reducedMotion: boolean }) {
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
  const tint = suspected ? '#ff8585' : '#75dfac';
  return <group name={`AcvCarriageInterior_C${ordinal}`} position={[carCenterX(ordinal), 0, 1.34]} userData={{ illustrative: true, passengerData: false }}>
    {/* Keep the rank illustration outside the door leaves so the shell does not obscure it. */}
    <Html center position={[0, 2.75, .95]} zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
      <div className="reference-acv-reveal"><AcvRankFace rank={rank}/><span>Car {carId} · Rank #{rank} of 8</span></div>
    </Html>
    <mesh position={[0, 1.85, -.3]} raycast={NO_RAYCAST}><boxGeometry args={[3.4, 2.35, .5]} /><meshStandardMaterial color="#122029" roughness={.9} side={THREE.DoubleSide} /></mesh>
    <group ref={left} position={[-.34, 1.9, .15]}><mesh raycast={NO_RAYCAST}><boxGeometry args={[.64, 2.3, .09]} /><meshStandardMaterial color="#233241" metalness={.35} roughness={.5} emissive={tint} emissiveIntensity={.16} side={THREE.DoubleSide} /></mesh></group>
    <group ref={right} position={[.34, 1.9, .15]}><mesh raycast={NO_RAYCAST}><boxGeometry args={[.64, 2.3, .09]} /><meshStandardMaterial color="#233241" metalness={.35} roughness={.5} emissive={tint} emissiveIntensity={.16} side={THREE.DoubleSide} /></mesh></group>
  </group>;
}

// Illustrative mechanics only: neither verified geometry nor a component damage map.
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
            <mesh rotation={[Math.PI / 2, 0, 0]} raycast={NO_RAYCAST}><cylinderGeometry args={[.065, .065, 1.95, 10]} /><meshStandardMaterial color="#B4C0C9" metalness={.8} roughness={.3} /></mesh>
            {[-1, 1].map(side => <mesh key={side} position={[0, 0, side * .97]} rotation={[Math.PI / 2, 0, 0]} raycast={NO_RAYCAST}><cylinderGeometry args={[.42, .42, .16, 16]} /><meshStandardMaterial color="#39495A" emissive={CYAN} emissiveIntensity={.1} metalness={.5} roughness={.5} /></mesh>)}
          </group>)}
        </group>)}
      </group>;
    })}
    {[-1.15, 1.15].map(z => <mesh key={z} position={[0, .74, z]} raycast={NO_RAYCAST}><boxGeometry args={[TRAIN_LENGTH + 2, .16, .13]} /><meshStandardMaterial color="#6F8598" emissive={CYAN} emissiveIntensity={.07} metalness={.55} roughness={.4} transparent opacity={.88} /></mesh>)}
    {Array.from({ length: CAR_COUNT + 1 }, (_, index) => -TRAIN_LENGTH / 2 + index * CAR_PITCH).map(x => <mesh key={x} position={[x, .95, 0]} raycast={NO_RAYCAST}><boxGeometry args={[.12, .55, 2.3]} /><meshStandardMaterial color="#5E7488" emissive={CYAN} emissiveIntensity={.06} metalness={.5} roughness={.45} transparent opacity={.8} /></mesh>)}
  </group>;
}

function ReferenceGeometry({ ids, subsystem, selectedOrdinal, onSelect, xray, onReady, visualization, reducedMotion }: {
  ids: string[]; subsystem: Subsystem; selectedOrdinal: number | null; onSelect: ReferenceTrainSceneProps['onSelect']; xray: boolean; onReady: () => void;
  visualization?: SubsystemVisualState; reducedMotion: boolean;
}) {
  const { scene } = useGLTF(MODEL_URL);
  const frames = useRef(0);
  const [hoveredCar, setHoveredCar] = useState<number | null>(null);
  const shmBand = subsystem === 'shm' ? shmRiskBand(visualization?.shm?.prediction) : undefined;
  const model = useMemo(() => {
    const clone = scene.clone(true);
    const baseColors = new Map<THREE.Material, THREE.Color>();
    clone.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      object.material = Array.isArray(object.material) ? object.material.map(material => material.clone()) : object.material.clone();
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        if (material instanceof THREE.MeshStandardMaterial) baseColors.set(material, material.color.clone());
      }
      object.castShadow = true;
      object.receiveShadow = true;
    });
    const root = clone.getObjectByName('RailWitness_Eight_Car_Reference')!;
    return { root, baseColors, cars: root.children.filter(object => Number.isInteger(object.userData.carOrdinal)), links: root.children.filter(object => !Number.isInteger(object.userData.carOrdinal)) };
  }, [scene]);
  useEffect(() => {
    for (const car of [...model.cars, ...model.links]) {
      car.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return;
        const shell = object.userData.role === 'shell';
        const material = object.material as THREE.MeshStandardMaterial;
        const tinted = shmBand && shell && ['aluminium', 'roof', 'frame', 'livery'].includes(material.name);
        const baseColor = model.baseColors.get(material);
        if (baseColor) material.color.copy(baseColor);
        if (tinted) material.color.set(shmBand.color);
        object.userData.shmRisk = tinted ? shmBand.id : undefined;
        const ghost = xray && (shell || subsystem === 'shm');
        material.transparent = ghost;
        material.opacity = tinted ? xray ? .35 : 1 : ghost ? subsystem === 'shm' ? shell ? .17 : .25 : .13 : 1;
        material.depthWrite = !ghost;
        material.needsUpdate = true;
        object.castShadow = !ghost;
        // Transparent shells do not swallow sensor events; labels remain selectable.
        object.raycast = xray || subsystem === 'shm' || subsystem === 'door' ? NO_RAYCAST : THREE.Mesh.prototype.raycast;
      });
    }
  }, [model, xray, subsystem, shmBand]);
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
  const suspectedGlow = useMemo(() => new THREE.Color(AMBER), []);
  const riskGlow = useMemo(() => new THREE.Color(shmBand?.color ?? CYAN), [shmBand]);
  useFrame((_, delta) => {
    if (++frames.current === 2) onReady();
    for (const [index, car] of model.cars.entries()) {
      const stress = subsystem === 'shm' && visualization?.stress;
      const suspected = subsystem === 'acv' && visualization?.acv?.hasUsableData !== false && visualization?.acv?.rankedCars[0] === ids[index];
      const intensity = suspected ? .22 : shmBand ? .32 + (stress && !reducedMotion ? unitProgress(stress.amplitude) * .18 : 0) : stress ? .1 + (reducedMotion ? 0 : unitProgress(stress.amplitude) * .42) : 0;
      car.traverse(object => {
        if (!(object instanceof THREE.Mesh) || object.userData.role !== 'shell') return;
        const material = object.material as THREE.MeshStandardMaterial;
        if (material.name === 'lamp' || material.name === 'tail') return;
        const tinted = object.userData.shmRisk;
        material.emissive.lerp(suspected ? suspectedGlow : tinted ? riskGlow : glow, reducedMotion ? 1 : Math.min(1, delta * 6));
        material.emissiveIntensity = THREE.MathUtils.damp(material.emissiveIntensity, shmBand && !tinted ? 0 : intensity, reducedMotion ? 1000 : 7, delta);
      });
    }
  });
  return <group name={subsystem === 'door' ? 'RepresentativeDoorCabin' : 'EightCarReferenceConsist'} userData={{ carCount: subsystem === 'door' ? 1 : CAR_COUNT, schematic: true }}>
    {model.cars.map((car, index) => {
      const ordinal = index + 1;
      if (subsystem === 'door' && ordinal !== REPRESENTATIVE_DOOR.carOrdinal) return null;
      const selected = selectedOrdinal === ordinal;
      const rank = subsystem === 'acv' ? (visualization?.acv?.rankedCars.indexOf(ids[index]) ?? -1) + 1 : 0;
      const suspected = rank === 1 && visualization?.acv?.hasUsableData !== false;
      return <group key={car.uuid}>
        <primitive object={car}
          onPointerOver={(event: ThreeEvent<PointerEvent>) => { event.stopPropagation(); setHoveredCar(ordinal); document.body.style.cursor = 'pointer'; }}
          onPointerOut={() => { setHoveredCar(null); document.body.style.cursor = ''; }}
          onClick={(event: ThreeEvent<MouseEvent>) => { event.stopPropagation(); onSelect({ kind: 'car', ordinal, carId: ids[index] }); }}
        />
        {(subsystem === 'acv' || subsystem === 'rail') && <Html center position={[carCenterX(ordinal), 4.04, 0]} zIndexRange={[15, 0]}>
          <button className={`reference-car-label${suspected ? ' is-ranked-first' : ''}${selected || hoveredCar === ordinal ? ' is-selected' : ''}`}
            aria-label={`Focus car ${ids[index]}`} aria-pressed={selected} data-acv-rank={rank || undefined} title={`Car ${ids[index]} · schematic order ${ordinal}${rank ? ` · ACV rank ${rank}${suspected ? ' · most suspected' : ''}` : ''}`}
            onClick={() => onSelect({ kind: 'car', ordinal, carId: ids[index] })}>
            <span>CAR {ids[index]}</span>{rank > 0 && <small>Rank {rank}</small>}
          </button>
        </Html>}
        {selected && <Line points={[[carCenterX(ordinal)-4.6,.015,-1.6],[carCenterX(ordinal)+4.6,.015,-1.6],[carCenterX(ordinal)+4.6,.015,1.6],[carCenterX(ordinal)-4.6,.015,1.6],[carCenterX(ordinal)-4.6,.015,-1.6]]} color={CYAN} transparent opacity={.45} lineWidth={1} raycast={NO_RAYCAST} />}
      </group>;
    })}
    {subsystem !== 'door' && model.links.map(link => <primitive key={link.uuid} object={link} />)}
  </group>;
}

function ReferenceRails({ subsystem, selection, onSelect, visualization }: Pick<ReferenceTrainSceneProps, 'subsystem' | 'selection' | 'onSelect' | 'visualization'>) {
  return <group name="ReferenceRails" userData={{ scope: 'recording', localisation: 'side-only' }}>
    {RAIL_SIDES.map(({ side, z }) => {
      const selected = selection.kind === 'railSide' && selection.side === side;
      const predicted = subsystem === 'rail' && visualization?.rail?.prediction === side;
      const color = predicted ? AMBER : selected ? CYAN : '#536875';
      return <group key={side}>
      <mesh name={side === 'Side I' ? 'RailSide_I' : 'RailSide_II'} position={[subsystem === 'door' ? carCenterX(REPRESENTATIVE_DOOR.carOrdinal) : 0, subsystem === 'rail' ? .22 : .015, z]}
        userData={{ side, predicted }}
        onClick={(event: ThreeEvent<MouseEvent>) => { if (subsystem !== 'rail') return; event.stopPropagation(); onSelect({ kind: 'railSide', side }); }}
        onPointerOver={(event: ThreeEvent<PointerEvent>) => { if (subsystem !== 'rail') return; event.stopPropagation(); document.body.style.cursor = 'pointer'; }} onPointerOut={() => { document.body.style.cursor = ''; }}>
        <boxGeometry args={subsystem === 'rail' ? [TRAIN_LENGTH + 9, .46, predicted || selected ? .42 : .34] : [subsystem === 'door' ? CAR_LENGTH + 3 : TRAIN_LENGTH + 9, .10, predicted || selected ? .13 : .08]} />
        <meshStandardMaterial color={color} emissive={predicted || selected ? color : '#000000'} emissiveIntensity={predicted ? .5 : selected ? .25 : 0} metalness={.7} roughness={.3} />
      </mesh>
      {subsystem === 'rail' && <Html center position={[-TRAIN_LENGTH / 2 - (side === 'Side I' ? 5.4 : 2.6), side === 'Side I' ? 1.95 : .55, z * 1.7]} zIndexRange={[12, 0]}><button className={`reference-rail-label${predicted ? ' is-predicted' : ''}`} onClick={() => onSelect({ kind: 'railSide', side })} aria-label={`Focus ${side} rail`} aria-pressed={selected}>{side.toUpperCase()}{predicted ? ' · MODEL RESULT' : ''}</button></Html>}
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
    if (subsystem === 'rail' && ordinal === null) {
      // Kept just inside OrbitControls' maxPolarAngle so the tween settles here instead of being pulled back up.
      const position = new THREE.Vector3(carCenterX(1) - 5, 3.6, selection.kind === 'railSide' && selection.side === 'Side I' ? -3.4 : 3.4);
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

function DetachedRecording({ subsystem, source, onSelect }: Pick<ReferenceTrainSceneProps,'subsystem'|'source'|'onSelect'>) {
  if (subsystem !== 'door' && subsystem !== 'shm') return null;
  return <button className="reference-detached" onClick={() => onSelect({kind:'recording'})} aria-label={subsystem === 'door' ? 'Inspect unmapped door stream' : 'Inspect unlocated stress recording'}>
    <span className="reference-detached__icon" aria-hidden="true">{subsystem === 'door' ? '▥' : '◇'}</span>
    <span className="reference-detached__eyebrow">{subsystem === 'door' ? 'DOOR RECORDING' : 'STRUCTURAL RECORDING'}</span>
    <strong>{subsystem === 'door' ? 'Illustrative door motion' : 'Measurement location not supplied'}</strong>
    <span>{subsystem === 'door' ? 'Physical door identity unavailable' : 'Uniform stress pulse · explanatory, not a measured spatial distribution'}</span>
    <span className="reference-detached__source">{source?.fileName ?? 'Select a recording'}</span>
    <span className="reference-detached__action">Inspect source fields <span aria-hidden="true">↗</span></span>
  </button>;
}

function ReferenceFallback({ ids, selectedOrdinal, ...props }: ReferenceTrainSceneProps & { ids: string[]; selectedOrdinal: number | null }) {
  const door = props.visualization?.door;
  const shmBand = props.subsystem === 'shm' ? shmRiskBand(props.visualization?.shm?.prediction) : undefined;
  const opening = doorOpeningFraction(door, props.reducedMotion);
  return <div className="reference-fallback" role="group" aria-label={props.subsystem === 'door' ? 'Representative door cabin schematic' : 'Eight-car reference schematic'}>
    <div className="reference-fallback__heading"><span>INTERACTIVE REFERENCE SCHEMATIC</span><small>3D unavailable · component selection remains available</small></div>
    <div className="reference-fallback__cars">{ids.map((id,index) => {
      if (props.subsystem === 'door' && index + 1 !== REPRESENTATIVE_DOOR.carOrdinal) return null;
      const rank = props.subsystem === 'acv' ? (props.visualization?.acv?.rankedCars.indexOf(id) ?? -1) + 1 : 0;
      const suspected = rank === 1 && props.visualization?.acv?.hasUsableData !== false;
      return <button type="button" key={id} aria-label={props.subsystem === 'door' ? 'Representative door cabin' : `Focus car ${id}`} aria-pressed={selectedOrdinal === index+1} data-acv-rank={rank || undefined} data-shm-risk={shmBand?.id} title={rank ? `ACV rank ${rank}${suspected ? ' · most suspected' : ''}` : undefined} disabled={props.subsystem === 'shm' || props.subsystem === 'door'} className={`reference-fallback__car${suspected ? ' is-ranked-first' : ''}${selectedOrdinal === index+1 ? ' is-selected' : ''}`} onClick={()=>props.onSelect({kind:'car',carId:id,ordinal:index+1})}><span>{props.subsystem === 'door' || props.subsystem === 'shm' ? 'REFERENCE' : `CAR ${id}`}</span><i /><small>{rank ? `Rank ${rank}` : props.subsystem === 'shm' ? 'Unlocated' : 'Reference'}</small></button>;
    })}</div>
    {props.subsystem === 'acv' && selectedOrdinal && props.visualization?.acv?.hasUsableData !== false && props.visualization?.acv?.rankedCars.includes(ids[selectedOrdinal - 1]) && <div className="reference-fallback__interior" aria-label="Illustrative ACV carriage interior"><AcvRankFace rank={props.visualization.acv.rankedCars.indexOf(ids[selectedOrdinal - 1]) + 1}/><div className="reference-passenger-note"><strong>Ranked #{props.visualization.acv.rankedCars.indexOf(ids[selectedOrdinal - 1]) + 1} of 8</strong>Relative model ranking: red = rank 1, green = ranks 2–8</div></div>}
    {props.subsystem === 'door' && door && <div className={`reference-fallback__door${completedDoorAbnormal(door) ? ' is-abnormal' : ''}`} aria-label={`Illustrative ${door.operation} movement, cycle ${door.cycleNumber}`} style={{ '--door-opening': `${opening * 37}px` } as CSSProperties}>
      <div className="reference-fallback__door-frame"><i /><i /></div><span>Cycle {door.cycleNumber} · {door.operation}<small>{door.completed ? `Classified as ${door.prediction}` : 'Recorded movement in progress'}</small></span>
    </div>}
    {props.subsystem === 'rail' && <div className="reference-fallback__sensor-strip" role="img" aria-label="64 reference sensor nodes, eight per carriage">{ids.map((id,index) => <div key={id}>{RAIL_AXLE_BOXES.filter(anchor => anchor.carOrdinal === index + 1).map(anchor => <i key={anchor.id} title={`Car ${id} · P${anchor.position} · ${anchor.side}`} />)}</div>)}</div>}
    {props.subsystem === 'rail' && <div className="reference-fallback__rails">{RAIL_SIDES.map(({side})=><button key={side} className={props.visualization?.rail?.prediction === side ? 'is-predicted' : ''} onClick={()=>props.onSelect({kind:'railSide',side})} aria-label={`Select reference rail ${side}`} aria-pressed={props.selection.kind==='railSide'&&props.selection.side===side}><i />{side}{props.visualization?.rail?.prediction === side ? ' · Model result' : ''}<i /></button>)}</div>}
    {props.subsystem === 'rail' && selectedOrdinal && <div className="reference-fallback__axles" role="group" aria-label={`Car ${selectedOrdinal} axle boxes`}>
      {(['Side I','Side II'] as RailSide[]).map(side=><div key={side}><span>{side}</span>{RAIL_AXLE_BOXES.filter(anchor=>anchor.carOrdinal===selectedOrdinal&&anchor.side===side).map(anchor=><button key={anchor.id} aria-label={`Select car ${anchor.carOrdinal} axle box ${anchor.position}, ${anchor.side}`} aria-pressed={props.selection.kind==='axleBox'&&props.selection.position===anchor.position} className={props.selection.kind==='axleBox'&&props.selection.position===anchor.position?'is-selected':''} onClick={()=>props.onSelect({kind:'axleBox',carOrdinal:anchor.carOrdinal,position:anchor.position})}>P{anchor.position}</button>)}</div>)}
    </div>}
    {props.subsystem==='rail'&&props.selection.kind==='axleBox'&&<div className="reference-fallback__callout"><RailCallout anchor={RAIL_AXLE_BOXES[(props.selection.carOrdinal-1)*8+props.selection.position-1]} source={props.source} cursorLabel={props.cursorLabel} sensorReadout={props.sensorReadout}/></div>}
    {props.subsystem === 'door' && <DetachedRecording subsystem={props.subsystem} source={props.source} onSelect={props.onSelect} />}
  </div>;
}

export function ReferenceTrainScene(props: ReferenceTrainSceneProps) {
  const [available,setAvailable] = useState(supportsWebGL);
  const [ready,setReady] = useState(false);
  const ids = useMemo(()=>referenceCarIds(props.subsystem==='acv'||props.subsystem==='rail' ? props.carIds : []),[props.carIds,props.subsystem]);
  const selectedOrdinal = props.subsystem === 'shm' || props.subsystem === 'door' ? null : selectedCarOrdinal(props.selection,ids);
  const source = props.source;
  const fallback = <ReferenceFallback {...props} ids={ids} selectedOrdinal={selectedOrdinal}/>;
  const mappedContext = props.subsystem==='acv'||props.subsystem==='rail';
  const door = props.visualization?.door;
  const acvFirst = props.subsystem === 'acv' ? props.visualization?.acv?.rankedCars[0] : undefined;
  const acvSuspected = acvFirst && props.visualization?.acv?.hasUsableData !== false;
  const railPrediction = props.subsystem === 'rail' ? props.visualization?.rail?.prediction : undefined;
  const railAbnormal = railPrediction === 'Side I' || railPrediction === 'Side II';
  const shmPrediction = props.subsystem === 'shm' ? props.visualization?.shm?.prediction : undefined;
  const shmBand = shmRiskBand(shmPrediction);
  const sceneStatus = props.subsystem === 'door' && door ? door.completed ? `Cycle ${door.cycleNumber} · classified as ${door.prediction}` : `Cycle ${door.cycleNumber} · replaying recorded movement` : props.subsystem === 'rail' ? railPrediction ? `Recording model result · ${railPrediction}` : 'Rail model · Not analysed' : props.subsystem === 'acv' ? acvFirst ? acvSuspected ? `ACV model · Car ${acvFirst} ranked first` : 'ACV model · Insufficient thermal data' : 'ACV model · Not analysed' : props.subsystem === 'shm' ? shmBand ? `${shmBand.label} · recording-level result` : 'SHM model · Not analysed' : source ? 'Recorded source · select a component to inspect' : 'Select a recording to inspect';
  return <div className="reference-train-scene" role="group" aria-label={props.subsystem === 'door' ? 'Representative door cabin layout' : 'Eight-car dataset reference layout'} data-ready={!available||ready} data-renderer={available?'webgl':'schematic'} data-car-count={props.subsystem === 'door' ? 1 : 8} data-axle-box-count={props.subsystem==='rail'?64:0} data-layer={props.subsystem} data-xray={props.xray} data-selected-car={selectedOrdinal??''} data-acv-first-car={acvFirst ?? ''} data-rail-class={railPrediction ?? 'uncomputed'} data-shm-risk={props.subsystem === 'shm' ? shmBand?.id ?? 'uncomputed' : undefined} data-reduced-motion={props.reducedMotion} data-door-completed={door?.completed ?? false}
    style={{ '--stress-amplitude': props.reducedMotion ? 0 : unitProgress(props.visualization?.stress?.amplitude ?? 0), '--shm-risk-color': shmBand?.color } as CSSProperties}>
    <div className={`reference-scene-status${completedDoorAbnormal(door) || railAbnormal || acvSuspected ? ' is-amber' : props.subsystem === 'rail' || props.subsystem === 'acv' || (props.subsystem === 'shm' && !shmBand) ? ' is-neutral' : ''}`} role="status"><i /><span>{sceneStatus}</span></div>
    <div className="reference-train-stage">
      {available ? <ReferenceBoundary fallback={fallback} onError={()=>setAvailable(false)}><Suspense fallback={<div className="reference-loading"><i/>{props.subsystem === 'door' ? 'Loading representative cabin geometry' : 'Loading eight-car reference geometry'}</div>}>
        <Canvas shadows dpr={[1,1.5]} camera={{position:[-25,22,80],fov:35,near:.1,far:500}} gl={{antialias:true,alpha:true,powerPreference:'high-performance'}}>
          <fog attach="fog" args={['#081016',180,350]}/>
          <ContextLoss onLost={()=>setAvailable(false)}/>
          <ReferenceEnvironment/>
          <ReferenceDirection selectedOrdinal={props.subsystem === 'door' ? REPRESENTATIVE_DOOR.carOrdinal : selectedOrdinal}/>
          <ReferenceRails subsystem={props.subsystem} selection={props.selection} onSelect={props.onSelect} visualization={props.visualization}/>
          <ReferenceGeometry ids={ids} subsystem={props.subsystem} selectedOrdinal={selectedOrdinal} onSelect={props.onSelect} xray={props.xray} visualization={props.visualization} reducedMotion={props.reducedMotion} onReady={()=>setReady(true)}/>
          {props.subsystem==='rail'&&<AxleBoxLayer xray={props.xray} selectedOrdinal={selectedOrdinal} selection={props.selection} onSelect={props.onSelect} source={source} cursorLabel={props.cursorLabel} sensorReadout={props.sensorReadout}/>}
          {props.subsystem==='acv'&&selectedOrdinal&&props.visualization?.acv?.hasUsableData !== false&&props.visualization?.acv?.rankedCars.includes(ids[selectedOrdinal-1])&&<AcvCarriageInterior key={selectedOrdinal} ordinal={selectedOrdinal} carId={ids[selectedOrdinal-1]} rank={props.visualization.acv.rankedCars.indexOf(ids[selectedOrdinal-1])+1} reducedMotion={props.reducedMotion}/>}
          {props.subsystem==='shm'&&props.xray&&<StructuralInternals/>}
          {props.subsystem==='door'&&<IllustrativeDoor visualization={props.visualization} reducedMotion={props.reducedMotion} />}
          <ReferenceCamera subsystem={props.subsystem} selection={props.selection} ids={ids} fitKey={props.fitKey} reducedMotion={props.reducedMotion} visualization={props.visualization}/>
        </Canvas>
      </Suspense></ReferenceBoundary> : fallback}
      <div className="reference-vignette" aria-hidden="true"/>
    </div>
    {available && props.subsystem === 'door' && <DetachedRecording subsystem={props.subsystem} source={source} onSelect={props.onSelect}/>}
    {props.subsystem === 'shm' && <aside className="reference-shm-legend" aria-label="SHM risk legend">
      <h3>SHM risk legend</h3>
      <div className="reference-shm-result"><span>Fatigue damage</span><output aria-label="SHM fatigue damage">{shmBand ? String(shmPrediction) : 'Not analysed'}</output><strong>{shmBand?.label ?? 'Run analysis to colour the train'}</strong></div>
      <div className="reference-shm-bands">{SHM_RISK_BANDS.map(band => <div key={band.id} data-band={band.id} aria-current={band.id === shmBand?.id ? 'true' : undefined} style={{ '--band-color': band.color } as CSSProperties}>
        <i aria-hidden="true"/><span><strong>{band.label}</strong><small>{band.range}</small></span>{band.id === shmBand?.id && <b>Current</b>}
      </div>)}</div>
      <p>Recording-level colour; sensor location unavailable.</p>
      <p>Provisional display thresholds: 0.33 and 0.67. Not model-validated engineering limits.</p>
      {shmBand && shmPrediction! > 1 && <p>Above the displayed 0–1 range; the original value is preserved in red.</p>}
      <button type="button" onClick={() => props.onSelect({ kind: 'recording' })} aria-label="Inspect unlocated stress recording">Inspect source fields <span aria-hidden="true">↗</span></button>
    </aside>}
    <div className="reference-scene-caption"><span>{mappedContext ? props.subsystem==='acv' ? props.source && props.carIds.length === 8 ? 'Stable schematic car order · identity from case headers' : 'No case selected · schematic car placeholders' : 'Figure 2 reference · 8 cars / 64 axle boxes' : props.subsystem==='shm' ? props.xray ? 'X-ray internals are illustrative scaffolding, not verified engineering geometry' : 'X-ray reveals illustrative internal structure' : 'Representative cabin · physical door identity unavailable'}</span><span>Reference travel −X · schematic dimensions</span></div>
    {acvSuspected && <div className="reference-acv-key">Rank 1 = most suspected · ranking does not confirm a leak</div>}
    {props.subsystem==='rail'&&<div className="reference-rail-key" role="group" aria-label="Recording-level reference rails">
      {RAIL_SIDES.map(({side})=><button key={side} className={railPrediction === side ? 'is-predicted' : ''} onClick={()=>props.onSelect({kind:'railSide',side})} aria-label={`Select reference rail ${side}`} aria-pressed={props.selection.kind==='railSide'&&props.selection.side===side}><i/>{side}{railPrediction === side && <b>Model result</b>}<small>{side==='Side I'?'−Z / odd positions':'+Z / even positions'}</small></button>)}
      <span>{railPrediction ? 'Recording-level result · no individual car or axle-box localisation' : 'Reference rails · select a side to inspect its recorded channels'}</span>
    </div>}
  </div>;
}

export default ReferenceTrainScene;
