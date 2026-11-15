"""Portable version-2 review, evidence and arbitration contract (standard library)."""

from collections import defaultdict
from copy import deepcopy
from decimal import Decimal
import hashlib
import json
import math
from pathlib import Path, PurePosixPath
import re

if __package__:
    from .source_clock import SourceClock, SourceClockError, coverage_policy, validate_source_rows, validate_unpaired
else:
    from source_clock import SourceClock, SourceClockError, coverage_policy, validate_source_rows, validate_unpaired


SCHEMA_VERSION = 2
DIMENSIONS = ("P", "C", "M")
VERDICTS = ("pass", "fail", "unknown")
STATES = {"pending", "evaluated", "skipped", "blocked", "stale"}
CHANNELS = {"source", "execution", "timing", "physics"}
HASH_FIELDS = ("case_fingerprint", "task_card_hash", "evidence_hash", "time_mapping_hash", "trace_binding_hash")
MEDIA_KEYS = {"source", "execution", "timestamps", "source_timestamps", "physical_evidence", "execution_closeup",
              "source_captions", "execution_captions"}
ID_RE = re.compile(r"^[A-Za-z0-9_.-]{1,180}$")
HASH_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
EPS = 1e-6
UNKNOWN_CODES = {"source_occluded", "execution_occluded", "reference_missing", "evidence_gap"}
WHOLE_CASE_ISSUES = {"wrong_case", "wrong_clip", "task_scope_conflict", "conflicting_task", "task_conflict",
                     "task_outside_source_scope", "case_identity_invalid", "case_mismatch", "scope_conflict", "rule_conflict"}
ISSUE_CHANNELS = {
    "source_unavailable": {"source"}, "source_media_error": {"source"},
    "execution_unavailable": {"execution"}, "execution_media_error": {"execution"},
    "timing_unavailable": {"timing"}, "time_mapping_error": {"timing"},
    "media_not_aligned": {"timing"}, "mapping_unavailable": {"timing"}, "timeline_fault": {"timing"},
    "physics_unavailable": {"physics"}, "physical_evidence_error": {"physics"},
}


class ReviewError(ValueError):
    """A review cannot be connected to the assigned question and evidence."""


class StaleReview(ReviewError):
    """Same assignment, changed version. Retain the original claim without using it."""


def require(condition, message):
    if not condition:
        raise ReviewError(message)


def _number(value):
    return type(value) in (int, float) and math.isfinite(value)


def _identifier(value):
    return isinstance(value, str) and ID_RE.fullmatch(value) is not None and value not in {".", ".."}


def _hash(value):
    return isinstance(value, str) and HASH_RE.fullmatch(value) is not None


def _id_set(values, field):
    require(isinstance(values, list) and all(map(_identifier, values)), f"invalid {field}")
    require(len(values) == len(set(values)), f"duplicate {field}")
    return set(values)


def _interval(span, name):
    require(isinstance(span, (list, tuple)) and len(span) == 2 and all(map(_number, span))
            and 0 <= span[0] <= span[1], f"invalid {name}")
    return tuple(span)


def _contains(container, contained):
    return container[0] - EPS <= contained[0] <= contained[1] <= container[1] + EPS


def _canonical_number(value):
    # JSON.stringify prints shortest binary64 numbers and uses decimal for
    # magnitudes from 1e-6 through 1e20. Review integers must reach JS exactly.
    if type(value) is int:
        require(abs(value) < 2**53, "review integer exceeds binary64 exact range")
        return str(value)
    require(math.isfinite(value), "nonfinite review float")
    if value == 0:
        return "0"
    decimal = Decimal(repr(value)).normalize()
    if 1e-6 <= abs(value) < 1e21:
        return format(decimal, "f")
    mantissa, power = format(decimal, "e").split("e")
    return f"{mantissa}e{int(power):+d}"


def canonical_bytes(value):
    def encode(item):
        if isinstance(item, dict):
            require(all(isinstance(key, str) for key in item), "review object keys must be strings")
            keys = sorted(item, key=lambda s: s.encode("utf-16-be", "surrogatepass"))
            return "{" + ",".join(f"{encode(k)}:{encode(item[k])}" for k in keys) + "}"
        if isinstance(item, (list, tuple)):
            return "[" + ",".join(map(encode, item)) + "]"
        if type(item) in (int, float):
            return _canonical_number(item)
        return json.dumps(item, ensure_ascii=False, allow_nan=False, separators=(",", ":"))

    return encode(value).encode("utf-8")


def digest_bytes(content):
    return "sha256:" + hashlib.sha256(content).hexdigest()


def hash_file(path):
    with Path(path).open("rb") as stream:
        result = hashlib.sha256()
        while chunk := stream.read(1024 * 1024):
            result.update(chunk)
    return "sha256:" + result.hexdigest()


def digest(value):
    return digest_bytes(canonical_bytes(value))


def case_identity(case):
    media = case["media_hashes"]
    trace = case["trace_binding_hash"]
    derived = {
        "task_card_hash": digest(case["task_card"]),
        "evidence_hash": digest({"media_hashes": media, "trace_binding_hash": trace}),
        "time_mapping_hash": digest({"timeline": case["timeline"], "timestamps_sha256": media.get("timestamps"),
                                     "source_timestamps_sha256": media.get("source_timestamps")}),
    }
    derived["case_fingerprint"] = digest({"review_schema_version": SCHEMA_VERSION, "blind_id": case["blind_id"],
                                          "trace_binding_hash": trace, **derived})
    return derived


