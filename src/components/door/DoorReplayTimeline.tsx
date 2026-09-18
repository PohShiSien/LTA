import { useEffect, useId, useMemo, useRef, type KeyboardEvent } from 'react';
import { ChevronLeft, ChevronRight, Pause, Play } from 'lucide-react';
import { chronologicalDoorCycles, clampDoorProgress, doorCycleResultVisible, type DoorReplayCycle } from '../../lib/doorReplay';
import './DoorReplay.css';

export interface DoorReplayTimelineProps {
  cycles: DoorReplayCycle[];
  selectedIndex: number;
  playing: boolean;
  progress: number;
  onPlay: () => void;
  onPause: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onSelect: (index: number) => void;
  reducedMotion?: boolean;
}

export default function DoorReplayTimeline({ cycles, selectedIndex, playing, progress, onPlay, onPause, onPrevious, onNext, onSelect, reducedMotion = false }: DoorReplayTimelineProps) {
  const ordered = useMemo(() => chronologicalDoorCycles(cycles), [cycles]);
  const position = ordered.findIndex(cycle => cycle.index === selectedIndex);
  const selected = ordered[position];
  const fraction = clampDoorProgress(progress);
  const timelineRef = useRef<HTMLDivElement>(null);
  const scrubId = useId();
  useEffect(() => {
    const rail = timelineRef.current;
    const marker = rail?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!rail || !marker) return;
    const left = marker.offsetLeft - rail.offsetLeft;
    if (left < rail.scrollLeft || left + marker.offsetWidth > rail.scrollLeft + rail.clientWidth) {
      rail.scrollTo({ left: Math.max(0, left - rail.clientWidth / 2 + marker.offsetWidth / 2), behavior: reducedMotion ? 'instant' : 'smooth' });
    }
  }, [selectedIndex, reducedMotion]);

  const navigate = (event: KeyboardEvent<HTMLButtonElement>, itemPosition: number) => {
    const target = event.key === 'ArrowLeft' ? itemPosition - 1 : event.key === 'ArrowRight' ? itemPosition + 1 : event.key === 'Home' ? 0 : event.key === 'End' ? ordered.length - 1 : null;
    if (target === null || !ordered[target]) return;
    event.preventDefault();
    onSelect(ordered[target].index);
    timelineRef.current?.querySelector<HTMLButtonElement>(`[data-cycle-index="${ordered[target].index}"]`)?.focus();
  };

  return <section className={`door-replay-timeline${reducedMotion ? ' reduced-motion' : ''}`} aria-label="Door recorded-cycle replay">
    <header><div><span className="door-replay-eyebrow">Recorded movement replay</span><h2>Cycle timeline</h2></div><span className="door-replay-mode">Compressed · 1.5 s / cycle</span></header>
    <div className="door-replay-controls">
      <div className="door-replay-buttons">
        <button onClick={onPrevious} disabled={position <= 0} aria-label="Previous cycle"><ChevronLeft size={16} /></button>
        <button className="door-replay-play" onClick={playing ? onPause : onPlay} disabled={!ordered.length} aria-label={playing ? 'Pause cycle replay' : 'Play cycle replay'}>{playing ? <Pause size={14} /> : <Play size={14} />}<span>{playing ? 'Pause' : 'Play'}</span></button>
        <button onClick={onNext} disabled={position < 0 || position >= ordered.length - 1} aria-label="Next cycle"><ChevronRight size={16} /></button>
      </div>
      <div className="door-replay-now"><strong>{selected ? `Cycle ${selected.index + 1} of ${ordered.length}` : 'No recorded cycles'}</strong><span>{selected?.operation === 'Unknown' ? 'Movement direction unavailable' : `${selected?.operation ?? '—'} · inferred`}</span></div>
      <div className="door-replay-progress" role="progressbar" aria-label="Selected cycle replay progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}><i style={{ width: `${fraction * 100}%` }} /><span>{Math.round(fraction * 100)}%</span></div>
    </div>
    {selected && <div className="door-replay-timestamps"><span>Start <time>{selected.startTime}</time></span><span>End <time>{selected.endTime}</time></span></div>}
    <div className="door-replay-markers" ref={timelineRef} role="group" aria-label="All detected Door cycles">
      {ordered.map((cycle, itemPosition) => {
        const visible = doorCycleResultVisible(itemPosition, position, playing, fraction);
        const abnormal = visible && cycle.prediction === 'Abnormal resistance';
        const isSelected = cycle.index === selectedIndex;
        return <button key={cycle.index} data-cycle-index={cycle.index} className={`${abnormal ? 'abnormal' : visible ? 'normal' : 'pending'}${isSelected ? ' selected' : ''}`} aria-pressed={isSelected} aria-label={`Recorded cycle ${cycle.index + 1}: ${visible ? cycle.prediction : 'classification available at cycle completion'}; ${cycle.operation}; ${cycle.startTime} to ${cycle.endTime}`} title={`Cycle ${cycle.index + 1} · ${cycle.startTime} → ${cycle.endTime}`} onClick={() => onSelect(cycle.index)} onKeyDown={event => navigate(event, itemPosition)}><span>{String(cycle.index + 1).padStart(2, '0')}</span><i aria-hidden="true">{abnormal ? '!' : visible ? '·' : '—'}</i>{isSelected && <b aria-hidden="true" style={{ transform: `scaleX(${fraction})` }} />}</button>;
      })}
    </div>
    <div className="door-replay-scrubber"><label htmlFor={scrubId}>Select cycle</label><input id={scrubId} type="range" min={0} max={Math.max(0, ordered.length - 1)} value={Math.max(0, position)} disabled={ordered.length < 2} onChange={event => { const cycle = ordered[Number(event.target.value)]; if (cycle) onSelect(cycle.index); }} aria-valuetext={selected ? `Recorded cycle ${selected.index + 1}, ${selected.startTime}` : 'No cycles'} /></div>
    <footer><div className="door-replay-legend"><span><i className="normal" />Normal</span><span><i className="abnormal" />! Abnormal resistance</span><span><i className="pending" />Awaiting replay completion</span></div><p>True recording order and timestamps. Classification is revealed after each recorded movement.</p></footer>
  </section>;
}
