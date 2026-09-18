"""Strict CSV parsing. Never silently sort timestamps or discard sensor rows."""
from __future__ import annotations
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
import csv
import io
import re
import numpy as np

LABELS = ('Normal', 'Abnormal resistance')
EPOCH = datetime(1970, 1, 1)
COLUMNS = ['current', 'voltage', 'bemf', 'opening_time', 'closing_time',
           'close_command', 'open_command', 'dcsr', 'dcsl', 'dlsr', 'dlsl',
           'opened', 'locked', 'is_opening', 'is_closing', 'position']
ORIGINAL_HEADERS = ['Datetime', 'Motor current(mA)', 'Motor Voltage(10mV)',
    'Motor electrodynamic force', 'Door opening time(.1s)', 'Door closing time(.1s)',
    'Close command', 'Open command', 'DCSR', 'DCSL', 'DLSR', 'DLSL', 'Door Opened',
    'Door Locked', 'Door is opening', 'Door is closing', 'Door leaf position']

def norm(s: str) -> str:
    return re.sub(r'[^a-z0-9]', '', s.lower().replace('\ufeff', ''))

ALIASES = {norm(k): v for k, v in zip(ORIGINAL_HEADERS, ['timestamp'] + COLUMNS)}
ALIASES.update({norm('Motor back electromotive force'): 'bemf',
                norm('Door opening time(0.1s)'): 'opening_time',
                norm('Door closing time(0.1s)'): 'closing_time'})
NATIVE_RE = re.compile(r'^(\d{4})-(\d{1,2})-(\d{1,2})-(\d{1,2})-(\d{1,2})-(\d{1,2})-(\d{1,3})$')

class DataError(ValueError):
    """Actionable input validation error suitable for display in the app."""


def parse_timestamp(value: str) -> int:
    """Milliseconds on the supplied naive clock; '.92' native field means 92 ms."""
    s = str(value).strip()
    match = NATIVE_RE.fullmatch(s)
    try:
        if match:
            y, mo, d, h, mi, sec, ms = map(int, match.groups())
            dt = datetime(y, mo, d, h, mi, sec, ms * 1000)
        else:
            dt = datetime.fromisoformat(s)
            if dt.tzinfo is not None:
                raise ValueError('Timezone-aware input is unsupported; use the dataset\'s native clock.')
            if dt.microsecond % 1000:
                raise ValueError('Sub-millisecond timestamps are unsupported.')
        delta = dt - EPOCH
        return (delta.days * 86400 + delta.seconds) * 1000 + delta.microseconds // 1000
    except (ValueError, OverflowError) as exc:
        raise DataError(f'Invalid timestamp {s!r}: {exc}') from exc


def format_timestamp(ms: int) -> str:
    d = EPOCH + timedelta(milliseconds=int(ms))
    return f'{d.year}-{d.month}-{d.day}-{d.hour}-{d.minute}-{d.second}-{d.microsecond//1000}'


@dataclass
class Stream:
    timestamps: list[str]
    t_ms: np.ndarray
    x: np.ndarray
    source_name: str = ''
    extra_columns: tuple[str, ...] = ()

    def subset(self, lo: int, hi: int) -> 'Stream':
        return Stream(self.timestamps[lo:hi], self.t_ms[lo:hi], self.x[lo:hi],
                      self.source_name, self.extra_columns)

    def column(self, name: str) -> np.ndarray:
        return self.x[:, COLUMNS.index(name)]


