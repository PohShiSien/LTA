import { Component, Suspense, useEffect, useMemo, useRef, useState, type ReactNode, type CSSProperties } from 'react';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { ContactShadows, Environment, Html, Lightformer, OrbitControls, useGLTF } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import * as THREE from 'three';
import './train.css';

export type TrainDoorStatus = 'normal' | 'candidate' | 'awaiting_verification' | 'corroborated' | 'not_corroborated' | 'insufficient_evidence';
export interface TrainSceneProps {
  selectedDoor: string;
  onSelectDoor: (id: string) => void;
  doorStatuses: Record<string, TrainDoorStatus>;
  resetKey?: number;
}

const DOOR_OFFSETS = [-3.1, -1.05, 1.05, 3.1];
const STATUS_COLORS: Record<TrainDoorStatus, string> = {
  normal: '#5baea8',
  candidate: '#ffb34f',
  awaiting_verification: '#ffb34f',
  corroborated: '#ff605e',
  not_corroborated: '#68c5bb',
  insufficient_evidence: '#a8abc9',
};
const STATUS_LABELS: Record<TrainDoorStatus, string> = {
  normal: 'Normal',
  candidate: 'Candidate anomaly',
  awaiting_verification: 'Awaiting verification',
  corroborated: 'Corroborated',
  not_corroborated: 'Not corroborated',
  insufficient_evidence: 'Insufficient evidence',
};

export const TRAIN_DOORS = Array.from({ length: 24 }, (_, index) => {
  const car = Math.floor(index / 8);
  const slot = index % 8;
  // Number the far side first so the initial D07 advisory faces the camera.
  const side = slot < 4 ? -1 : 1;
  return { id: `D${String(index + 1).padStart(2, '0')}`, car, side, x: (car - 1) * 9.5 + DOOR_OFFSETS[slot % 4] };
});

type DoorLocation = (typeof TRAIN_DOORS)[number];

class SceneBoundary extends Component<{ children: ReactNode; fallback: ReactNode; onError: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onError(); }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

function supportsWebGL() {
  if (typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!context) return false;
    context.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch { return false; }
}

function useReducedMotionPreference() {
  const [reducedMotion, setReducedMotion] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return reducedMotion;
}

function MRTExterior({ onReady }: { onReady: () => void }) {
  const framesRendered = useRef(0);
  useFrame(() => {
    // Report readiness after the loaded model has had a full render frame.
    if (++framesRendered.current === 2) onReady();
  });
  const { scene } = useGLTF(`${import.meta.env.BASE_URL}models/railwitness-mrt.glb`);
  const model = useMemo(() => {
    const copy = scene.clone(true);
    copy.traverse(object => {
      if (object instanceof THREE.Mesh) { object.castShadow = true; object.receiveShadow = true; }
    });
    return copy;
  }, [scene]);
  // Opaque train surfaces must participate in pointer hit-testing. Without
  // this blocker, the event system can select a far-side door through the shell.
  return <primitive object={model}
    onPointerOver={(event: ThreeEvent<PointerEvent>) => event.stopPropagation()}
    onClick={(event: ThreeEvent<MouseEvent>) => event.stopPropagation()}
  />;
}