def bind_case(case):
    return {**case, **case_identity(case)}


def safe_asset_path(name):
    return isinstance(name, str) and name and not re.search(r"[\\%?#:\x00-\x1f]", name) and all(
        piece and piece not in {".", ".."} for piece in name.split("/")
    )


def requirement_map(case, dim):
    return {row["id"]: row for row in case["task_card"]["requirements"].get(dim, [])}


def scope_for(case, dim):
    task = case["task_card"]
    return task.get("dimension_scopes", {}).get(dim, task["scope_id"])


def assigned_dimensions(case):
    return tuple(case.get("review_dimensions", [dim for dim in DIMENSIONS if requirement_map(case, dim)]))


def _options(req):
    values = req.get("evidence_options")
    require(isinstance(values, list) and bool(values), "requirement needs evidence alternatives")
    alternatives = []
    for option in values:
        selected = _id_set(option, "evidence alternative")
        require(selected and selected <= CHANNELS, "evidence alternative uses invalid channels")
        alternatives.append(frozenset(selected))
    return alternatives


def _validate_case(case):
    require(isinstance(case, dict) and _identifier(case.get("blind_id")), "invalid blind ID")
    require(all(_hash(case.get(key)) for key in HASH_FIELDS), "missing case identity digest")
    media, hashes = case.get("media"), case.get("media_hashes")
    require(isinstance(media, dict) and isinstance(hashes, dict), "missing case media hashes")
    require(set(media) <= MEDIA_KEYS and set(hashes) == {key for key, name in media.items() if name is not None}
            and all(safe_asset_path(media[k]) and _hash(hashes[k]) for k in hashes), "invalid case media or hashes")
    timeline = case.get("timeline")
    require(isinstance(timeline, dict), "case needs an explicit timeline")
    for field in ("source_video_offset_s", "execution_video_offset_s", "source_duration_s", "execution_duration_s",
                  "preparation_s", "uniform_scale"):
        require(_number(timeline.get(field)) and timeline[field] >= 0, f"invalid timeline {field}")
    require(all(timeline[field] > 0 for field in ("source_duration_s", "execution_duration_s", "uniform_scale")),
            "timeline durations and uniform scale must be positive")
    score_window = _interval(timeline.get("score_window_s"), "score window")
    require(score_window[1] > score_window[0], "score window must have positive duration")
    require(timeline.get("time_policy") in {"identity", "declared"}, "timeline must declare a time_policy")
    if timeline["time_policy"] == "identity":
        require(all(timeline[key] == 0 for key in ("source_video_offset_s", "execution_video_offset_s", "preparation_s"))
                and timeline["uniform_scale"] == 1, "identity timeline offsets and scale disagree")
    task = case.get("task_card")
    require(isinstance(task, dict) and all(_identifier(task.get(key)) for key in ("protocol_id", "profile_id", "scope_id")),
            "task card has no protocol, profile, or scope")
    require(task.get("review_mode") in {"diagnostic", "acceptance"}, "invalid task card review mode")
    required = _id_set(task.get("required_dimensions"), "required dimensions")
    require(required and required <= set("VPCM"), "invalid necessary dimensions")
    mappings = _id_set(task.get("allowed_correspondence_ids"), "allowed correspondence")
    require(mappings, "correspondence set is empty")
    scopes = task.get("dimension_scopes", {})
    require(isinstance(scopes, dict) and set(scopes) <= set(DIMENSIONS) and all(map(_identifier, scopes.values())),
            "invalid dimension scope")
    try:
        coverage_policy(timeline, task)
    except SourceClockError as exc:
        raise ReviewError(str(exc)) from exc
    groups = task.get("requirements")
    require(isinstance(groups, dict) and set(groups) <= set(DIMENSIONS), "invalid task requirements")
    if task.get("setup_issue") is not None:
        setup = task["setup_issue"]
        require(isinstance(setup, dict) and _id_set(setup.get("affected_dimensions"), "setup issue dimensions") <= set(DIMENSIONS)
                and bool(setup["affected_dimensions"]), "invalid frozen setup issue")
    declared_ids = set()
    for dim in DIMENSIONS:
        rows = groups.get(dim, [])
        require(isinstance(rows, list) and bool(rows) == (dim in required), f"applicability disagrees with {dim} requirements")
        failure_codes = set()
        for req in rows:
            identifier = req.get("id") if isinstance(req, dict) else None
            require(_identifier(identifier) and identifier.startswith(dim + ".") and identifier not in declared_ids
                    and _identifier(req.get("failure_code")) and req["failure_code"] not in failure_codes
                    and isinstance(req.get("label_zh"), str) and req["label_zh"].strip(),
                    f"invalid or duplicate {dim} requirement")
            declared_ids.add(identifier)
            failure_codes.add(req["failure_code"])
            require(req.get("failure_evidence") in {"event_anchor", "window"}, "unknown failure evidence mode")
            _options(req)
            if req.get("window_s") is not None:
                require(_contains(score_window, _interval(req["window_s"], "requirement window")), "requirement outside score window")
            for reason in req.get("unknown_reasons", []):
                require(isinstance(reason, dict) and _identifier(reason.get("code")), "invalid requirement unknown reason")
    require(_id_set(task.get("reference_unresolved_requirement_ids", []), "unresolved reference requirements") <= declared_ids,
            "unresolved reference requirement was not declared")
    selected_mapping = case.get("assigned_correspondence_id", task.get("review_correspondence_id"))
    require(selected_mapping in mappings if selected_mapping is not None else len(mappings) == 1,
            "assignment does not select a registered shared correspondence")
    assigned = assigned_dimensions(case)
    require(len(assigned) == len(set(assigned)) and set(assigned) <= required.intersection(DIMENSIONS),
            "assignment includes an inapplicable dimension")
    require(all(case[key] == observed for key, observed in case_identity(case).items()),
            "case hashes do not match declared task card, timeline or evidence")


