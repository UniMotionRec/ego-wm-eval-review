"""Exercise the exporter with declared nonidentity clocks and a corrupted frame map."""
from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path
import shutil
import tempfile

from export_review_bundle import _jsonl, clip_frame_times, export_bundle
from review_contract import validate_manifest


def _write_lines(path, rows):
    with path.open("w", encoding="utf-8") as stream:
        for row in rows:
            print(json.dumps(row), file=stream)


def check_clocks(asset_folder):
    example = asset_folder / "source.mp4"
    pts, _ = clip_frame_times(example)
    tick = float(pts[1]-pts[0])
    with tempfile.TemporaryDirectory() as scratch:
        root = Path(scratch)
        audit = root / "input"
        audit.mkdir()
        shutil.copyfile(example, audit / "source.mp4")
        shutil.copyfile(example, audit / "execution.mp4")
        timeline = {"time_policy": "declared", "source_video_offset_s": .2, "execution_video_offset_s": .1,
                    "source_duration_s": 2, "execution_duration_s": 4.5, "preparation_s": .5, "uniform_scale": 2,
                    "score_window_s": [0, 4.5], "physics_dt_s": tick, "native_trace_end_s": 4.5}
        source = [{"source_frame_id": j+6, "source_video_pts_s": float(pts[j+6]), "source_time_s": j*tick}
                  for j in range(61)]
        execution = []
        for j in range(136):
            t = j * tick
            paired = source[round((t-.5) / (2*tick))] if t >= .5 else dict.fromkeys(source[0])
            execution.append({"execution_frame_id": j+3, "execution_video_pts_s": float(pts[j+3]),
                              "state_index": j, "transition_index": j-1 if j else None, "trace_time_s": t,
                              "repeat_state": False, **paired})
        _write_lines(audit / "source.jsonl", source)
        _write_lines(audit / "frames.jsonl", execution)
        rules = {}
        for dimension in "PCM":
            rules[dimension] = [{"id": f"{dimension}.fixture", "label_zh": "样例", "failure_code": "fixture_fail",
                                 "failure_label_zh": "失败样例", "failure_evidence": "window", "evidence_options": [["execution"]]}]
        manifest_case = {"blind_id": "clock-fixture", "task": {"task_family": "carry_place", "description": "fixture"},
                         "rubric": {key: "test" for key in ("functional", "contact", "motion")},
                         "files": {"source": "source.mp4", "execution": "execution.mp4",
                                   "source_timestamps": "source.jsonl", "execution_timestamps": "frames.jsonl"},
                         "timeline": timeline, "trace_binding_hash": "sha256:"+"a"*64,
                         "task_card": {"protocol_id": "fixture", "profile_id": "fixture", "scope_id": "full_episode",
                                       "review_mode": "diagnostic", "required_dimensions": list("VPCM"),
                                       "allowed_correspondence_ids": ["fixture"], "requirements": rules}}
        (audit / "clock.json").write_text(json.dumps(manifest_case), encoding="utf-8")
        config = {"batch_id": "clock-test", "title": "clock test", "schema_version": 2,
                  "assignment_id": "clock-test-v2", "reviewer_ids": ("R1", "R2"), "web_compat": True}
        copied = root / "checked"
        export_bundle(audit, copied, **config)
        output = validate_manifest(json.loads((copied / "review-manifest.json").read_text()))["cases"][0]
        assert output["timeline"] == timeline
        assert list(_jsonl(copied / output["media"]["timestamps"])) == execution
        assert list(_jsonl(copied / output["media"]["source_timestamps"])) == source
        altered = deepcopy(execution)
        altered[30]["execution_video_pts_s"] += .015
        _write_lines(audit / "frames.jsonl", altered)
        try:
            export_bundle(audit, root / "corrupt", **config)
        except ValueError as exc:
            assert "decoded PTS" in str(exc)
        else:
            raise AssertionError("exporter accepted corrupt decoded PTS")
        return 2


if __name__ == "__main__":
    print(f"{check_clocks(Path(__file__).resolve().parents[1] / 'docs' / 'demo')} clock checks passed")
