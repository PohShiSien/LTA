import { ChevronFirst, ChevronRight, Clock3, EyeOff, Pause, Play, SkipForward } from 'lucide-react';
import type { ReplayAction, ReplayState, TelemetryCycle } from '../../types/railwitness';

interface Props { state: ReplayState; cycles: TelemetryCycle[]; dispatch: (action: ReplayAction) => void; disabled?: boolean }

export function ReplayTimeline({ state, cycles, dispatch, disabled = false }: Props) {
  return <section className="replay-bar" aria-label="Chronological replay controls">
    <div className="replay-bar-label"><Clock3 size={14} /><span>CYCLE REPLAY</span></div>
    <div className="replay-controls">
      <button className="icon-button" aria-label="Restart from first cycle" title="Restart from first cycle" onClick={() => dispatch({ type: 'reset', index: 0 })} disabled={disabled}><ChevronFirst size={14} /></button>
      <button className="icon-button" aria-label={state.playing ? 'Pause replay' : 'Play replay'} title={state.playing ? 'Pause' : 'Play'} disabled={disabled || state.currentIndex === cycles.length - 1} onClick={() => dispatch({ type: state.playing ? 'pause' : 'play' })}>{state.playing ? <Pause size={12} /> : <Play size={12} />}</button>
      <button className="icon-button" aria-label="Step to next cycle" title="Step to next cycle" onClick={() => dispatch({ type: 'step' })} disabled={disabled || state.currentIndex === cycles.length - 1}><SkipForward size={13} /></button>
    </div>
    <div className="replay-progress">
      <input aria-label="Replay cycle" className="timeline-range" type="range" min={0} max={cycles.length - 1} value={state.currentIndex} disabled={disabled} aria-valuetext={`Cycle ${state.currentIndex + 1}, ${cycles[state.currentIndex].timestampLabel}`} onChange={event => dispatch({ type: 'seek', index: Number(event.target.value) })} />
      <div className="timeline-labels"><span>{cycles[0].timestampLabel}</span><span>Cycle {String(state.currentIndex + 1).padStart(2, '0')} / {String(cycles.length).padStart(2, '0')}</span><span>{state.hideFutureData && state.currentIndex < cycles.length - 1 ? 'FUTURE HIDDEN' : cycles[cycles.length - 1].timestampLabel}</span></div>
    </div>
    <span className="timeline-current">{cycles[state.currentIndex].timestampLabel}</span>
    <label className="future-switch"><EyeOff size={12} /><span>Hide future data</span><input type="checkbox" checked={state.hideFutureData} disabled={disabled} onChange={event => dispatch({ type: 'set-hide-future', value: event.target.checked })} /><span className={`switch ${state.hideFutureData ? 'on' : ''}`} aria-hidden="true" /></label>
    <ChevronRight size={12} color="#526c7c" />
  </section>;
}
