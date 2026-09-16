import { useState } from 'react';
import { Check, ClipboardCheck, MessageSquareText, Save } from 'lucide-react';
import type { InspectionOutcome, ReviewEvent } from '../../lib/reviewStore';
import './review.css';

interface Props {
  doorId: string;
  events: ReviewEvent[];
  persistent: boolean;
  onRecord: (kind: ReviewEvent['kind'], text: string, outcome?: InspectionOutcome) => void;
}

const outcomeLabels: Record<InspectionOutcome, string> = {
  issue_observed: 'Issue observed',
  no_issue_observed: 'No issue observed',
  inconclusive: 'Inconclusive',
};

export function EngineerReview({ doorId, events, persistent, onRecord }: Props) {
  const [text, setText] = useState('');
  const [outcome, setOutcome] = useState<InspectionOutcome>('inconclusive');
  const [kind, setKind] = useState<'note' | 'inspection'>('note');
  const [saved, setSaved] = useState(false);
  const acknowledged = events.some(event => event.kind === 'acknowledged');
  const record = () => {
    if (!text.trim()) return;
    onRecord(kind, text.trim(), kind === 'inspection' ? outcome : undefined);
    setText('');
    setSaved(true);
  };
  return <section className="panel engineer-review" aria-label="Engineer review">
    <div className="panel-heading">
      <div className="heading-copy"><h2><ClipboardCheck size={16} />Engineer review · {doorId}</h2><p>Human observations stay separate from the automated assessment.</p></div>
      <button className="button small" disabled={acknowledged} onClick={() => onRecord('acknowledged', 'Advisory acknowledged for review.')}>
        <Check size={12} />{acknowledged ? 'Acknowledged' : 'Acknowledge advisory'}
      </button>
    </div>
    <div className="review-content">
      <form className="review-form" onSubmit={event => { event.preventDefault(); record(); }}>
        <div className="review-form-controls">
          <label>Record type<select className="select-input" aria-label="Review record type" value={kind} onChange={event => { setKind(event.target.value as 'note' | 'inspection'); setSaved(false); }}><option value="note">Investigation note</option><option value="inspection">Inspection observation</option></select></label>
          {kind === 'inspection' && <label>Observation<select className="select-input" aria-label="Inspection observation" value={outcome} onChange={event => setOutcome(event.target.value as InspectionOutcome)}>{Object.entries(outcomeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}
        </div>
        <label className="review-text-label" htmlFor="engineer-note">{kind === 'inspection' ? 'Describe the inspection observation' : 'Investigation note'}</label>
        <textarea id="engineer-note" value={text} maxLength={2000} placeholder="Record what you observed and what to check next…" rows={3} onChange={event => { setText(event.target.value); setSaved(false); }} required />
        <div className="review-save"><span>{saved ? <span role="status">Review recorded.</span> : `${text.length} / 2000`}</span><button className="button primary small" type="submit" disabled={!text.trim()}><Save size={12} />Save review</button></div>
      </form>
      <div className="review-history">
        <p className="eyebrow">REVIEW RECORD</p>
        {!events.length ? <p className="review-empty"><MessageSquareText size={17} />No review recorded for this advisory at the current observation cutoff.</p> : <ol>{events.slice().reverse().map(event => <li key={event.id}>
          <div><strong>{event.kind === 'acknowledged' ? 'Acknowledged' : event.kind === 'inspection' ? `Inspection · ${outcomeLabels[event.outcome ?? 'inconclusive']}` : 'Investigation note'}</strong><span>Observed through {event.cycleId}</span></div>
          <p>{event.text}</p><time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString('en-SG', { timeZone: 'Asia/Singapore', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} SGT</time>
        </li>)}</ol>}
      </div>
    </div>
    <p className={`review-storage-note ${persistent ? '' : 'review-storage-note--warning'}`}>
      {persistent ? 'Saved in this browser · synthetic session' : 'Browser storage unavailable · reviews last only until this page is closed'}
      <span>Reviews use the session evidence cutoff. Reference any inspected movement in your note. Recording a review does not clear an advisory or change a verification result.</span>
    </p>
  </section>;
}
