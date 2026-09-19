import { useRef, useState, type DragEvent } from 'react';
import { dismissTourForSession, hasSeenTour } from '../components/tour/tourStorage';
import { Activity, AlertTriangle, ArrowRight, Check, Fingerprint, PlayCircle, Snowflake, Upload, Waves, X } from 'lucide-react';
import type { Subsystem } from '../types/multisystem';
import { detectSubsystem } from '../lib/detectSubsystem';
import { Wordmark } from '../components/brand/Logo';
import './Landing.css';

const SUBSYSTEM_CARDS: { id: Subsystem; label: string; icon: typeof Fingerprint }[] = [
  { id: 'door', label: 'Doors', icon: Fingerprint },
  { id: 'acv', label: 'ACV', icon: Snowflake },
  { id: 'rail', label: 'Rail Corrugation', icon: Waves },
  { id: 'shm', label: 'Structural Health', icon: Activity },
];

interface StagedFile {
  id: string;
  file: File;
  subsystem: Subsystem | null;
  confidence: 'high' | 'ambiguous';
  reason: string;
}

export interface LandingProps {
  onAnalyze: (jobs: { subsystem: Subsystem; files: File[] }[]) => void;
  onStartDemo: () => void;
}

export default function Landing({ onAnalyze, onStartDemo }: LandingProps) {
  const [staged, setStaged] = useState<StagedFile[]>([]);
  const [selected, setSelected] = useState<Set<Subsystem>>(new Set());
  const [dragging, setDragging] = useState(false);
  const [showOffer, setShowOffer] = useState(() => !hasSeenTour());
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = async (files: FileList | File[]) => {
    const additions = await Promise.all(Array.from(files).map(async (file, index) => {
      const guess = await detectSubsystem(file);
      return { id: `${file.name}-${file.size}-${file.lastModified}-${Date.now()}-${index}`, file, subsystem: guess.subsystem, confidence: guess.confidence, reason: guess.reason } satisfies StagedFile;
    }));
    setStaged(previous => [...previous, ...additions]);
    setSelected(previous => {
      const next = new Set(previous);
      for (const addition of additions) if (addition.subsystem && addition.confidence === 'high') next.add(addition.subsystem);
      return next;
    });
  };

  const removeFile = (id: string) => setStaged(previous => previous.filter(item => item.id !== id));
  const reassign = (id: string, subsystem: Subsystem | '') => setStaged(previous => previous.map(item => item.id === id ? { ...item, subsystem: subsystem || null, confidence: 'high' } : item));
  const toggleSubsystem = (id: Subsystem) => setSelected(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });

  const drop = (event: DragEvent) => { event.preventDefault(); setDragging(false); if (event.dataTransfer.files.length) void addFiles(event.dataTransfer.files); };
  const missing = [...selected].filter(subsystem => !staged.some(item => item.subsystem === subsystem));
  const ambiguousCount = staged.filter(item => item.confidence === 'ambiguous' || !item.subsystem).length;
  const canAnalyze = selected.size > 0 && missing.length === 0;

  const analyze = () => {
    if (!canAnalyze) return;
    const jobs = [...selected].map(subsystem => ({ subsystem, files: staged.filter(item => item.subsystem === subsystem).map(item => item.file) }));
    onAnalyze(jobs);
  };

  return <div className="landing-shell">
    <header className="landing-topbar"><Wordmark size={20} /><button className="landing-textlink" onClick={onStartDemo}><PlayCircle size={16} />Try guided demo</button></header>
    <main className="landing-main">
      <section className="landing-hero">
        <span className="landing-eyebrow">JAGARAIL</span>
        <h1>Evidence in Context</h1>
        <p>Upload inspection data to begin your analysis. JagaRail brings together four independent railway diagnostic datasets — Doors, ACV, Rail Corrugation and Structural Health — in one reference workspace.</p>
      </section>

      {showOffer && <div className="landing-offer" role="status">
        <span><PlayCircle size={18} aria-hidden="true" />New here? Take a two-minute guided demo before uploading your own data.</span>
        <div><button className="ms-button primary small" onClick={onStartDemo}>Start guided demo</button><button className="ms-button small" onClick={() => { dismissTourForSession(); setShowOffer(false); }}>Skip and upload my data</button></div>
      </div>}

      <section className="landing-upload" aria-label="Upload inspection data" onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={drop} data-dragging={dragging}>
        <Upload size={30} aria-hidden="true" />
        <h2>Drag and drop recordings here</h2>
        <p>CSV recordings for Doors, Rail Corrugation and Structural Health. CSV or XLSX case files for ACV. Upload as many files as you have — you'll confirm which system each belongs to below.</p>
        <button className="ms-button primary" onClick={() => inputRef.current?.click()}>Browse files</button>
        <input ref={inputRef} type="file" multiple accept=".csv,.xlsx" className="landing-file-input" aria-label="Browse files" onChange={event => { if (event.target.files?.length) void addFiles(event.target.files); event.target.value = ''; }} />
      </section>

      {staged.length > 0 && <section className="landing-files" aria-label="Uploaded files">
        <h3>Uploaded files <span>{staged.length}</span></h3>
        <ul>{staged.map(item => <li key={item.id} className={item.confidence === 'ambiguous' || !item.subsystem ? 'needs-confirmation' : ''}>
          <div className="landing-file-name"><span>{item.file.name}</span><small>{(item.file.size / 1024).toFixed(0)} KB</small></div>
          <label className="landing-file-assign"><span>Analyse as</span>
            <select value={item.subsystem ?? ''} onChange={event => reassign(item.id, event.target.value as Subsystem | '')} aria-label={`Subsystem for ${item.file.name}`}>
              <option value="">Not assigned</option>
              {SUBSYSTEM_CARDS.map(card => <option key={card.id} value={card.id}>{card.label}</option>)}
            </select>
          </label>
          {(item.confidence === 'ambiguous' || !item.subsystem) && <span className="landing-file-note"><AlertTriangle size={13} aria-hidden="true" />{item.reason}. Confirm the subsystem above.</span>}
          {item.confidence === 'high' && item.subsystem && <span className="landing-file-note is-ok"><Check size={13} aria-hidden="true" />{item.reason}</span>}
          <button className="landing-file-remove" aria-label={`Remove ${item.file.name}`} onClick={() => removeFile(item.id)}><X size={15} /></button>
        </li>)}</ul>
      </section>}

      <section className="landing-subsystems" aria-label="Choose systems to analyse">
        <h2>What would you like to analyse?</h2>
        <div className="landing-cards" role="group" aria-label="Subsystem selection">
          {SUBSYSTEM_CARDS.map(card => {
            const isSelected = selected.has(card.id);
            const Icon = card.icon;
            return <button key={card.id} type="button" className={`landing-card${isSelected ? ' is-selected' : ''}`} aria-pressed={isSelected} onClick={() => toggleSubsystem(card.id)}>
              <span className="landing-card-check" aria-hidden="true">{isSelected && <Check size={14} />}</span>
              <Icon size={30} aria-hidden="true" />
              <strong>{card.label}</strong>
            </button>;
          })}
        </div>
        {missing.length > 0 && <p className="landing-missing" role="status">{missing.map(subsystem => SUBSYSTEM_CARDS.find(card => card.id === subsystem)?.label).join(', ')} needs at least one assigned file before analysis can start.</p>}
        {ambiguousCount > 0 && staged.length > 0 && missing.length === 0 && <p className="landing-missing" role="status">{ambiguousCount} file{ambiguousCount === 1 ? '' : 's'} still need{ambiguousCount === 1 ? 's' : ''} a confirmed subsystem above.</p>}
      </section>

      <div className="landing-cta">
        <button className="ms-button primary landing-analyze" disabled={!canAnalyze} onClick={analyze}>Analyse selected systems<ArrowRight size={16} /></button>
        <button className="landing-textlink" onClick={onStartDemo}><PlayCircle size={16} />Try guided demo</button>
      </div>
    </main>
  </div>;
}
