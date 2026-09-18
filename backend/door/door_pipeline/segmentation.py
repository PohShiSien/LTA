"""Gap-based segmentation calibrated from training boundaries, not test answers."""
from __future__ import annotations
from dataclasses import dataclass, asdict
import numpy as np
from .io import Stream, Segment, make_segment, DataError

@dataclass
class GapSegmenter:
    threshold_ms: float = 200.0
    nominal_step_ms: float = 20.0
    max_training_within_gap_ms: float = 20.0
    min_training_between_gap_ms: float = 10000.0
    min_training_rows: int = 2
    max_training_rows: int = 1000000

    def fit(self, stream: Stream, segments: list[Segment]) -> 'GapSegmenter':
        if len(segments) < 2:
            raise DataError('Need at least two labelled training cycles to calibrate segmentation.')
        within = np.concatenate([np.diff(stream.t_ms[s.lo:s.hi]) for s in segments])
        # Exclude gaps spanning omitted/purged cycles. They are not real adjacent boundaries.
        between = np.asarray([b.start_ms-a.end_ms for a,b in zip(segments[:-1],segments[1:]) if a.hi == b.lo])
        if len(between) == 0:
            raise DataError('Need adjacent training cycles to calibrate between-cycle gaps.')
        self.nominal_step_ms = float(np.median(within))
        self.max_training_within_gap_ms = float(np.max(within))
        self.min_training_between_gap_ms = float(np.min(between))
        if self.max_training_within_gap_ms >= self.min_training_between_gap_ms:
            raise DataError('Within/between-cycle gaps overlap: this dataset-specific segmenter needs redesign.')
        # Midpoint in log-space; fitted using training cycles only.
        self.threshold_ms = float(np.sqrt(self.max_training_within_gap_ms*self.min_training_between_gap_ms))
        self.min_training_rows = min(s.hi-s.lo for s in segments)
        self.max_training_rows = max(s.hi-s.lo for s in segments)
        return self

    def predict(self, stream: Stream) -> list[Segment]:
        boundaries = np.r_[0, np.flatnonzero(np.diff(stream.t_ms) > self.threshold_ms)+1, len(stream.t_ms)]
        result = []
        for lo,hi in zip(boundaries[:-1],boundaries[1:]):
            if hi-lo < 2:
                raise DataError('A gap-delimited block has fewer than two rows. Check incomplete/missing telemetry; it was not silently dropped.')
            result.append(make_segment(stream, int(lo), int(hi)))
        return result

    def to_dict(self) -> dict:
        return asdict(self)
