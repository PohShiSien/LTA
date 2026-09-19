import { useEffect, useRef, useState } from 'react';

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
