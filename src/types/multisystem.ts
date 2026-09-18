export type Subsystem = 'door' | 'acv' | 'rail' | 'shm';
export type RailClass = 'Normal' | 'Side I' | 'Side II';
export type ValueKind = 'recorded' | 'derived' | 'predicted' | 'metadata';
export type SourceMode = 'uploaded' | 'demo';
export type CellValue = string | number | null;

export interface SourceRef {
  datasetId: string;
  subsystem: Subsystem;
  fileId: string;
  fileName: string;
  mode: SourceMode;
  recordId?: string;
}
export type PhysicalAnchor =
  | { kind: 'car'; carId: string }
  | { kind: 'door'; carId: string; doorId: string }
  | { kind: 'axleBox'; carOrdinal: number; position: number }
  | { kind: 'railSide'; side: 'Side I' | 'Side II' }
  | { kind: 'measurementPoint'; pointId: string; meshKey: string };
export type Mapping =
  | { status: 'mapped'; anchor: PhysicalAnchor; provenance: string; basis: 'dataset-schema' | 'verified-metadata' }
  | { status: 'unmapped'; reason: string };
export interface DisplayField {
  source: SourceRef;
  fieldKey: string;
  columnIndex: number;
  originalHeader: string;
  label: string;
  kind: ValueKind;
  scope: 'sample' | 'cycle' | 'car-case' | 'recording';
  rawUnit: string | null;
  displayUnit: string | null;
  displayScale?: number;
  carId?: string;
  validityFieldKey?: string;
  description?: string;
  mapping: Mapping;
}
export interface Recording {
  source: SourceRef;
  headers: string[];
  rows: CellValue[][];
  fields: DisplayField[];
  carIds: string[];
  sampleRateHz?: number;
  timeColumnIndex?: number;
  warnings: string[];
  mapping: Mapping;
}
/** Raw samples stay in the analysis worker; this is the lightweight UI manifest. */
export interface RecordingSummary extends Omit<Recording, 'rows'> { rowCount: number }
export interface DoorSegment {
  start_time: string;
  end_time: string;
  prediction: 'Normal' | 'Abnormal resistance';
  startIndex: number;
  endIndex: number;
}
export interface ModelInfo {
  version: string;
  name: string;
  description: string;
  training: string;
  validation: string;
}
export type AnalysisResult = {
  source: SourceRef;
  model: ModelInfo;
  analysedAt: string;
  notes: string[];
} & (
  | { subsystem: 'door'; scope: 'cycle'; segments: DoorSegment[] }
  | { subsystem: 'acv'; scope: 'car-case'; rankedCars: string[]; scores?: Record<string, number> }
  | { subsystem: 'rail'; scope: 'recording'; prediction: RailClass }
  | { subsystem: 'shm'; scope: 'recording'; predictedDamage: number; mapping: Mapping }
);
export type ComponentSelection =
  | { kind: 'car'; carId: string; ordinal: number }
  | { kind: 'axleBox'; carOrdinal: number; position: number }
  | { kind: 'door'; carId: string; doorId: string }
  | { kind: 'railSide'; side: 'Side I' | 'Side II' }
  | { kind: 'recording' };