def validate_manifest(manifest):
    require(isinstance(manifest, dict) and manifest.get("schema_version") == manifest.get("review_schema_version") == 2,
            "version 2 review manifest required")
    require(_identifier(manifest.get("batch_id")) and _identifier(manifest.get("assignment_id")), "invalid batch or assignment ID")
    role = manifest.get("assignment_role")
    reviewers = _id_set(manifest.get("reviewer_ids"), "reviewer IDs")
    require(role in {"independent", "arbiter"} and len(reviewers) == (2 if role == "independent" else 1),
            "assign exactly two independent reviewers, or one arbiter")
    cases = manifest.get("cases")
    require(isinstance(cases, list) and cases, "assignment contains no cases")
    seen = set()
    for case in cases:
        _validate_case(case)
        blind = case["blind_id"]
        require(blind not in seen, "duplicate blind case")
        seen.add(blind)
        if role == "arbiter":
            require(case.get("review_dimensions"), "arbiter case has no specific disputed dimension")
    return manifest


def case_paths(case, root):
    """Path resolution for an organizer's exact exported packet."""
    base = Path(root).resolve()
    paths = {}
    for key, name in case["media"].items():
        if name is None:
            continue
        require(safe_asset_path(name), "unsafe review path")
        path = (base / PurePosixPath(name)).resolve()
        require(path.is_relative_to(base), "review asset escapes its bundle")
        paths[key] = path
    return paths


def _verified_jsonl(case, key, read_asset):
    name = case["media"].get(key)
    if not name:
        return []
    raw = read_asset(name)
    require(digest_bytes(raw) == case["media_hashes"][key], f"{key} changed after case binding")
    rows = [json.loads(line) for line in raw.decode("utf-8").splitlines() if line.strip()]
    require(all(isinstance(row, dict) for row in rows), f"invalid {key} row")
    return rows


def _frame_rows(case, key, prefix, read_asset):
    frames = {}
    previous_pts, previous_time, previous_id, previous_state = -math.inf, -math.inf, -1, -1
    timeline = case["timeline"]
    for row in _verified_jsonl(case, key, read_asset):
        frame, pts = row.get(f"{prefix}_frame_id"), row.get(f"{prefix}_video_pts_s")
        duration = timeline[f"{prefix}_video_offset_s"] + timeline[f"{prefix}_duration_s"]
        require(type(frame) is int and frame > previous_id and _number(pts)
                and 0 <= pts <= duration + .002 and pts > previous_pts, f"{key} timestamps and frame IDs must be increasing")
        if prefix == "execution":
            stamp, state = row.get("trace_time_s"), row.get("state_index")
            repeated = state == previous_state
            require(_number(stamp) and stamp >= 0 and type(state) is int and state >= previous_state and state >= 0
                    and row.get("repeat_state") is repeated, "invalid execution trace mapping")
            if repeated:
                require(abs(stamp - previous_time) <= EPS, "duplicate physical state requires the same trace time")
            else:
                require(stamp > previous_time, "new state requires a later trace time")
            transition = row.get("transition_index")
            require(transition is None if state == 0 else type(transition) is int and transition == state - 1,
                    "invalid executed transition identity")
            if transition is not None:
                interval = _interval(row.get("action_interval_s"), "mapped transition interval")
                require(abs(interval[1] - stamp) <= EPS, "mapped interval does not end at its state time")
            previous_time, previous_state = stamp, state
        else:
            source_time = row.get("source_time_s")
            require(_number(source_time) and source_time >= 0 and source_time >= previous_time - EPS, "invalid source timestamp")
            previous_time = source_time
        previous_pts, previous_id = pts, frame
        frames[frame] = row
    return frames


def _raw_contacts(case, read_asset):
    contacts = {}
    previous_end = -math.inf
    for row in _verified_jsonl(case, "physical_evidence", read_asset):
        transition = row.get("transition_index")
        span = _interval(row.get("solver_interval_s"), "solver interval")
        require(type(transition) is int and transition >= 0 and transition not in contacts
                and type(row.get("contacts_available")) is bool and span[0] >= previous_end - EPS and span[1] > span[0]
                and _number(row.get("state_time_s")) and abs(row["state_time_s"] - span[1]) <= EPS
                and isinstance(row.get("object_contacts"), list), "invalid or duplicate solver interval identity")
        contacts[transition] = row
        previous_end = span[1]
    return contacts


