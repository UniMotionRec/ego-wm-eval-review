# Reviewer batch tools

Use Python 3.10 or later. The pipeline's `audit-export` command creates the packet directory and an adjacent private key. The exporter preserves its blind IDs and packages the videos and review criteria without the run mapping or scores.

```sh
python scripts/export_review_bundle.py \
  --audit /path/to/audit-export --output /private/path/review.zip \
  --batch-id development-review --title 'Ego WM development review' \
  --web-compat
```

An output path without `.zip` creates a directory. `--web-compat` uses `ffmpeg` and `ffprobe` to convert browser-incompatible video to H.264/yuv420p, preserving frame count and duration. The default copies the original files. To add filtered contact and pose observations for packets that lack them, include `--private-key /private/path/audit.private-key.json --runs-root /private/path/runs`. Store the private key and review batches outside the website repository.

The public practice deck uses drawings from `generate_synthetic_demo.py`. To regenerate them, install Pillow and ffmpeg.

```sh
python scripts/generate_synthetic_demo.py --output docs/demo --font /path/to/DejaVuSans.ttf
```
