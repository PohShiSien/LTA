import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowLeft, ArrowRight, X } from 'lucide-react';
import './GuidedTour.css';

interface Step {
  selector: string;
  title: string;
  body: string;
}

const STEPS: Step[] = [
  { selector: '.landing-upload', title: '1 · Upload', body: 'Drop a recording here, or browse files. JagaRail reads the file’s schema to guess which subsystem it belongs to, and asks you to confirm anything ambiguous.' },
  { selector: '.landing-cards', title: '2 · Choose analyses', body: 'Select the systems matching your files. Each system uses its own supplied model and recording; their timelines and train identities stay separate.' },
  { selector: '.landing-analyze', title: '3 · Analyse', body: 'With files assigned, this button opens the workspace and runs their models automatically. For this tour, Next opens an empty workspace so you can explore the controls.' },
  { selector: '.ms-source-panel', title: '4 · Processing', body: 'Upload a recording here to run its model automatically. Processing updates appear for the active subsystem, and an error stays visible if a file or model cannot run.' },
  { selector: '#subsystem-train', title: '5 · 3D inspection', body: 'After analysis, the train focuses the available finding. Drag to rotate and scroll to zoom. Recording-level results stay unlocated when the model supplies no component location.' },
  { selector: '[aria-label="Prediction result"]', title: '6 · Read the finding', body: 'The result shows the model’s actual output. The next-steps table links each recommendation to its supporting evidence through “Why?”. Without an analysed file, no prediction is shown.' },
  { selector: '#evidence-inspector', title: '7 · Inspect evidence', body: 'After uploading, review the recorded signal, sample cursor and original source fields here. These measurements explain the recording; they do not replace the model output.' },
  { selector: '.ms-page-heading .ms-button', title: '8 · Export', body: 'Once analysis succeeds, download its CSV or export the available results as a ZIP. Finish returns to a clean Home page, ready for your own files.' },
];

interface Props {
  step: number;
  onStepChange: (step: number) => void;
  onFinish: () => void;
  onSkip: () => void;
}

export default function GuidedTour({ step, onStepChange, onFinish, onSkip }: Props) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [panelSize, setPanelSize] = useState({ width: 360, height: 260 });
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(document.activeElement as HTMLElement | null);
  const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const current = STEPS[step];

  useEffect(() => {
    let frame: number;
    let previousTarget: Element | null = null;
    const track = () => {
      const target = document.querySelector(current.selector);
      if (target && target !== previousTarget) target.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' });
      previousTarget = target;
      const next = target?.getBoundingClientRect() ?? null;
      setRect(previous => previous?.x === next?.x && previous?.y === next?.y && previous?.width === next?.width && previous?.height === next?.height ? previous : next);
      frame = requestAnimationFrame(track);
    };
    setRect(null);
    track();
    panelRef.current?.focus({ preventScroll: true });
    return () => cancelAnimationFrame(frame);
  }, [current.selector, reducedMotion]);

  useEffect(() => () => { if (restoreFocus.current?.isConnected) restoreFocus.current.focus({ preventScroll: true }); }, []);

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
    if (step === STEPS.length - 1) onFinish();
    else onStepChange(step + 1);
  };
  const goPrevious = () => { if (step > 0) onStepChange(step - 1); };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); onSkip(); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); goNext(); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); goPrevious(); }
    else if (event.key === 'Tab') {
      const buttons = [...panelRef.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const first = buttons[0], last = buttons.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    } else if (event.key === 'Enter' && event.target === panelRef.current) { event.preventDefault(); goNext(); }
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

  return <div className="tour-overlay" role="presentation" data-tour-target={current.selector}>
    {box && <div className="tour-spotlight" style={{ top: box.top, left: box.left, width: box.width, height: box.height }} />}
    <div className="tour-panel" ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="tour-title" tabIndex={-1} onKeyDown={onKeyDown} style={{ top: tooltipTop, left: tooltipLeft }}>
      <header><span className="tour-step-count">Step {step + 1} of {STEPS.length}</span><button aria-label="Skip guided tour" onClick={onSkip}><X size={16} /></button></header>
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