def build_evidence_index(case, read_asset):
    """Validate each structured channel; a failed mapping leaves independent raw evidence intact."""
    errors = {}

    def load(channel, callback):
        try:
            return callback()
        except (ReviewError, SourceClockError, OSError, KeyError, UnicodeError, json.JSONDecodeError) as error:
            errors[channel] = str(error)
            return {}

    def source_map():
        frames = _frame_rows(case, "source_timestamps", "source", read_asset)
        validate_source_rows(frames.values(), case["timeline"])
        return frames

    source = load("source_timestamps", source_map)
    contacts = load("physics", lambda: _raw_contacts(case, read_asset))
    source_support = []

    def execution_map():
        frames = _frame_rows(case, "timestamps", "execution", read_asset)
        coverage_policy(case["timeline"], case["task_card"])
        if "source_timestamps" in errors:
            raise ReviewError("source frame mapping failed verification")
        clock = SourceClock(list(source.values()), case["timeline"]) if frames and "source_timestamps" in case["media"] else None
        for row in frames.values():
            if clock is None:
                validate_unpaired(row)
            else:
                clock.validate_pair(row)
            transition = row.get("transition_index")
            if transition in contacts:
                require(all(abs(a - b) <= EPS for a, b in zip(row["action_interval_s"], contacts[transition]["solver_interval_s"])),
                        "mapped transition interval disagrees with raw solver evidence")
        if clock is not None:
            source_support.extend(clock.trace_support())
        return frames

    execution = load("timing", execution_map)
    return {"source": source, "execution": execution, "physics": contacts, "errors": errors,
            "source_support": source_support}


def _issue_status(row, status):
    reports = row.get("material_issues", [])
    require(isinstance(reports, list), "material issues must be a list")
    global_block = False
    broken_channels = set()
    unscoped_issue = False
    for issue in reports:
        require(isinstance(issue, dict) and _identifier(issue.get("code")), "invalid material issue")
        code = issue["code"]
        affected = _id_set(issue.get("affected_channels", []), "material issue channels")
        require(affected <= CHANNELS, "invalid affected channel")
        if code in WHOLE_CASE_ISSUES:
            global_block = True
            continue
        if not (affected or code in ISSUE_CHANNELS):
            unscoped_issue = True
            continue
        expected = ISSUE_CHANNELS.get(code, affected)
        require(expected <= affected if affected else code in ISSUE_CHANNELS,
                "material issue omits an affected channel")
        for channel in expected | affected:
            status[channel] = "unavailable"
            broken_channels.add(channel)
    return global_block, broken_channels, unscoped_issue


def _channel_status(row, case, index):
    status = row.get("evidence_status")
    require(isinstance(status, dict) and set(status) == CHANNELS
            and set(status.values()) <= {"valid", "unavailable", "unverified"}, "invalid evidence channel status")
    status = dict(status)
    for channel, permitted in {
        "source": bool(case["media"].get("source")) and "source" not in (index or {}).get("errors", {}),
        "execution": bool(case["media"].get("execution")) and "execution" not in (index or {}).get("errors", {}),
        "timing": bool(index and index.get("execution")),
        "physics": bool(index and index.get("physics")),
    }.items():
        if not permitted:
            status[channel] = "unavailable"
    return status


def _windows_cover(spans, requested):
    covered = requested[0]
    for start, end in spans:
        if end < covered - EPS:
            continue
        if start > covered + EPS:
            return False
        covered = max(covered, end)
        if covered >= requested[1] - EPS:
            return True
    return False


def _needs_physics_detail(req):
    if req.get("physics_granularity"):
        return req["physics_granularity"]
    name = req["id"].lower()
    return "object_patch" if name.startswith("c.") and any(s in name for s in ("object_patch", "contact_region", "object_region")) else None


def _physical_capable(rows, req, span, transition):
    detail = _needs_physics_detail(req)
    query = [rows.get(transition)] if transition is not None else rows.values()
    valid = []
    for item in query:
        if not item or not item.get("contacts_available"):
            continue
        if detail == "object_patch" and not any(
                sample.get("active") and sample.get("patch_id") not in (None, "", "whole_object", "unknown")
                for sample in item.get("object_contacts", [])):
            continue
        valid.append(tuple(item["solver_interval_s"]))
    return _windows_cover(valid, span)


def _check_frame(entry, index):
    evidence = index["execution"].get(entry.get("execution_frame_id"))
    require(evidence is not None, "trace anchor frame is absent from the verified map")
    for field in ("state_index", "transition_index", "source_frame_id"):
        if field in evidence or field in entry:
            require(field in entry and entry[field] == evidence.get(field), f"trace anchor {field} mismatch")
    for field in ("trace_time_s", "execution_video_pts_s"):
        require(_number(entry.get(field)) and _number(evidence.get(field))
                and abs(entry[field] - evidence[field]) <= EPS, f"trace anchor {field} mismatch")
    return evidence


def _execution_covers(index, required_span):
    frames = index["execution"]
    if not frames:
        return False
    start = next(iter(frames.values()))["trace_time_s"]
    end = frames[next(reversed(frames))]["trace_time_s"]
    # At 24 FPS a final subframe can be complete without a separate render.
    return start <= required_span[0] + .05 and end >= required_span[1] - .05


