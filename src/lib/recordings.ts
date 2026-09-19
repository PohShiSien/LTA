import { strFromU8, Unzip, UnzipInflate, unzipSync } from 'fflate';
import type { CellValue, DisplayField, Mapping, Recording, SourceRef, Subsystem } from '../types/multisystem';
import { railChannelIndexes } from './topology';

const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const unmapped = (reason: string): Mapping => ({ status: 'unmapped', reason });
const numeric = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** RFC-style quoted fields, including embedded newlines; malformed quoting is rejected. */
export function parseCsv(contents: string): string[][] {
  const text = contents.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let closedQuote = false;
  const finishCell = () => { row.push(cell); cell = ''; closedQuote = false; };
  const finishRow = () => {
    finishCell();
    if (row.length > 1 || row[0].trim() !== '') rows.push(row);
    row = [];
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { cell += '"'; index++; }
        else { quoted = false; closedQuote = true; }
      } else cell += char;
    } else if (char === ',') finishCell();
    else if (char === '\r' || char === '\n') {
      if (char === '\r' && text[index + 1] === '\n') index++;
      finishRow();
    } else if (char === '"') {
      if (cell.length || closedQuote) throw new Error(`Malformed CSV quote near character ${index + 1}.`);
      quoted = true;
    } else {
      if (closedQuote) throw new Error(`Unexpected text after a quoted CSV field near character ${index + 1}.`);
      cell += char;
    }
  }
  if (quoted) throw new Error('The CSV ends inside an unclosed quoted field.');
  if (cell.length || row.length || closedQuote) finishRow();
  if (!rows.length) throw new Error('The recording is empty.');
  return rows;
}

function parseCell(value: CellValue, preserveText = false): CellValue {
  if (value === null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (preserveText) return value;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (NUMBER.test(trimmed)) {
    const number = Number(trimmed);
    if (Number.isFinite(number)) return number;
  }
  return value;
}

function xmlText(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '\uFFFD';
    }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[entity.toLowerCase()];
  });
}

function attributes(tag: string): Record<string, string> {
  return Object.fromEntries([...tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(match => [match[1], xmlText(match[2] ?? match[3])]));
}

function textNodes(xml: string): string {
  return [...xml.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)].map(match => xmlText(match[1])).join('');
}

function columnIndex(reference: string): number {
  const letters = /^([A-Z]+)\d+$/.exec(reference)?.[1];
  if (!letters) throw new Error(`Invalid spreadsheet cell address: ${reference}.`);
  let index = 0;
  for (const letter of letters) index = index * 26 + letter.charCodeAt(0) - 64;
  return index - 1;
}

