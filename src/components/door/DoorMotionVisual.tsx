import { useId } from 'react';
import { doorMotionOpenness, type DoorReplayCycle } from '../../lib/doorReplay';
import './DoorReplay.css';

export interface DoorMotionVisualProps {
  operation: DoorReplayCycle['operation'];
  progress: number;
  completed: boolean;
  prediction: DoorReplayCycle['prediction'];
  reducedMotion: boolean;
}

export default function DoorMotionVisual({ operation, progress, completed, prediction, reducedMotion }: DoorMotionVisualProps) {
  const clipId = useId();
  const titleId = useId();
  const openness = doorMotionOpenness(operation, reducedMotion ? (completed ? 1 : 0) : progress);
  const abnormal = completed && prediction === 'Abnormal resistance';
  const label = completed ? (abnormal ? 'Abnormal resistance detected' : 'Classified as Normal') : 'Recorded movement in progress';
  return <section className={`door-motion-visual${abnormal ? ' abnormal' : completed ? ' normal' : ''}${reducedMotion ? ' reduced-motion' : ''}`} aria-label="Illustrative door motion">
    <div className="door-motion-copy"><span className="door-replay-eyebrow">Illustrative door motion</span><h3>{operation === 'Unknown' ? 'Direction unavailable' : `${operation} · inferred movement`}</h3><p>Physical door identity unavailable</p><div className="door-motion-result" role="status" aria-live="polite">{label}</div>{completed && abnormal && <small>Fault detected in this recorded movement</small>}</div>
    <svg viewBox="0 0 310 170" role="img" aria-labelledby={titleId} data-operation={operation} data-openness={openness ?? 'unknown'}>
      <title id={titleId}>{`${operation === 'Unknown' ? 'Representative train doorway; movement direction unavailable.' : `Representative doors ${operation === 'Open' ? 'sliding apart' : 'sliding together'}. ${completed ? 'Recorded movement complete.' : 'Compressed replay in progress.'}`} This motion is illustrative, not a measured physical door position.`}</title>
      <defs><clipPath id={clipId}><rect x="67" y="13" width="176" height="143" rx="5" /></clipPath></defs>
      <path className="door-motion-hull" d="M15 156V36Q15 7 44 7H266Q295 7 295 36V156" />
      <rect className="door-motion-opening" x="67" y="13" width="176" height="143" rx="5" />
      <g clipPath={`url(#${clipId})`}>
        <g className="door-motion-leaf" transform={`translate(${-(openness ?? 0) * 78} 0)`}><rect x="68" y="14" width="86" height="142" rx="3" /><rect className="door-motion-window" x="81" y="29" width="59" height="70" rx="7" /><path d="M140 113v21" /></g>
        <g className="door-motion-leaf" transform={`translate(${(openness ?? 0) * 78} 0)`}><rect x="156" y="14" width="86" height="142" rx="3" /><rect className="door-motion-window" x="170" y="29" width="59" height="70" rx="7" /><path d="M169 113v21" /></g>
      </g>
      <path className="door-motion-sill" d="M56 159h198M38 165h234" /><path className="door-motion-hull-detail" d="M27 36h25v63H27zM258 36h25v63h-25z" />
    </svg>
  </section>;
}