def _validate_evidence(evidence, required, case, status, index, verdict, decisive):
    require(isinstance(evidence, list), "evidence must be a list")
    witnessed = set()
    timeline = case["timeline"]
    observation_scope = _interval(timeline["score_window_s"], "score window")
    for entry in evidence:
        require(isinstance(entry, dict), "invalid evidence reference")
        claims = _id_set(entry.get("requirement_ids"), "evidence requirements")
        kind, basis = entry.get("kind"), entry.get("time_basis")
        channels = _id_set(entry.get("channels"), "evidence channels")
        require(claims and claims <= required.keys(), "evidence refers to another question")
        require(entry.get("mapping_hash") == case["time_mapping_hash"], "evidence mapping version mismatch")
        require(all(status.get(c) == "valid" for c in channels), "evidence claims an unavailable channel")
        for claim in claims:
            require(channels in _options(required[claim]), f"evidence does not provide an entire alternative for {claim}")
        require(kind in {"reviewed_scope", "observation_window", "event_anchor", "physical_transition"}, "unsupported evidence kind")
        require(entry.get("provenance") in {"reviewer_selected", "reviewer_claim_over_frozen_scope"}, "unknown evidence provenance")
        transition = None
        if basis == "trace":
            require(index and (index["execution"] or "physics" in channels and index["physics"]),
                    "no verified mapping or raw trace for evidence")
            if kind == "event_anchor":
                frame = _check_frame(entry, index)
                stamp = frame["trace_time_s"]
                span = (stamp, stamp)
                transition = frame["transition_index"]
            elif kind == "physical_transition":
                transition = entry.get("transition_index")
                raw = index["physics"].get(transition)
                require("physics" in channels and raw and type(transition) is int
                        and entry.get("state_index") == transition + 1 and raw.get("contacts_available")
                        and not any(k in entry for k in ("execution_frame_id", "execution_video_pts_s", "source_frame_id")),
                        "physical evidence is not tied to a valid raw transition")
                stamp = raw.get("state_time_s", raw["solver_interval_s"][1])
                require(_number(entry.get("trace_time_s")) and abs(entry["trace_time_s"] - stamp) <= EPS,
                        "physical transition trace time mismatch")
                span = (stamp, stamp)
            else:
                span = _interval(entry.get("interval_s"), "trace evidence interval")
            require(_contains(observation_scope, span), "trace evidence is outside assigned window")
        elif basis in {"execution_media", "source_media"}:
            channel = basis.removesuffix("_media")
            require(channel in channels and not {"timing", "physics"} & channels,
                    "media-only evidence cannot support trace or solver requirements")
            require(kind != "physical_transition", "raw transition cannot use a media clock")
            require(not any(k in entry for k in ("trace_time_s", "state_index", "transition_index")),
                    "media evidence impersonates trace time")
            start = timeline[f"{channel}_video_offset_s"]
            available = (start, start + timeline[f"{channel}_duration_s"])
            if kind == "event_anchor":
                stamp = entry.get(f"{channel}_video_pts_s")
                require(_number(stamp), "visual anchor lacks media PTS")
                span = (stamp, stamp)
            else:
                span = _interval(entry.get("interval_s"), "media evidence interval")
            require(_contains(available, span), "media evidence is outside clip")
        else:
            raise ReviewError("evidence has no recognized time basis")

        for claim in claims:
            req = required[claim]
            required_span = _interval(req.get("window_s") or observation_scope, "requirement evidence window")
            full_window = _contains(required_span, observation_scope) and _contains(observation_scope, required_span)
            if basis == "trace":
                if kind in {"event_anchor", "physical_transition"}:
                    require(_contains(required_span, span), f"evidence anchor outside {claim} window")
                else:
                    require(_contains(span, required_span), f"evidence does not cover the {claim} window")
                if kind in {"reviewed_scope", "observation_window"} and {"execution", "timing"} & channels:
                    require(_execution_covers(index, required_span),
                            "execution capture does not cover the required observation window")
                if {"source", "timing"} <= channels:
                    require(_windows_cover(index.get("source_support", ()), span),
                            "Source timing does not support the requested trace interval")
            elif kind in {"reviewed_scope", "observation_window"}:
                require(full_window and _contains(span, available), "unmapped scope needs the complete declared visual clip")
                if basis == "execution_media" and index and index["execution"]:
                    require(_execution_covers(index, required_span),
                            "verified execution capture is shorter than the declared observation window")
            else:
                require(full_window and kind == "event_anchor",
                        "requirement window needs trace-mapped evidence")
            if "physics" in channels:
                physical_span = (span if transition is None else
                                 tuple(index["physics"].get(transition, {}).get("solver_interval_s", span)))
                require(_physical_capable(index["physics"], req, physical_span, transition),
                        f"raw contact evidence does not support {claim} at that time")
            if verdict == "pass" and kind == "reviewed_scope":
                witnessed.add(claim)
            if verdict == "fail" and claim in decisive and (
                    (req["failure_evidence"] == "event_anchor" and kind in {"event_anchor", "physical_transition"}) or
                    (req["failure_evidence"] == "window" and kind == "observation_window")):
                witnessed.add(claim)
    return witnessed


def _independent_fail_dim(record, case, dep, gate_facts):
    def fact(key):
        value = gate_facts.get(key)
        return value.get("verdict") if isinstance(value, dict) else value

    if dep == "V":
        return fact("V") == "fail"
    entry = record.get(dep, {})
    local = entry.get("assessment_state") == "evaluated" and entry.get("verdict") == "fail"
    if dep == "C" and len(case["task_card"]["allowed_correspondence_ids"]) > 1:
        gate = gate_facts.get("C") or {}
        return isinstance(gate, dict) and gate.get("verdict") == "fail" and gate.get("all_correspondences_failed") is True
    return local or fact(dep) == "fail"