function DoorZone({ door, selected, status, onSelect, reducedMotion }: {
  door: DoorLocation; selected: boolean; status: TrainDoorStatus; onSelect: () => void; reducedMotion: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const bar = useRef<THREE.Mesh>(null);
  const color = STATUS_COLORS[status];
  const anomaly = status === 'candidate' || status === 'awaiting_verification' || status === 'corroborated';
  const highlight = selected || hovered;
  useFrame(({ clock }) => {
    if (!bar.current) return;
    const material = bar.current.material as THREE.MeshBasicMaterial;
    material.opacity = anomaly && !reducedMotion ? .7 + Math.sin(clock.elapsedTime * 2.5) * .25 : highlight || anomaly ? .95 : .5;
  });
  useEffect(() => () => { document.body.style.cursor = ''; }, []);
  const select = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation();
    onSelect();
  };
  return <group name={`Car${String(door.car + 1).padStart(2, '0')}_Door_${door.side > 0 ? 'L' : 'R'}_${door.id}`} position={[door.x, 1.94, door.side * 1.249]} rotation={[0, door.side < 0 ? Math.PI : 0, 0]}>
    <mesh
      onClick={select}
      onPointerOver={event => { event.stopPropagation(); setHovered(true); document.body.style.cursor = 'pointer'; }}
      onPointerOut={() => { setHovered(false); document.body.style.cursor = ''; }}
      renderOrder={2}
    >
      <planeGeometry args={[1.11, 1.91]} />
      <meshBasicMaterial color={color} transparent opacity={highlight ? .09 : 0} depthWrite={false} side={THREE.DoubleSide} />
    </mesh>
    {(highlight || anomaly) && <group>
      {[-1, 1].map(side => <mesh key={`vertical-${side}`} position={[side * .539, 0, .005]}>
        <boxGeometry args={[highlight ? .027 : .017, 1.86, .012]} />
        <meshBasicMaterial color={color} transparent opacity={highlight ? .9 : .57} toneMapped={false} />
      </mesh>)}
      {[-1, 1].map(side => <mesh key={`horizontal-${side}`} position={[0, side * .93, .005]}>
        <boxGeometry args={[1.10, .025, .012]} />
        <meshBasicMaterial color={color} transparent opacity={highlight ? .9 : .57} toneMapped={false} />
      </mesh>)}
    </group>}
    <mesh ref={bar} position={[0, 1.005, .017]}>
      <boxGeometry args={[anomaly || highlight ? .30 : .14, .047, .022]} />
      <meshBasicMaterial color={color} transparent opacity={.7} toneMapped={false} />
    </mesh>
    {(selected || hovered) && <Html position={[0, 2.08, .05]} center zIndexRange={[12, 0]} style={{ pointerEvents: 'none' }}>
      <div className={`train-door-callout${anomaly ? ' train-door-callout--anomaly' : ''}`} style={{ '--door-color': color } as CSSProperties}>
        <span className="train-door-callout__id">{door.id}</span>
        <span>{selected ? STATUS_LABELS[status] : 'Select door'}</span>
        <i />
      </div>
    </Html>}
  </group>;
}

