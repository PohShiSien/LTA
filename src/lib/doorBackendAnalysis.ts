import type { AnalysisResult, RecordingSummary } from '../types/multisystem';
import { validateDoorAnalysis, type DoorAnalysis } from './railwitnessDoorClient';

/** Adapt only successfully validated uploaded Door results; demo inference remains separate. */
export function doorAnalysisResult(analysis: DoorAnalysis, recording: RecordingSummary): AnalysisResult {
  validateDoorAnalysis(analysis);
  if (recording.source.subsystem !== 'door' || recording.source.mode !== 'uploaded') throw new Error('The Door backend can only populate an uploaded Door recording.');
  if (analysis.source_name !== recording.source.fileName || analysis.summary.rows !== recording.rowCount) throw new Error('Door backend result does not match the selected source filename or row count. Run analysis again with the original CSV.');
  let nextIndex = 0;
  return {
    source: { ...recording.source },
    subsystem: 'door',
    scope: 'cycle',
    analysedAt: new Date().toISOString(),
    model: {
      version: analysis.model_id,
      name: analysis.model_name,
      description: 'Frozen logistic regression with trained preprocessing and gap-based completed-cycle segmentation, served by the Python backend.',
      training: 'Frozen deployment artifact: backend/door/models/door_model.joblib. No training occurs in React.',
      validation: 'Internal model validation is separate from organiser Test performance. Classifier scores are uncalibrated.',
    },
    notes: [...analysis.warnings, analysis.retention],
    segments: analysis.segments.map(segment => {
      const startIndex = segment.start_index ?? nextIndex;
      const endIndex = segment.end_index ?? startIndex + segment.n_rows - 1;
      nextIndex = endIndex + 1;
      return { start_time: segment.start_time, end_time: segment.end_time, prediction: segment.prediction, startIndex, endIndex };
    }),
  };
}
