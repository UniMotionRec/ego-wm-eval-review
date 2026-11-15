#!/usr/bin/env python3
"""Build a reviewer ZIP or directory from evaluator audit-export packets."""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from zipfile import ZIP_DEFLATED, ZIP_STORED, ZipFile


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


def _write_clip(source, destination, web_compat):
    if not web_compat:
        shutil.copyfile(source, destination)
        return None
    duration, frames, codec, pixel_format = _clip_info(source)
    encoder = (["-c:v", "copy"] if codec == "h264" and pixel_format == "yuv420p" else
               ["-c:v", "libx264", "-preset", "medium", "-crf", "19", "-threads", "2", "-pix_fmt", "yuv420p"])
    subprocess.run(["ffmpeg", "-hide_banner", "-v", "error", "-nostdin", "-i", str(source),
                    "-map", "0:v:0", "-map", "0:a?", "-map_metadata", "-1", "-map_chapters", "-1",
                    *encoder, "-c:a", "aac", "-movflags", "+faststart", str(destination)], check=True)
    result_duration, result_frames, _, _ = _clip_info(destination)
    if (frames is not None and result_frames is not None and frames != result_frames) or abs(result_duration - duration) > 1e-5:
        raise ValueError(f"Browser conversion changed the video timing: {source.name}")
    return duration


def _export_filtered_contacts(transitions, destination):
    with transitions.open(encoding="utf-8") as source, destination.open("w", encoding="utf-8") as output:
        for line in source:
            if not line.strip():
                continue
            step = json.loads(line)
            state = step["post_state"]
            row = {"state_time_s": step["t1_s"], "solver_interval_s": [step["t0_s"], step["t1_s"]],
                   "object_position_m": state.get("object_position_m"),
                   "object_quat_wxyz": state.get("object_quat_wxyz"),
                   "palm_position_m": state.get("palm_position_m"),
                   "contacts_available": step.get("contacts_valid"),
                   "object_contacts": [{key: sample.get(key) for key in _CONTACT_KEYS}
                                       for sample in step.get("contacts", []) if sample.get("instance_id")]}
            print(json.dumps(row, ensure_ascii=False, separators=(",", ":"), allow_nan=False), file=output)


def _trace_for_blind_id(blind_id, mapping, runs):
    run_id = _safe_name(mapping[blind_id]["run_id"], "mapped run ID")
    run_dir = _safe_path(runs, run_id)
    final = _read_json(_safe_path(run_dir, "final.json"))
    if final["status"] != "complete":
        raise ValueError("Reviewer trace was requested for an incomplete run")
    attempt = _safe_name(final["attempt"], "attempt name")
    return _safe_path(run_dir, f"{attempt}/transitions.jsonl")


def _write_batch(audit, stage, batch_id, title, *, web_compat, mapping=None, runs=None):
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
            if role not in files:
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
                                   ("source_captions", "source_captions"), ("execution_captions", "execution_captions")):
            if packet_field in files:
                source = _safe_path(audit, files[packet_field])
                relative = f"media/{blind_id}.{name}{source.suffix}"
                shutil.copyfile(source, stage / relative)
                case["media"][name] = relative
        if mapping is not None and "physical_evidence" not in case["media"]:
            relative = f"media/{blind_id}.physical_evidence.jsonl"
            _export_filtered_contacts(_trace_for_blind_id(blind_id, mapping, runs), stage / relative)
            case["media"]["physical_evidence"] = relative
        cases.append(case)
    if not cases:
        raise ValueError("No blinded review packets found")
    _write_json(stage / "review-manifest.json", {"schema_version": 1, "batch_id": batch_id, "title": title, "cases": cases})
    return len(cases)


def export_bundle(audit, output, *, batch_id, title, web_compat=False, private_key=None, runs_root=None):
    audit, output = Path(audit).resolve(strict=True), Path(output).resolve()
    _safe_name(batch_id, "batch ID")
    if bool(private_key) != bool(runs_root):
        raise ValueError("Provide both private key and run root to attach trace evidence")
    mapping = _read_json(Path(private_key))["mapping"] if private_key else None
    runs = Path(runs_root).resolve(strict=True) if runs_root else None
    if output.exists():
        raise FileExistsError(f"Bundle already exists: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=output.parent) as storage:
        scratch = Path(storage)
        stage = scratch / "batch"
        stage.mkdir()
        count = _write_batch(audit, stage, batch_id, title, web_compat=web_compat, mapping=mapping, runs=runs)
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
    parser.add_argument("--web-compat", action="store_true", help="Normalize video encoding without changing video timing")
    parser.add_argument("--private-key", type=Path, help="Optional separate audit mapping for filtered trace evidence")
    parser.add_argument("--runs-root", type=Path, help="Optional private evaluator result root")
    args = parser.parse_args()
    count = export_bundle(args.audit, args.output, batch_id=args.batch_id, title=args.title,
                          web_compat=args.web_compat, private_key=args.private_key, runs_root=args.runs_root)
    print(f"Exported {count} blinded cases to {args.output}")


if __name__ == "__main__":
    main()
