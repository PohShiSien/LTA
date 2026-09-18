import { useCallback, useEffect, useMemo, useState } from 'react';
import { chronologicalDoorCycles, doorReplayProgress, DOOR_REPLAY_DURATION_MS, DOOR_REPLAY_RESULT_HOLD_MS, type DoorReplayCycle } from './doorReplay';

interface DoorReplayOptions {
  sourceKey: string;
  cycles: DoorReplayCycle[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  ready: boolean;
  reducedMotion: boolean;
}
interface PlaybackState {
  sourceKey: string;
  selectedIndex: number;
  playing: boolean;
  elapsedMs: number;
}
const completedState = (sourceKey: string, selectedIndex: number): PlaybackState => ({ sourceKey, selectedIndex, playing: false, elapsedMs: DOOR_REPLAY_DURATION_MS });

/** Playback only advances once the caller has the selected cycle's matching detail. */
export function useDoorReplay({ sourceKey, cycles, selectedIndex, onSelect, ready, reducedMotion }: DoorReplayOptions) {
  const ordered = useMemo(() => chronologicalDoorCycles(cycles), [cycles]);
  const [state, setState] = useState<PlaybackState>(() => completedState(sourceKey, selectedIndex));
  const current = state.sourceKey === sourceKey && state.selectedIndex === selectedIndex;
  const playing = current && state.playing && ordered.some(cycle => cycle.index === selectedIndex);
  const progress = current ? doorReplayProgress(state.elapsedMs) : 1;

  useEffect(() => {
    // Masked in render as well: a new recording cannot briefly inherit an old timer.
    setState(previous => previous.sourceKey === sourceKey && previous.selectedIndex === selectedIndex
      ? previous : completedState(sourceKey, selectedIndex));
  }, [sourceKey, selectedIndex]);

  useEffect(() => {
    if (!playing || !ready) return;
    let previousTime = performance.now();
    let active = true;
    const timer = window.setInterval(() => {
      const now = performance.now();
      const elapsed = now - previousTime;
      previousTime = now;
      if (!active) return;
      setState(previous => previous.sourceKey !== sourceKey || previous.selectedIndex !== selectedIndex || !previous.playing
        ? previous : { ...previous, elapsedMs: Math.min(DOOR_REPLAY_DURATION_MS + DOOR_REPLAY_RESULT_HOLD_MS, previous.elapsedMs + elapsed) });
    }, reducedMotion ? 100 : 32);
    return () => { active = false; window.clearInterval(timer); };
  }, [sourceKey, selectedIndex, playing, ready, reducedMotion]);

  useEffect(() => {
    if (!current || !playing || !ready || state.elapsedMs < DOOR_REPLAY_DURATION_MS + DOOR_REPLAY_RESULT_HOLD_MS) return;
    const position = ordered.findIndex(cycle => cycle.index === selectedIndex);
    const nextCycle = ordered[position + 1];
    if (!nextCycle) {
      setState(previous => ({ ...previous, playing: false }));
      return;
    }
    setState({ sourceKey, selectedIndex: nextCycle.index, playing: true, elapsedMs: 0 });
    onSelect(nextCycle.index);
  }, [current, playing, ready, state.elapsedMs, ordered, selectedIndex, sourceKey, onSelect]);

  const select = useCallback((index: number) => {
    if (!ordered.some(cycle => cycle.index === index)) return;
    setState(completedState(sourceKey, index));
    onSelect(index);
  }, [ordered, sourceKey, onSelect]);
  const previous = useCallback(() => {
    const position = ordered.findIndex(cycle => cycle.index === selectedIndex);
    if (position > 0) select(ordered[position - 1].index);
  }, [ordered, selectedIndex, select]);
  const next = useCallback(() => {
    const position = ordered.findIndex(cycle => cycle.index === selectedIndex);
    if (position >= 0 && position < ordered.length - 1) select(ordered[position + 1].index);
  }, [ordered, selectedIndex, select]);
  const play = useCallback(() => {
    if (!ordered.length) return;
    const index = ordered.some(cycle => cycle.index === selectedIndex) ? selectedIndex : ordered[0].index;
    setState(previous => ({ sourceKey, selectedIndex: index, playing: true,
      elapsedMs: previous.sourceKey === sourceKey && previous.selectedIndex === index && previous.elapsedMs < DOOR_REPLAY_DURATION_MS ? previous.elapsedMs : 0 }));
    if (index !== selectedIndex) onSelect(index);
  }, [ordered, selectedIndex, sourceKey, onSelect]);
  const pause = useCallback(() => setState(previous => previous.sourceKey === sourceKey ? { ...previous, playing: false } : previous), [sourceKey]);

  return { playing, progress, completed: progress >= 1, play, pause, previous, next, select };
}