/** OOXML reader for tabular case files. No DOM dependency, so parsing can run in a worker. */
function readWorkbook(contents: ArrayBuffer): { table: CellValue[][]; warnings: string[]; date1904: boolean } {
  let files: ReturnType<typeof unzipSync>;
  try {
    // Worksheet XML can exceed 350 MB. Only small workbook metadata is expanded here.
    files = unzipSync(new Uint8Array(contents), { filter: entry => /^xl\/(?:workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml)$/.test(entry.name) });
  } catch { throw new Error('Cannot read this XLSX archive. Upload an unencrypted .xlsx workbook or CSV.'); }
  const xml = (name: string) => files[name] ? strFromU8(files[name]) : '';
  const workbook = xml('xl/workbook.xml');
  if (!workbook) throw new Error('The XLSX archive has no workbook definition.');
  const sheets = [...workbook.matchAll(/<(?:\w+:)?sheet\s([^>]*?)\/?\s*>/g)].map(match => attributes(match[1]));
  if (sheets.length !== 1) throw new Error('Use a workbook containing one recording worksheet; multiple sheets need separate files.');
  const relationships = [...xml('xl/_rels/workbook.xml.rels').matchAll(/<(?:\w+:)?Relationship\s([^>]*?)\/?\s*>/g)].map(match => attributes(match[1]));
  const target = relationships.find(relation => relation.Id === sheets[0]['r:id'])?.Target;
  if (!target) throw new Error('The recording worksheet relationship is missing.');
  const sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
  if (!/^xl\/worksheets\/[^/]+\.xml$/.test(sheetPath)) throw new Error('The workbook uses an unsupported worksheet reference.');
  const strings = [...xml('xl/sharedStrings.xml').matchAll(/<(?:\w+:)?si(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?si>/g)].map(match => textNodes(match[1]));
  const table: CellValue[][] = [];
  let formulaCount = 0;
  const readRow = (rowXml: string) => {
    const row: CellValue[] = [];
    const seen = new Set<number>();
    for (const cellMatch of rowXml.matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
      const attr = attributes(cellMatch[1]);
      const index = columnIndex(attr.r ?? '');
      if (index > 4095 || seen.has(index)) throw new Error('The worksheet has excessive or duplicate cell columns.');
      seen.add(index);
      const body = cellMatch[2] ?? '';
      const value = /<(?:\w+:)?v(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?v>/.exec(body)?.[1];
      if (/<(?:\w+:)?f\b/.test(body)) formulaCount++;
      if (attr.t === 's') {
        const stringIndex = Number(value);
        if (value === undefined || !Number.isInteger(stringIndex) || strings[stringIndex] === undefined) throw new Error('The worksheet references a missing shared string.');
        row[index] = strings[stringIndex];
      } else if (attr.t === 'inlineStr') row[index] = textNodes(body);
      else if (attr.t === 'e') row[index] = value ? `Invalid (${xmlText(value)})` : 'Invalid';
      else if (attr.t === 'str' || attr.t === 'd') row[index] = value === undefined ? null : xmlText(value);
      else if (attr.t === undefined || attr.t === 'n' || attr.t === 'b') row[index] = value === undefined ? null : parseCell(xmlText(value));
      else throw new Error(`Unsupported spreadsheet cell type: ${attr.t}.`);
    }
    if (row.some(value => value !== null && value !== undefined && value !== '')) table.push(Array.from({ length: row.length }, (_, index) => row[index] ?? null));
  };
  let foundSheet = false;
  let finishedSheet = false;
  let buffer = '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const unzipper = new Unzip(file => {
    if (file.name !== sheetPath) return;
    if (foundSheet) throw new Error('The archive contains duplicate recording worksheets.');
    foundSheet = true;
    file.ondata = (error, data, final) => {
      if (error) throw new Error(`Cannot decompress the recording worksheet: ${error.message}`);
      buffer += decoder.decode(data, { stream: !final });
      if (/<!DOCTYPE/i.test(buffer)) throw new Error('The worksheet uses unsupported external definitions.');
      let consumed = 0;
      for (const match of buffer.matchAll(/<(?:\w+:)?row\b[^>]*>([\s\S]*?)<\/(?:\w+:)?row>/g)) {
        readRow(match[1]);
        consumed = match.index! + match[0].length;
      }
      if (consumed) buffer = buffer.slice(consumed);
      // The buffer contains only a partial row or worksheet metadata, never the full sheet.
      if (buffer.length > 16 * 1024 * 1024) throw new Error('A spreadsheet row or metadata block exceeds the supported size.');
      if (final) { finishedSheet = true; buffer = ''; }
    };
    file.start();
  });
  unzipper.register(UnzipInflate);
  const compressed = new Uint8Array(contents);
  for (let offset = 0; offset < compressed.length; offset += 65536) unzipper.push(compressed.subarray(offset, offset + 65536), offset + 65536 >= compressed.length);
  if (!foundSheet || !finishedSheet) throw new Error('The recording worksheet is missing or incomplete.');
  if (!table.length) throw new Error('The worksheet contains no recorded cells.');
  const date1904 = /<(?:\w+:)?workbookPr\b[^>]*\bdate1904=["'](?:1|true)["']/.test(workbook);
  return { table, date1904, warnings: formulaCount ? ['Spreadsheet formula cells use their cached values; formulas are not recalculated.'] : [] };
}

export function railHeaders(): string[] {
  const headers = ['Rotating speed'];
  for (let car = 1; car <= 8; car++) for (let position = 1; position <= 8; position++) {
    headers.push(`Vibration of bearing in position ${position} of car ${car}`, `Shock of bearing in position ${position} of car ${car}`);
  }
  return headers;
}

const normalHeader = (header: string) => header.trim().toLowerCase().replace(/\s+/g, ' ');
const contentHash = (contents: string | ArrayBuffer): string => {
  let hash = 2166136261;
  if (typeof contents === 'string') for (let index = 0; index < contents.length; index++) hash = Math.imul(hash ^ contents.charCodeAt(index), 16777619);
  else for (const value of new Uint8Array(contents)) hash = Math.imul(hash ^ value, 16777619);
  return (hash >>> 0).toString(16).padStart(8, '0');
};

function basicField(source: SourceRef, header: string, column: number, mapping: Mapping): DisplayField {
  return { source, fieldKey: `column-${column}`, columnIndex: column, originalHeader: header, label: header, kind: 'recorded', scope: 'sample', rawUnit: null, displayUnit: null, mapping };
}

function doorField(source: SourceRef, header: string, index: number, mapping: Mapping): DisplayField {
  const field = basicField(source, header, index, mapping);
  if (/^(car type|car number|door number)$/i.test(header.trim())) return { ...field, kind: 'metadata', scope: 'recording', description: 'Recorded identity only; no verified relationship to the reference layout is supplied.' };
  if (/motor current/i.test(header) && /mA/i.test(header)) return { ...field, rawUnit: 'mA', displayUnit: 'A', displayScale: 0.001 };
  if (/motor voltage/i.test(header) && /10\s*mV/i.test(header)) return { ...field, rawUnit: '10 mV', displayUnit: 'V', displayScale: 0.01 };
  if (/door (opening|closing) time/i.test(header) && /(?:0?\.1\s*s|0\.1 s)/i.test(header)) return { ...field, rawUnit: '0.1 s', displayUnit: 's', displayScale: 0.1 };
  if (/^(DCSR|DCSL|DLSR|DLSL)$/i.test(header.trim())) return { ...field, description: 'Controller switch state. Left/right switch names do not identify a rail side.' };
  if (/force|position/i.test(header)) return { ...field, description: 'The source documentation does not supply a unit for this field.' };
  return field;
}

/** Parse all source samples; display decimation must happen only after this boundary. */
export async function parseRecording(fileName: string, contents: string | ArrayBuffer, subsystem: Subsystem, datasetId = `ps3-${subsystem}`): Promise<Recording> {
  if (!fileName.trim()) throw new Error('A source filename is required.');
  let rawTable: CellValue[][];
  const warnings: string[] = [];
  let excelDates = false;
  let excel1904 = false;
  if (/\.xlsx$/i.test(fileName)) {
    if (subsystem !== 'acv') throw new Error('XLSX input is supported for ACV case files. Select the matching subsystem.');
    if (typeof contents === 'string') throw new Error('XLSX input must be supplied as binary file data.');
    const workbook = readWorkbook(contents);
    rawTable = workbook.table;
    warnings.push(...workbook.warnings);
    excelDates = true;
    excel1904 = workbook.date1904;
  } else {
    if (!/\.csv$/i.test(fileName)) throw new Error('Upload a CSV recording or an ACV .xlsx case file.');
    rawTable = parseCsv(typeof contents === 'string' ? contents : new TextDecoder('utf-8', { fatal: true }).decode(contents));
  }
  const source: SourceRef = { datasetId, subsystem, fileName, fileId: `${datasetId}:${subsystem}:${fileName}:${contentHash(contents)}` };
  let headers: string[];
  let data: CellValue[][];
  const firstNumeric = rawTable[0].every(value => numeric(parseCell(value)));
  if ((subsystem === 'rail' || subsystem === 'shm') && firstNumeric) {
    headers = subsystem === 'rail' ? railHeaders() : rawTable[0].map((_, index) => `Stress (source column ${index + 1})`);
    data = rawTable;
    warnings.push('The file has no header row. Columns are addressed explicitly using the documented source schema.');
  } else {
    headers = rawTable[0].map(value => String(value ?? ''));
    data = rawTable.slice(1);
  }
  if (subsystem === 'acv') {
    const nonempty = data.filter(row => row.some(value => value !== null && String(value).trim() !== ''));
    if (nonempty.length !== data.length) warnings.push(`${data.length - nonempty.length} empty rows excluded from the recorded sample count.`);
    data = nonempty;
  }
  if (!data.length) throw new Error('The file has a header but no recorded samples.');
  if (headers.some(header => !header.trim()) || new Set(headers.map(normalHeader)).size !== headers.length) throw new Error('Source headers must be nonempty and unique; no columns were shifted or discarded.');
  const identityColumns = new Set(headers.flatMap((header, index) => /^(car model|car type|car number|door number|train number|datetime|time|timestamp)$/i.test(header.trim()) ? [index] : []));
  const rows = data.map((row, rowIndex) => {
    if (row.length > headers.length || (!excelDates && row.length !== headers.length)) throw new Error(`Row ${rowIndex + 2} has ${row.length} columns; expected ${headers.length}. No channel shifting is allowed.`);
    // Reuse each parsed row rather than holding a second complete rich-case table.
    row.length = headers.length;
    for (let column = 0; column < headers.length; column++) row[column] = parseCell(row[column] ?? null, identityColumns.has(column));
    return row;
  });
  let mapping: Mapping = unmapped('Reference layout — asset mapping not supplied.');
  let fields: DisplayField[] = [];
  let carIds: string[] = [];
  let sampleRateHz: number | undefined;
  let timeColumnIndex = headers.findIndex(header => /^(datetime|time|timestamp)$/i.test(header.trim()));
  if (subsystem === 'rail') {
    const expectedHeaders = railHeaders();
    if (headers.length !== 129 || headers.some((header, index) => normalHeader(header) !== normalHeader(expectedHeaders[index]))) throw new Error('Rail requires exactly 129 columns in documented order: rotational-speed sensor followed by each vibration/shock pair. Unexpected headers or extra columns cannot be mapped.');
    if (rows.length !== 10000) throw new Error(`Rail requires exactly 10,000 samples for its documented one-second recording; received ${rows.length}.`);
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      if (!rows[rowIndex].every(numeric)) throw new Error(`Rail sample ${rowIndex + 1} contains a missing or nonnumeric channel. A complete numeric recording is required for inference.`);
      if (rows[rowIndex][0] !== 0 && rows[rowIndex][0] !== 1) throw new Error(`Rail sample ${rowIndex + 1}: rotational-speed sensor must be the recorded binary 0/1 pulse, not converted speed.`);
    }
    sampleRateHz = 10000;
    carIds = Array.from({ length: 8 }, (_, index) => String(index + 1));
    mapping = unmapped('Recording-level reference. Individual measurement fields map to documented axle-box ordinals; train identity and geographic location are not supplied.');
    fields[0] = { ...basicField(source, headers[0], 0, unmapped('One recording-level rotational-speed sensor, not 64 wheel sensors.')), rawUnit: 'binary pulse', displayUnit: 'binary pulse', description: 'Recorded 0/1 sensor output; it does not establish signed travel direction.' };
    for (let carOrdinal = 1; carOrdinal <= 8; carOrdinal++) for (let position = 1; position <= 8; position++) {
      const address = railChannelIndexes(carOrdinal, position);
      for (const [kind, column] of [['Vibration', address.vibration], ['Shock', address.shock]] as const) fields[column] = {
        ...basicField(source, headers[column], column, { status: 'mapped', anchor: { kind: 'axleBox', carOrdinal, position }, basis: 'dataset-schema', provenance: 'Rail Corrugation Info Kit §2.1 / Figure 2; validated 129-column order.' }),
        label: `${kind} · Car ${carOrdinal} / Position ${position} · ${address.side}`, carId: String(carOrdinal), rawUnit: 'm/s²', displayUnit: 'm/s²',
      };
    }
  } else if (subsystem === 'shm') {
    if (headers.length !== 1 || rows.some(row => !numeric(row[0]))) throw new Error('The supplied SHM schema is one numeric stress column per file. Upload that stress segment, not its label table or an unrecognized multichannel schema.');
    mapping = unmapped('Measurement location not supplied. Random file numbers are not carriage, bogie, or time identifiers.');
    fields = headers.map((header, index) => ({ ...basicField(source, header, index, mapping), description: 'Dynamic stress sample; acquisition unit and sample rate are not specified in the supplied file/kit.' }));
    warnings.push('Stress unit and sample rate are not supplied. File numbering does not establish chronology or physical location.');
  } else if (subsystem === 'door') {
    if (timeColumnIndex < 0 || !headers.some(header => /motor current/i.test(header)) || !headers.some(header => /door.*position/i.test(header))) throw new Error('Door input requires the actual controller headers, including Datetime, motor current, and door position.');
    if (rows.some(row => row[timeColumnIndex] === null)) throw new Error('Door readings require a timestamp on every row.');
    mapping = unmapped('Door stream — location unmapped. Source identity fields, when present, do not provide a verified anchor on this eight-car reference.');
    fields = headers.map((header, index) => doorField(source, header, index, mapping));
    warnings.push('Controller left/right switch labels are not Side I/Side II rail labels. No synthetic healthy envelope is applied to this recording.');
  } else {
    const carColumns = headers.map(header => /^Car (\d{2}) - (.+)$/.exec(header));
    carIds = [...new Set(carColumns.flatMap(match => match ? [match[1]] : []))].sort();
    if (carIds.length !== 8 || timeColumnIndex < 0) throw new Error('ACV requires a Time column and exactly eight distinct two-digit car identifiers in Car NN - parameter headers.');
    mapping = unmapped('Car identities come from source headers; the displayed consist order and icon placement are schematic.');
    fields = headers.map((header, index) => {
      const match = carColumns[index];
      if (!match) {
        const metadata = /^(car model|train number)$/i.test(header.trim());
        return { ...basicField(source, header, index, mapping), kind: metadata ? 'metadata' : 'recorded', scope: metadata ? 'recording' : 'sample' };
      }
      const [, carId, label] = match;
      const validIndex = headers.findIndex(candidate => normalHeader(candidate) === normalHeader(`Car ${carId} - ACV Information Valid`));
      return { ...basicField(source, header, index, { status: 'mapped', anchor: { kind: 'car', carId }, basis: 'dataset-schema', provenance: `Exact identifier from source header: ${header}. Physical consist order is not supplied.` }), carId, label,
        validityFieldKey: validIndex >= 0 && validIndex !== index ? `column-${validIndex}` : undefined,
        description: /mode|status|command|running|fault|valid|load/i.test(label) ? 'Raw source state or code. Values without a documented meaning remain uninterpreted.' : 'Recorded value; a unit is shown only if the source header explicitly states it.',
      };
    });
    warnings.push('Eight car IDs are preserved exactly. Their displayed order is a labelled schematic, independent of predicted leak rank.');
    if (excelDates && rows.some(row => numeric(row[timeColumnIndex]))) {
      fields[timeColumnIndex].rawUnit = excel1904 ? 'Excel serial days (1904)' : 'Excel serial days (1900)';
      fields[timeColumnIndex].description = 'Excel wall-clock timestamp. No source timezone is supplied.';
      if (excel1904) warnings.push('Workbook uses the Excel 1904 date system.');
    }
    // Units in this dataset's plain temperature/pressure headers are undocumented.
    for (const field of fields) {
      const explicitUnit = /\((°C|degC|K|kPa|MPa|bar|Pa|V|A)\)/i.exec(field.originalHeader)?.[1];
      if (explicitUnit) field.rawUnit = field.displayUnit = explicitUnit;
    }
    if (rows.length > 1) {
      const seconds = (value: CellValue): number | null => numeric(value) && excelDates ? value * 86400 : typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) / 1000 : null;
      const first = seconds(rows[0][timeColumnIndex]);
      const second = seconds(rows[1][timeColumnIndex]);
      const step = first !== null && second !== null ? second - first : 0;
      const uniform = step > 0 && rows.every((row, index) => {
        const time = seconds(row[timeColumnIndex]);
        return time !== null && Math.abs(time - (first! + index * step)) < 0.05;
      });
      if (uniform) {
        sampleRateHz = 1 / (Math.round(step * 1000) / 1000);
        if (Math.abs(step - 30) > 0.05) warnings.push(`This file's timestamps indicate ${Math.round(step * 1000) / 1000}-second intervals, rather than the kit's nominal 30 seconds.`);
      } else warnings.push('Recorded timestamps are not uniformly spaced or cannot be decoded. The trace uses sample index; each cursor retains its actual source time.');
    }
  }
  return { source, headers, rows, fields, carIds, sampleRateHz, timeColumnIndex: timeColumnIndex < 0 ? undefined : timeColumnIndex, warnings, mapping };
}