def _scope_states(case, data, gate_facts):
    modes = {
        "V": set(DIMENSIONS),
        "P": {"C", "M"},
        "C": {"M"},
    }
    for key, item in data.items():
        if item.get("assessment_state") != "skipped":
            continue
        require(case["task_card"]["review_mode"] == "acceptance", "only acceptance flow can short circuit")
        require(item.get("skip_reason") == "short_circuit_fail", "skip has no allowed predeclared basis")
        dep = item.get("skip_dependency")
        require(isinstance(dep, dict) and dep.get("verdict") == "fail"
                and dep.get("case_fingerprint") == case["case_fingerprint"] and key in modes.get(dep.get("dimension"), ()),
                "invalid skip dependency")
        if case.get("diagnostic_failure_sample") is True or not _independent_fail_dim(data, case, dep["dimension"], gate_facts):
            item.update(assessment_state="pending", skip_reopened=True)
    return data


def _validate_dimension(item, case, dim, status, whole_case_block, broken_channels, unscoped_issue, index):
    required = requirement_map(case, dim)
    require(required, "empty requirements cannot produce pass")
    require(item.get("applicability") == "required" and item.get("scope_id") == scope_for(case, dim),
            f"{dim}: applicability or scope mismatch")
    state, fact = item.get("assessment_state"), item.get("verdict")
    require(state in STATES, "invalid assessment state")
    reasons = _id_set(item.get("reason_codes", []), "reason codes")
    decisive = _id_set(item.get("decisive_requirement_ids", []), "decisive requirement IDs")
    unresolved = _id_set(item.get("unresolved_requirement_ids", []), "unresolved requirement IDs")
    covered = _id_set(item.get("covered_requirement_ids", []), "covered requirement IDs")
    raw_evidence = item.get("evidence", [])
    require((decisive | unresolved | covered) <= required.keys() and not decisive & unresolved and not covered & unresolved,
            f"{dim}: inconsistent claimed requirements")
    hidden = {code for code, req in required.items()
              if not any(all(status.get(channel) == "valid" for channel in alt) for alt in _options(req))}
    reference_missing = set(case["task_card"].get("reference_unresolved_requirement_ids", ())) & required.keys()
    setup_block = dim in (case["task_card"].get("setup_issue") or {}).get("affected_dimensions", ())
    if state != "evaluated":
        require(fact is None and not decisive and not covered and not raw_evidence, "unassessed dimension carries a verdict or decisive evidence")
        if state == "blocked":
            scoped_gap = any(all(
                any(status.get(channel) != "valid" for channel in alt)
                or {"source", "timing"} <= alt and not _windows_cover(
                    (index or {}).get("source_support", ()), req.get("window_s") or case["timeline"]["score_window_s"])
                for alt in _options(req)) for req in required.values())
            require(whole_case_block or setup_block or unscoped_issue or bool(hidden) or scoped_gap,
                    "blocked requires an affected requirement or a repair report")
        if state == "stale":
            raise ReviewError("only the organizer can mark a changed submission as stale")
        return item

    require(not whole_case_block and not setup_block, "case or task identity problem prevents an evaluated claim")
    require(fact in VERDICTS, "evaluated dimension must have a three-state verdict")
    require(reference_missing <= unresolved and not (covered | decisive) & (hidden | reference_missing),
            "a decisive claim depends on unavailable evidence or an unresolved reference")
    witnessed = _validate_evidence(raw_evidence, required, case, status, index, fact, decisive)
    if fact == "pass":
        require(not decisive and not unresolved and not reasons and covered == set(required)
                and witnessed == set(required), "pass needs every necessary requirement and no stale reason")
    elif fact == "fail":
        require(decisive and decisive <= covered and decisive <= witnessed
                and reasons == {required[r]["failure_code"] for r in decisive}, "fail needs frozen reasons and evidence for a decisive requirement")
    else:
        allowed = UNKNOWN_CODES | {config["code"] for key in unresolved for config in required[key].get("unknown_reasons", [])}
        require(not decisive and unresolved and reasons and reasons <= allowed,
                "unknown needs unresolved requirements with a valid uncertainty reason")
        needs_repair = {key for key in unresolved & hidden
                        if all(option & broken_channels for option in _options(required[key]))}
        require(not needs_repair,
                "a missing necessary artifact must be reported as a material blockage")
    return item