function TrainCameraController({ selectedDoor, resetKey, reducedMotion }: Pick<TrainSceneProps, 'selectedDoor' | 'resetKey'> & { reducedMotion: boolean }) {
  const controls = useRef<OrbitControlsImpl>(null);
  const { camera, gl, size } = useThree();
  const goal = useRef({ x: 0, azimuth: -.50, running: true });
  const previousSide = useRef(1);
  useEffect(() => {
    // Fit the full train across both widescreen and narrow layouts.
    if (camera instanceof THREE.PerspectiveCamera) {
      const aspect = size.width / Math.max(1, size.height);
      camera.fov = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(2 * Math.atan(32 / (2 * 37 * aspect))), 17, 58);
      camera.updateProjectionMatrix();
    }
  }, [camera, size.width, size.height]);
  const interaction = useRef(false);
  const selected = TRAIN_DOORS.find(door => door.id === selectedDoor) ?? TRAIN_DOORS[6];
  useEffect(() => {
    const x = THREE.MathUtils.clamp(selected.x * .075, -1.05, 1.05);
    const changedSide = selected.side !== previousSide.current;
    goal.current = { x, azimuth: selected.side > 0 ? -.5 : -Math.PI + .5, running: true };
    if (changedSide) previousSide.current = selected.side;
  }, [selectedDoor, selected.side, selected.x]);
  useEffect(() => {
    if (resetKey === undefined) return;
    const side = selected.side;
    camera.position.set(-17.3, 12.1, 31.8 * side);
    controls.current?.target.set(0, 1.3, 0);
    goal.current = { x: 0, azimuth: side > 0 ? -.5 : -Math.PI + .5, running: true };
  // Reset is intentionally driven by resetKey; changing doors uses the focus transition above.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);
  useEffect(() => {
    const canvas = gl.domElement;
    const onContextMenu = (event: Event) => event.preventDefault();
    canvas.addEventListener('contextmenu', onContextMenu);
    return () => canvas.removeEventListener('contextmenu', onContextMenu);
  }, [gl]);
  useFrame((_, delta) => {
    const control = controls.current;
    if (!control) return;
    control.target.y = THREE.MathUtils.clamp(control.target.y, .85, 2.0);
    control.target.z = THREE.MathUtils.clamp(control.target.z, -.75, .75);
    control.target.x = THREE.MathUtils.clamp(control.target.x, -3, 3);
    if (!goal.current.running || interaction.current) return;
    const alpha = reducedMotion ? 1 : 1 - Math.exp(-delta * 2.8);
    const dx = (goal.current.x - control.target.x) * alpha;
    control.target.x += dx;
    camera.position.x += dx;
    const azimuth = control.getAzimuthalAngle();
    const difference = goal.current.azimuth - azimuth;
    if (Math.abs(difference) > .008) {
      const relative = camera.position.clone().sub(control.target);
      const spherical = new THREE.Spherical().setFromVector3(relative);
      spherical.theta += difference * alpha;
      camera.position.copy(control.target).add(new THREE.Vector3().setFromSpherical(spherical));
    }
    control.update();
    if (Math.abs(goal.current.x - control.target.x) < .015 && Math.abs(difference) < .008) goal.current.running = false;
  });
  return <OrbitControls ref={controls}
    makeDefault enableDamping={!reducedMotion} dampingFactor={.08} enablePan panSpeed={.3} rotateSpeed={.35} zoomSpeed={.6}
    target={[0, 1.3, 0]} minDistance={25} maxDistance={48}
    minPolarAngle={Math.PI * .28} maxPolarAngle={Math.PI * .47}
    minAzimuthAngle={-Math.PI + .18} maxAzimuthAngle={.9}
    onStart={() => { interaction.current = true; goal.current.running = false; }}
    onEnd={() => { interaction.current = false; }}
  />;
}

function TrainEnvironment() {
  const sleepers = useMemo(() => Array.from({ length: 39 }, (_, index) => index - 19), []);
  return <>
    <ambientLight intensity={.48} />
    <hemisphereLight color="#d6ecff" groundColor="#111c26" intensity={1.2} />
    <directionalLight position={[-5, 12, 8]} intensity={2.4} color="#e2eef9" castShadow shadow-mapSize={[1024, 1024]} shadow-camera-left={-18} shadow-camera-right={18} shadow-camera-top={10} shadow-camera-bottom={-10} shadow-bias={-.0004} />
    <directionalLight position={[9, 6, -10]} intensity={2.0} color="#5c99ad" />
    <directionalLight position={[-15, 4, -3]} intensity={.9} color="#f4c3b0" />
    <Environment resolution={128} frames={1}>
      <Lightformer intensity={3.7} position={[0, 9, -2]} rotation={[Math.PI / 2, 0, 0]} scale={[32, 4, 1]} />
      <Lightformer intensity={2.5} position={[0, 4, 9]} rotation={[0, Math.PI, 0]} scale={[28, 2, 1]} />
      <Lightformer intensity={1.2} color="#74b7d5" position={[0, 5, -8]} scale={[20, 3, 1]} />
    </Environment>
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -.095, 0]} receiveShadow>
      <planeGeometry args={[160, 100]} />
      <meshStandardMaterial color="#0a141c" roughness={.94} metalness={.14} />
    </mesh>
    <gridHelper args={[80, 80, '#192e37', '#152730']} position={[0, -.07, 0]} />
    <gridHelper args={[80, 16, '#1a343e', '#1a343e']} position={[0, -.065, 0]} />
    {[-.86, .86].map(z => <group key={z}>
      <mesh position={[0, .03, z]}>
        <boxGeometry args={[42, .09, .07]} />
        <meshStandardMaterial color="#718087" metalness={.85} roughness={.3} />
      </mesh>
      <mesh position={[0, -.026, z]}>
        <boxGeometry args={[42, .035, .14]} />
        <meshStandardMaterial color="#2d434d" metalness={.6} roughness={.6} />
      </mesh>
    </group>)}
    {sleepers.map(x => <mesh key={x} position={[x, -.045, 0]}>
      <boxGeometry args={[.15, .025, 2.43]} />
      <meshStandardMaterial color="#1b303b" roughness={.9} />
    </mesh>)}
    <ContactShadows position={[0, -.051, 0]} opacity={.42} scale={40} blur={1.7} far={5} resolution={256} frames={1} color="#00080d" />
  </>;
}

function ContextLossHandler({ onContextLost }: { onContextLost: () => void }) {
  const { gl } = useThree();
  useEffect(() => {
    const canvas = gl.domElement;
    const handler = (event: Event) => { event.preventDefault(); onContextLost(); };
    canvas.addEventListener('webglcontextlost', handler);
    return () => canvas.removeEventListener('webglcontextlost', handler);
  }, [gl, onContextLost]);
  return null;
}