export function sampleTimeLabel(recording: Pick<Recording, 'source' | 'fields' | 'timeColumnIndex' | 'sampleRateHz'>, row: readonly CellValue[], index: number): string {
  if (recording.timeColumnIndex !== undefined) {
    const value = row[recording.timeColumnIndex];
    const unit = recording.fields[recording.timeColumnIndex]?.rawUnit;
    if (numeric(value) && unit?.startsWith('Excel serial days')) {
      const epoch = unit.includes('1904') ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
      return `${new Date(epoch + Math.round(value * 86400000)).toISOString().replace('T', ' ').replace('Z', '')} (source time)`;
    }
    return value === null || value === undefined ? 'Time not recorded' : String(value);
  }
  return recording.sampleRateHz ? `${(index / recording.sampleRateHz).toFixed(4)} s elapsed` : `Sample ${index + 1} · acquisition time not supplied`;
}

export function fieldValue(recording: Pick<Recording, 'fields'>, field: DisplayField, row: readonly CellValue[]): { raw: CellValue; value: CellValue; validity: 'valid' | 'invalid' | 'not_recorded' | 'unknown' } {
  const raw = row[field.columnIndex] ?? null;
  if (raw === null || raw === '') return { raw, value: null, validity: 'not_recorded' };
  if (typeof raw === 'string' && /^(?:invalid|none|nan|n\/a|#)/i.test(raw.trim())) return { raw, value: null, validity: /^none$/i.test(raw.trim()) ? 'not_recorded' : 'invalid' };
  let validity: 'valid' | 'invalid' | 'unknown' = 'valid';
  if (field.validityFieldKey) {
    const validityField = recording.fields.find(candidate => candidate.fieldKey === field.validityFieldKey);
    const flag = validityField ? row[validityField.columnIndex] : null;
    if (typeof flag === 'string' && /^invalid$/i.test(flag.trim())) validity = 'invalid';
    else if (!(typeof flag === 'string' && /^valid$/i.test(flag.trim()))) validity = 'unknown';
  }
  return { raw, value: numeric(raw) ? raw * (field.displayScale ?? 1) : raw, validity };
}