def validate_submission(row, manifest, *, case=None, evidence_index=None, gate_facts=None):
    """Validate a finalized human claim and normalize stale skip gates."""
    require(isinstance(row, dict) and row.get("review_schema_version") == 2, "strict review requires schema v2")
    require(row.get("batch_id") == manifest["batch_id"] and row.get("assignment_id") == manifest["assignment_id"]
            and row.get("role") == manifest["assignment_role"] and row.get("reviewer_id") in manifest["reviewer_ids"],
            "reviewer is not assigned to this batch and role")
    require(row.get("submission_state") == "finalized", "only finalized review submissions can be reconciled")
    if case is None:
        case = next((item for item in manifest["cases"] if item["blind_id"] == row.get("blind_id")), None)
    require(case is not None and row.get("blind_id") == case["blind_id"], "blind case is outside the assignment")
    identity = tuple(key for key in HASH_FIELDS if not _hash(row.get(key)))
    require(not identity, "review omits case, evidence, mapping, or task identity")
    if any(row[key] != case[key] for key in HASH_FIELDS):
        raise StaleReview("case content changed since this review")
    task = case["task_card"]
    require(all(row.get(key) == task[key] for key in ("protocol_id", "profile_id")), "profile or protocol mismatch")
    require(row.get("correspondence_id") in task["allowed_correspondence_ids"], "undeclared correspondence")
    selected_mapping = case.get("assigned_correspondence_id", task.get("review_correspondence_id"))
    require(selected_mapping is None or row["correspondence_id"] == selected_mapping,
            "review changes the assigned shared correspondence")
    dimensions = row.get("dimensions")
    require(isinstance(dimensions, dict) and set(dimensions) == set(assigned_dimensions(case))
            and all(isinstance(value, dict) for value in dimensions.values()),
            "submission does not match the assigned dimensions")
    status = _channel_status(row, case, evidence_index)
    blocked, broken_channels, unscoped_issue = _issue_status(row, status)
    normalized = deepcopy(row)
    gates = case.get("gates", {}) if gate_facts is None else gate_facts
    normalized["dimensions"] = _scope_states(case, deepcopy(dimensions), gates)
    for dim, item in normalized["dimensions"].items():
        _validate_dimension(item, case, dim, status, blocked, broken_channels, unscoped_issue, evidence_index)
    return normalized


def and3(values):
    terms = tuple(values)
    require(terms and all(x in VERDICTS for x in terms), "missing or invalid three-state conjunction")
    return "fail" if "fail" in terms else "pass" if all(x == "pass" for x in terms) else "unknown"


def or3(values):
    terms = tuple(values)
    require(terms and all(x in VERDICTS for x in terms), "missing or invalid three-state disjunction")
    return "pass" if "pass" in terms else "fail" if all(x == "fail" for x in terms) else "unknown"


def joint_contact_motion(mapping_facts, allowed_mapping_ids):
    allowed = tuple(allowed_mapping_ids)
    require(allowed and len(allowed) == len(set(allowed)) and not set(mapping_facts) - set(allowed),
            "invalid frozen correspondence alternatives")
    pairs = {}
    for key in allowed:
        pair = tuple(mapping_facts.get(key, ("unknown", "unknown")))
        require(len(pair) == 2, "a mapping needs a contact and motion fact")
        pairs[key] = and3(pair)
    return or3(pairs.values()), [key for key, status in pairs.items() if status == "pass"]


def comparable_questions(source_assignment, other_assignment):
    """Verify an arbitration assignment preserves every compared question."""
    validate_manifest(source_assignment)
    validate_manifest(other_assignment)
    require(other_assignment["assignment_role"] == "arbiter"
            and other_assignment["batch_id"] == source_assignment["batch_id"]
            and other_assignment["assignment_id"] != source_assignment["assignment_id"]
            and other_assignment.get("source_assignment_id") == source_assignment["assignment_id"]
            and set(other_assignment["reviewer_ids"]).isdisjoint(source_assignment["reviewer_ids"]),
            "arbiter must be separately assigned and distinct from both independent reviewers")
    original = {case["blind_id"]: case for case in source_assignment["cases"]}
    for case in other_assignment["cases"]:
        parent = original.get(case["blind_id"])
        require(parent and all(case[key] == parent[key] for key in HASH_FIELDS)
                and set(assigned_dimensions(case)) <= set(assigned_dimensions(parent)),
                "arbitration changes a case fingerprint or exceeds the original question")
        selected = case.get("assigned_correspondence_id")
        require(selected is None or selected in parent["task_card"]["allowed_correspondence_ids"],
                "arbiter is assigned an unregistered correspondence")


def _reconciled_value(left, right):
    states = [item.get("assessment_state", "pending") for item in (left, right)]
    if states == ["evaluated", "evaluated"]:
        if left["verdict"] == right["verdict"]:
            return {"assessment_state": "evaluated", "verdict": left["verdict"], "disputed": False}
        return {"assessment_state": "pending", "verdict": None, "disputed": True}
    for state in ("blocked", "stale"):
        if state in states:
            return {"assessment_state": state, "verdict": None, "disputed": False}
    return {"assessment_state": "skipped" if states == ["skipped", "skipped"] else "pending",
            "verdict": None, "disputed": False}


def _key_for(dimension, correspondence):
    return (dimension, None if dimension == "P" else correspondence)


