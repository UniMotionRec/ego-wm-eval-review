#!/usr/bin/env python3
"""Build a reviewer ZIP or directory from evaluator audit-export packets."""
from __future__ import annotations

import argparse
from fractions import Fraction
import json
import math
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from zipfile import ZIP_DEFLATED, ZIP_STORED, ZipFile

if __package__:
    from .review_contract import bind_case, hash_file, validate_manifest
else:
    from review_contract import bind_case, hash_file, validate_manifest


_TASK_TITLES = {
    "lift_hold": "Lift and hold",
    "carry_place": "Carry and place",
    "push_slide": "Push or slide",
    "reorient": "Reorient the object",
    "handover": "Transfer between hands",
    "articulated": "Move the articulated part",
}
_RUBRIC = ("functional", "contact", "motion")
_SAFE_NAME = re.compile(r"^[A-Za-z0-9_.-]{1,112}$")
_CONTACT_KEYS = ("instance_id", "hand_id", "hand_region", "patch_id", "support_instance_id",
                 "normal_force_N", "force_on_object_world_N", "distance_m", "active")


def _read_json(path):
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def _write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def _safe_path(root, filename):
    if not isinstance(filename, str) or Path(filename).is_absolute() or ".." in Path(filename).parts:
        raise ValueError("Expected a relative packet asset path")
    path = (root / filename).resolve(strict=True)
    if not path.is_relative_to(root):
        raise ValueError("Packet asset is outside the audit directory")
    return path


def _safe_name(value, label):
    if not isinstance(value, str) or not _SAFE_NAME.fullmatch(value) or value in {".", ".."}:
        raise ValueError(f"Invalid {label}")
    return value


def _clip_info(video):
    result = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
                             "-show_entries", "stream=codec_name,pix_fmt,nb_frames,duration:format=duration",
                             "-of", "json", str(video)], check=True, capture_output=True, text=True)
    data = json.loads(result.stdout)
    streams = data.get("streams", [])
    if not streams:
        raise ValueError(f"Packet video has no video stream: {video.name}")
    info = streams[0]
    duration = float(info.get("duration") or data["format"]["duration"])
    frames = info.get("nb_frames")
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError(f"Packet video has invalid duration: {video.name}")
    return duration, int(frames) if frames and frames != "N/A" else None, info.get("codec_name"), info.get("pix_fmt")



def clip_frame_times(video):
    """Return decoded video PTS on the actual stream's exact rational clock."""
    result = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_frames",
                             "-show_entries", "stream=time_base,duration_ts:frame=best_effort_timestamp,pkt_duration",
                             "-of", "json", str(video)], check=True, capture_output=True, text=True)
    document = json.loads(result.stdout)
    streams = document.get("streams", [])
    if len(streams) != 1:
        raise ValueError(f"Expected one video clock in {video.name}")
    stream = streams[0]
    time_base = Fraction(stream["time_base"])
    frames = document.get("frames", [])
    points = tuple(int(frame["best_effort_timestamp"]) * time_base for frame in frames)
    if not points or any(b <= a for a, b in zip(points, points[1:])):
        raise ValueError(f"Invalid presentation order in {video.name}")
    duration = (int(stream["duration_ts"]) * time_base if "duration_ts" in stream else
                points[-1] - points[0] + int(frames[-1]["pkt_duration"]) * time_base)
    return points, duration

def _write_clip(source, destination, web_compat):
    if not web_compat:
        shutil.copyfile(source, destination)
        return None
    duration, frames, codec, pixel_format = _clip_info(source)
    source_clock = clip_frame_times(source)
    encoder = (["-c:v", "copy"] if codec == "h264" and pixel_format == "yuv420p" else
               ["-c:v", "libx264", "-preset", "medium", "-crf", "19", "-threads", "2", "-pix_fmt", "yuv420p"])
    subprocess.run(["ffmpeg", "-hide_banner", "-v", "error", "-nostdin", "-i", str(source),
                    "-map", "0:v:0", "-map", "0:a?", "-map_metadata", "-1", "-map_chapters", "-1",
                    *encoder, "-c:a", "aac", "-movflags", "+faststart", str(destination)], check=True)
    result_duration, result_frames, _, _ = _clip_info(destination)
    if ((frames is not None and result_frames is not None and frames != result_frames)
            or abs(result_duration - duration) > 1e-5 or clip_frame_times(destination) != source_clock):
        raise ValueError(f"Browser conversion changed the decoded frame PTS or duration: {source.name}")
    return duration


