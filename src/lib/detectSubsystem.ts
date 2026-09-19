import type { Subsystem } from '../types/multisystem';

export interface SubsystemGuess {
  subsystem: Subsystem | null;
  confidence: 'high' | 'ambiguous';
  reason: string;
}

const RAIL_HEADER_COUNT = 129;

function splitFirstLine(text: string): string[] {
  const firstLine = text.replace(/^﻿/, '').split(/\r?\n/, 1)[0] ?? '';
  // A lightweight split for detection only; the worker's full CSV parser performs the authoritative parse.
  return firstLine.split(',').map(cell => cell.trim().replace(/^"|"$/g, ''));
}

/**
 * Suggests a subsystem from the extension and first row; the user can correct the assignment.
 * This never substitutes for the worker's authoritative per-subsystem validation in `parseRecording`.
 */
export async function detectSubsystem(file: File): Promise<SubsystemGuess> {
  if (/\.xlsx$/i.test(file.name)) {
    return { subsystem: 'acv', confidence: 'high', reason: 'XLSX workbooks are supported for ACV case files only.' };
  }
  if (!/\.csv$/i.test(file.name)) {
    return { subsystem: null, confidence: 'ambiguous', reason: 'Only .csv recordings or ACV .xlsx case files are supported.' };
  }
  const head = await file.slice(0, 64 * 1024).text();
  const cells = splitFirstLine(head);
  if (cells.some(cell => /^Car \d{2} - /i.test(cell))) {
    return { subsystem: 'acv', confidence: 'high', reason: 'Header row uses the "Car NN - parameter" ACV schema.' };
  }
  const hasDatetime = cells.some(cell => /^(datetime|time|timestamp)$/i.test(cell));
  const hasMotorCurrent = cells.some(cell => /motor current/i.test(cell));
  const hasDoorPosition = cells.some(cell => /door.*position/i.test(cell));
  if (hasDatetime && hasMotorCurrent && hasDoorPosition) {
    return { subsystem: 'door', confidence: 'high', reason: 'Header row includes Datetime, motor current and door position fields.' };
  }
  if (cells.length === RAIL_HEADER_COUNT) {
    return { subsystem: 'rail', confidence: 'high', reason: `Row has exactly ${RAIL_HEADER_COUNT} columns, matching the Rail Corrugation schema.` };
  }
  if (cells.length === 1 && (cells[0] !== '' && Number.isFinite(Number(cells[0])) || /stress/i.test(cells[0]))) {
    return { subsystem: 'shm', confidence: 'high', reason: 'File has a single numeric column, matching the Structural Health stress schema.' };
  }
  return { subsystem: null, confidence: 'ambiguous', reason: `Could not match this file's ${cells.length}-column schema to a known subsystem.` };
}
