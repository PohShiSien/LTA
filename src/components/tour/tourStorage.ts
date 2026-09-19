export const TOUR_FLAG = 'jagarail.tour.completed.v1';
const SESSION_DISMISS_KEY = 'jagarail.tour.dismissed';

export function hasSeenTour(): boolean {
  try { return Boolean(localStorage.getItem(TOUR_FLAG)) || Boolean(sessionStorage.getItem(SESSION_DISMISS_KEY)); }
  catch { return false; }
}
export function dismissTourForSession(): void {
  try { sessionStorage.setItem(SESSION_DISMISS_KEY, '1'); } catch { /* private browsing: the offer simply reappears */ }
}
export function markTourComplete(): void {
  try { localStorage.setItem(TOUR_FLAG, '1'); } catch { /* private browsing: the offer simply reappears */ }
}
