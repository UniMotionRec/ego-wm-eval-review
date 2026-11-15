#!/usr/bin/env python3
"""Render original 2D practice clips for the public review site."""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import subprocess

from PIL import Image, ImageDraw, ImageFont


W, H, FPS, DURATION_S = 640, 360, 30, 4.8
BG = "#f3f1e9"
INK = "#1d2d29"
TEAL = "#245c50"
PAPER = "#faf9f4"


def smooth_time(t, start, end):
    x = min(1., max(0., (t - start) / (end - start)))
    return x * x * (3 - 2 * x)


def draw_cup(draw, cx, bottom):
    body = [(cx - 22, bottom - 54), (cx + 22, bottom - 54),
            (cx + 15, bottom - 4), (cx + 8, bottom), (cx - 9, bottom), (cx - 16, bottom - 4)]
    draw.rounded_rectangle((cx + 15, bottom - 45, cx + 39, bottom - 20), 11, outline="#7d3c25", width=7)
    draw.polygon(body, fill="#ce774e")
    draw.line(body + [body[0]], fill="#7d3c25", width=2, joint="curve")
    draw.ellipse((cx - 22, bottom - 60, cx + 22, bottom - 48), fill="#f2bb91", outline="#7d3c25", width=2)
    draw.line((cx - 12, bottom - 43, cx - 7, bottom - 12), fill="#e9a27d", width=3)


def draw_hand(draw, cx, bottom, spread, manual):
    left = round(cx - 68)
    height = round(bottom - 35)
    fill, dark = ("#b68d70", "#785744") if manual else ("#487a81", "#264e54")
    draw.line((left - 24, height - 2, left + 5, height - 2), fill=dark, width=15)
    draw.rounded_rectangle((left, height - 20, left + 31, height + 18), 10 if manual else 5,
                           fill=fill, outline=dark, width=2)
    finger_spread = 7 + spread
    for sign in (-1, 1):
        shoulder = (left + 27, height + sign * 11)
        elbow = (left + 38, height + sign * finger_spread)
        tip = (left + 50, height + sign * finger_spread)
        draw.line((shoulder, elbow, tip), fill=dark, width=9, joint="curve")
        draw.line((shoulder, elbow, tip), fill=fill, width=6, joint="curve")
        if not manual:
            draw.ellipse((elbow[0] - 3, elbow[1] - 3, elbow[0] + 3, elbow[1] + 3), fill="#adc0ba")


def frame(t, shot, fonts):
    title_font, body_font, stamp_font = fonts
    canvas = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(canvas)
    draw.rounded_rectangle((14, 14, W - 14, H - 14), 18, fill=PAPER, outline="#c9c9b9", width=1)
    draw.rounded_rectangle((31, 28, 152, 54), 12, fill="#e3ebe1")
    draw.text((44, 34), "2D practice clip", font=stamp_font, fill=TEAL)
    draw.text((29, 64), "Source demonstration" if shot == "source" else "Execution replay", font=title_font, fill=INK)
    draw.text((W - 100, 36), f"{t:0.2f} s", font=stamp_font, fill=TEAL)
    draw.rounded_rectangle((29, 105, W - 29, 304), 10, fill="#e6ebe0")
    draw.rectangle((30, 251, W - 30, 288), fill="#cbd0bd")
    draw.line((30, 250, W - 30, 250), fill="#647466", width=2)
    draw.rounded_rectangle((420, 244, 501, 257), 6, fill="#91bd9f")
    for x in range(427, 494, 10):
        draw.line((x, 250, x + 5, 250), fill="#245c50", width=1)
    draw.text((432, 269), "Target", font=body_font, fill=TEAL)
    motion = smooth_time(t, .87, 3.17)
    side = 356 if shot == "second" else 460
    cup_x = round(165 + (side - 165) * motion)
    cup_bottom = round(247 - 81 * math.sin(math.pi * motion))
    approach = smooth_time(t, .05, .87)
    separate = smooth_time(t, 3.28, 4.22)
    hand_x = cup_x - round((1 - approach) * 40 + 79 * separate)
    hand_bottom = cup_bottom - 29 * separate
    openness = round(8 * ((1 - approach) + separate))
    shadow = 16 + round((1.0 - math.sin(math.pi * motion)) * 10)
    draw.ellipse((cup_x - shadow, 245, cup_x + shadow, 252), fill="#a5aa98")
    draw_hand(draw, hand_x, hand_bottom, openness, shot == "source")
    draw_cup(draw, cup_x, cup_bottom)
    draw.rounded_rectangle((29, 320, W - 29, 328), 4, fill="#ddded1")
    bar_end = 29 + round((W - 58) * t / DURATION_S)
    if bar_end > 29:
        draw.rounded_rectangle((29, 320, bar_end, 328), 4, fill="#387d68")
    return canvas


def encode(output, shot, fonts):
    with subprocess.Popen(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo",
                           "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-", "-an",
                           "-c:v", "libx264", "-crf", "22", "-preset", "slow", "-threads", "2",
                           "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(output)], stdin=subprocess.PIPE) as ffmpeg:
        for index in range(round(DURATION_S * FPS)):
            ffmpeg.stdin.write(frame(index / FPS, shot, fonts).tobytes())
        ffmpeg.stdin.close()
        if ffmpeg.wait() != 0:
            raise RuntimeError(f"Failed to render {output.name}")


def generate(out, font_path):
    out.mkdir(parents=True, exist_ok=True)
    fonts = [ImageFont.truetype(str(font_path), size) for size in (24, 14, 13)]
    for shot, name in (("source", "source.mp4"), ("first", "execution-a.mp4"), ("second", "execution-b.mp4")):
        encode(out / name, shot, fonts)
    captions = {
        "source.vtt": ("The hand approaches the cup.", "The hand lifts and carries the cup.",
                       "The hand lowers the cup, lets go, and moves away."),
        "execution-a.vtt": ("The gripper approaches the cup.", "The gripper carries the cup above the tabletop.",
                            "The gripper opens and moves away."),
        "execution-b.vtt": ("The gripper approaches the cup.", "The gripper carries the cup above the tabletop.",
                            "The gripper opens and moves away."),
    }
    ranges = ("00:00:00.000 --> 00:00:00.870", "00:00:00.870 --> 00:00:03.170", "00:00:03.170 --> 00:00:04.800")
    for name, captions_for_clip in captions.items():
        cues = [f"{timestamps}\n{text}\n" for timestamps, text in zip(ranges, captions_for_clip, strict=True)]
        (out / name).write_text("WEBVTT\n\n" + "\n".join(cues), encoding="utf-8")
    task = {"title": "Carry and place a cup",
            "description": "One hand carries a cup across the table, sets it down on the green target, and withdraws.",
            "rubric": {"functional": "Check whether the cup ends inside the green target and remains there after release.",
                       "contact": "Compare when the hand contacts and releases the cup.",
                       "motion": "Compare the cup path, the order of movement, and the hand withdrawal."}}
    cases = [{"blind_id": f"practice-{index}", "task": task,
              "media": {"source": "source.mp4", "execution": f"execution-{clip}.mp4",
                        "source_captions": "source.vtt", "execution_captions": f"execution-{clip}.vtt"},
              "timeline": {"source_duration_s": DURATION_S, "execution_duration_s": DURATION_S}}
             for index, clip in enumerate(("b", "a"), start=1)]
    result = {"schema_version": 1, "batch_id": "practice-2d", "title": "Practice review", "cases": cases}
    (out / "review-manifest.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--font", type=Path, default=Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"))
    args = parser.parse_args()
    generate(args.output, args.font)


if __name__ == "__main__":
    main()
