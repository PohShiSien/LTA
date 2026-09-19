import { lazy, Suspense, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { Activity, ArrowDownToLine, ArrowRight, Box, Check, ChevronDown, ChevronRight, CircleHelp, Database, FileUp, Fingerprint, Focus, Info, Layers3, LoaderCircle, Pin, Search, ShieldCheck, Snowflake, TrainFront, Upload, Waves, X } from 'lucide-react';
import type { AnalysisResult, CellValue, ComponentSelection, DisplayField, RecordingSummary, Subsystem } from '../types/multisystem';
import { initialSelection, sourceKey, workerRequest, type InspectionData, type WorkerRequest } from '../lib/workerClient';
import { fieldValue, sampleTimeLabel } from '../lib/recordings';
import { numericValue } from '../lib/signals';
import { selectedCarOrdinal } from '../lib/topology';
import { RecordingTrace } from '../components/telemetry/RecordingTrace';
import { createDoorClient, type DoorAnalysis } from '../lib/railwitnessDoorClient';
import { createModelClient, type ModelAnalysis } from '../lib/modelBackend';
import { doorAnalysisResult } from '../lib/doorBackendAnalysis';
import { useDoorCycleDetail } from '../lib/useDoorCycleDetail';
import DoorCycleEvidence from '../components/door/DoorCycleEvidence';
import DoorReplayTimeline from '../components/door/DoorReplayTimeline';
import DoorMotionVisual from '../components/door/DoorMotionVisual';
import ResultSummary, { NextSteps } from '../components/workspace/AnalysisResultSummary';
import StressReplay from '../components/shm/StressReplay';
import { useDoorReplay } from '../lib/useDoorReplay';
import type { DoorReplayCycle } from '../lib/doorReplay';
import type { SubsystemVisualState } from '../types/visualization';
import { useStressPlayback } from '../lib/useWorkspaceMotion';
import { LogoMark } from '../components/brand/Logo';
import './SubsystemWorkspace.css';

const apiUrl = import.meta.env.VITE_API_URL ?? import.meta.env.VITE_DOOR_API_URL ?? 'http://127.0.0.1:8000';
const doorClient = createDoorClient(apiUrl);
const modelClient = createModelClient(apiUrl);

const ReferenceTrainScene = lazy(() => import('../components/train/ReferenceTrainScene'));
const SUBSYSTEMS = {
  door: { title: 'Door controller', short: 'Doors', icon: Fingerprint, label: 'Cycle detection & resistance', description: 'Inspect the controller stream and its classified opening and closing cycles.', accept: '.csv' },
  acv: { title: 'Air conditioning', short: 'ACV', icon: Snowflake, label: 'Leak inspection priority & recorded car conditions', description: 'Rank the eight cars for ACV inspection and review their recorded evidence.', accept: '.xlsx,.csv' },
  rail: { title: 'Rail corrugation', short: 'Rail corrugation', icon: Waves, label: 'Recording classification & axle-box measurements', description: 'Classify each recording and inspect its vibration and shock measurements.', accept: '.csv' },
  shm: { title: 'Structural health', short: 'Structural health', icon: Activity, label: 'Fatigue damage & recorded dynamic stress', description: 'Estimate fatigue damage for each recording and inspect its stress measurements.', accept: '.csv' },
} as const;
interface Session { recordings: RecordingSummary[]; selectedId: string | null; cursor: number; selection: ComponentSelection; metric: string; pins: string[]; results: Record<string, AnalysisResult> }
const newSession = (subsystem: Subsystem): Session => ({ recordings: [], selectedId: null, cursor: 0, selection: initialSelection(subsystem), metric: '', pins: [], results: {} });
const createSessions = () => Object.fromEntries((Object.keys(SUBSYSTEMS) as Subsystem[]).map(subsystem => [subsystem, newSession(subsystem)])) as Record<Subsystem, Session>;
const initialLayer = (): Subsystem => { const route = location.hash.slice(1); return route in SUBSYSTEMS ? route as Subsystem : 'door'; };
const displayNumber = (value: CellValue | undefined) => value === undefined || value === null || value === '' ? 'Not recorded' : typeof value !== 'number' ? value : value !== 0 && (Math.abs(value) < .001 || Math.abs(value) >= 1e6) ? value.toExponential(5) : Number(value.toPrecision(7)).toLocaleString('en-SG', { maximumFractionDigits: 7 });
function downloadFile(name: string, data: BlobPart, type: string) { const url = URL.createObjectURL(new Blob([data], { type })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
function selectionLabel(selection: ComponentSelection, subsystem: Subsystem): string {
  if (selection.kind === 'axleBox') return `Car ${selection.carOrdinal} · Axle box ${selection.position} · ${selection.position % 2 ? 'Side I' : 'Side II'}`;
  if (selection.kind === 'car') return `Car ${selection.carId}`;
  if (selection.kind === 'railSide') return `${selection.side} · recording-level reference`;
  return subsystem === 'door' ? 'Door stream — location unmapped' : subsystem === 'shm' ? 'Measurement location not supplied' : 'Recording context';
}
function fieldMatches(field: DisplayField, selection: ComponentSelection, subsystem: Subsystem) {
  if (subsystem === 'shm') return true;
  if (subsystem === 'door') return selection.kind === 'recording';
  if (subsystem === 'acv') return !field.carId || selection.kind === 'recording' || (selection.kind === 'car' && field.carId === selection.carId);
  if (field.mapping.status !== 'mapped') return true;
  const anchor = field.mapping.anchor;
  if (anchor.kind !== 'axleBox') return true;
  if (selection.kind === 'axleBox') return anchor.carOrdinal === selection.carOrdinal && anchor.position === selection.position;
  if (selection.kind === 'car') return anchor.carOrdinal === selection.ordinal;
  if (selection.kind === 'railSide') return (anchor.position % 2 ? 'Side I' : 'Side II') === selection.side;
  return true;
}

export interface ImportJob { subsystem: Subsystem; files: File[] }
export interface SubsystemWorkspaceProps {
  visibleSubsystems?: Subsystem[];
  importJobs?: ImportJob[];
  onBackToUpload?: () => void;
  onOpenTour?: () => void;
}
type ImportStage = 'queued' | 'uploading' | 'analysing' | 'done' | 'error';
interface ImportProgress { stage: ImportStage; message?: string; failedAt?: 'uploading' | 'analysing' }
const ALL_SUBSYSTEMS = Object.keys(SUBSYSTEMS) as Subsystem[];

export default function SubsystemWorkspace({ visibleSubsystems, importJobs, onBackToUpload, onOpenTour }: SubsystemWorkspaceProps = {}) {
  const [subsystem, setSubsystem] = useState<Subsystem>(() => visibleSubsystems?.[0] ?? initialLayer());
  const [sessions, setSessions] = useState(createSessions);
  const [revealed, setRevealed] = useState<Subsystem[]>(() => visibleSubsystems?.length ? visibleSubsystems : ALL_SUBSYSTEMS);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [progress, setProgress] = useState<Partial<Record<Subsystem, ImportProgress>>>(() => Object.fromEntries((importJobs ?? []).map(job => [job.subsystem, { stage: 'queued' }])));
  const [showCabinHint, setShowCabinHint] = useState(true);
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Partial<Record<Subsystem, string>>>({});
  const error = errors[subsystem] ?? '';
  const setError = (message: string, target = subsystem) => setErrors(previous => ({ ...previous, [target]: message }));
  const [doorJobs, setDoorJobs] = useState<Record<string, DoorAnalysis>>({});
  const [modelJobs, setModelJobs] = useState<Record<string, ModelAnalysis>>({});
  const [doorCycles, setDoorCycles] = useState<Record<string, number>>({});
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState('');
  const [dragging, setDragging] = useState(false);
  const [xray, setXray] = useState(subsystem === 'rail');
  const [fitKey, setFitKey] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [showHelp, setShowHelp] = useState(false);
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [fieldLimit, setFieldLimit] = useState(30);
  const [spectral, setSpectral] = useState(false);
  const [inspection, setInspection] = useState<{ key: string; data: InspectionData } | null>(null);
  const [inspectionBusy, setInspectionBusy] = useState(false);
  const uploadInput = useRef<HTMLInputElement>(null);
  const helpRef = useRef<HTMLDialogElement>(null);
  const sourceFiles = useRef(new Map<string, File>());
  const operations = useRef(new Set<Subsystem>());
  const importStarted = useRef(false);
  const pendingImports = useRef(new Set(importJobs?.map(job => job.subsystem)));
  const mounted = useRef(true);
  const progressTimers = useRef<Partial<Record<Subsystem, ReturnType<typeof setTimeout>>>>({});
  const failedFiles = useRef<Partial<Record<Subsystem, File[]>>>({});
  const focusedResults = useRef(new Set<string>());
  const skey = subsystem, session = sessions[subsystem];
  const recording = session.recordings.find(item => sourceKey(item) === session.selectedId);
  const recordingKey = recording ? sourceKey(recording) : '';
  const result = session.results[recordingKey] ?? null;
  const doorJob = subsystem === 'door' ? doorJobs[recordingKey] : undefined;
  const modelJob = subsystem !== 'door' ? modelJobs[recordingKey] : undefined;
  const hasResult = Boolean(result || modelJob);
  const recordingModel = subsystem !== 'door';
  const allModelJobs = session.recordings.flatMap(item => modelJobs[sourceKey(item)] ? [modelJobs[sourceKey(item)]] : []);
  const allAnalysed = session.recordings.length > 0 && allModelJobs.length === session.recordings.length;
  const selectedDoorCycle = result?.segments.length ? doorCycles[recordingKey] ?? 0 : null;
  const doorEvidence = useDoorCycleDetail(doorClient, recordingKey, doorJob, selectedDoorCycle);
  const config = SUBSYSTEMS[subsystem];
  const carIds = recording?.carIds.length === 8 ? recording.carIds : Array.from({ length: 8 }, (_, i) => subsystem === 'rail' ? String(i + 1) : String(i + 1).padStart(2, '0'));
  const ordinal = selectedCarOrdinal(session.selection, carIds);
  const contextFields = useMemo(() => recording?.fields.filter(field => fieldMatches(field, session.selection, subsystem)) ?? [], [recording, session.selection, subsystem]);
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
  const exportableDoorJob = sessions.door.selectedId ? doorJobs[sessions.door.selectedId] : undefined;
  const activeBusy = busy[skey] || busy[recordingKey] || (progress[subsystem]?.stage === 'queued' ? 'Queued for analysis…' : '');
  const patchSession = (key: Subsystem, update: Partial<Session> | ((previous: Session) => Session)) => setSessions(previous => ({ ...previous, [key]: typeof update === 'function' ? update(previous[key]) : { ...previous[key], ...update } }));
  const withRecording = async <T,>(request: Extract<WorkerRequest, { key: string }>, item: RecordingSummary): Promise<T> => {
    try { return await workerRequest<T>(request); }
    catch (reason) {
      if (!(reason instanceof Error) || !reason.message.includes('no longer loaded')) throw reason;
      const file = sourceFiles.current.get(sourceKey(item));
      if (file) await workerRequest({ type: 'load', subsystem: item.source.subsystem, fileName: file.name, contents: await file.arrayBuffer(), datasetId: item.source.datasetId });
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
  useEffect(() => { setQuery(''); setShowAll(false); setFieldLimit(30); setSpectral(false); setXray(subsystem === 'rail'); }, [subsystem, recordingKey]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 4200); return () => clearTimeout(timer); }, [notice]);
  useEffect(() => {
    if (!recordingKey) { setInspection(null); return; }
    let cancelled = false; setInspectionBusy(true);
    withRecording<InspectionData>({ type: 'inspect', key: recordingKey, cursor: session.cursor, fields: signalKeys.split('|').filter(Boolean) }, recording!).then(data => { if (!cancelled) setInspection({ key: recordingKey, data }); }).catch(reason => { if (!cancelled) setError(reason.message); }).finally(() => { if (!cancelled) setInspectionBusy(false); });
    return () => { cancelled = true; };
  }, [recordingKey, session.cursor, signalKeys]);
  useEffect(() => { if (showHelp) helpRef.current?.showModal(); else helpRef.current?.close(); }, [showHelp]);

  const clearBusy = (target: string) => setBusy(previous => { const next = { ...previous }; delete next[target]; return next; });
  const finishOperation = (target: Subsystem, failures: string[], failedAt: 'uploading' | 'analysing' = 'analysing') => {
    operations.current.delete(target);
    clearBusy(target);
    setError(failures.join('\n'), target);
    const finished: ImportProgress = failures.length ? { stage: 'error', message: failures.join('\n'), failedAt } : { stage: 'done' };
    setProgress(previous => ({ ...previous, [target]: finished }));
    clearTimeout(progressTimers.current[target]);
    if (!failures.length) progressTimers.current[target] = setTimeout(() => setProgress(previous => {
      if (previous[target] !== finished) return previous;
      const next = { ...previous }; delete next[target]; return next;
    }), 2500);
  };
  // Both upload entry points pass the just-parsed recordings directly to the real backend.
  // Reading session.recordings here would use the render before the upload completed.
  const analyseRecordings = async (targets: RecordingSummary[], target: Subsystem): Promise<string[]> => {
    const failures: string[] = [];
    setProgress(previous => ({ ...previous, [target]: { stage: 'analysing' } }));
    for (const item of targets) {
      const key = sourceKey(item);
      setBusy(previous => ({ ...previous, [key]: `Analysing ${item.source.fileName}…`, [target]: `Analysing ${item.source.fileName}…` }));
      setDoorJobs(previous => { const next = { ...previous }; delete next[key]; return next; });
      setModelJobs(previous => { const next = { ...previous }; delete next[key]; return next; });
      patchSession(target, previous => { const results = { ...previous.results }; delete results[key]; return { ...previous, results }; });
      try {
        const file = sourceFiles.current.get(key);
        if (!file) throw new Error('The original recording is unavailable. Upload it again before analysis.');
        if (target === 'door') {
          const analysis = await doorClient.analyse(file);
          const output = doorAnalysisResult(analysis, item);
          const firstAbnormal = output.segments.findIndex(segment => segment.prediction === 'Abnormal resistance');
          setDoorJobs(previous => ({ ...previous, [key]: analysis }));
          setDoorCycles(previous => ({ ...previous, [key]: Math.max(0, firstAbnormal) }));
          patchSession(target, previous => ({ ...previous, results: { ...previous.results, [key]: output } }));
        } else {
          const analysis = await modelClient.analyse(target, file, item.rowCount, item.carIds);
          setModelJobs(previous => ({ ...previous, [key]: analysis }));
        }
      } catch (reason) {
        failures.push(`${item.source.fileName}: ${reason instanceof Error ? reason.message : 'Analysis failed. No prediction was generated.'}`);
      } finally { clearBusy(key); }
    }
    return failures;
  };
  const addFiles = async (files: FileList | File[], target = subsystem) => {
    if (pendingImports.current.has(target)) { setError('This subsystem is queued for analysis. Wait for its staged recordings to finish before uploading more files.', target); return; }
    if (operations.current.has(target)) { setError('This source session is processing. Wait for it to finish before uploading another recording.', target); return; }
    operations.current.add(target);
    setError('', target);
    setProgress(previous => ({ ...previous, [target]: { stage: 'uploading' } }));
    const failures: string[] = [], loadedItems: RecordingSummary[] = [];
    let failedAt: 'uploading' | 'analysing' = 'analysing';
    failedFiles.current[target] = Array.from(files);
    try {
      for (const file of Array.from(files)) {
        setBusy(previous => ({ ...previous, [target]: `Reading ${file.name}…` }));
        try {
          const loaded = await workerRequest<RecordingSummary>({ type: 'load', subsystem: target, fileName: file.name, contents: await file.arrayBuffer(), datasetId: `ps3-${target}` });
          sourceFiles.current.set(sourceKey(loaded), file);
          loadedItems.push(loaded);
          patchSession(target, previous => ({ ...previous, recordings: [...previous.recordings.filter(item => sourceKey(item) !== sourceKey(loaded)), loaded], selectedId: sourceKey(loaded), cursor: 0, selection: initialSelection(target, loaded), metric: '', pins: [] }));
        } catch (reason) { failures.push(`${file.name}: ${reason instanceof Error ? reason.message : 'Could not read recording.'}`); }
      }
      if (failures.length) failedAt = 'uploading';
      if (loadedItems.length) failures.push(...await analyseRecordings(loadedItems, target));
    } finally {
      finishOperation(target, failures, failedAt);
      if (uploadInput.current) uploadInput.current.value = '';
    }
  };
  const runAnalysis = async (all = false) => {
    const target = subsystem;
    if (operations.current.has(target) || pendingImports.current.has(target)) return;
    const targets = all ? session.recordings : recording ? [recording] : [];
    if (!targets.length) return;
    operations.current.add(target);
    setError('', target);
    delete failedFiles.current[target];
    const failures = await analyseRecordings(targets, target);
    finishOperation(target, failures);
  };
  useEffect(() => {
    mounted.current = true;
    if (!importStarted.current && importJobs?.length) {
      importStarted.current = true;
      // Each job carries its own subsystem and files; changing tabs never cancels or redirects it.
      void (async () => {
        for (const job of importJobs) {
          if (!mounted.current) break;
          pendingImports.current.delete(job.subsystem);
          await addFiles(job.files, job.subsystem);
        }
      })();
    }
    return () => {
      mounted.current = false;
      Object.values(progressTimers.current).forEach(clearTimeout);
    };
  }, []);
  const addSubsystem = (target: Subsystem) => {
    setRevealed(previous => previous.includes(target) ? previous : [...previous, target]);
    setShowAddMenu(false); location.hash = target; setSubsystem(target);
  };
  const selectRecording = (key: string) => { const item = session.recordings.find(candidate => sourceKey(candidate) === key); patchSession(skey, { selectedId: key, cursor: 0, selection: initialSelection(subsystem, item), metric: '', pins: [] }); };
  const removeRecording = () => {
    if (!recording) return;
    void workerRequest({ type: 'remove', key: recordingKey }).catch(() => {});
    sourceFiles.current.delete(recordingKey);
    setDoorJobs(previous => { const next = { ...previous }; delete next[recordingKey]; return next; });
    setModelJobs(previous => { const next = { ...previous }; delete next[recordingKey]; return next; });
    setDoorCycles(previous => { const next = { ...previous }; delete next[recordingKey]; return next; });
    patchSession(skey, previous => {
      const remaining = previous.recordings.filter(item => sourceKey(item) !== recordingKey);
      const results = { ...previous.results }; delete results[recordingKey];
      return { ...previous, recordings: remaining, selectedId: remaining[0] ? sourceKey(remaining[0]) : null, results, cursor: 0, metric: '', pins: [], selection: initialSelection(subsystem, remaining[0]) };
    });
  };
  const selectComponent = (selection: ComponentSelection) => patchSession(skey, { selection: subsystem === 'shm' ? { kind: 'recording' } : selection, metric: subsystem === 'acv' && selection.kind === 'car' ? recording?.fields.find(field => field.carId === selection.carId && field.label === metric?.label)?.fieldKey ?? '' : '' });
  const cursorTo = (cursor: number) => { if (recording) patchSession(skey, { cursor: Math.max(0, Math.min(recording.rowCount - 1, cursor)) }); };
  const saveCsv = async () => {
    if (!hasResult || exporting) return;
    setExporting(true); setError('');
    try {
      if (modelJob) downloadFile(`${subsystem}_predictions.csv`, await modelClient.csv(modelJob), 'text/csv;charset=utf-8');
      else {
        if (!doorJob) throw new Error('Door analysis is unavailable. Run analysis again before downloading.');
        downloadFile('door_predictions.csv', await doorClient.csv(doorJob.job_id), 'text/csv;charset=utf-8');
      }
    } catch (reason) { setError((reason as Error).message); }
    finally { setExporting(false); }
  };
  const saveZip = async () => {
    if (exporting) return;
    setExporting(true); setError('');
    try {
      if (subsystem !== 'door') {
        if (!allAnalysed) throw new Error('Run analysis for every loaded recording before exporting all results.');
        downloadFile('predictions.zip', await modelClient.export(subsystem, allModelJobs, 'zip'), 'application/zip');
        setNotice(`All ${config.short} predictions exported from the model backend.`);
      } else {
        if (!exportableDoorJob) throw new Error('Door analysis is unavailable. Run analysis again before exporting the ZIP.');
        downloadFile('predictions.zip', await doorClient.zip(exportableDoorJob.job_id), 'application/zip');
        setNotice('Selected Door predictions exported from the model backend.');
      }
    } catch (reason) { setError((reason as Error).message); }
    finally { setExporting(false); }
  };
  const saveAllCsv = async () => {
    if (subsystem === 'door' || !allAnalysed || exporting) return;
    setExporting(true); setError('');
    try { downloadFile(`${subsystem}_predictions.csv`, await modelClient.export(subsystem, allModelJobs, 'csv'), 'text/csv;charset=utf-8'); }
    catch (reason) { setError((reason as Error).message); }
    finally { setExporting(false); }
  };
  const updateDoorCycle = (index: number) => {
    if (!result) return;
    const segment = result.segments[index];
    if (!segment) return;
    selectComponent({ kind: 'recording' }); cursorTo(segment.startIndex);
    setDoorCycles(previous => ({ ...previous, [recordingKey]: index }));
  };
  const drop = (event: DragEvent) => { event.preventDefault(); setDragging(false); if (event.dataTransfer.files.length) void addFiles(event.dataTransfer.files); };
  const currentSignal = inspected?.signals.find(signal => signal.fieldKey === metric?.fieldKey);
  const statistics = currentSignal?.statistics;
  const railSensor = subsystem === 'rail' && metric?.mapping.status === 'mapped';
  const stateSignal = metric?.rawUnit === 'binary pulse' || Boolean(metric && /^(close command|open command|DCSR|DCSL|DLSR|DLSL|door opened|door locked|door is opening|door is closing)$/i.test(metric.originalHeader.trim())) || Boolean(subsystem === 'acv' && metric && /\b(mode|status|state|alarm|command|validity)\b/i.test(metric.label));
  const summaryMetrics = !statistics ? [] : stateSignal
    ? [{ label: 'Selected sample', value: metric && inspected ? fieldValue(recording!, metric, row).value : null }]
    : railSensor ? [{ label: 'RMS · mean removed', value: statistics.acRms }, { label: 'Absolute peak · mean removed', value: statistics.acPeak }]
    : subsystem === 'shm' ? [{ label: 'Stress RMS', value: statistics.rms }, { label: 'Stress range · max − min', value: statistics.maximum == null || statistics.minimum == null ? null : statistics.maximum - statistics.minimum }]
    : [{ label: 'Mean', value: statistics.mean }, { label: 'Minimum', value: statistics.minimum }, { label: 'Maximum', value: statistics.maximum }];
  const vibrationField = contextFields.find(field => /vibration/i.test(field.originalHeader)), shockField = contextFields.find(field => /shock/i.test(field.originalHeader));
  const replayCycles = useMemo<DoorReplayCycle[]>(() => result ? result.segments.map((segment, index) => ({
    index, startTime: segment.start_time, endTime: segment.end_time, startIndex: segment.startIndex, endIndex: segment.endIndex,
    prediction: segment.prediction, operation: doorJob?.segments[index]?.operation_inferred ?? 'Unknown',
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
  const stress = useStressPlayback(subsystem === 'shm' ? recordingKey : '', subsystem === 'shm' ? recording?.rowCount ?? 0 : 0, session.cursor, cursorTo);
  useEffect(() => { if (reducedMotion) stress.pause(); }, [reducedMotion]);
  const stableSignal = inspection?.key === recordingKey ? inspection.data.signals.find(signal => signal.fieldKey === metric?.fieldKey) ?? null : null;
  const stressValue = subsystem === 'shm' && metric && inspected ? numericValue(fieldValue(recording!, metric, row).value) : null;
  useEffect(() => {
    const jobId = doorJob?.job_id ?? modelJob?.job_id;
    if (!jobId || focusedResults.current.has(jobId)) return;
    focusedResults.current.add(jobId);
    if (modelJob?.subsystem === 'acv') {
      const carId = modelJob.prediction[0];
      selectComponent({ kind: 'car', carId, ordinal: carIds.indexOf(carId) + 1 });
    } else if (modelJob?.subsystem === 'rail' && modelJob.prediction !== 'Normal') {
      selectComponent({ kind: 'railSide', side: modelJob.prediction });
    } else if (doorJob && selectedDoorCycle !== null) {
      updateDoorCycle(selectedDoorCycle);
    }
    document.getElementById('subsystem-train')?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
  }, [recordingKey, doorJob?.job_id, modelJob?.job_id]);
  const visualization: SubsystemVisualState = {
    door: selectedReplayCycle ? { cycleNumber: selectedReplayCycle.index + 1, operation: selectedReplayCycle.operation, progress: replay.progress, completed: replay.completed, prediction: selectedReplayCycle.prediction } : undefined,
    acv: modelJob?.subsystem === 'acv' ? { rankedCars: modelJob.prediction, hasUsableData: modelJob.evidence.cars.some(car => car.has_data) } : undefined,
    rail: modelJob?.subsystem === 'rail' ? { prediction: modelJob.prediction } : undefined,
    shm: modelJob?.subsystem === 'shm' ? { prediction: modelJob.prediction } : undefined,
    stress: subsystem === 'shm' ? { progress: stress.progress, playing: stress.playing, amplitude: Math.min(1, Math.abs(stressValue ?? 0) / (stableSignal?.statistics.peak || 1)) } : undefined,
  };

  return <div className="multi-shell" data-reduced-motion={reducedMotion} data-subsystem={subsystem}>
    <a className="ms-skip" href="#workspace-content" onClick={event => { event.preventDefault(); document.getElementById('workspace-content')?.focus(); }}>Skip to workspace</a>
    <aside className="ms-sidebar"><a className="ms-brand" href="#" onClick={event => { event.preventDefault(); if (onBackToUpload) onBackToUpload(); else location.hash = ''; }}><LogoMark size={30}/>JagaRail</a><p className="ms-brand-caption">EVIDENCE IN CONTEXT</p><span className="ms-nav-caption">SUBSYSTEM WORKSPACE</span><nav aria-label="Subsystems">{(Object.entries(SUBSYSTEMS) as [Subsystem, typeof SUBSYSTEMS[Subsystem]][]).filter(([id]) => revealed.includes(id)).map(([id, item]) => <button key={id} className={id === subsystem ? 'active' : ''} aria-current={id === subsystem ? 'page' : undefined} onClick={() => { location.hash = id; setSubsystem(id); }}><item.icon size={17}/><span>{item.short}</span>{id === subsystem && <i/>}</button>)}</nav><div className="ms-sidebar-bottom">
      <div className="ms-sidebar-actions">
        {onBackToUpload && <button onClick={onBackToUpload}><Upload size={15}/>Back to uploads</button>}
        {revealed.length < ALL_SUBSYSTEMS.length && <div className="ms-add-subsystem">
          <button onClick={() => setShowAddMenu(value => !value)} aria-expanded={showAddMenu}><Layers3 size={15}/>Add subsystem</button>
          {showAddMenu && <div className="ms-add-subsystem-menu">
            {ALL_SUBSYSTEMS.filter(id => !revealed.includes(id)).map(id => <button key={id} onClick={() => addSubsystem(id)}>{SUBSYSTEMS[id].short}</button>)}
          </div>}
        </div>}
        {onOpenTour && <button onClick={onOpenTour}><CircleHelp size={15}/>Guided tour</button>}
      </div>
      <div className="ms-independence"><Layers3 size={17}/><p>Four independent datasets.<br/>One reference workspace.</p></div><button className="ms-help" onClick={() => setShowHelp(true)}><CircleHelp size={16}/>How it works</button><p className="ms-sidebar-version">JAGARAIL <span>v3.0</span></p></div></aside>
    <div className="ms-main"><header className="ms-topbar"><div><Box size={13}/><span>Reference workspace</span><ChevronRight size={12}/><strong>{config.short}</strong></div><span className="ms-mode-chip">UPLOADED SOURCES</span></header>
      <main id="workspace-content" className="ms-workspace" tabIndex={-1}>
        <div className="ms-page-heading"><div><div className="ms-eyebrow">{config.label}</div><h1>{config.title}</h1><p>{config.description}</p></div><button className="ms-button" disabled={(recordingModel ? !allAnalysed : !exportableDoorJob) || exporting || Boolean(activeBusy)} onClick={() => void saveZip()}><ArrowDownToLine size={14}/>predictions.zip</button></div>
        <NextSteps concealReplay={Boolean(selectedReplayCycle && (!replay.completed || replay.playing))} doorAnalysis={doorJob} modelAnalysis={modelJob} onCycle={selectDoorCycle} onCar={carId => selectComponent({ kind: 'car', carId, ordinal: carIds.indexOf(carId) + 1 })} onRailSide={side => selectComponent({ kind: 'railSide', side })}/>
        {progress[subsystem] && (() => {
          const info = progress[subsystem]!;
          const checkingDone = info.stage === 'analysing' || info.stage === 'done' || info.stage === 'error' && info.failedAt === 'analysing';
          return <section className="ms-progress-board" aria-label="Processing status"><div className="ms-progress-card" aria-live="polite">
            <header><h3><config.icon size={16}/>{config.short}</h3><span className={`ms-kind ${info.stage === 'done' ? 'predicted' : 'derived'}`}>{info.stage === 'error' ? 'Needs attention' : info.stage === 'done' ? 'Complete' : info.stage === 'queued' ? 'Queued' : 'Processing'}</span></header>
            <ol className="ms-progress-steps">{[
              { label: 'Checking & validating files', done: checkingDone, active: info.stage === 'uploading', failed: info.stage === 'error' && info.failedAt === 'uploading' },
              { label: 'Running model inference', done: info.stage === 'done', active: info.stage === 'analysing', failed: info.stage === 'error' && info.failedAt === 'analysing' },
            ].map(step => <li key={step.label} className={step.done ? 'done' : step.active ? 'active' : step.failed ? 'failed' : ''}><span className="step-icon">{step.done ? <Check size={12}/> : step.active ? <LoaderCircle size={12} className="spin"/> : step.failed ? <X size={12}/> : null}</span>{step.label}</li>)}</ol>
            {info.stage === 'queued' && <p>Waiting for the preceding subsystem to finish.</p>}
            {info.stage === 'error' && <><p className="ms-progress-error">{info.message}</p><button className="ms-button small ms-progress-retry" disabled={Boolean(activeBusy)} onClick={() => { const files = failedFiles.current[subsystem]; if (files) void addFiles(files); else void runAnalysis(true); }}>Retry {config.short}</button></>}
          </div></section>;
        })()}
        <section className="ms-source-panel" aria-label="Recording selection" onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={drop} data-dragging={dragging}>
          <div className="ms-source-controls"><button className="ms-upload" onClick={() => uploadInput.current?.click()} disabled={Boolean(activeBusy)}><Upload size={16}/><span>Upload recording<small>or drop {config.accept.replaceAll('.', '').toUpperCase()} here</small></span></button><input ref={uploadInput} type="file" multiple accept={config.accept} aria-label="Upload recording files" className="ms-file-input" disabled={Boolean(activeBusy)} onChange={event => { if (event.target.files) void addFiles(event.target.files); }}/><label className="ms-file-select"><span>SELECTED RECORDING</span><select aria-label="Selected recording" value={session.selectedId ?? ''} onChange={event => selectRecording(event.target.value)}><option value="" disabled>{activeBusy ? 'Preparing recording…' : 'No recording loaded'}</option>{session.recordings.map(item => <option value={sourceKey(item)} key={sourceKey(item)}>{item.source.fileName}{session.recordings.filter(candidate => candidate.source.fileName === item.source.fileName).length > 1 ? ` · source ${item.source.fileId.split(':').at(-1)?.slice(0, 8)}` : ''}</option>)}</select></label>{recording && <button className="ms-button small" aria-label="Remove selected recording" title="Remove selected recording and its result" disabled={Boolean(activeBusy)} onClick={removeRecording}><X size={14}/></button>}<button className="ms-button primary" onClick={() => void runAnalysis()} disabled={!recording || Boolean(activeBusy)}>{activeBusy ? <LoaderCircle className="spin" size={14}/> : <Activity size={14}/>}<span>{progress[subsystem]?.stage === 'queued' ? 'Queued…' : activeBusy ? 'Processing…' : hasResult ? 'Run again' : 'Run analysis'}</span></button>{session.recordings.length > 1 && <button className="ms-button" onClick={() => void runAnalysis(true)} disabled={Boolean(activeBusy)}>Analyse all {session.recordings.length}</button>}<button className="ms-button" onClick={() => void saveCsv()} disabled={!hasResult || exporting || Boolean(activeBusy)}><ArrowDownToLine size={14}/>CSV</button>{recordingModel && session.recordings.length > 1 && <button className="ms-button" onClick={() => void saveAllCsv()} disabled={!allAnalysed || exporting || Boolean(activeBusy)}><ArrowDownToLine size={14}/>All results CSV</button>}</div>
          <div className="ms-source-context"><Database size={12}/><span>{recording ? `${recording.source.datasetId} / ${recording.source.fileName} · ${recording.rowCount.toLocaleString()} rows · ${recording.fields.length} source fields` : 'Upload a recording to inspect its fields and automatically run the trained model.'}</span>{recording && <span className="ms-door-route">Prediction: trained backend model</span>}{activeBusy && <strong role="status">{activeBusy}</strong>}</div>
        </section>
        {error && <div className="ms-error" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}><X size={15}/></button></div>}
        {recording?.warnings.length ? <details className="ms-source-warnings"><summary><CircleHelp size={12}/>{recording.warnings.length} source note{recording.warnings.length === 1 ? '' : 's'}<ChevronDown size={12}/></summary>{recording.warnings.map(warning => <p key={warning}>{warning}</p>)}</details> : null}
        <section id="subsystem-train" className="ms-train-panel" aria-label={subsystem === 'door' ? 'Representative cabin workspace' : 'Eight-car reference workspace'}><div className="ms-scene-heading"><div><span className="ms-eyebrow">01 · WHAT WAS ANALYSED</span><h2>{subsystem === 'door' ? 'Recorded door movements' : subsystem === 'acv' ? 'Eight cars. Recorded conditions.' : subsystem === 'rail' ? 'Follow the evidence to the rail side.' : 'Stress in context.'}</h2><p>{subsystem === 'door' ? 'Illustrative location; physical asset metadata unavailable' : subsystem === 'shm' ? 'Reference layout — asset mapping not supplied' : subsystem === 'acv' ? recording ? 'Stable labelled schematic order · car identities are preserved from this file' : 'Select a case to discover its exact car identifiers · schematic placeholders shown' : '64 axle boxes · 128 measurement channels · two reference rail sides'}</p></div><div className="ms-scene-controls"><label><input type="checkbox" checked={xray} onChange={event => setXray(event.target.checked)}/>X-ray</label><button className="ms-button small" onClick={() => { selectComponent({ kind: 'recording' }); setFitKey(value => value + 1); }}><Focus size={13}/>Fit train</button></div></div>
          <div className="ms-scene">{subsystem === 'acv' && recording && showCabinHint && <div className="ms-cabin-hint" role="status"><Info size={14}/><span>Click on a train cabin to select and inspect it.</span><button aria-label="Dismiss hint" onClick={() => setShowCabinHint(false)}><X size={13}/></button></div>}<Suspense fallback={<div className="ms-scene-loading"><LoaderCircle className="spin" size={24}/>Loading reference layout</div>}><ReferenceTrainScene subsystem={subsystem} carIds={carIds} selection={session.selection} onSelect={selectComponent} xray={xray} reducedMotion={reducedMotion} fitKey={fitKey} visualization={visualization} source={recording?.source ?? null} cursorLabel={timestamp} sensorReadout={inspected && session.selection.kind === 'axleBox' ? { vibration: vibrationField ? numericValue(row[vibrationField.columnIndex]) : null, shock: shockField ? numericValue(row[shockField.columnIndex]) : null } : undefined}/></Suspense></div>
          {selectedReplayCycle && <section id="door-replay" className="ms-door-replay" aria-label="Recorded Door replay">
          <DoorReplayTimeline cycles={replayCycles} selectedIndex={selectedDoorCycle ?? 0} playing={replay.playing} progress={replay.progress} onPlay={replay.play} onPause={replay.pause} onPrevious={replay.previous} onNext={replay.next} onSelect={replay.select} reducedMotion={reducedMotion}/>
            <details className="ms-motion-alternative"><summary>Illustrative movement detail · physical door identity unavailable</summary><DoorMotionVisual operation={selectedReplayCycle.operation} progress={replay.progress} completed={replay.completed} prediction={selectedReplayCycle.prediction} reducedMotion={reducedMotion}/></details>
          </section>}
          {subsystem !== 'door' && <nav className="ms-car-navigator" aria-label="Carriage navigator"><span>REFERENCE CARS</span>{carIds.map((id, index) => <button key={`${id}-${index}`} className={ordinal === index + 1 ? 'active' : ''} aria-label={`Select car ${id}`} aria-pressed={ordinal === index + 1} onClick={() => selectComponent({ kind: 'car', carId: id, ordinal: index + 1 })}><TrainFront size={13}/><strong>{id}</strong></button>)}</nav>}
          <div className="ms-scene-note"><span><span className="ms-kind metadata">Metadata</span>{subsystem === 'rail' ? 'Reference travel: −X. Side I = −Z; Side II = +Z. Camera rotation does not change channel identity.' : 'Drawn geometry is schematic. Dataset recordings do not establish a shared physical train or timeline.'}</span><label><input type="checkbox" checked={reducedMotion} onChange={event => setReducedMotion(event.target.checked)}/>Reduce motion</label></div>
        </section>
        <ResultSummary result={result} recording={recording} onCycle={selectDoorCycle} onCar={carId => selectComponent({ kind: 'car', carId, ordinal: carIds.indexOf(carId) + 1 })} doorAnalysis={doorJob} modelAnalysis={modelJob} selectedCycle={selectedDoorCycle} concealReplay={Boolean(selectedReplayCycle && (!replay.completed || replay.playing))}/>
        {doorJob && <div id="door-cycle-evidence"><DoorCycleEvidence detail={doorEvidence.detail} loading={doorEvidence.loading} error={doorEvidence.error} sourceName={doorJob.source_name} cycleNumber={selectedDoorCycle === null ? null : selectedDoorCycle + 1} onRetry={doorEvidence.retry} replayProgress={replay.progress} concealResult={!replay.completed}/></div>}
        {subsystem === 'shm' && recording && <details className="ms-stress-disclosure" onToggle={event => { if (!event.currentTarget.open) stress.pause(); }}>
          <summary>Optional stress playback<ChevronDown size={14}/></summary>
          <StressReplay signal={stableSignal} rowCount={recording.rowCount} sampleRateHz={recording.sampleRateHz} cursor={session.cursor} currentValue={stressValue} onCursor={cursor => { stress.pause(); cursorTo(cursor); }} playing={stress.playing} onToggle={stress.toggle} reducedMotion={reducedMotion} unit={metric?.displayUnit}/>
        </details>}

        <section className="ms-inspector" id="evidence-inspector" aria-label="Evidence inspector"><div className="ms-inspector-heading"><div><span className="ms-eyebrow">PINNED EVIDENCE INSPECTOR</span><h2>{selectionLabel(session.selection, subsystem)}</h2><p>{recording ? `${recording.source.datasetId} / ${recording.source.fileName}` : 'Select a source to inspect its recorded fields.'}</p></div><span className="ms-kind recorded">Recorded</span></div>
          {subsystem === 'rail' && ordinal && <div className="ms-sensor-navigator" role="group" aria-label={`Car ${ordinal} axle boxes`}><span>AXLE BOX</span>{Array.from({ length: 8 }, (_, index) => <button key={index} className={session.selection.kind === 'axleBox' && session.selection.position === index + 1 ? 'active' : ''} onClick={() => selectComponent({ kind: 'axleBox', carOrdinal: ordinal, position: index + 1 })} aria-label={`Select car ${ordinal} axle box ${index + 1}`}>{index + 1}<small>{index % 2 ? 'II' : 'I'}</small></button>)}</div>}
          {((subsystem === 'door' && session.selection.kind !== 'recording') || subsystem === 'shm') && <div className="ms-unmapped"><Box size={17}/><p>{subsystem === 'door' ? 'No uploaded controller stream is mapped to this rendered component.' : 'Measurement location not supplied. This file is not assigned to any car or bogie.'}</p>{subsystem === 'door' && <button className="ms-text-button" onClick={() => selectComponent({ kind: 'recording' })}>Inspect unlocated stream<ArrowRight size={12}/></button>}</div>}
          {recording ? <>
            <div className="ms-time-control"><label htmlFor="source-sample-cursor">SAMPLE CURSOR <strong>{timestamp}</strong></label><input id="source-sample-cursor" type="range" min={0} max={Math.max(0, recording.rowCount - 1)} value={session.cursor} onChange={event => cursorTo(Number(event.target.value))} aria-label="Recording sample cursor"/><span><input className="ms-sample-number" type="number" min={1} max={recording.rowCount} value={session.cursor + 1} aria-label="Sample number" onChange={event => { const value = Number(event.target.value); if (Number.isInteger(value) && value >= 1) cursorTo(value - 1); }}/> / {recording.rowCount.toLocaleString()}{inspectionBusy && <LoaderCircle size={11} className="spin"/>}</span></div>
            {session.pins.length > 0 && <div className="ms-pinned-fields">{session.pins.map(key => { const field = recording.fields.find(item => item.fieldKey === key); if (!field) return null; const reading = fieldValue(recording, field, row); return <div key={key}><span><Pin size={10}/>{field.originalHeader}</span><strong>{inspected ? reading.validity === 'invalid' ? 'Invalid' : displayNumber(reading.value) : '…'} <small>{field.displayUnit ?? 'unit unknown'}</small></strong><button aria-label={`Unpin ${field.label}`} onClick={() => patchSession(skey, { pins: session.pins.filter(item => item !== key) })}><X size={11}/></button></div>; })}</div>}
            <div className="ms-evidence-grid"><div className="ms-signal-area"><div className="ms-metric-controls"><label>Metric<select aria-label="Metric" value={metric?.fieldKey ?? ''} onChange={event => patchSession(skey, { metric: event.target.value })}>{!numericFields.length && <option value="">No mapped fields</option>}{numericFields.map(field => <option key={field.fieldKey} value={field.fieldKey}>{field.carId ? `${field.carId} · ` : ''}{field.label}</option>)}</select></label>{subsystem === 'rail' && currentSignal?.spectrum && <div className="ms-chart-tabs"><button onClick={() => setSpectral(false)} className={!spectral ? 'active' : ''}>Trace</button><button onClick={() => setSpectral(true)} className={spectral ? 'active' : ''}>Spectrum</button></div>}</div>
              {metric && currentSignal ? <><RecordingTrace signal={currentSignal} cursor={session.cursor} rowCount={recording.rowCount} sampleRateHz={recording.sampleRateHz} unit={metric.displayUnit} label={metric.label} onCursor={cursorTo} spectrum={spectral}/><div className="ms-derived-stats" role="group" aria-label="Selected signal measurements">{summaryMetrics.map(item => <div key={item.label}><span>{item.label}</span><strong title={item.value === null || item.value === undefined ? undefined : String(item.value)}>{displayNumber(item.value)}<small>{metric.displayUnit ?? 'source units · unit not supplied'}</small></strong></div>)}</div><p className="ms-derivation-note">{stateSignal ? 'Recorded state at the selected sample; no average or RMS is assigned to state codes.' : `Calculated from the full selected channel across ${recording.rowCount.toLocaleString()} samples, independently of the chart cursor and display downsampling. ${railSensor ? 'RMS and peak remove the channel mean, matching Rail signal preprocessing. The classifier also applies its saved baseline and other features.' : 'These measurements describe the recording; they are not additional model predictions.'}`} Valid numeric samples: {currentSignal.statistics.count.toLocaleString()} / {recording.rowCount.toLocaleString()}.{currentSignal.statistics.missing > 0 && ` ${currentSignal.statistics.missing.toLocaleString()} missing or invalid samples excluded.`}</p></> : <div className="ms-chart-empty"><Waves size={28}/><p>{inspectionBusy ? 'Reading the original samples…' : numericFields.length ? 'Choose a numeric recorded field to inspect its trace.' : 'No recording is physically mapped to this selection.'}</p></div>}
              {subsystem === 'rail' && companion && inspected?.signals.find(signal => signal.fieldKey === companion.fieldKey) && <details className="ms-companion"><summary>{companion.label}<ChevronDown size={12}/></summary><RecordingTrace signal={inspected.signals.find(signal => signal.fieldKey === companion.fieldKey)!} cursor={session.cursor} rowCount={recording.rowCount} sampleRateHz={recording.sampleRateHz} unit={companion.displayUnit} label={companion.label} onCursor={cursorTo}/></details>}
              {subsystem === 'acv' && metric && <div className="ms-car-comparison"><h3>Same field across all cars</h3><p>Recorded at {timestamp}. Missing fields stay unrecorded.</p>{carIds.map(id => { const field = recording.fields.find(item => item.carId === id && item.label === metric.label); const reading = field ? fieldValue(recording, field, row) : null; return <button key={id} onClick={() => selectComponent({ kind: 'car', carId: id, ordinal: carIds.indexOf(id) + 1 })}><span>Car {id}</span><strong>{reading && inspected ? reading.validity === 'invalid' ? 'Invalid' : displayNumber(reading.value) : 'Not recorded'}</strong><small>{reading?.validity === 'unknown' ? 'Validity code unknown' : reading?.validity === 'valid' ? (field?.displayUnit ?? 'Unit unknown') : reading?.validity === 'invalid' ? 'Invalid' : 'Not recorded'}</small></button>; })}</div>}
            </div><div className="ms-field-browser"><div className="ms-field-heading"><h3>Source fields <span>{displayedFields.length}</span></h3><label><input type="checkbox" checked={showAll} onChange={event => { setShowAll(event.target.checked); setFieldLimit(30); }}/>All recording fields</label></div><label className="ms-search"><Search size={14}/><input value={query} onChange={event => { setQuery(event.target.value); setFieldLimit(30); }} placeholder="Search names, channels, metadata…" aria-label="Search source fields"/></label><div className="ms-field-list" role="region" aria-label="Searchable source fields" tabIndex={0}>{visibleFields.map(field => { const reading = fieldValue(recording, field, row); return <details key={field.fieldKey} className={`ms-field ${metric?.fieldKey === field.fieldKey ? 'selected' : ''}`}><summary><span className={`ms-kind ${field.kind}`}>{field.kind}</span><span className="ms-field-name">{field.originalHeader}</span><strong>{inspected ? reading.validity === 'invalid' ? 'Invalid' : displayNumber(reading.value) : '…'}</strong><ChevronDown size={11}/></summary><div className="ms-field-details"><dl><div><dt>Source column</dt><dd>{field.columnIndex + 1} (index {field.columnIndex})</dd></div><div><dt>Raw value / unit</dt><dd>{inspected ? reading.raw === null || reading.raw === undefined || reading.raw === '' ? 'Not recorded' : String(reading.raw) : '…'} · {field.rawUnit ?? 'Unit not supplied'}</dd></div><div><dt>Display value / unit</dt><dd>{inspected ? displayNumber(reading.value) : '…'} · {field.displayUnit ?? 'Unit not supplied'}</dd></div><div><dt>Validity</dt><dd>{inspected ? reading.validity === 'unknown' ? 'Code meaning not supplied' : reading.validity.replace('_', ' ') : 'Reading sample…'}</dd></div><div><dt>Source identity</dt><dd>{field.source.fileId}</dd></div><div><dt>Source / scope</dt><dd>{field.source.subsystem} / {field.source.datasetId} / {field.source.fileName} · {field.scope} · sample {session.cursor + 1}</dd></div><div><dt>Mapping</dt><dd>{field.mapping.status === 'mapped' ? field.mapping.provenance : field.mapping.reason}</dd></div>{field.displayScale !== undefined && field.displayScale !== 1 && <div><dt>Conversion</dt><dd>Raw × {field.displayScale} = displayed value</dd></div>}</dl>{field.description && <p>{field.description}</p>}<div className="ms-field-actions"><button onClick={() => { patchSession(skey, { metric: field.fieldKey }); if (showAll) { const anchor = field.mapping.status === 'mapped' ? field.mapping.anchor : null; if (anchor?.kind === 'axleBox') patchSession(skey, { selection: { kind: 'axleBox', carOrdinal: anchor.carOrdinal, position: anchor.position } }); else if (field.carId) patchSession(skey, { selection: { kind: 'car', carId: field.carId, ordinal: carIds.indexOf(field.carId) + 1 } }); } }}><Waves size={12}/>View trace</button><button disabled={!session.pins.includes(field.fieldKey) && session.pins.length >= 4} onClick={() => patchSession(skey, { pins: session.pins.includes(field.fieldKey) ? session.pins.filter(key => key !== field.fieldKey) : [...session.pins, field.fieldKey] })}><Pin size={12}/>{session.pins.includes(field.fieldKey) ? 'Unpin field' : 'Pin field'}</button></div></div></details>; })}{displayedFields.length > fieldLimit && <button className="ms-show-more" onClick={() => setFieldLimit(value => value + 50)}>Show next {Math.min(50, displayedFields.length - fieldLimit)} fields</button>}{!displayedFields.length && <p className="ms-no-fields">No matching source fields in this selection.</p>}</div></div></div>
          </> : <div className="ms-empty-inspector"><FileUp size={29}/><h3>Your recording is the source of truth.</h3><p>Upload a file to discover its actual fields, units and available identity information.</p><button className="ms-button" onClick={() => uploadInput.current?.click()}>Choose recording<ArrowRight size={13}/></button></div>}
        </section>
        <footer className="ms-footer"><span><ShieldCheck size={11}/>Model outputs support investigation. They do not certify mechanical condition.</span><span>Independent datasets · schematic geometry · scoped inference</span></footer>
      </main>
    </div>
    {notice && <div className="ms-notice" role="status"><Check size={14}/>{notice}</div>}
    <dialog className="ms-dialog" ref={helpRef} onClose={() => setShowHelp(false)} onClick={event => { if (event.target === event.currentTarget) setShowHelp(false); }}><div><header><h2>One workspace. Four independent sources.</h2><button aria-label="Close help" onClick={() => setShowHelp(false)}><X size={17}/></button></header><ol><li>Select the subsystem that matches your recording.</li><li>Upload CSV or ACV XLSX data. Analysis runs automatically using the subsystem’s supplied trained model.</li><li>Select a relevant car, axle box or unlocated stream to inspect actual recorded fields.</li><li>Use the sample cursor, metric selector and pinned fields to review evidence.</li><li>Download the selected result as CSV. For ACV, Rail and SHM, analyse all loaded recordings to download their combined CSV or predictions.zip.</li></ol><p>Door results classify detected cycles. ACV ranks the eight cars for inspection; Rail returns a classification per recording; SHM returns a fatigue damage estimate per recording. No shared train identity or synchronized timeline is implied.</p><p>All four subsystems run their supplied models in the backend. ACV ranks cars under the model’s one-leaking-car-per-case assumption; the result is an inspection priority, not a confirmed diagnosis. For Door, the ZIP uses the currently selected analysed stream because its required CSV has no file identifier column.</p><button className="ms-button primary" onClick={() => setShowHelp(false)}>Return to workspace</button></div></dialog>
  </div>;
}
