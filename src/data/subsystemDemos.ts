import type { AnalysisResult, Recording, Subsystem } from '../types/multisystem';
import { parseRecording } from '../lib/recordings';

/** Authored fixture adapter; never called for uploaded recordings. */
export async function demoRecording(subsystem: Subsystem): Promise<Recording> {
  let name: string, csv: string;
  if (subsystem === 'rail') {
    name = 'rail-side-i-demo.csv';
    csv = Array.from({ length: 10000 }, (_, sample) => [sample % 300 < 150 ? 1 : 0, ...Array.from({ length: 128 }, (_, column) => {
      const axle = Math.floor(column / 2), sideI = axle % 2 === 0, shock = column % 2 === 1;
      const t = sample / 10000;
      return ((sideI ? 2.5 : .7) * Math.sin(2 * Math.PI * (shock ? 870 : 340) * t + axle * .1) + .2 * Math.sin(2 * Math.PI * 71 * t) + (shock && sample % 853 < 3 ? 7 : 0)).toFixed(5);
    })].join(',')).join('\n');
  } else if (subsystem === 'shm') {
    name = 'stress-segment-demo.csv';
    csv = Array.from({ length: 5000 }, (_, i) => (12 * Math.sin(i / 24) + 5 * Math.sin(i / 7) + 2 * Math.cos(i / 137)).toFixed(6)).join('\n');
  } else if (subsystem === 'door') {
    name = 'door-stream-demo.csv';
    const headers = ['Datetime', 'Motor current(mA)', 'Motor Voltage(10mV)', 'Motor electrodynamic force', 'Door opening time(.1s)', 'Door closing time(.1s)', 'Close command', 'Open command', 'DCSR', 'DCSL', 'DLSR', 'DLSL', 'Door Opened', 'Door Locked', 'Door is opening', 'Door is closing', 'Door leaf position'];
    csv = [headers.join(','), ...Array.from({ length: 600 }, (_, i) => {
      const t = new Date(Date.UTC(2026, 8, 18, 14, 0, 0) + i * 100);
      const timestamp = t.toISOString().replace('T', '-').replaceAll(':', '-').replace('.', '-').replace('Z', '');
      const local = i % 200, active = local >= 20 && local <= 100, closing = Math.floor(i / 200) % 2 === 0, position = active ? (local - 20) / 80 * 100 : local < 20 ? 0 : 100;
      const current = active ? 2100 + 800 * Math.sin(position * Math.PI / 100) + (i > 400 && position > 60 && position < 80 ? 1700 : 0) : 0;
      return [timestamp, current.toFixed(1), active ? 7200 : 0, active ? 25 : 0, 80, 80, Number(active && closing), Number(active && !closing), Number(local > 100), Number(local > 100), Number(local > 105), Number(local > 105), Number(!closing && local > 100), Number(closing && local > 105), Number(active && !closing), Number(active && closing), position.toFixed(1)].join(',');
    })].join('\n');
  } else {
    name = 'acv-demo.csv';
    const cars = Array.from({ length: 8 }, (_, i) => String(i + 1).padStart(2, '0'));
    csv = [['Time', ...cars.flatMap(id => [`Car ${id} - Indoor Average Temperature`, `Car ${id} - Outdoor Average Temperature`, `Car ${id} - Cooling Control Temperature`, `Car ${id} - Running Mode`, `Car ${id} - ACV Information Valid`])].join(','), ...Array.from({ length: 180 }, (_, i) => [new Date(Date.UTC(2026, 8, 18) + i * 30000).toISOString(), ...cars.flatMap(id => [22 + Number(id) * .13 + (id === '03' ? 6 : 0) + Math.sin(i / 10) * .5, 32 + Math.sin(i / 30), 22, 2, 'Valid'])].join(','))].join('\n');
  }
  return parseRecording(name, csv, subsystem, 'demo', `synthetic-${subsystem}`);
}
export function demoAnalysis(recording: Recording): AnalysisResult {
  if (recording.source.mode !== 'demo') throw new Error('Synthetic inference is unavailable for uploaded sources.');
  const common = { source: recording.source, analysedAt: new Date().toISOString(), model: { name: 'Synthetic fixture', version: 'demo-1', description: 'Authored interface demonstration; no learned inference is claimed.', training: 'None. Synthetic demonstration only.', validation: 'Not a model performance result.' }, notes: ['Synthetic results are excluded from uploaded-data predictions.zip.'] };
  switch (recording.source.subsystem) {
    case 'rail': return { ...common, subsystem: 'rail', scope: 'recording', prediction: 'Side I' };
    case 'shm': return { ...common, subsystem: 'shm', scope: 'recording', predictedDamage: 2.61e-6, mapping: recording.mapping };
    case 'acv': return { ...common, subsystem: 'acv', scope: 'car-case', rankedCars: ['03', ...recording.carIds.filter(id => id !== '03')] };
    case 'door': return { ...common, subsystem: 'door', scope: 'cycle', segments: [20, 220, 420].map((start, i) => ({ start_time: String(recording.rows[start][0]), end_time: String(recording.rows[start + 80][0]), prediction: i === 2 ? 'Abnormal resistance' : 'Normal', startIndex: start, endIndex: start + 80, operation: Number(recording.rows[start][recording.headers.indexOf('Door is opening')]) === 1 ? 'Open' : 'Close' })) };
  }
}
