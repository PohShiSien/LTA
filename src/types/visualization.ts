/** Recorded replay display state. It never changes an inference result or asset mapping. */
export interface SubsystemVisualState {
  door?: {
    cycleNumber: number;
    operation: 'Open' | 'Close' | 'Unknown';
    progress: number;
    completed: boolean;
    prediction: 'Normal' | 'Abnormal resistance';
  };
  stress?: { progress: number; amplitude: number; playing: boolean };
}
