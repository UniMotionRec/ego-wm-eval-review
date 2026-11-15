"""Check the source-time support of a structured review frame map."""

from bisect import bisect_left
import math
from statistics import median_low


# Precision of serialized and decoded clocks, separate from frame cadence.
CLOCK_EPS_S = 2e-6
SOURCE_FIELDS = ("source_frame_id", "source_video_pts_s", "source_time_s")


class SourceClockError(ValueError):
    """A declared source correspondence is unavailable or invalid."""


def _finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def coverage_policy(timeline, task_card=None):
    coverage = timeline.get("source_coverage", "complete")
    if coverage not in ("complete", "partial"):
        raise SourceClockError("Source coverage must be complete or explicit partial")
    if coverage == "partial" and task_card is not None:
        scope = task_card.get("scope_id")
        dimensions = task_card.get("dimension_scopes", {})
        requirements = task_card.get("requirements")
        if requirements:
            source_dimensions = {dim for dim, rows in requirements.items()
                                 if dim in ("C", "M") or any(
                                     all("source" in option for option in req.get("evidence_options", []))
                                     for req in rows)}
            scopes = (dimensions.get(dim, scope) for dim in source_dimensions)
        else:
            scopes = (scope, *dimensions.values())
        if scope is None or "full_episode" in scopes:
            raise SourceClockError("Partial source coverage needs an explicit narrower review scope")
    return coverage


def validate_source_rows(rows, timeline):
    previous_id, previous_pts, previous_time = -1, -math.inf, -math.inf
    offset = timeline.get("source_video_offset_s")
    duration = timeline.get("source_duration_s")
    for row in rows:
        frame_id, pts, time = (row.get(field) for field in SOURCE_FIELDS)
        if (type(frame_id) is not int or frame_id <= previous_id
                or not _finite(pts) or not 0 <= pts or pts <= previous_pts
                or not _finite(time) or not 0 <= time or time <= previous_time):
            raise SourceClockError("Source frame IDs, decoded PTS and acquisition times must be finite and increasing")
        if offset is not None and duration is not None and not offset - CLOCK_EPS_S <= pts <= offset + duration + CLOCK_EPS_S:
            raise SourceClockError("Source frame PTS lies outside the declared source clip window")
        previous_id, previous_pts, previous_time = frame_id, pts, time