function TrainFallback({ selectedDoor, onSelectDoor, doorStatuses }: TrainSceneProps) {
  return <div className="train-fallback" role="group" aria-label="Interactive train schematic">
    <div className="train-fallback__caption"><span className="train-fallback__signal" />Interactive fleet schematic<span>3 cars · 24 door zones</span></div>
    <div className="train-fallback__cars">
      {[0, 1, 2].map(car => <div className="train-fallback__car" key={car}>
        <div className="train-fallback__doors">
          {TRAIN_DOORS.filter(door => door.car === car && door.side < 0).map(door => <FallbackDoor key={door.id} door={door} selected={door.id === selectedDoor} status={doorStatuses[door.id] ?? 'normal'} onSelect={() => onSelectDoor(door.id)} />)}
        </div>
        <div className="train-fallback__body"><span>RW · 017</span><i /><b>0{car + 1}</b></div>
        <div className="train-fallback__doors">
          {TRAIN_DOORS.filter(door => door.car === car && door.side > 0).map(door => <FallbackDoor key={door.id} door={door} selected={door.id === selectedDoor} status={doorStatuses[door.id] ?? 'normal'} onSelect={() => onSelectDoor(door.id)} />)}
        </div>
      </div>)}
    </div>
    <div className="train-fallback__rails"><i /><i /></div>
    <p>Choose a door to inspect its telemetry. 3D rendering is unavailable in this browser.</p>
  </div>;
}

function FallbackDoor({ door, selected, status, onSelect }: { door: DoorLocation; selected: boolean; status: TrainDoorStatus; onSelect: () => void }) {
  return <button type="button" className={`train-fallback__door${selected ? ' is-selected' : ''}`} aria-pressed={selected} aria-label={`Door ${door.id}, car ${door.car + 1}, ${STATUS_LABELS[status]}`} onClick={onSelect} style={{ '--door-color': STATUS_COLORS[status] } as CSSProperties}>
    <span /><span /><b>{door.id}</b>
  </button>;
}

function DoorSelectionMap({ selectedDoor, onSelectDoor, doorStatuses }: TrainSceneProps) {
  return <div className="train-door-map" role="group" aria-label="Select one of 24 monitored doors">
    {[0, 1, 2].map(car => <div className="train-door-map__car" key={car} role="group" aria-label={`Car ${car + 1}`}>
      <span className="train-door-map__car-label">C0{car + 1}</span>
      <div className="train-door-map__buttons">
        {TRAIN_DOORS.filter(door => door.car === car).map(door => {
          const status = doorStatuses[door.id] ?? 'normal';
          return <button key={door.id} type="button" className={`train-door-map__door${selectedDoor === door.id ? ' is-selected' : ''}${status !== 'normal' ? ' has-status' : ''}`}
            aria-label={`Select door ${door.id}`} aria-pressed={selectedDoor === door.id}
            title={`${door.id} · ${STATUS_LABELS[status]}`} onClick={() => onSelectDoor(door.id)}
            style={{ '--door-color': STATUS_COLORS[status] } as CSSProperties}>
            {door.id.slice(1)}
          </button>;
        })}
      </div>
    </div>)}
  </div>;
}

export function TrainScene(props: TrainSceneProps) {
  const [available, setAvailable] = useState(supportsWebGL);
  const [modelReady, setModelReady] = useState(false);
  const reducedMotion = useReducedMotionPreference();
  const fallback = <TrainFallback {...props} />;
  return <div className="train-scene" aria-label="Train 017 interactive digital twin" data-ready={!available || modelReady} data-renderer={available ? 'webgl' : 'schematic'} data-reduced-motion={reducedMotion}>
    <div className="train-scene__stage">
    {available ? <SceneBoundary fallback={fallback} onError={() => setAvailable(false)}>
      <Suspense fallback={<div className="train-scene-loading"><span />Loading digital twin</div>}>
        <Canvas shadows dpr={[1, 1.75]} camera={{ position: [-17.3, 12.1, 31.8], fov: 24, near: .1, far: 180 }} gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }} style={{ background: 'transparent' }}>
          <fog attach="fog" args={['#081016', 40, 95]} />
          <ContextLossHandler onContextLost={() => setAvailable(false)} />
          <TrainEnvironment />
          <MRTExterior onReady={() => setModelReady(true)} />
          {TRAIN_DOORS.map(door => <DoorZone key={door.id} reducedMotion={reducedMotion} door={door} status={props.doorStatuses[door.id] ?? 'normal'} selected={props.selectedDoor === door.id} onSelect={() => props.onSelectDoor(door.id)} />)}
          <TrainCameraController selectedDoor={props.selectedDoor} resetKey={props.resetKey} reducedMotion={reducedMotion} />
        </Canvas>
      </Suspense>
    </SceneBoundary> : fallback}
    <div className="train-scene__vignette" aria-hidden="true" />
    </div>
    <DoorSelectionMap {...props} />
  </div>;
}

export default TrainScene;
