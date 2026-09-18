import { useId, type KeyboardEvent, type PointerEvent } from 'react';
import type { SignalInspection } from '../../lib/signals';

interface Props {
  signal: SignalInspection;
  cursor: number;
  rowCount: number;
  sampleRateHz?: number;
  unit: string | null;
  label: string;
  onCursor: (index: number) => void;
  spectrum?: boolean;
}
const WIDTH = 800, HEIGHT = 225, LEFT = 53, RIGHT = 16, TOP = 18, BOTTOM = 191;
export function RecordingTrace({ signal, cursor, rowCount, sampleRateHz, unit, label, onCursor, spectrum = false }: Props) {
  const id = useId();
  const spectral = spectrum ? signal.spectrum : undefined;
  const data = spectral ? spectral.points.map(point => ({ x: point.frequency, y: point.amplitude })) : signal.points.map(point => ({ x: point.index, y: point.value }));
  const values = data.flatMap(point => point.y === null ? [] : [point.y]);
  const low = values.length ? Math.min(0, ...values) : 0;
  const high = values.length ? Math.max(...values) : 1;
  const span = Math.max(1e-9, high - low);
  const minimum = low - span * .12, maximum = high + span * .16;
  const xMaximum = spectral ? spectral.points.at(-1)?.frequency ?? 1 : Math.max(1, rowCount - 1);
  const x = (value: number) => LEFT + value / xMaximum * (WIDTH - LEFT - RIGHT);
  const y = (value: number) => BOTTOM - (value - minimum) / (maximum - minimum) * (BOTTOM - TOP);
  let drawing = false;
  const path = data.map(point => {
    if (point.y === null) { drawing = false; return ''; }
    const instruction = `${drawing ? 'L' : 'M'}${x(point.x).toFixed(2)},${y(point.y).toFixed(2)}`;
    drawing = true; return instruction;
  }).join(' ');
  const format = (value: number) => Math.abs(value) > 0 && (Math.abs(value) < .01 || Math.abs(value) >= 1e5) ? value.toExponential(1) : value.toFixed(Math.abs(value) < 10 ? 2 : 0);
  const move = (event: PointerEvent<SVGSVGElement>) => {
    if (spectral || !(event.buttons & 1)) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    onCursor(Math.round(Math.max(0, Math.min(1, ((event.clientX - bounds.left) / bounds.width * WIDTH - LEFT) / (WIDTH - LEFT - RIGHT))) * (rowCount - 1)));
  };
  const key = (event: KeyboardEvent) => {
    const increment = event.shiftKey ? 100 : 1;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? rowCount - 1 : event.key === 'ArrowRight' || event.key === 'ArrowUp' ? cursor + increment : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? cursor - increment : undefined;
    if (next !== undefined) { event.preventDefault(); onCursor(Math.max(0, Math.min(rowCount - 1, next))); }
  };
  return <div className="recording-trace">
    <div className="recording-trace-title"><span>{spectral ? 'DERIVED · FFT AMPLITUDE' : 'RECORDED · RAW SIGNAL'}</span><span>{unit ?? 'Unit not supplied'}</span></div>
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role={spectral ? 'img' : 'slider'} tabIndex={spectral ? undefined : 0}
      aria-label={spectral ? `${label} amplitude spectrum` : `${label} sample cursor`} aria-valuemin={spectral ? undefined : 0} aria-valuemax={spectral ? undefined : rowCount - 1} aria-valuenow={spectral ? undefined : cursor}
      aria-valuetext={spectral ? undefined : `Sample ${cursor + 1} of ${rowCount}`} onKeyDown={key}
      onPointerDown={event => { if (!spectral) { event.currentTarget.setPointerCapture(event.pointerId); const bounds = event.currentTarget.getBoundingClientRect(); onCursor(Math.round(Math.max(0, Math.min(1, ((event.clientX - bounds.left) / bounds.width * WIDTH - LEFT) / (WIDTH - LEFT - RIGHT))) * (rowCount - 1))); } }} onPointerMove={move}>
      <defs><linearGradient id={`trace-${id}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#64dec3" stopOpacity=".14"/><stop offset="1" stopColor="#64dec3" stopOpacity="0"/></linearGradient></defs>
      {Array.from({ length: 5 }, (_, index) => { const value = minimum + (maximum - minimum) * index / 4; return <g key={index}><line x1={LEFT} x2={WIDTH - RIGHT} y1={y(value)} y2={y(value)} className="rt-grid"/><text x={LEFT - 9} y={y(value) + 3} textAnchor="end">{format(value)}</text></g>; })}
      {Array.from({ length: 5 }, (_, index) => { const value = xMaximum * index / 4; return <g key={index}><line x1={x(value)} x2={x(value)} y1={TOP} y2={BOTTOM} className="rt-grid rt-grid-vertical"/><text x={x(value)} y={BOTTOM + 22} textAnchor="middle">{spectral ? `${value.toFixed(0)} Hz` : sampleRateHz ? `${(value / sampleRateHz).toFixed(3)} s` : `${Math.round(value) + 1}`}</text></g>; })}
      <path d={path} className="rt-line-glow"/><path d={path} className="rt-line"/>
      {!spectral && <g className="rt-cursor"><line x1={x(cursor)} x2={x(cursor)} y1={TOP} y2={BOTTOM}/><path d={`M${x(cursor) - 4},${TOP - 5}h8l-4,6z`}/></g>}
      {!values.length && <text x={WIDTH / 2} y={HEIGHT / 2} textAnchor="middle">No numeric values recorded</text>}
    </svg>
    <p>{spectral ? `Derived spectrum · samples ${spectral.startIndex + 1}–${spectral.endIndex + 1} · Δf ${spectral.resolutionHz.toFixed(2)} Hz · ${spectral.window}. Diagnostic evidence, not a model attribution.` : `Peak-preserving display · ${signal.points.length.toLocaleString()} plotted points from ${rowCount.toLocaleString()} raw samples. Analysis uses the original samples. ${sampleRateHz ? 'Elapsed recording time.' : 'Horizontal axis: sample index; no acquisition frequency assumed.'}`}</p>
  </div>;
}