def _export_filtered_contacts(transitions, destination):
    with transitions.open(encoding="utf-8") as source, destination.open("w", encoding="utf-8") as output:
        for line in source:
            if not line.strip():
                continue
            step = json.loads(line)
            state = step["post_state"]
            row = {"transition_index": step["step_id"], "state_time_s": step["t1_s"], "solver_interval_s": [step["t0_s"], step["t1_s"]],
                   "object_position_m": state.get("object_position_m"),
                   "object_quat_wxyz": state.get("object_quat_wxyz"),
                   "palm_position_m": state.get("palm_position_m"),
                   "contacts_available": step.get("contacts_valid"),
                   "object_contacts": [{key: sample.get(key) for key in _CONTACT_KEYS}
                                       for sample in step.get("contacts", []) if sample.get("instance_id") and step.get("contacts_valid")]}
            print(json.dumps(row, ensure_ascii=False, separators=(",", ":"), allow_nan=False), file=output)


def _trace_for_blind_id(blind_id, key, runs):
    from review_contract import hash_file

    linked = key["mapping"][blind_id]
    run_id = _safe_name(linked["run_id"], "mapped run ID")
    run_dir = _safe_path(runs, run_id)
    final = _read_json(_safe_path(run_dir, "final.json"))
    if final["status"] != "complete" or final["manifest_hash"] != key["manifest_hash"]:
        raise ValueError("Reviewer trace does not belong to this private audit mapping")
    attempt = _safe_name(final["attempt"], "attempt name")
    receipt = _read_json(_safe_path(run_dir, f"{attempt}/execution_receipt.json"))
    score = _read_json(_safe_path(run_dir, f"{attempt}/score.json"))
    trace_name = _safe_name(receipt["trace_file"], "trace file")
    trace_file = _safe_path(run_dir, f"{attempt}/{trace_name}")
    metadata = _read_json(trace_file)
    identity = {"manifest_hash": key["manifest_hash"], "run_id": run_id, "episode_id": linked["episode_id"]}
    if any(row.get(field) != expected for field, expected in identity.items() for row in (metadata, score)):
        raise ValueError("Trace and score do not match the private audit mapping")
    if score["trace_hash"] != receipt["trace_hash"] or hash_file(trace_file) != "sha256:" + receipt["trace_hash"]:
        raise ValueError("Reviewer trace metadata changed after scoring")
    name = _safe_name(metadata["transitions_file"], "transition file")
    transitions = _safe_path(run_dir, f"{attempt}/{name}")
    if hash_file(transitions) != "sha256:" + metadata["transitions_sha256"]:
        raise ValueError("Reviewer physical records changed after scoring")
    return transitions


def _jsonl(path):
    with path.open(encoding="utf-8") as stream:
        for line in stream:
            if line.strip():
                yield json.loads(line)


def _check_video_map(stage, case, role, mapping_key, prefix):
    """Verify exported frame map coordinates against the delivered media bytes."""
    if role not in case["media"]:
        if mapping_key in case["media"]:
            raise ValueError(f"{role} map has no corresponding media")
        return
    video = stage / case["media"][role]
    points, duration = clip_frame_times(video)
    timeline = case["timeline"]
    if timeline[f"{role}_video_offset_s"] + timeline[f"{role}_duration_s"] > float(points[0] + duration) + 2e-6:
        raise ValueError(f"Declared {role} media window extends outside the delivered clip")
    if mapping_key not in case["media"]:
        return
    previous = -1
    for row in _jsonl(stage / case["media"][mapping_key]):
        index = row[f"{prefix}_frame_id"]
        if type(index) is not int or not previous < index < len(points):
            raise ValueError(f"Invalid {role} frame order")
        if not math.isclose(float(points[index]), row[f"{prefix}_video_pts_s"], abs_tol=2e-6, rel_tol=0):
            raise ValueError(f"{role} frame map does not match decoded PTS")
        previous = index
    if previous < 0:
        raise ValueError(f"Empty {role} frame map")



