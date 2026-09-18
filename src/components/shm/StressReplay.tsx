import { Pause, Play } from 'lucide-react';
import type { SignalInspection } from '../../lib/signals';
import { RecordingTrace } from '../telemetry/RecordingTrace';
import '../acv/AcvEvidence.css';
import './ShmEvidence.css';

interface Props {
  signal: SignalInspection | null;
  rowCount: number;
  sampleRateHz?: number;
  cursor: number;
  onCursor: (index: number) => void;
  playing: boolean;
  onToggle: () => void;
  reducedMotion: boolean;
  unit?: string | null;
}
export default function StressReplay({ signal, rowCount, sampleRateHz, cursor, onCursor, playing, onToggle, reducedMotion, unit = null }: Props) {
  return <section className="ve-panel shm-stress-replay" aria-label="Recorded stress replay">
    <header className="ve-heading"><div><span className="ve-kicker">RECORDED STRESS · EXPLANATORY REPLAY</span><h2>Follow the measured stress signal</h2><p>Structural reference view — physical sensor location unavailable.</p></div><button type="button" className="ms-button" onClick={onToggle} disabled={!signal || (reducedMotion && !playing)} aria-label={playing ? 'Pause stress replay' : 'Play stress replay'}>{playing ? <Pause size={13}/> : <Play size={13}/>} {playing ? 'Pause' : 'Play'} stress</button></header>
    {signal ? <><RecordingTrace signal={signal} cursor={cursor} rowCount={rowCount} sampleRateHz={sampleRateHz} unit={unit} label="Recorded stress" onCursor={onCursor}/>
      <div className="shm-replay-controls"><span>Sample <strong>{Math.min(rowCount, cursor + 1).toLocaleString()}</strong> / {rowCount.toLocaleString()}</span><input type="range" min={0} max={Math.max(0, rowCount - 1)} value={cursor} onChange={event => onCursor(Number(event.target.value))} aria-label="Stress replay sample"/><span>{sampleRateHz ? `${(cursor / sampleRateHz).toFixed(3)} s` : 'Sample order'}</span></div>
      <p className="ve-footnote">{reducedMotion ? 'Reduced motion is enabled; use the sample slider or arrow keys to inspect the stress trace. ' : 'Playback compresses the recording for inspection. '}The structural pulse is illustrative; it does not represent a measured spatial stress distribution. The file-level damage output stays fixed during replay.</p>
    </> : <p className="ve-empty">Loading the recorded stress trace…</p>}
  </section>;
}