def organize_reviews(labels, manifest, *, evidence_index_for, arbitrations=(), gate_facts_for=None):
    """Validate both designated reviewers and an exactly scoped optional third decision.

    Retains original rows including stale claims. Only a comparable pair of
    current evaluated decisions can request arbitration.
    """
    validate_manifest(manifest)
    require(manifest["assignment_role"] == "independent", "expected the independent assignment")
    assignments = {manifest["assignment_id"]: manifest}
    case_sets = {manifest["assignment_id"]: {x["blind_id"]: x for x in manifest["cases"]}}
    for arbitration in arbitrations:
        comparable_questions(manifest, arbitration)
        identifier = arbitration["assignment_id"]
        require(identifier not in assignments, "duplicate arbitration assignment")
        assignments[identifier] = arbitration
        case_sets[identifier] = {x["blind_id"]: x for x in arbitration["cases"]}

    rows = list(labels)
    accepted, stale, stale_by_case = [], [], defaultdict(dict)
    evidence_cache = {}
    independent = defaultdict(lambda: defaultdict(dict))
    arbiters = defaultdict(dict)
    seen = {}
    for ordinal, row in enumerate(rows):
        assignment_id, blind = row.get("assignment_id"), row.get("blind_id")
        require(assignment_id in assignments and blind in case_sets[assignment_id], "unknown assignment or blind case")
        assignment = assignments[assignment_id]
        case = case_sets[assignment_id][blind]
        identity = (assignment_id, blind, row.get("reviewer_id"), row.get("correspondence_id"))
        if identity in seen and seen[identity] == row:
            continue
        require(identity not in seen, "conflicting finalized submissions from one reviewer")
        seen[identity] = row
        if blind not in evidence_cache:
            evidence_cache[blind] = evidence_index_for(case)
        gates = gate_facts_for(case) if gate_facts_for is not None else None
        try:
            normalized = validate_submission(row, assignment, case=case, evidence_index=evidence_cache[blind], gate_facts=gates)
        except StaleReview as error:
            stale_reason = {"row_index": ordinal, "blind_id": blind, "reviewer_id": row.get("reviewer_id"), "reason": str(error)}
            stale.append(stale_reason)
            if assignment["assignment_role"] == "independent":
                stale_by_case[blind][row.get("reviewer_id")] = stale_reason
            continue
        correspondence = normalized["correspondence_id"]
        if assignment["assignment_role"] == "arbiter":
            selected = case.get("assigned_correspondence_id")
            require(selected is None or correspondence == selected, "arbiter selected a correspondence outside its assignment")
        accepted.append(normalized)
        for dim, fact in normalized["dimensions"].items():
            scope = _key_for(dim, correspondence)
            detail = {"reviewer_id": normalized["reviewer_id"], "assignment_id": assignment_id, "claim": fact}
            if assignment["assignment_role"] == "arbiter":
                require(scope not in arbiters[blind], "more than one arbiter for a disputed question")
                arbiters[blind][scope] = detail
                continue
            votes = independent[blind][scope]
            prior = votes.get(normalized["reviewer_id"])
            if prior and dim == "P":
                require((prior["claim"]["assessment_state"], prior["claim"]["verdict"]) ==
                        (fact["assessment_state"], fact["verdict"]), "functional label cannot change across correspondences")
                continue
            require(prior is None, "duplicate review for one question")
            votes[normalized["reviewer_id"]] = detail

    results, disagreements = {}, []
    for case in manifest["cases"]:
        blind = case["blind_id"]
        task = case["task_card"]
        allowed = task["allowed_correspondence_ids"]
        assigned_mapping = case.get("assigned_correspondence_id", task.get("review_correspondence_id", allowed[0]))
        dimensions = {}
        for dim in DIMENSIONS:
            for correspondence in ([None] if dim == "P" else allowed):
                scope = (dim, correspondence)
                votes = independent[blind].get(scope, {})
                snapshots = [votes.get(reviewer, {}).get("claim", {})
                             for reviewer in manifest["reviewer_ids"]]
                snapshots = [claim if claim else {"assessment_state": "stale"} if reviewer in stale_by_case[blind] else {}
                             for reviewer, claim in zip(manifest["reviewer_ids"], snapshots)]
                if not requirement_map(case, dim):
                    merged = {"assessment_state": "skipped", "verdict": None, "disputed": False,
                              "skip_reason": "not_applicable"}
                elif dim not in assigned_dimensions(case) or dim != "P" and correspondence != assigned_mapping:
                    merged = {"assessment_state": "skipped", "verdict": None, "disputed": False,
                              "skip_reason": "not_assigned"}
                else:
                    merged = _reconciled_value(*snapshots)
                arbiter = arbiters[blind].pop(scope, None)
                if arbiter:
                    require(merged["disputed"], "arbiter decision is outside a comparable disagreement")
                    final = arbiter["claim"]
                    merged.update(assessment_state=final["assessment_state"], verdict=final["verdict"],
                                  arbiter=arbiter)
                elif merged["disputed"]:
                    disagreements.append({"blind_id": blind, "dimension": dim, "correspondence_id": correspondence,
                                          "scope_id": scope_for(case, dim), "case_fingerprint": case["case_fingerprint"]})
                merged["independent"] = votes
                merged["scoped_identity"] = {"scope_id": scope_for(case, dim), "profile_id": case["task_card"]["profile_id"],
                                             "protocol_id": case["task_card"]["protocol_id"],
                                             "correspondence_id": correspondence,
                                             **{key: case[key] for key in HASH_FIELDS}}
                if dim == "P":
                    dimensions["P"] = merged
                else:
                    dimensions.setdefault(dim, {})[correspondence] = merged
        require(not arbiters[blind], "unmatched arbitration evidence")
        results[blind] = dimensions
    return {"by_case": results, "disagreements": disagreements, "stale_rows": stale,
            "validated_rows": accepted, "original_rows": rows, "review_schema_version": SCHEMA_VERSION}