def _check_v2_evidence(stage, case):
    media, timeline = case["media"], case["timeline"]
    lo, hi = timeline["score_window_s"]
    dt = timeline.get("physics_dt_s", .002)
    native_end = timeline.get("native_trace_end_s", hi)
    tolerance = 2e-6

    def near(x, y, room=tolerance):
        return isinstance(x, (int, float)) and isinstance(y, (int, float)) and abs(x-y) <= room

    if (not isinstance(dt, (int, float)) or not math.isfinite(dt) or dt <= 0
            or not hi - tolerance <= native_end <= hi + dt + tolerance):
        raise ValueError("Invalid native trace bounds")
    source_rows = {}
    if "source_timestamps" in media:
        previous = None
        for line in _jsonl(stage / media["source_timestamps"]):
            time = line["source_time_s"]
            if not isinstance(time, (int, float)) or not math.isfinite(time) or time < 0 or (previous is not None and time <= previous):
                raise ValueError("Invalid acquisition clock in source map")
            source_rows[line["source_frame_id"]] = line
            previous = time
    trace_rows = {}
    if "physical_evidence" in media:
        first = previous = None
        for line in _jsonl(stage / media["physical_evidence"]):
            begin, end = line["solver_interval_s"]
            index = line["transition_index"]
            if (type(index) is not int or index < 0 or not begin < end or not near(end, line["state_time_s"])
                    or type(line["contacts_available"]) is not bool or not isinstance(line["object_contacts"], list)
                    or (previous is not None and (index != previous["transition_index"] + 1
                                                  or not near(begin, previous["state_time_s"])))):
                raise ValueError("Invalid transition sequence in delivered physical evidence")
            first = line if first is None else first
            trace_rows[index] = line
            previous = line
        if first is None or first["solver_interval_s"][0] > lo + tolerance or not near(previous["state_time_s"], native_end):
            raise ValueError("Physical evidence does not cover the declared trace")
    if "timestamps" not in media:
        return
    first = previous = None
    for line in _jsonl(stage / media["timestamps"]):
        state, transition, trace_time = (line[key] for key in ("state_index", "transition_index", "trace_time_s"))
        repeated = previous is not None and state == previous["state_index"]
        if (type(state) is not int or state < 0 or not isinstance(trace_time, (int, float)) or not math.isfinite(trace_time)
                or (transition is not None if state == 0 else transition != state - 1)
                or line.get("repeat_state") is not repeated
                or (previous is not None and (state < previous["state_index"] or trace_time < previous["trace_time_s"]
                                              or repeated != near(trace_time, previous["trace_time_s"])) )):
            raise ValueError("Renderer frame mapping changed state/transition identity or an explicit repeat")
        if trace_rows and transition is not None:
            record = trace_rows.get(transition)
            if record is None or not near(trace_time, record["state_time_s"]) or line.get("action_interval_s") != record["solver_interval_s"]:
                raise ValueError("Renderer frame is not from the named physical transition")
        if source_rows and line.get("source_frame_id") is not None:
            source = source_rows.get(line["source_frame_id"])
            if source is None or any(not near(source[field], line.get(field)) for field in ("source_video_pts_s", "source_time_s")):
                raise ValueError("Source acquisition map disagrees with the execution frame")
        first = line if first is None else first
        previous = line
    if first is None or first["trace_time_s"] > lo + dt + tolerance or not near(previous["trace_time_s"], hi, dt + tolerance):
        raise ValueError("Delivered frame map does not cover the declared score window")

