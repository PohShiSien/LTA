import { useEffect, useRef, useState } from 'react';
import type { SubsystemVisualState } from '../types/visualization';

/** A short presentation of a completed analysis, never a second inference pass. */
export function useAnalysisScan(key: string, enabled: boolean, reducedMotion: boolean) {
  const [frame, setFrame] = useState({ key: '', progress: 0 });
  useEffect(() => {
    if (!enabled || !key || reducedMotion) return;
    const start = performance.now();
    setFrame({ key, progress: 0 });
    const timer = setInterval(() => {
      const progress = Math.min(1, (performance.now() - start) / 2000);
      setFrame({ key, progress });
      if (progress === 1) clearInterval(timer);
    }, 50);
    return () => clearInterval(timer);
  }, [key, enabled, reducedMotion]);
  const progress = reducedMotion ? 1 : frame.key === key ? frame.progress : 0;
  const phase: SubsystemVisualState['analysisPhase'] = !key ? 'idle' : !enabled || progress === 1 ? 'settled' : 'scanning';
  return { phase, progress: phase === 'settled' ? 1 : progress };
}

/** Replay sample order in eight seconds; sample indices are never presented as timestamps. */
export function useStressPlayback(key: string, rowCount: number, cursor: number, onCursor: (cursor: number) => void) {
  const [playback, setPlayback] = useState({ key: '', playing: false });
  const current = useRef({ key, cursor, onCursor });
  current.current = { key, cursor, onCursor };
  const playing = playback.key === key && playback.playing && rowCount > 1;
  useEffect(() => {
    setPlayback(previous => previous.key === key ? previous : { key, playing: false });
  }, [key]);
  useEffect(() => {
    if (!playing) return;
    const start = performance.now();
    const origin = current.current.cursor;
    const timer = setInterval(() => {
      if (current.current.key !== key) return;
      const next = Math.min(rowCount - 1, origin + Math.floor((performance.now() - start) / 8000 * (rowCount - 1)));
      current.current.onCursor(next);
      if (next === rowCount - 1) {
        setPlayback({ key, playing: false });
        clearInterval(timer);
      }
    }, 100);
    return () => clearInterval(timer);
  }, [key, rowCount, playing]);
  const pause = () => setPlayback({ key, playing: false });
  const toggle = () => {
    if (!playing && cursor >= rowCount - 1) current.current.onCursor(0);
    setPlayback({ key, playing: !playing });
  };
  return { playing, toggle, pause, progress: rowCount > 1 ? cursor / (rowCount - 1) : 0 };
}
