import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowLeft, ArrowRight, X } from 'lucide-react';
import './GuidedTour.css';

interface Step {
  selector: string;
  title: string;
  body: string;
  /** Runs once, when the user presses Next to leave this step. */
  onAdvance?: () => void;
}

const STEPS: Step[] = [
  { selector: '.landing-upload', title: '1 · Upload', body: 'Drop a recording here, or browse files. JagaRail reads the file’s schema to guess which subsystem it belongs to, and asks you to confirm anything ambiguous.' },
  { selector: '.landing-cards', title: '2 · Choose analyses', body: 'Select one or more subsystems to analyse. This walkthrough uses Doors with a clearly labelled synthetic recording.' },
  { selector: '.landing-cta .landing-analyze, .landing-analyze', title: '3 · Analyse', body: 'Press Next to analyse the selected systems — this opens the results workspace and starts the run.' },
  { selector: '.ms-progress-board, .ms-source-panel', title: '4 · Processing', body: 'This checklist reflects real processing events — checking files, running the model, preparing results — never a simulated progress bar.' },
  { selector: '.ms-scene, .reference-train-scene', title: '5 · 3D inspection', body: 'The interactive train focuses the relevant component automatically, then hands control straight back — drag to rotate, scroll to zoom.' },
  { selector: '.ms-result', title: '6 · Read the finding', body: 'The diagnosis leads with what the model actually found, and whether a physical location is genuinely supported — never an assumed one.' },
  { selector: '.ms-evidence-grid, .ms-signal-area', title: '7 · Inspect evidence', body: 'Scroll through the recorded signal chart and source fields backing the result.' },
  { selector: '.ms-page-heading .ms-button, [aria-label*="predictions"]', title: '8 · Export', body: 'Download the result as CSV, or collect it into a combined ZIP. Demo exports always stay clearly separate from your real uploaded results.' },
];

interface Props {
  step: number;
  onStepChange: (step: number) => void;
  onEnterWorkspaceDemo: () => void;
  onFinish: () => void;
  onSkip: () => void;
}

export default function GuidedTour({ step, onStepChange, onEnterWorkspaceDemo, onFinish, onSkip }: Props) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [panelSize, setPanelSize] = useState({ width: 360, height: 260 });
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);
  const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const current = STEPS[step];

  useEffect(() => {
    restoreFocus.current = document.activeElement as HTMLElement | null;
    let frame: number;
    const track = () => {
      const target = document.querySelector(current.selector.split(',')[0].trim());
      setRect(target ? target.getBoundingClientRect() : null);
      frame = requestAnimationFrame(track);
    };
    const target = document.querySelector(current.selector.split(',')[0].trim());
    target?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' });
    track();
    panelRef.current?.focus();
    return () => cancelAnimationFrame(frame);
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => { restoreFocus.current?.focus?.(); }, []);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const measure = () => setPanelSize({ width: panel.offsetWidth, height: panel.offsetHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [step]);

  const goNext = () => {
    current.onAdvance?.();
    if (step === STEPS.length - 1) onFinish();
    else onStepChange(step + 1);
  };
  const goPrevious = () => { if (step > 0) onStepChange(step - 1); };

  // Step "Analyse" -> "Processing" crosses from the landing page into the workspace and starts the demo run.
  useEffect(() => {
    if (step !== 3) return;
    const timer = setTimeout(() => onEnterWorkspaceDemo(), 0);
    return () => clearTimeout(timer);
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  // Once inside the workspace, click "Run analysis" as soon as it's available so the checklist has something real to show.
  useEffect(() => {
    if (step !== 3) return;
    const timer = setInterval(() => {
      const button = document.querySelector('.ms-source-panel .ms-button.primary') as HTMLButtonElement | null;
      if (button && !button.disabled) { button.click(); clearInterval(timer); }
    }, 200);
    return () => clearInterval(timer);
  }, [step]);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); onSkip(); }
    else if (event.key === 'ArrowRight' || event.key === 'Enter') { event.preventDefault(); goNext(); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); goPrevious(); }
  };

  const pad = 10;
  const margin = 16;
  const box = rect ? { top: rect.top - pad, left: rect.left - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 } : null;
  let tooltipTop: number;
  if (!box) tooltipTop = window.innerHeight / 2 - panelSize.height / 2;
  else {
    const spaceBelow = window.innerHeight - (box.top + box.height) - margin;
    const spaceAbove = box.top - margin;
    if (spaceBelow >= panelSize.height) tooltipTop = box.top + box.height + margin;
    else if (spaceAbove >= panelSize.height) tooltipTop = box.top - panelSize.height - margin;
    // Neither side fits: dock wherever has more room and let the viewport clamp win.
    else tooltipTop = spaceBelow >= spaceAbove ? box.top + box.height + margin : margin;
  }
  tooltipTop = Math.min(Math.max(margin, tooltipTop), Math.max(margin, window.innerHeight - panelSize.height - margin));
  const tooltipLeft = box ? Math.min(Math.max(margin, box.left), Math.max(margin, window.innerWidth - panelSize.width - margin)) : window.innerWidth / 2 - panelSize.width / 2;

  return <div className="tour-overlay" role="presentation">
    {box && <div className="tour-spotlight" style={{ top: box.top, left: box.left, width: box.width, height: box.height }} />}
    <div className="tour-panel" ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="tour-title" tabIndex={-1} onKeyDown={onKeyDown} style={{ top: tooltipTop, left: tooltipLeft }}>
      <header><span className="tour-step-count">Step {step + 1} of {STEPS.length}</span><button aria-label="Skip guided demo" onClick={onSkip}><X size={16} /></button></header>
      <h2 id="tour-title">{current.title}</h2>
      <p>{current.body}</p>
      <footer>
        <button className="ms-button small" onClick={onSkip}>Skip</button>
        <div className="tour-nav">
          <button className="ms-button small" onClick={goPrevious} disabled={step === 0}><ArrowLeft size={13} />Previous</button>
          <button className="ms-button primary small" onClick={goNext}>{step === STEPS.length - 1 ? 'Finish' : 'Next'}<ArrowRight size={13} /></button>
        </div>
      </footer>
    </div>
  </div>;
}
