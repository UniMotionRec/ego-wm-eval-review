# Reviewer batch tools

Use Python 3.10 or later. The pipeline's `audit-export` command creates the packet directory and an adjacent private key. The exporter preserves its blind IDs and packages the videos and review criteria without the run mapping or scores.

```sh
python scripts/export_review_bundle.py \
  --audit /path/to/audit-export --output /private/path/review.zip \
  --batch-id development-review --title 'Ego WM development review' \
  --web-compat
```

An output path without `.zip` creates a directory. `--web-compat` uses `ffmpeg` and `ffprobe` to convert browser-incompatible video to H.264/yuv420p, preserving frame count and duration. The default copies the original files. For legacy packets, to add filtered contact and pose observations that are missing, include `--private-key /private/path/audit.private-key.json --runs-root /private/path/runs`. Store the private key and review batches outside the website repository.

The public practice deck uses drawings from `generate_synthetic_demo.py`. To regenerate them, install Pillow and ffmpeg.

```sh
python scripts/generate_synthetic_demo.py --output docs/demo --font /path/to/DejaVuSans.ttf
```

For v2, stage packets with `task_card`, explicit `timeline`, and `trace_binding_hash`. The `files` mapping can include `source_timestamps`, `execution_timestamps`, `physical_evidence`, and a synchronized `execution_closeup`. Physics rows must be exported from the verified attempt before packaging. The v2 exporter checks media PTS, transition identity when present, and SHA-256 identities. It preserves declared preparation, offsets, scale, and score windows. An absent channel remains unavailable to the reviewer. Provide `--schema-version 2 --assignment-id <id> --reviewer-id R1 --reviewer-id R2` for an independent assignment. `python scripts/check_bundle_clocks.py` checks a shifted, scaled timeline and rejection of corrupted media timing.

Source timestamps must support the declared comparison window. Staging, packaging and label ingestion share `source_clock.py`, which checks acquisition order, the source-to-execution clock, nearest-frame distance and gaps. Declare a nonzero acquisition origin with `source_start_s`. A wider variable-frame-rate or sparse acquisition schedule can declare `source_max_gap_s` based on its source sampling contract. The default derives a cadence bound from the actual acquisition rows.

Use explicit `source_coverage: partial` for a limited source domain and scope source-dependent questions accordingly. Unsupported intervals and the final frame's presentation tail do not establish precise source timing. Execution-only or physics-only requirements retain their own coverage. Repeated video frames keep the same native state identity and add no physical hold duration.
