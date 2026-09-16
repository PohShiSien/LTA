import { describe, expect, it } from 'vitest';
import { parseReviewHistory, visibleReviews, type ReviewEvent } from '../src/lib/reviewStore';

const fixture: ReviewEvent = { id: 'r1', caseKey: 'recurs:RW-C005-D07', kind: 'note', text: 'Compare the previous closing movement.', createdAt: '2026-09-16T08:00:00Z', evidenceThrough: 1000, cycleId: 'C005' };

describe('browser-local engineer reviews', () => {
  it('restores valid history and rejects malformed persisted data', () => {
    expect(parseReviewHistory(JSON.stringify([fixture]))).toEqual([fixture]);
    expect(parseReviewHistory('{broken')).toEqual([]);
    expect(parseReviewHistory(JSON.stringify({ records: [fixture] }))).toEqual([]);
    expect(parseReviewHistory(JSON.stringify([fixture, { ...fixture, evidenceThrough: 'later' }, { ...fixture, text: '<'.repeat(2001) }, { ...fixture, outcome: 'safe' }]))).toEqual([fixture]);
  });
  it('does not show a future review after rewind or a review from another scenario', () => {
    const later = { ...fixture, id: 'r2', evidenceThrough: 2000 };
    const other = { ...fixture, id: 'r3', caseKey: 'clears:RW-C005-D07' };
    expect(visibleReviews([fixture, later, other], fixture.caseKey, 1000)).toEqual([fixture]);
    expect(visibleReviews([fixture, later], fixture.caseKey, 999)).toEqual([]);
  });
});