def _enrich_v2(case, packet, stage):
    timeline = dict(packet["timeline"])
    if timeline.get("time_policy") not in {"identity", "declared"}:
        raise ValueError("Time mapping must be explicitly identity or declared")
    if timeline["time_policy"] == "identity" and any(timeline.get(name) != value for name, value in (
            ("source_video_offset_s", 0), ("execution_video_offset_s", 0), ("preparation_s", 0), ("uniform_scale", 1))):
        raise ValueError("Timeline parameters disagree with identity time policy")
    case.update(task_card=packet["task_card"], timeline=timeline, trace_binding_hash=packet["trace_binding_hash"])
    if "task_display" in packet:
        case["task"] = packet["task_display"]
    if "review_dimensions" in packet:
        case["review_dimensions"] = packet["review_dimensions"]
    case["media_hashes"] = {name: hash_file(stage / path) for name, path in case["media"].items()}
    for role, key in (("source", "source_timestamps"), ("execution", "timestamps")):
        _check_video_map(stage, case, role, key, role)
    _check_v2_evidence(stage, case)
    if "execution_closeup" in case["media"]:
        if clip_frame_times(stage / case["media"]["execution_closeup"]) != clip_frame_times(stage / case["media"]["execution"]):
            raise ValueError("Execution views must share exact presentation times and duration")
    return bind_case(case)

def _write_batch(audit, stage, batch_id, title, *, web_compat, mapping=None, runs=None, schema_version=1, assignment=None):
    assets = stage / "media"
    assets.mkdir()
    cases = []
    source_copies = {}
    seen = set()
    for path in sorted(audit.glob("*.json")):
        packet = _read_json(path)
        if not isinstance(packet, dict) or "blind_id" not in packet:
            continue
        blind_id = _safe_name(packet["blind_id"], "blind ID")
        if blind_id in seen:
            raise ValueError(f"Duplicate packet for blind ID {blind_id}")
        seen.add(blind_id)
        task = packet["task"]
        rubric = packet.get("rubric", {})
        description = task.get("description")
        if not isinstance(description, str) or any(not isinstance(rubric.get(key), str) for key in _RUBRIC):
            raise ValueError(f"Packet {blind_id} needs a description and the three rubric texts")
        case = {"blind_id": blind_id,
                "task": {"title": _TASK_TITLES.get(task.get("task_family"), "Robot task"),
                         "description": description, "rubric": {key: rubric[key] for key in _RUBRIC}},
                "media": {}}
        files = packet["files"]
        timeline = {}
        for role in ("source", "execution"):
            if role not in files or files[role] is None:
                if schema_version == 2:
                    continue
                raise ValueError(f"Packet {blind_id} lacks its {role} video")
            source = _safe_path(audit, files[role])
            stat = source.stat()
            identity = (stat.st_dev, stat.st_ino)
            if role == "source" and identity in source_copies:
                relative, duration = source_copies[identity]
            else:
                suffix = ".mp4" if web_compat else source.suffix
                dest_name = f"reference-{len(source_copies) + 1:02d}{suffix}" if role == "source" else f"{blind_id}.execution{suffix}"
                relative = f"media/{dest_name}"
                duration = _write_clip(source, stage / relative, web_compat)
            if role == "source":
                source_copies[identity] = relative, duration
            case["media"][role] = relative
            if duration is not None:
                timeline[f"{role}_duration_s"] = duration
        if timeline:
            case["timeline"] = timeline
        for packet_field, name in (("execution_timestamps", "timestamps"), ("physical_evidence", "physical_evidence"),
                                   ("source_timestamps", "source_timestamps"), ("execution_closeup", "execution_closeup"),
                                   ("source_captions", "source_captions"), ("execution_captions", "execution_captions")):
            if files.get(packet_field) is not None:
                source = _safe_path(audit, files[packet_field])
                relative = f"media/{blind_id}.{name}{source.suffix}"
                shutil.copyfile(source, stage / relative)
                case["media"][name] = relative
        if mapping is not None and "physical_evidence" not in case["media"]:
            relative = f"media/{blind_id}.physical_evidence.jsonl"
            _export_filtered_contacts(_trace_for_blind_id(blind_id, mapping, runs), stage / relative)
            case["media"]["physical_evidence"] = relative
        cases.append(_enrich_v2(case, packet, stage) if schema_version == 2 else case)
    if not cases:
        raise ValueError("No blinded review packets found")
    manifest = {"schema_version": schema_version, "batch_id": batch_id, "title": title, "cases": cases}
    if schema_version == 2:
        manifest.update(review_schema_version=2, **assignment)
        validate_manifest(manifest)
    _write_json(stage / "review-manifest.json", manifest)
    return len(cases)