def load_stream(source: str | Path | bytes) -> Stream:
    if isinstance(source, bytes):
        raw, name = source, 'uploaded.csv'
    else:
        path = Path(source)
        raw, name = path.read_bytes(), path.name
    if len(raw) > 25 * 1024 * 1024:
        raise DataError('CSV exceeds the 25 MiB limit for this local prototype.')
    try:
        text = raw.decode('utf-8-sig')
    except UnicodeDecodeError as exc:
        raise DataError('Save the CSV with UTF-8 encoding.') from exc
    reader = csv.reader(io.StringIO(text))
    try:
        header = next(reader)
    except StopIteration:
        raise DataError('The CSV is empty.')
    canonical = [ALIASES.get(norm(h)) for h in header]
    required = ['timestamp'] + COLUMNS
    if len(header) != len(set(norm(h) for h in header)):
        raise DataError('Duplicate column headers are not supported.')
    for c in required:
        if canonical.count(c) != 1:
            raise DataError(f'Missing or ambiguous telemetry column: {c}. Upload a raw Door stream, not a submission CSV.')
    idx = [canonical.index(c) for c in required]
    stamps, times, values = [], [], []
    for line_no, row in enumerate(reader, start=2):
        if not row or not any(s.strip() for s in row):
            continue
        if len(row) != len(header):
            raise DataError(f'Row {line_no}: expected {len(header)} fields, got {len(row)}.')
        stamp = row[idx[0]].strip()
        t = parse_timestamp(stamp)
        if times and t <= times[-1]:
            raise DataError(f'Row {line_no}: timestamps must strictly increase. Duplicate/interleaved assets require separate streams.')
        vals = []
        for col, j in zip(COLUMNS, idx[1:]):
            s = row[j].strip()
            try:
                v = float(s) if s.lower() not in ('', 'na', 'nan', 'null') else np.nan
            except ValueError as exc:
                raise DataError(f'Row {line_no}, {col}: {s!r} is not numeric.') from exc
            if np.isinf(v):
                raise DataError(f'Row {line_no}, {col}: infinite values are invalid.')
            vals.append(v)
        stamps.append(stamp); times.append(t); values.append(vals)
    if len(times) < 2:
        raise DataError('At least two telemetry rows are required.')
    x = np.asarray(values, dtype=np.float64)
    if np.any(np.mean(~np.isfinite(x), axis=0) > 0.10):
        raise DataError('More than 10% of a required signal is missing. Repair the source before inference.')
    extra = tuple(h for h,c in zip(header,canonical) if c is None)
    return Stream(stamps, np.asarray(times, dtype=np.int64), x, name, extra)


@dataclass(frozen=True)
class Segment:
    lo: int
    hi: int  # exclusive row index
    start_ms: int
    end_ms: int
    start_time: str
    end_time: str


def make_segment(stream: Stream, lo: int, hi: int) -> Segment:
    return Segment(lo, hi, int(stream.t_ms[lo]), int(stream.t_ms[hi-1]),
                   stream.timestamps[lo], stream.timestamps[hi-1])


def read_answers(path: str | Path, stream: Stream) -> tuple[list[Segment], np.ndarray, list[dict]]:
    with Path(path).open(encoding='utf-8-sig', newline='') as f:
        reader = csv.DictReader(f)
        needed = {'segment_id','start_time','end_time','operation','status','n_rows'}
        if not needed.issubset(reader.fieldnames or []):
            raise DataError('Training labels must be Train_Segments_Answer.csv, not an example submission.')
        rows = list(reader)
    segments, y = [], []
    last_hi = 0
    for row in rows:
        if row['status'] not in LABELS:
            raise DataError(f'Unexpected ground-truth status: {row["status"]}')
        a, b = parse_timestamp(row['start_time']), parse_timestamp(row['end_time'])
        lo = int(np.searchsorted(stream.t_ms, a)); hi = int(np.searchsorted(stream.t_ms, b, side='right'))
        if lo >= hi or stream.t_ms[lo] != a or stream.t_ms[hi-1] != b:
            raise DataError(f'Label {row["segment_id"]}: boundaries do not exactly occur in Train.csv.')
        if lo != last_hi or hi-lo != int(row['n_rows']):
            raise DataError(f'Label {row["segment_id"]}: overlapping/uncovered rows or incorrect n_rows.')
        if hi-lo < 2:
            raise DataError('A ground-truth cycle must contain at least two rows.')
        segments.append(make_segment(stream, lo, hi)); y.append(LABELS.index(row['status'])); last_hi = hi
    if last_hi != len(stream.t_ms):
        raise DataError('Ground-truth segments do not cover every training row.')
    return segments, np.asarray(y, dtype=int), rows


def predictions_csv(segments: list[dict]) -> str:
    output = io.StringIO(newline='')
    writer = csv.DictWriter(output, fieldnames=['start_time','end_time','prediction'], lineterminator='\n')
    writer.writeheader()
    for s in segments:
        if s['prediction'] not in LABELS:
            raise DataError('Invalid prediction label.')
        if parse_timestamp(s['end_time']) <= parse_timestamp(s['start_time']):
            raise DataError('Predicted segments must have positive duration.')
        writer.writerow({k:s[k] for k in writer.fieldnames})
    return output.getvalue()