class SourceClock:
    """Bind one score window to source acquisitions through the declared affine clock."""

    def __init__(self, rows, timeline, *, source_window=None):
        validate_source_rows(rows, timeline)
        self.partial = coverage_policy(timeline) == "partial"
        start = timeline.get("source_start_s", 0.)
        prep, scale = timeline["preparation_s"], timeline["uniform_scale"]
        lo, hi = timeline["score_window_s"]
        if (not all(map(_finite, (start, prep, scale, lo, hi)))
                or min(start, prep, lo) < 0 or scale <= 0 or hi <= lo):
            raise SourceClockError("Invalid source-to-trace clock or score window")
        if source_window is not None:
            native_start, native_end = source_window
            if (not all(map(_finite, source_window)) or native_start < 0 or native_end <= native_start
                    or abs(start - native_start) > CLOCK_EPS_S):
                raise SourceClockError("Declared source origin differs from the recorded source window")
        self.start, self.prep, self.scale = start, prep, scale
        self.window = (self.to_source(max(lo, prep)), self.to_source(hi))
        self.declared_support = timeline.get("source_trace_support_s")
        # Work in physical trace seconds when applying serialization precision.
        self.eps = CLOCK_EPS_S / scale
        self.rows = rows
        self.times = [row["source_time_s"] for row in rows]
        self.by_id = {row["source_frame_id"]: row for row in rows}
        first, last = self.window
        self.support = []
        self.max_gap = None
        self.presentation_tail = None
        if last <= first:
            if not self.partial:
                raise SourceClockError("Declared score window contains no source execution time")
            return
        if source_window is not None and last > native_end + self.eps:
            raise SourceClockError("Score window extends beyond the recorded source window")
        if not self.partial and (len(rows) < 2 or self.times[0] > first + self.eps):
            raise SourceClockError("Source timestamps do not cover the declared score window")
        if len(rows) < 2:
            if rows and first <= self.times[0] <= last:
                self.support.append((self.times[0], self.times[0]))
            return
        adjacent = list(zip(rows, rows[1:]))
        # Frame ID deltas expose sparse indexing of a denser acquisition clock.
        # Two nominal periods allow VFR cadence changes and a single missed sample.
        # A registered wider VFR or sparse schedule can declare its own gap bound.
        self.max_gap = timeline.get("source_max_gap_s")
        if self.max_gap is None:
            self.max_gap = 2 * median_low(
                (b["source_time_s"] - a["source_time_s"]) / (b["source_frame_id"] - a["source_frame_id"])
                for a, b in adjacent)
        if not _finite(self.max_gap) or self.max_gap <= 0:
            raise SourceClockError("Declared source maximum interval must be finite and positive")
        if self.times[-1] < last - self.eps:
            self.presentation_tail = self._terminal_presentation_cell(timeline, adjacent, last)
            if self.presentation_tail is None and not self.partial:
                raise SourceClockError("Source timestamps do not cover the declared score window")
        run_start = self.times[0]
        for a, b in zip(self.times, self.times[1:]):
            if b - a <= self.max_gap + self.eps:
                continue
            if not self.partial and a < last - self.eps and b > first + self.eps:
                raise SourceClockError(f"Unsupported source timestamp gap [{a:.9g}, {b:.9g}] seconds")
            self._add_support(run_start, a)
            run_start = b
        self._add_support(run_start, self.times[-1])

    def _terminal_presentation_cell(self, timeline, adjacent, last):
        offset, duration = timeline.get("source_video_offset_s"), timeline.get("source_duration_s")
        if not _finite(offset) or not _finite(duration):
            return None
        t0, t1 = self.times[-2:]
        p0, p1 = (row["source_video_pts_s"] for row in self.rows[-2:])
        presentation_tick = median_low(
            (b["source_video_pts_s"] - a["source_video_pts_s"]) / (b["source_frame_id"] - a["source_frame_id"])
            for a, b in adjacent)
        remaining_media = offset + duration - p1
        # The last decoded frame occupies a presentation cell. A complete map
        # can include the cell's visual tail without inventing another acquisition.
        if not 0 < remaining_media <= presentation_tick + CLOCK_EPS_S:
            return None
        acquisition_per_media = (t1 - t0) / (p1 - p0)
        if last - t1 <= remaining_media * acquisition_per_media + self.eps:
            return (t1, last)
        return None

    def _add_support(self, start, end):
        lo, hi = self.window
        left, right = max(lo, start), min(hi, end)
        if left <= right + self.eps:
            self.support.append((left, max(left, right)))

    def trace_support(self):
        observed = [[self.prep + (a - self.start) * self.scale, self.prep + (b - self.start) * self.scale]
                    for a, b in self.support]
        declared = self.declared_support
        if declared is not None and (
                not isinstance(declared, list) or len(declared) != len(observed)
                or any(not isinstance(span, list) or len(span) != 2 or any(
                    not _finite(value) or abs(value - expected) > CLOCK_EPS_S for value, expected in zip(span, actual))
                    for span, actual in zip(declared, observed))):
            raise SourceClockError("Declared source support differs from the verified acquisition windows")
        return observed

    def to_source(self, trace_time):
        return self.start + (trace_time - self.prep) / self.scale

    def expected_at(self, trace_time):
        if not _finite(trace_time):
            raise SourceClockError("Renderer trace timestamp must be finite")
        t = self.to_source(trace_time)
        first, last = self.window
        if last <= first or not first - self.eps <= t <= last + self.eps:
            return None
        return t

    def nearest(self, requested):
        if requested is None:
            return None
        if self.presentation_tail is not None and requested > self.presentation_tail[0] + self.eps:
            return None
        if self.partial and not any(a - self.eps <= requested <= b + self.eps for a, b in self.support):
            return None
        i = bisect_left(self.times, requested)
        if i == len(self.times) or i and requested - self.times[i - 1] <= self.times[i] - requested:
            i -= 1
        if abs(self.times[i] - requested) > (self.max_gap or 0.) / 2 + self.eps:
            raise SourceClockError("Execution timestamp is too far from any supported source frame")
        return self.rows[i]

    def unpaired_status(self, requested):
        if requested is None:
            return None
        if self.presentation_tail is not None and requested > self.presentation_tail[0] + self.eps:
            return "presentation_tail"
        return "unsupported"

    def validate_pair(self, row):
        requested = self.expected_at(row["trace_time_s"])
        if "source_timestamp_s" in row:
            saved = row["source_timestamp_s"]
            if ((saved is not None) != (requested is not None)
                    or requested is not None and (not _finite(saved) or abs(saved - requested) > self.eps)):
                raise SourceClockError("Renderer source timestamp differs from the declared source-to-trace clock")
        if requested is None:
            validate_unpaired(row)
            return
        closest = self.nearest(requested)
        if closest is None:
            validate_unpaired(row)
            if row.get("source_mapping_status") != self.unpaired_status(requested):
                raise SourceClockError("Unpaired source time needs its explicit coverage marker")
            return
        if row.get("source_mapping_status") not in (None, "supported"):
            raise SourceClockError("Supported source frame is incorrectly marked unavailable")
        frame = row.get("source_frame_id")
        paired = self.by_id.get(frame) if type(frame) is int else None
        if paired is None:
            raise SourceClockError("Execution timestamp lacks a mapped source frame inside the declared window")
        for field in ("source_video_pts_s", "source_time_s"):
            if field == "source_time_s" and field not in row:
                continue  # Source clock is still bound by the frame ID and its decoded PTS.
            observed = row.get(field)
            if not _finite(observed) or abs(paired[field] - observed) > CLOCK_EPS_S:
                raise SourceClockError("Source acquisition map disagrees with the execution frame")
        distance = abs(paired["source_time_s"] - requested)
        if distance > abs(closest["source_time_s"] - requested) + self.eps:
            raise SourceClockError("Execution frame does not name a nearest supported source frame")


def validate_unpaired(row):
    if any(row.get(field) is not None for field in SOURCE_FIELDS):
        raise SourceClockError("Execution has a source pairing outside the supported source window")