def export_bundle(audit, output, *, batch_id, title, web_compat=False, private_key=None, runs_root=None,
                  schema_version=1, assignment_id=None, reviewer_ids=(), assignment_role="independent"):
    if schema_version not in (1, 2):
        raise ValueError("Unsupported review bundle version")
    assignment = {"assignment_id": assignment_id, "assignment_role": assignment_role, "reviewer_ids": list(reviewer_ids)}
    audit, output = Path(audit).resolve(strict=True), Path(output).resolve()
    _safe_name(batch_id, "batch ID")
    if bool(private_key) != bool(runs_root):
        raise ValueError("Provide both private key and run root to attach trace evidence")
    if schema_version == 2 and private_key:
        raise ValueError("Stage v2 physical evidence with its review trace binding before exporting")
    mapping = _read_json(Path(private_key)) if private_key else None
    runs = Path(runs_root).resolve(strict=True) if runs_root else None
    if output.exists():
        raise FileExistsError(f"Bundle already exists: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=output.parent) as storage:
        scratch = Path(storage)
        stage = scratch / "batch"
        stage.mkdir()
        count = _write_batch(audit, stage, batch_id, title, web_compat=web_compat, mapping=mapping, runs=runs,
                             schema_version=schema_version, assignment=assignment)
        if output.suffix == ".zip":
            archive_path = scratch / "review.zip"
            with ZipFile(archive_path, "w") as archive:
                archive.write(stage / "review-manifest.json", "review-manifest.json", ZIP_DEFLATED)
                for file in sorted((stage / "media").iterdir()):
                    method = ZIP_STORED if file.suffix in {".mp4", ".webm", ".mov"} else ZIP_DEFLATED
                    archive.write(file, file.relative_to(stage).as_posix(), method)
            archive_path.rename(output)
        else:
            stage.rename(output)
    return count


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audit", type=Path, required=True, help="An egowm_eval audit-export output directory")
    parser.add_argument("--output", type=Path, required=True, help="New .zip path or directory")
    parser.add_argument("--batch-id", required=True)
    parser.add_argument("--title", required=True)
    parser.add_argument("--schema-version", type=int, choices=[1, 2], default=1)
    parser.add_argument("--assignment-id")
    parser.add_argument("--assignment-role", choices=["independent", "arbiter"], default="independent")
    parser.add_argument("--reviewer-id", action="append", default=[])
    parser.add_argument("--web-compat", action="store_true", help="Normalize video encoding without changing video timing")
    parser.add_argument("--private-key", type=Path, help="Optional separate audit mapping for filtered trace evidence")
    parser.add_argument("--runs-root", type=Path, help="Optional private evaluator result root")
    args = parser.parse_args()
    count = export_bundle(args.audit, args.output, batch_id=args.batch_id, title=args.title,
                          web_compat=args.web_compat, private_key=args.private_key, runs_root=args.runs_root,
                          schema_version=args.schema_version, assignment_id=args.assignment_id,
                          reviewer_ids=args.reviewer_id, assignment_role=args.assignment_role)
    print(f"Exported {count} blinded cases to {args.output}")


if __name__ == "__main__":
    main()
