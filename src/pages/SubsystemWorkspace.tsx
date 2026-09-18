import { lazy, Suspense, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { Activity, ArrowDownToLine, ArrowRight, Box, Check, ChevronDown, ChevronRight, CircleHelp, Database, FileUp, Fingerprint, Focus, Layers3, LoaderCircle, Pin, Search, ShieldCheck, Snowflake, TrainFront, Upload, Waves, X } from 'lucide-react';
import type { AnalysisResult, CellValue, ComponentSelection, DisplayField, RecordingSummary, SourceMode, Subsystem } from '../types/multisystem';
import { initialSelection, sourceKey, workerRequest, type InspectionData, type WorkerRequest } from '../lib/workerClient';
import { fieldValue, sampleTimeLabel } from '../lib/recordings';
import { predictionCsv, predictionsZip } from '../lib/exportPredictions';
import { numericValue } from '../lib/signals';
import { RecordingTrace } from '../components/telemetry/RecordingTrace';
import { createDoorClient, type DoorAnalysis } from '../lib/railwitnessDoorClient';
import { doorAnalysisResult } from '../lib/doorBackendAnalysis';
import { useDoorCycleDetail } from '../lib/useDoorCycleDetail';
import DoorCycleEvidence from '../components/door/DoorCycleEvidence';
import DoorReplayTimeline from '../components/door/DoorReplayTimeline';
import DoorMotionVisual from '../components/door/DoorMotionVisual';
import ResultSummary from '../components/workspace/AnalysisResultSummary';
import AcvCarRanking from '../components/acv/AcvCarRanking';
import AcvPeerComparison from '../components/acv/AcvPeerComparison';
import RailEvidencePanel from '../components/rail/RailEvidencePanel';
import StressReplay from '../components/shm/StressReplay';
import FatigueDamagePanel from '../components/shm/FatigueDamagePanel';
import { useDoorReplay } from '../lib/useDoorReplay';
import type { DoorReplayCycle } from '../lib/doorReplay';
import type { VisualizationEvidence } from '../lib/visualEvidence';
import type { SubsystemVisualState } from '../types/visualization';
import { useAnalysisScan, useStressPlayback } from '../lib/useWorkspaceMotion';
import './SubsystemWorkspace.css';

const doorClient = createDoorClient(import.meta.env.VITE_DOOR_API_URL ?? 'http://127.0.0.1:8000');

const ReferenceTrainScene = lazy(() => import('../components/train/ReferenceTrainScene'));
const SUBSYSTEMS = {
  door: { title: 'Door controller', short: 'Doors', icon: Fingerprint, label: 'Cycle detection & resistance', description: 'Inspect the controller stream and its classified opening and closing cycles.', accept: '.csv' },
  acv: { title: 'Air conditioning', short: 'ACV', icon: Snowflake, label: 'Car-level leak ranking', description: 'Compare recorded conditions across eight cars and inspect the case ranking.', accept: '.xlsx,.csv' },
  rail: { title: 'Rail corrugation', short: 'Rail corrugation', icon: Waves, label: 'Recording-level rail classification', description: 'Trace axle-box measurements to their source. Inspect the predicted reference rail side.', accept: '.csv' },
  shm: { title: 'Structural health', short: 'Structural health', icon: Activity, label: 'Per-file fatigue damage', description: 'Examine a dynamic-stress segment and its cumulative fatigue damage estimate.', accept: '.csv' },
} as const;
type SessionKey = `${Subsystem}:${SourceMode}`;
interface Session { recordings: RecordingSummary[]; selectedId: string | null; cursor: number; selection: ComponentSelection; metric: string; pins: string[]; results: Record<string, AnalysisResult> }
const sessionKey = (subsystem: Subsystem, mode: SourceMode): SessionKey => `${subsystem}:${mode}`;
const newSession = (subsystem: Subsystem): Session => ({ recordings: [], selectedId: null, cursor: 0, selection: initialSelection(subsystem), metric: '', pins: [], results: {} });
const createSessions = () => Object.fromEntries((Object.keys(SUBSYSTEMS) as Subsystem[]).flatMap(subsystem => (['uploaded', 'demo'] as SourceMode[]).map(mode => [sessionKey(subsystem, mode), newSession(subsystem)]))) as Record<SessionKey, Session>;
const initialLayer = (): Subsystem => { const route = location.hash.slice(1); return route in SUBSYSTEMS ? route as Subsystem : 'rail'; };
const unmapped = { status: 'unmapped' as const, reason: 'Reference layout — asset mapping not supplied' };
const displayNumber = (value: CellValue | undefined) => value === undefined || value === null || value === '' ? 'Not recorded' : typeof value !== 'number' ? value : value !== 0 && (Math.abs(value) < .001 || Math.abs(value) >= 1e6) ? value.toExponential(5) : Number(value.toPrecision(7)).toLocaleString('en-SG', { maximumFractionDigits: 7 });
function downloadFile(name: string, data: BlobPart, type: string) { const url = URL.createObjectURL(new Blob([data], { type })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
function selectedOrdinal(selection: ComponentSelection, recording?: RecordingSummary) {
  return selection.kind === 'car' ? selection.ordinal : selection.kind === 'axleBox' ? selection.carOrdinal : selection.kind === 'door' ? Math.max(1, (recording?.carIds.indexOf(selection.carId) ?? 0) + 1) : null;
}
function selectionLabel(selection: ComponentSelection, subsystem: Subsystem): string {
  if (selection.kind === 'axleBox') return `Car ${selection.carOrdinal} · Axle box ${selection.position} · ${selection.position % 2 ? 'Side I' : 'Side II'}`;
  if (selection.kind === 'car') return `Car ${selection.carId}`;
  if (selection.kind === 'door') return `Reference door ${selection.doorId} · Car ${selection.carId}`;
  if (selection.kind === 'railSide') return `${selection.side} · recording-level reference`;
  return subsystem === 'door' ? 'Door stream — location unmapped' : subsystem === 'shm' ? 'Measurement location not supplied' : 'Recording context';
}
function fieldMatches(field: DisplayField, selection: ComponentSelection, subsystem: Subsystem, recording: RecordingSummary) {
  if (subsystem === 'shm') return true;
  if (subsystem === 'door') return recording.mapping.status === 'mapped' || selection.kind === 'recording';
  if (subsystem === 'acv') return !field.carId || selection.kind === 'recording' || (selection.kind === 'car' && field.carId === selection.carId);
  if (field.mapping.status !== 'mapped') return true;
  const anchor = field.mapping.anchor;
  if (anchor.kind !== 'axleBox') return true;
  if (selection.kind === 'axleBox') return anchor.carOrdinal === selection.carOrdinal && anchor.position === selection.position;
  if (selection.kind === 'car') return anchor.carOrdinal === selection.ordinal;
  if (selection.kind === 'railSide') return (anchor.position % 2 ? 'Side I' : 'Side II') === selection.side;
  return true;
}

export default function SubsystemWorkspace() {
  const [subsystem, setSubsystem] = useState<Subsystem>(initialLayer);
  const [mode, setMode] = useState<SourceMode>('uploaded');
  const [sessions, setSessions] = useState(createSessions);
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [doorJobs, setDoorJobs] = useState<Record<string, DoorAnalysis>>({});
  const [doorCycles, setDoorCycles] = useState<Record<string, number>>({});
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState('');
  const [dragging, setDragging] = useState(false);
  const [xray, setXray] = useState(true);
  const [fitKey, setFitKey] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [showHelp, setShowHelp] = useState(false);
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [fieldLimit, setFieldLimit] = useState(30);
  const [spectral, setSpectral] = useState(false);
  const [inspection, setInspection] = useState<{ key: string; data: InspectionData } | null>(null);
  const [inspectionBusy, setInspectionBusy] = useState(false);
  const [visualEvidence, setVisualEvidence] = useState<{ key: string; data: VisualizationEvidence | null; error: string } | null>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const helpRef = useRef<HTMLDialogElement>(null);
  const demoRequested = useRef(new Set<Subsystem>());
  const sourceFiles = useRef(new Map<string, File>());
  const operations = useRef(new Set<SessionKey>());
  const skey = sessionKey(subsystem, mode), session = sessions[skey];
  const recording = session.recordings.find(item => sourceKey(item) === session.selectedId);
  const recordingKey = recording ? sourceKey(recording) : '';
  const activeSourceKey = useRef(recordingKey);
  activeSourceKey.current = recordingKey;
  const result = session.results[recordingKey] ?? null;
  const doorJob = subsystem === 'door' && mode === 'uploaded' ? doorJobs[recordingKey] : undefined;
  const selectedDoorCycle = result?.subsystem === 'door' && result.segments.length ? doorCycles[recordingKey] ?? 0 : null;
  const doorEvidence = useDoorCycleDetail(doorClient, recordingKey, doorJob, selectedDoorCycle);
  const config = SUBSYSTEMS[subsystem];
  const carIds = recording?.carIds.length === 8 ? recording.carIds : Array.from({ length: 8 }, (_, i) => subsystem === 'rail' ? String(i + 1) : String(i + 1).padStart(2, '0'));
  const ordinal = selectedOrdinal(session.selection, recording);
  const contextFields = useMemo(() => recording?.fields.filter(field => fieldMatches(field, session.selection, subsystem, recording)) ?? [], [recording, session.selection, subsystem]);
  const numericFields = contextFields.filter(field => field.kind === 'recorded' && field.columnIndex !== recording?.timeColumnIndex);
  const preferred = subsystem === 'door' ? numericFields.find(field => /current/i.test(field.originalHeader)) : subsystem === 'rail' ? numericFields.find(field => field.mapping.status === 'mapped' && field.mapping.anchor.kind === 'axleBox') : numericFields.find(field => /indoor.*temperature/i.test(field.originalHeader));
  const metric = numericFields.find(field => field.fieldKey === session.metric) ?? preferred ?? numericFields[0];
  const companion = subsystem === 'rail' && session.selection.kind === 'axleBox' ? numericFields.find(field => field.fieldKey !== metric?.fieldKey && field.mapping.status === 'mapped' && field.mapping.anchor.kind === 'axleBox') : undefined;
  const signalKeys = [metric?.fieldKey, companion?.fieldKey].filter((key): key is string => Boolean(key)).join('|');
  const inspected = inspection?.key === recordingKey && inspection.data.cursor === session.cursor ? inspection.data : null;
  const row = inspected?.row ?? [];
  const timestamp = recording && inspected ? sampleTimeLabel(recording, row, inspected.cursor) : recording ? 'Reading selected sample…' : 'No recording selected';
  const displayedFields = (showAll ? recording?.fields ?? [] : contextFields).filter(field => `${field.originalHeader} ${field.label} ${field.kind}`.toLowerCase().includes(query.toLowerCase()));
  const visibleFields = displayedFields.slice(0, fieldLimit);
  // Overview mode can expose hundreds of fields; keep the selected trace inspectable and pinnable.
  if (metric && displayedFields.includes(metric) && !visibleFields.includes(metric)) visibleFields.unshift(metric);
  const allUploadedResults = Object.values(sessions).flatMap(item => Object.values(item.results)).filter(item => item.source.mode === 'uploaded');
  const exportableResults = allUploadedResults.filter(item => item.subsystem !== 'door' || sourceKey(item) === sessions['door:uploaded'].selectedId);
  const activeBusy = busy[skey] || busy[recordingKey];
  const mapping = recording?.mapping ?? unmapped;
  const patchSession = (key: SessionKey, update: Partial<Session> | ((previous: Session) => Session)) => setSessions(previous => ({ ...previous, [key]: typeof update === 'function' ? update(previous[key]) : { ...previous[key], ...update } }));
  const withRecording = async <T,>(request: Extract<WorkerRequest, { key: string }>, item: RecordingSummary): Promise<T> => {
    try { return await workerRequest<T>(request); }
    catch (reason) {
      if (!(reason instanceof Error) || !reason.message.includes('no longer loaded')) throw reason;
      const file = sourceFiles.current.get(sourceKey(item));
      if (item.source.mode === 'demo') await workerRequest({ type: 'demo', subsystem: item.source.subsystem });
      else if (file) await workerRequest({ type: 'load', subsystem: item.source.subsystem, fileName: file.name, contents: await file.arrayBuffer(), datasetId: item.source.datasetId });
      else throw new Error('The original file is no longer available. Upload it again.');
      return workerRequest<T>(request);
    }
  };

  useEffect(() => { const change = () => setSubsystem(initialLayer()); addEventListener('hashchange', change); return () => removeEventListener('hashchange', change); }, []);
  useEffect(() => {
    const preference = matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => setReducedMotion(preference.matches);
    preference.addEventListener('change', change);
    return () => preference.removeEventListener('change', change);
  }, []);
  useEffect(() => { setQuery(''); setShowAll(false); setFieldLimit(30); setSpectral(false); setError(''); setXray(subsystem === 'rail'); }, [subsystem, mode, recordingKey]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 4200); return () => clearTimeout(timer); }, [notice]);
  useEffect(() => {
    if (mode !== 'demo' || session.recordings.length || demoRequested.current.has(subsystem)) return;
    demoRequested.current.add(subsystem); setBusy(previous => ({ ...previous, [skey]: 'Preparing synthetic recording…' }));
    workerRequest<RecordingSummary>({ type: 'demo', subsystem }).then(loaded => patchSession(skey, previous => ({ ...previous, recordings: [loaded], selectedId: sourceKey(loaded), selection: initialSelection(subsystem, loaded) })))
      .catch(reason => { setError(reason.message); demoRequested.current.delete(subsystem); }).finally(() => setBusy(previous => { const next = { ...previous }; delete next[skey]; return next; }));
  }, [subsystem, mode, skey, session.recordings.length]);
  useEffect(() => {
    if (!recordingKey) { setInspection(null); return; }
    let cancelled = false; setInspectionBusy(true);
    withRecording<InspectionData>({ type: 'inspect', key: recordingKey, cursor: session.cursor, fields: signalKeys.split('|').filter(Boolean) }, recording!).then(data => { if (!cancelled) setInspection({ key: recordingKey, data }); }).catch(reason => { if (!cancelled) setError(reason.message); }).finally(() => { if (!cancelled) setInspectionBusy(false); });
    return () => { cancelled = true; };
  }, [recordingKey, session.cursor, signalKeys]);
  useEffect(() => { if (showHelp) helpRef.current?.showModal(); else helpRef.current?.close(); }, [showHelp]);
  useEffect(() => {
    if (!recording || subsystem === 'door') return;
    let current = true;
    setVisualEvidence(null);
    withRecording<VisualizationEvidence>({ type: 'visualEvidence', key: recordingKey }, recording)
      .then(data => { if (current) setVisualEvidence({ key: recordingKey, data, error: '' }); })
      .catch(reason => { if (current) setVisualEvidence({ key: recordingKey, data: null, error: reason instanceof Error ? reason.message : 'Recorded evidence could not be loaded.' }); });
    return () => { current = false; };
  }, [recordingKey, subsystem]);

  const addFiles = async (files: FileList | File[]) => {
    const targetSubsystem = subsystem, targetKey = sessionKey(subsystem, 'uploaded');
    if (operations.current.has(targetKey)) { setError('This source session is processing. Wait for it to finish before uploading another recording.'); return; }
    operations.current.add(targetKey);
    setMode('uploaded'); setError('');
    const failures: string[] = [];
    for (const file of Array.from(files)) {
      setBusy(previous => ({ ...previous, [targetKey]: `Reading ${file.name}…` }));
      try {
        const loaded = await workerRequest<RecordingSummary>({ type: 'load', subsystem: targetSubsystem, fileName: file.name, contents: await file.arrayBuffer(), datasetId: `ps3-${targetSubsystem}` });
        sourceFiles.current.set(sourceKey(loaded), file);
        patchSession(targetKey, previous => ({ ...previous, recordings: [...previous.recordings.filter(item => sourceKey(item) !== sourceKey(loaded)), loaded], selectedId: sourceKey(loaded), cursor: 0, selection: initialSelection(targetSubsystem, loaded), metric: '', pins: [] }));
      } catch (reason) { failures.push(`${file.name}: ${reason instanceof Error ? reason.message : 'Could not read recording.'}`); }
    }
    setBusy(previous => { const next = { ...previous }; delete next[targetKey]; return next; });
    if (failures.length) setError(failures.join('\n')); else setNotice(`${files.length} recording${files.length === 1 ? '' : 's'} loaded. Ready for analysis.`);
    if (uploadInput.current) uploadInput.current.value = '';
    operations.current.delete(targetKey);
  };
  const runAnalysis = async (all = false) => {
    const targetKey = skey;
    if (operations.current.has(targetKey)) return;
    operations.current.add(targetKey);
    const targets = all ? session.recordings : recording ? [recording] : [];
    setError('');
    for (const item of targets) {
      const key = sourceKey(item); setBusy(previous => ({ ...previous, [key]: `Analysing ${item.source.fileName}…`, [targetKey]: `Analysing ${item.source.fileName}…` }));
      // A failed Door re-analysis must not leave a previous result presented as this run.
      if (item.source.subsystem === 'door' && item.source.mode === 'uploaded') {
        setDoorJobs(previous => { const next = { ...previous }; delete next[key]; return next; });
        patchSession(targetKey, previous => { const results = { ...previous.results }; delete results[key]; return { ...previous, results }; });
      }
      try {
        let output: AnalysisResult;
        if (item.source.subsystem === 'door' && item.source.mode === 'uploaded') {
          const file = sourceFiles.current.get(key);
          if (!file) throw new Error('The original Door CSV is unavailable. Upload it again before analysis.');
          const analysis = await doorClient.analyse(file);
          output = doorAnalysisResult(analysis, item);
          setDoorJobs(previous => ({ ...previous, [key]: analysis }));
          setDoorCycles(previous => ({ ...previous, [key]: 0 }));
        } else {
          output = await withRecording<AnalysisResult>({ type: 'analyse', key }, item);
        }
        patchSession(targetKey, previous => ({ ...previous, results: { ...previous.results, [key]: output } }));
        if ((output.subsystem === 'acv' || output.subsystem === 'rail') && activeSourceKey.current === key) setFitKey(value => value + 1);
      }
      catch (reason) { setError(reason instanceof Error ? reason.message : 'Analysis failed. No prediction was generated.'); }
      finally { setBusy(previous => { const next = { ...previous }; delete next[key]; delete next[targetKey]; return next; }); }
    }
    operations.current.delete(targetKey);
  };
  const selectRecording = (key: string) => { const item = session.recordings.find(candidate => sourceKey(candidate) === key); patchSession(skey, { selectedId: key, cursor: 0, selection: initialSelection(subsystem, item), metric: '', pins: [] }); };
  const removeRecording = () => {
    if (!recording) return;
    void workerRequest({ type: 'remove', key: recordingKey }).catch(() => {});
    sourceFiles.current.delete(recordingKey);
    setDoorJobs(previous => { const next = { ...previous }; delete next[recordingKey]; return next; });
    setDoorCycles(previous => { const next = { ...previous }; delete next[recordingKey]; return next; });
    if (mode === 'demo') demoRequested.current.delete(subsystem);
    patchSession(skey, previous => {
      const remaining = previous.recordings.filter(item => sourceKey(item) !== recordingKey);
      const results = { ...previous.results }; delete results[recordingKey];
      return { ...previous, recordings: remaining, selectedId: remaining[0] ? sourceKey(remaining[0]) : null, results, cursor: 0, metric: '', pins: [], selection: initialSelection(subsystem, remaining[0]) };
    });
  };
  const selectComponent = (selection: ComponentSelection) => patchSession(skey, { selection: subsystem === 'shm' ? { kind: 'recording' } : selection, metric: subsystem === 'acv' && selection.kind === 'car' ? recording?.fields.find(field => field.carId === selection.carId && field.label === metric?.label)?.fieldKey ?? '' : '' });
  const cursorTo = (cursor: number) => { if (recording) patchSession(skey, { cursor: Math.max(0, Math.min(recording.rowCount - 1, cursor)) }); };
  const saveCsv = async () => {
    if (!result || exporting) return;
    setExporting(true); setError('');
    try {
      if (result.subsystem === 'door' && result.source.mode === 'uploaded') {
        const job = doorJobs[sourceKey(result)];
        if (!job) throw new Error('Door analysis is unavailable. Run analysis again before downloading.');
        downloadFile('door_predictions.csv', await doorClient.csv(job.job_id), 'text/csv;charset=utf-8');
      } else {
        downloadFile(`${mode === 'demo' ? 'demo_' : ''}${subsystem}_predictions.csv`, predictionCsv([result], subsystem), 'text/csv;charset=utf-8');
      }
    } catch (reason) { setError((reason as Error).message); }
    finally { setExporting(false); }
  };
  const saveZip = async () => {
    if (exporting) return;
    setExporting(true); setError('');
    try {
      const door = exportableResults.find(item => item.subsystem === 'door');
      let doorCsv: Uint8Array<ArrayBuffer> | undefined;
      if (door) {
        const job = doorJobs[sourceKey(door)];
        if (!job) throw new Error('Door analysis is unavailable. Run analysis again before exporting the ZIP.');
        doorCsv = await doorClient.csv(job.job_id);
      }
      downloadFile('predictions.zip', predictionsZip(exportableResults, { doorCsv }), 'application/zip');
      setNotice('Prediction CSVs exported. Door bytes come directly from the frozen-model backend.');
    } catch (reason) { setError((reason as Error).message); }
    finally { setExporting(false); }
  };
  const updateDoorCycle = (index: number) => {
    if (result?.subsystem !== 'door') return;
    const segment = result.segments[index];
    if (!segment) return;
    selectComponent({ kind: 'recording' }); cursorTo(segment.startIndex);
    setDoorCycles(previous => ({ ...previous, [recordingKey]: index }));
  };
  const drop = (event: DragEvent) => { event.preventDefault(); setDragging(false); if (event.dataTransfer.files.length) void addFiles(event.dataTransfer.files); };
  const currentSignal = inspected?.signals.find(signal => signal.fieldKey === metric?.fieldKey);
  const vibrationField = contextFields.find(field => /vibration/i.test(field.originalHeader)), shockField = contextFields.find(field => /shock/i.test(field.originalHeader));
  const replayCycles = useMemo<DoorReplayCycle[]>(() => result?.subsystem === 'door' ? result.segments.map((segment, index) => ({
    index, startTime: segment.start_time, endTime: segment.end_time, startIndex: segment.startIndex, endIndex: segment.endIndex,
    prediction: segment.prediction, operation: doorJob?.segments[index]?.operation_inferred ?? segment.operation ?? 'Unknown',
  })) : [], [result, doorJob]);
  const replay = useDoorReplay({ sourceKey: `${skey}:${recordingKey}:${doorJob?.job_id ?? result?.analysedAt ?? ''}`, cycles: replayCycles,
    selectedIndex: selectedDoorCycle ?? 0, onSelect: updateDoorCycle,
    ready: !doorJob || Boolean(doorEvidence.detail && !doorEvidence.loading && !doorEvidence.error), reducedMotion });
  const selectDoorCycle = (index: number) => {
    replay.select(index);
    document.getElementById('subsystem-train')?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
  };
  const selectedReplayCycle = replayCycles.find(cycle => cycle.index === selectedDoorCycle);
  const sourceReplayStep = Math.floor(replay.progress * 20);
  useEffect(() => {
    if (!replay.playing || !selectedReplayCycle) return;
    cursorTo(selectedReplayCycle.startIndex + Math.round((selectedReplayCycle.endIndex - selectedReplayCycle.startIndex) * sourceReplayStep / 20));
  }, [replay.playing, sourceReplayStep, selectedReplayCycle]);
  const scan = useAnalysisScan(result ? `${recordingKey}:${result.analysedAt}` : '', subsystem === 'acv' || subsystem === 'rail', reducedMotion);
  const stress = useStressPlayback(subsystem === 'shm' ? recordingKey : '', subsystem === 'shm' ? recording?.rowCount ?? 0 : 0, session.cursor, cursorTo);
  useEffect(() => { if (reducedMotion) stress.pause(); }, [reducedMotion]);
  const stableSignal = inspection?.key === recordingKey ? inspection.data.signals.find(signal => signal.fieldKey === metric?.fieldKey) ?? null : null;
  const stressPoint = stableSignal?.points.reduce((nearest, point) => Math.abs(point.index - session.cursor) < Math.abs(nearest.index - session.cursor) ? point : nearest, stableSignal.points[0]);
  const visualization: SubsystemVisualState = {
    analysisPhase: scan.phase, scanProgress: scan.progress,
    door: selectedReplayCycle ? { cycleNumber: selectedReplayCycle.index + 1, operation: selectedReplayCycle.operation, progress: replay.progress, completed: replay.completed, prediction: selectedReplayCycle.prediction } : undefined,
    stress: subsystem === 'shm' ? { progress: stress.progress, playing: stress.playing, amplitude: Math.min(1, Math.abs(stressPoint?.value ?? 0) / (stableSignal?.statistics.peak || 1)) } : undefined,
  };
  const supplemental = visualEvidence?.key === recordingKey ? visualEvidence : null;
  const selectAcvCar = (carId: string) => selectComponent({ kind: 'car', carId, ordinal: carIds.indexOf(carId) + 1 });

  return <div className="multi-shell" data-reduced-motion={reducedMotion} data-subsystem={subsystem}>
    <a className="ms-skip" href="#workspace-content" onClick={event => { event.preventDefault(); document.getElementById('workspace-content')?.focus(); }}>Skip to workspace</a>
    <aside className="ms-sidebar"><a className="ms-brand" href="#rail" onClick={() => setSubsystem('rail')}><span>R</span>RailWitness</a><p className="ms-brand-caption">EVIDENCE IN CONTEXT</p><span className="ms-nav-caption">SUBSYSTEM WORKSPACE</span><nav aria-label="Subsystems">{(Object.entries(SUBSYSTEMS) as [Subsystem, typeof SUBSYSTEMS[Subsystem]][]).map(([id, item]) => <button key={id} className={id === subsystem ? 'active' : ''} aria-current={id === subsystem ? 'page' : undefined} onClick={() => { location.hash = id; setSubsystem(id); }}><item.icon size={17}/><span>{item.short}</span>{id === subsystem && <i/>}</button>)}</nav><div className="ms-sidebar-bottom"><div className="ms-independence"><Layers3 size={17}/><p>Four independent datasets.<br/>One reference workspace.</p></div><button className="ms-help" onClick={() => setShowHelp(true)}><CircleHelp size={16}/>How it works</button><p className="ms-sidebar-version">RAILWITNESS <span>v3.0</span></p></div></aside>
    <div className="ms-main"><header className="ms-topbar"><div><Box size={13}/><span>Reference workspace</span><ChevronRight size={12}/><strong>{config.short}</strong></div><span className={`ms-mode-chip ${mode}`}>{mode === 'demo' ? 'SYNTHETIC DEMO' : 'UPLOADED SOURCES'}</span></header>
      <main id="workspace-content" className="ms-workspace" tabIndex={-1}>
        <div className="ms-page-heading"><div><div className="ms-eyebrow">{config.label}</div><h1>{config.title}</h1><p>{config.description}</p></div><button className="ms-button" disabled={!exportableResults.length || exporting} onClick={() => void saveZip()}><ArrowDownToLine size={14}/>predictions.zip<span className="ms-count">{exportableResults.length}</span></button></div>
        <section className="ms-source-panel" aria-label="Recording selection" onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={drop} data-dragging={dragging}>
          <div className="ms-source-mode" role="group" aria-label="Source mode"><button className={mode === 'uploaded' ? 'active' : ''} onClick={() => setMode('uploaded')}>Uploaded sources</button><button className={mode === 'demo' ? 'active' : ''} onClick={() => setMode('demo')}>Synthetic demo</button></div>
          <div className="ms-source-controls"><button className="ms-upload" onClick={() => uploadInput.current?.click()} disabled={Boolean(busy[skey])}><Upload size={16}/><span>Upload recording<small>or drop {config.accept.replaceAll('.', '').toUpperCase()} here</small></span></button><input ref={uploadInput} type="file" multiple accept={config.accept} aria-label="Upload recording files" className="ms-file-input" onChange={event => { if (event.target.files) void addFiles(event.target.files); }}/><label className="ms-file-select"><span>SELECTED RECORDING</span><select aria-label="Selected recording" value={session.selectedId ?? ''} onChange={event => selectRecording(event.target.value)}><option value="" disabled>{activeBusy ? 'Preparing recording…' : 'No recording loaded'}</option>{session.recordings.map(item => <option value={sourceKey(item)} key={sourceKey(item)}>{item.source.fileName}{session.recordings.filter(candidate => candidate.source.fileName === item.source.fileName).length > 1 ? ` · source ${item.source.fileId.split(':').at(-1)?.slice(0, 8)}` : ''}</option>)}</select></label>{recording && mode === 'uploaded' && <button className="ms-button small" aria-label="Remove selected recording" title="Remove selected recording and its result" disabled={Boolean(activeBusy)} onClick={removeRecording}><X size={14}/></button>}<button className="ms-button primary" onClick={() => void runAnalysis()} disabled={!recording || Boolean(activeBusy)}>{activeBusy ? <LoaderCircle className="spin" size={14}/> : <Activity size={14}/>}<span>{activeBusy ? 'Processing…' : result ? 'Run again' : 'Run analysis'}</span></button>{session.recordings.length > 1 && <button className="ms-button" onClick={() => void runAnalysis(true)} disabled={Boolean(activeBusy)}>Analyse all {session.recordings.length}</button>}<button className="ms-button" onClick={() => void saveCsv()} disabled={!result || exporting}><ArrowDownToLine size={14}/>CSV</button></div>
          <div className={`ms-source-context ${mode}`}><Database size={12}/>{mode === 'demo' ? <span>Authored synthetic data and demonstration results. Excluded from uploaded-data prediction exports.</span> : <span>{recording ? `${recording.source.datasetId} / ${recording.source.fileName} · ${recording.rowCount.toLocaleString()} rows · ${recording.fields.length} source fields` : subsystem === 'door' ? 'Door source inspection runs in your browser. Run analysis sends the original CSV to the configured Door backend.' : 'Files are processed locally in your browser. Select the matching subsystem before uploading.'}</span>}{subsystem === 'door' && mode === 'uploaded' && recording && <span className="ms-door-route">Prediction: frozen Python backend</span>}{activeBusy && <strong role="status">{activeBusy}</strong>}</div>
        </section>
        {error && <div className="ms-error" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}><X size={15}/></button></div>}
        {recording?.warnings.length ? <details className="ms-source-warnings"><summary><CircleHelp size={12}/>{recording.warnings.length} source note{recording.warnings.length === 1 ? '' : 's'}<ChevronDown size={12}/></summary>{recording.warnings.map(warning => <p key={warning}>{warning}</p>)}</details> : null}
        <section id="subsystem-train" className="ms-train-panel" aria-label="Eight-car reference workspace"><div className="ms-scene-heading"><div><span className="ms-eyebrow">01 · WHAT WAS ANALYSED</span><h2>{subsystem === 'door' ? 'Recorded door movements' : subsystem === 'acv' ? 'Eight cars. One relative ranking.' : subsystem === 'rail' ? 'Follow the evidence to the rail side.' : 'Stress in context.'}</h2><p>{subsystem === 'door' && mode === 'uploaded' ? 'Illustrative location; physical asset metadata unavailable' : subsystem === 'door' || subsystem === 'shm' ? 'Reference layout — asset mapping not supplied' : subsystem === 'acv' ? recording ? 'Stable labelled schematic order · car identities are preserved from this file' : 'Select a case to discover its exact car identifiers · schematic placeholders shown' : '64 axle boxes · 128 measurement channels · two reference rail sides'}</p></div><div className="ms-scene-controls"><label><input type="checkbox" checked={xray} onChange={event => setXray(event.target.checked)}/>X-ray</label><button className="ms-button small" onClick={() => { selectComponent({ kind: 'recording' }); setFitKey(value => value + 1); }}><Focus size={13}/>Fit train</button></div></div>
          <div className="ms-scene"><Suspense fallback={<div className="ms-scene-loading"><LoaderCircle className="spin" size={24}/>Loading reference layout</div>}><ReferenceTrainScene subsystem={subsystem} carIds={carIds} selection={session.selection} onSelect={selectComponent} result={result} mapping={mapping} xray={xray} reducedMotion={reducedMotion} fitKey={fitKey} visualization={visualization} source={recording?.source ?? null} cursorLabel={timestamp} sensorReadout={inspected && session.selection.kind === 'axleBox' ? { vibration: vibrationField ? numericValue(row[vibrationField.columnIndex]) : null, shock: shockField ? numericValue(row[shockField.columnIndex]) : null } : undefined}/></Suspense></div>
          {selectedReplayCycle && <section id="door-replay" className="ms-door-replay" aria-label="Recorded Door replay">
          <DoorReplayTimeline cycles={replayCycles} selectedIndex={selectedDoorCycle ?? 0} playing={replay.playing} progress={replay.progress} onPlay={replay.play} onPause={replay.pause} onPrevious={replay.previous} onNext={replay.next} onSelect={replay.select} reducedMotion={reducedMotion}/>
            <details className="ms-motion-alternative"><summary>Illustrative movement detail · physical door identity unavailable</summary><DoorMotionVisual operation={selectedReplayCycle.operation} progress={replay.progress} completed={replay.completed} prediction={selectedReplayCycle.prediction} reducedMotion={reducedMotion}/></details>
          </section>}
          <nav className="ms-car-navigator" aria-label="Carriage navigator"><span>REFERENCE CARS</span>{carIds.map((id, index) => <button key={`${id}-${index}`} className={ordinal === index + 1 ? 'active' : ''} aria-label={`Select car ${id}`} aria-pressed={ordinal === index + 1} onClick={() => selectComponent({ kind: 'car', carId: id, ordinal: index + 1 })}><TrainFront size={13}/><strong>{id}</strong>{subsystem === 'acv' && result?.subsystem === 'acv' && <small>#{result.rankedCars.indexOf(id) + 1}</small>}</button>)}</nav>
          <div className="ms-scene-note"><span><span className="ms-kind metadata">Metadata</span>{subsystem === 'rail' ? 'Reference travel: −X. Side I = −Z; Side II = +Z. Camera rotation does not change channel identity.' : 'Drawn geometry is schematic. Dataset recordings do not establish a shared physical train or timeline.'}</span><label><input type="checkbox" checked={reducedMotion} onChange={event => setReducedMotion(event.target.checked)}/>Reduce motion</label></div>
        </section>
        <ResultSummary result={result} recording={recording} onCycle={selectDoorCycle} doorAnalysis={doorJob} selectedCycle={selectedDoorCycle} concealReplay={Boolean(selectedReplayCycle && (!replay.completed || replay.playing))}/>
        {doorJob && <div id="door-cycle-evidence"><DoorCycleEvidence detail={doorEvidence.detail} loading={doorEvidence.loading} error={doorEvidence.error} sourceName={doorJob.source_name} cycleNumber={selectedDoorCycle === null ? null : selectedDoorCycle + 1} onRetry={doorEvidence.retry} replayProgress={replay.progress} concealResult={!replay.completed}/></div>}
        {result?.subsystem === 'acv' && recording && <div className="ms-acv-visuals"><AcvCarRanking result={result} recording={recording} selectedCarId={session.selection.kind === 'car' ? session.selection.carId : undefined} onSelectCar={selectAcvCar} scanning={scan.phase === 'scanning'}/><AcvPeerComparison result={result} recording={recording} selectedCarId={session.selection.kind === 'car' ? session.selection.carId : undefined} onSelectCar={selectAcvCar} evidence={supplemental?.data?.subsystem === 'acv' ? supplemental.data : null} loading={!supplemental} error={supplemental?.error}/></div>}
        {result?.subsystem === 'rail' && recording && <RailEvidencePanel result={result} recording={recording} evidence={supplemental?.data?.subsystem === 'rail' ? supplemental.data : null} loading={!supplemental} error={supplemental?.error} onSelectSide={side => selectComponent({ kind: 'railSide', side })}/>}
        {subsystem === 'shm' && recording && <div className="ms-shm-visuals">
          <StressReplay signal={stableSignal} rowCount={recording.rowCount} sampleRateHz={recording.sampleRateHz} cursor={session.cursor} onCursor={cursor => { stress.pause(); cursorTo(cursor); }} playing={stress.playing} onToggle={stress.toggle} reducedMotion={reducedMotion} unit={metric?.displayUnit}/>
          {result?.subsystem === 'shm' && <FatigueDamagePanel result={result} recording={recording} evidence={supplemental?.data?.subsystem === 'shm' ? supplemental.data : null} loading={!supplemental} error={supplemental?.error}/>}
        </div>}

        <section className="ms-inspector" id="evidence-inspector" aria-label="Evidence inspector"><div className="ms-inspector-heading"><div><span className="ms-eyebrow">PINNED EVIDENCE INSPECTOR</span><h2>{selectionLabel(session.selection, subsystem)}</h2><p>{recording ? `${recording.source.datasetId} / ${recording.source.fileName}` : 'Select a source to inspect its recorded fields.'}</p></div><span className="ms-kind recorded">Recorded</span></div>
          {subsystem === 'rail' && ordinal && <div className="ms-sensor-navigator" role="group" aria-label={`Car ${ordinal} axle boxes`}><span>AXLE BOX</span>{Array.from({ length: 8 }, (_, index) => <button key={index} className={session.selection.kind === 'axleBox' && session.selection.position === index + 1 ? 'active' : ''} onClick={() => selectComponent({ kind: 'axleBox', carOrdinal: ordinal, position: index + 1 })} aria-label={`Select car ${ordinal} axle box ${index + 1}`}>{index + 1}<small>{index % 2 ? 'II' : 'I'}</small></button>)}</div>}
          {((subsystem === 'door' && session.selection.kind !== 'recording' && mapping.status === 'unmapped') || subsystem === 'shm') && <div className="ms-unmapped"><Box size={17}/><p>{subsystem === 'door' ? 'No uploaded controller stream is mapped to this rendered component.' : 'Measurement location not supplied. This file is not assigned to any car or bogie.'}</p>{subsystem === 'door' && <button className="ms-text-button" onClick={() => selectComponent({ kind: 'recording' })}>Inspect unlocated stream<ArrowRight size={12}/></button>}</div>}
          {recording ? <>
            <div className="ms-time-control"><label htmlFor="source-sample-cursor">SAMPLE CURSOR <strong>{timestamp}</strong></label><input id="source-sample-cursor" type="range" min={0} max={Math.max(0, recording.rowCount - 1)} value={session.cursor} onChange={event => cursorTo(Number(event.target.value))} aria-label="Recording sample cursor"/><span><input className="ms-sample-number" type="number" min={1} max={recording.rowCount} value={session.cursor + 1} aria-label="Sample number" onChange={event => { const value = Number(event.target.value); if (Number.isInteger(value) && value >= 1) cursorTo(value - 1); }}/> / {recording.rowCount.toLocaleString()}{inspectionBusy && <LoaderCircle size={11} className="spin"/>}</span></div>
            {session.pins.length > 0 && <div className="ms-pinned-fields">{session.pins.map(key => { const field = recording.fields.find(item => item.fieldKey === key); if (!field) return null; const reading = fieldValue(recording, field, row); return <div key={key}><span><Pin size={10}/>{field.originalHeader}</span><strong>{inspected ? reading.validity === 'invalid' ? 'Invalid' : displayNumber(reading.value) : '…'} <small>{field.displayUnit ?? 'unit unknown'}</small></strong><button aria-label={`Unpin ${field.label}`} onClick={() => patchSession(skey, { pins: session.pins.filter(item => item !== key) })}><X size={11}/></button></div>; })}</div>}
            <div className="ms-evidence-grid"><div className="ms-signal-area"><div className="ms-metric-controls"><label>Metric<select aria-label="Metric" value={metric?.fieldKey ?? ''} onChange={event => patchSession(skey, { metric: event.target.value })}>{!numericFields.length && <option value="">No mapped fields</option>}{numericFields.map(field => <option key={field.fieldKey} value={field.fieldKey}>{field.carId ? `${field.carId} · ` : ''}{field.label}</option>)}</select></label>{subsystem === 'rail' && currentSignal?.spectrum && <div className="ms-chart-tabs"><button onClick={() => setSpectral(false)} className={!spectral ? 'active' : ''}>Trace</button><button onClick={() => setSpectral(true)} className={spectral ? 'active' : ''}>Spectrum</button></div>}</div>
              {metric && currentSignal ? <><RecordingTrace signal={currentSignal} cursor={session.cursor} rowCount={recording.rowCount} sampleRateHz={recording.sampleRateHz} unit={metric.displayUnit} label={metric.label} onCursor={cursorTo} spectrum={spectral}/><div className="ms-derived-stats"><div><span><span className="ms-kind derived">Derived</span>RMS</span><strong>{displayNumber(currentSignal.statistics.rms)}<small>{metric.displayUnit ?? 'unit unknown'}</small></strong></div><div><span>Absolute peak</span><strong>{displayNumber(currentSignal.statistics.peak)}<small>{metric.displayUnit ?? 'unit unknown'}</small></strong></div><div><span>Numeric coverage</span><strong>{currentSignal.statistics.count.toLocaleString()}<small>/ {recording.rowCount.toLocaleString()}</small></strong></div></div><p className="ms-derivation-note">Calculated over samples 1–{recording.rowCount.toLocaleString()} of {recording.source.fileName}. These descriptive features do not by themselves explain the model decision.</p></> : <div className="ms-chart-empty"><Waves size={28}/><p>{inspectionBusy ? 'Reading the original samples…' : numericFields.length ? 'Choose a numeric recorded field to inspect its trace.' : 'No recording is physically mapped to this selection.'}</p></div>}
              {subsystem === 'rail' && companion && inspected?.signals.find(signal => signal.fieldKey === companion.fieldKey) && <details className="ms-companion"><summary>{companion.label}<ChevronDown size={12}/></summary><RecordingTrace signal={inspected.signals.find(signal => signal.fieldKey === companion.fieldKey)!} cursor={session.cursor} rowCount={recording.rowCount} sampleRateHz={recording.sampleRateHz} unit={companion.displayUnit} label={companion.label} onCursor={cursorTo}/></details>}
              {subsystem === 'acv' && metric && <div className="ms-car-comparison"><h3>Same field across all cars</h3><p>Recorded at {timestamp}. Missing fields stay unrecorded.</p>{carIds.map(id => { const field = recording.fields.find(item => item.carId === id && item.label === metric.label); const reading = field ? fieldValue(recording, field, row) : null; return <button key={id} onClick={() => selectComponent({ kind: 'car', carId: id, ordinal: carIds.indexOf(id) + 1 })}><span>Car {id}</span><strong>{reading && inspected ? reading.validity === 'invalid' ? 'Invalid' : displayNumber(reading.value) : 'Not recorded'}</strong><small>{reading?.validity === 'unknown' ? 'Validity code unknown' : reading?.validity === 'valid' ? (field?.displayUnit ?? 'Unit unknown') : reading?.validity === 'invalid' ? 'Invalid' : 'Not recorded'}</small></button>; })}</div>}
            </div><div className="ms-field-browser"><div className="ms-field-heading"><h3>Source fields <span>{displayedFields.length}</span></h3><label><input type="checkbox" checked={showAll} onChange={event => { setShowAll(event.target.checked); setFieldLimit(30); }}/>All recording fields</label></div><label className="ms-search"><Search size={14}/><input value={query} onChange={event => { setQuery(event.target.value); setFieldLimit(30); }} placeholder="Search names, channels, metadata…" aria-label="Search source fields"/></label><div className="ms-field-list" role="region" aria-label="Searchable source fields" tabIndex={0}>{visibleFields.map(field => { const reading = fieldValue(recording, field, row); return <details key={field.fieldKey} className={`ms-field ${metric?.fieldKey === field.fieldKey ? 'selected' : ''}`}><summary><span className={`ms-kind ${field.kind}`}>{field.kind}</span><span className="ms-field-name">{field.originalHeader}</span><strong>{inspected ? reading.validity === 'invalid' ? 'Invalid' : displayNumber(reading.value) : '…'}</strong><ChevronDown size={11}/></summary><div className="ms-field-details"><dl><div><dt>Source column</dt><dd>{field.columnIndex + 1} (index {field.columnIndex})</dd></div><div><dt>Raw value / unit</dt><dd>{inspected ? reading.raw === null || reading.raw === undefined || reading.raw === '' ? 'Not recorded' : String(reading.raw) : '…'} · {field.rawUnit ?? 'Unit not supplied'}</dd></div><div><dt>Display value / unit</dt><dd>{inspected ? displayNumber(reading.value) : '…'} · {field.displayUnit ?? 'Unit not supplied'}</dd></div><div><dt>Validity</dt><dd>{inspected ? reading.validity === 'unknown' ? 'Code meaning not supplied' : reading.validity.replace('_', ' ') : 'Reading sample…'}</dd></div><div><dt>Source identity</dt><dd>{field.source.fileId}</dd></div><div><dt>Source / scope</dt><dd>{field.source.subsystem} / {field.source.datasetId} / {field.source.fileName} · {field.scope} · sample {session.cursor + 1}</dd></div><div><dt>Mapping</dt><dd>{field.mapping.status === 'mapped' ? field.mapping.provenance : field.mapping.reason}</dd></div>{field.displayScale !== undefined && field.displayScale !== 1 && <div><dt>Conversion</dt><dd>Raw × {field.displayScale} = displayed value</dd></div>}</dl>{field.description && <p>{field.description}</p>}<div className="ms-field-actions"><button onClick={() => { patchSession(skey, { metric: field.fieldKey }); if (showAll) { const anchor = field.mapping.status === 'mapped' ? field.mapping.anchor : null; if (anchor?.kind === 'axleBox') patchSession(skey, { selection: { kind: 'axleBox', carOrdinal: anchor.carOrdinal, position: anchor.position } }); else if (field.carId) patchSession(skey, { selection: { kind: 'car', carId: field.carId, ordinal: carIds.indexOf(field.carId) + 1 } }); } }}><Waves size={12}/>View trace</button><button disabled={!session.pins.includes(field.fieldKey) && session.pins.length >= 4} onClick={() => patchSession(skey, { pins: session.pins.includes(field.fieldKey) ? session.pins.filter(key => key !== field.fieldKey) : [...session.pins, field.fieldKey] })}><Pin size={12}/>{session.pins.includes(field.fieldKey) ? 'Unpin field' : 'Pin field'}</button></div></div></details>; })}{displayedFields.length > fieldLimit && <button className="ms-show-more" onClick={() => setFieldLimit(value => value + 50)}>Show next {Math.min(50, displayedFields.length - fieldLimit)} fields</button>}{!displayedFields.length && <p className="ms-no-fields">No matching source fields in this selection.</p>}</div></div></div>
          </> : <div className="ms-empty-inspector"><FileUp size={29}/><h3>Your recording is the source of truth.</h3><p>Upload a file to discover its actual fields, units and available identity information.</p><button className="ms-button" onClick={() => uploadInput.current?.click()}>Choose recording<ArrowRight size={13}/></button></div>}
        </section>
        <footer className="ms-footer"><span><ShieldCheck size={11}/>Model outputs support investigation. They do not certify mechanical condition.</span><span>Independent datasets · schematic geometry · scoped inference</span></footer>
      </main>
    </div>
    {notice && <div className="ms-notice" role="status"><Check size={14}/>{notice}</div>}
    <dialog className="ms-dialog" ref={helpRef} onClose={() => setShowHelp(false)} onClick={event => { if (event.target === event.currentTarget) setShowHelp(false); }}><div><header><h2>One workspace. Four independent sources.</h2><button aria-label="Close help" onClick={() => setShowHelp(false)}><X size={17}/></button></header><ol><li>Select the subsystem that matches your recording.</li><li>Upload CSV or ACV XLSX data, then run analysis.</li><li>Select a relevant car, axle box or unlocated stream to inspect actual recorded fields.</li><li>Use the sample cursor, metric selector and pinned fields to review evidence.</li><li>Download a selected result as CSV, or all uploaded results in predictions.zip.</li></ol><p>Rail predictions classify the recording's rail side. ACV ranks cars across a case. SHM produces one numeric value per stress file. Door results classify detected cycles. No shared train identity or synchronized timeline is implied.</p><p>Synthetic demo mode uses authored fixtures and separate exports. Real uploads never receive demo predictions as a fallback. For Door, the ZIP uses the currently selected analysed stream because its required CSV has no file identifier column.</p><button className="ms-button primary" onClick={() => setShowHelp(false)}>Return to workspace</button></div></dialog>
  </div>;
}
