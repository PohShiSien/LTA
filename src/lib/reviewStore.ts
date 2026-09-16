export type ReviewKind = 'acknowledged' | 'note' | 'inspection';
export type InspectionOutcome = 'issue_observed' | 'no_issue_observed' | 'inconclusive';

export interface ReviewEvent {
  id: string;
  caseKey: string;
  kind: ReviewKind;
  text: string;
  outcome?: InspectionOutcome;
  createdAt: string;
  evidenceThrough: number;
  cycleId: string;
}

export const REVIEW_STORAGE_KEY = 'railwitness.reviews.v1';

/** Browser-local review history is separate from automated telemetry assessments. */
export function parseReviewHistory(raw: string | null): ReviewEvent[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((event): event is ReviewEvent => {
      if (!event || typeof event !== 'object') return false;
      const item = event as Record<string, unknown>;
      return typeof item.id === 'string' && typeof item.caseKey === 'string'
        && ['acknowledged', 'note', 'inspection'].includes(String(item.kind))
        && typeof item.text === 'string' && item.text.length <= 2000
        && typeof item.createdAt === 'string' && Number.isFinite(Date.parse(item.createdAt))
        && typeof item.evidenceThrough === 'number' && Number.isFinite(item.evidenceThrough)
        && typeof item.cycleId === 'string'
        && (item.outcome === undefined || ['issue_observed', 'no_issue_observed', 'inconclusive'].includes(String(item.outcome)));
    }).slice(-500);
  } catch { return []; }
}

export function visibleReviews(events: ReviewEvent[], caseKey: string, evidenceThrough: number): ReviewEvent[] {
  return events.filter(event => event.caseKey === caseKey && event.evidenceThrough <= evidenceThrough);
}
