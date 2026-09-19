import type { AnalysisResult, RecordingSummary } from '../types/multisystem';
import type { DoorAnalysis } from './railwitnessDoorClient';

/** Adapt only successfully validated results for the matching Door recording. */
export function doorAnalysisResult(analysis: DoorAnalysis, recording: RecordingSummary): AnalysisResult {
  if (recording.source.subsystem !== 'door') throw new Error('The Door backend can only populate a Door recording.');
  if (analysis.source_name !== recording.source.fileName || analysis.summary.rows !== recording.rowCount) throw new Error('Door backend result does not match the selected source filename or row count. Run analysis again with the original CSV.');
  return {
    source: { ...recording.source },
    subsystem: 'door',
    scope: 'cycle',
    analysedAt: new Date().toISOString(),
    model: {
      version: analysis.model_id,
      name: analysis.model_name,
      description: 'Frozen logistic regression with trained preprocessing and gap-based completed-cycle segmentation, served by the Python backend.',
      training: 'Frozen deployment artifact: backend/door/door_model.joblib. No training occurs in React.',
      validation: 'Internal model validation is separate from organiser Test performance. Classifier scores are uncalibrated.',
    },
    notes: [...analysis.warnings, analysis.retention],
    segments: analysis.segments.map(segment => ({
      start_time: segment.start_time, end_time: segment.end_time, prediction: segment.prediction,
      startIndex: segment.start_index, endIndex: segment.end_index,
    })),
  };
}
