import { useEffect, useState } from 'react';
import type { DoorAnalysis, DoorCycleDetail, createDoorClient } from './railwitnessDoorClient';

/** Scope both the request and its rendered state to the source, job and cycle. */
export function useDoorCycleDetail(client: ReturnType<typeof createDoorClient>, sourceKey: string, job: DoorAnalysis | undefined, cycleIndex: number | null) {
  const [retryKey, retry] = useState(0);
  const [state, setState] = useState<{ key: string; detail: DoorCycleDetail | null; error: string; loading: boolean } | null>(null);
  const key = job && cycleIndex !== null ? `${sourceKey}:${job.job_id}:${cycleIndex}:${retryKey}` : '';

  useEffect(() => {
    if (!key || !job || cycleIndex === null) return;
    const controller = new AbortController();
    let current = true;
    setState({ key, detail: null, error: '', loading: true });
    client.cycle(job.job_id, cycleIndex, controller.signal).then(detail => {
      if (detail.segment.cycle_index !== cycleIndex) throw new Error('The backend returned a different cycle. Run analysis again.');
      if (current) setState({ key, detail, error: '', loading: false });
    }).catch(reason => {
      if (current && !controller.signal.aborted) setState({ key, detail: null, error: reason instanceof Error ? reason.message : 'Could not load cycle evidence. Run analysis again.', loading: false });
    });
    return () => { current = false; controller.abort(); };
  }, [client, key, job, cycleIndex]);

  return {
    detail: state?.key === key ? state.detail : null,
    error: state?.key === key ? state.error : '',
    loading: Boolean(key) && (state?.key !== key || state.loading),
    retry: () => retry(value => value + 1),
  };
}
