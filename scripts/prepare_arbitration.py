"""Create a blind reviewer bundle containing only cases with independent disagreement."""

import argparse
from collections import defaultdict
import json
from pathlib import Path, PurePosixPath
from zipfile import ZIP_DEFLATED, ZipFile


DIMENSIONS = ("functional", "contact", "motion")
VERDICTS = {"pass", "fail", "unknown"}


def independent_labels(paths, batch):
    grouped = defaultdict(dict)
    known = {row["blind_id"] for row in batch["cases"]}
    for path in paths:
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if not line.strip():
                continue
            row = json.loads(line)
            reviewer, blind_id = row.get("reviewer_id"), row.get("blind_id")
            if not reviewer or blind_id not in known or row.get("role") != "independent":
                raise ValueError(f"{path.name}:{number}: unexpected reviewer, case or role")
            if row.get("batch_id") != batch["batch_id"]:
                raise ValueError(f"{path.name}:{number}: label belongs to a different batch")
            if any(row.get(key, {}).get("value") not in VERDICTS for key in DIMENSIONS):
                raise ValueError(f"{path.name}:{number}: three decisions are required")
            previous = grouped[blind_id].setdefault(reviewer, row)
            if previous != row:
                raise ValueError(f"{path.name}:{number}: conflicting versions from the same reviewer")
    return grouped


def prepare(archive, label_paths, output):
    with ZipFile(archive) as source:
        candidates = [name for name in source.namelist()
                      if PurePosixPath(name).name == "review-manifest.json"]
        if len(candidates) != 1:
            raise ValueError("Expected exactly one review-manifest.json")
        manifest_name = candidates[0]
        folder = PurePosixPath(manifest_name).parent
        manifest = json.loads(source.read(manifest_name))
        labels = independent_labels(label_paths, manifest)
        if len({reviewer for per_case in labels.values() for reviewer in per_case}) > 2:
            raise ValueError("Provide files from the two designated reviewers")
        selected = []
        pending = 0
        for case in manifest["cases"]:
            votes = list(labels[case["blind_id"]].values())
            if len(votes) < 2:
                pending += 1
            elif any(votes[0][key]["value"] != votes[1][key]["value"] for key in DIMENSIONS):
                selected.append(case)
        if not selected:
            return {"disputed_cases": 0, "awaiting_two_reviews": pending}
        clean_manifest = {
            "schema_version": 1, "batch_id": manifest["batch_id"][:91] + "-arbiter",
            "title": f"{manifest.get('title', 'Blind review')} · 复核",
            "assignment_role": "arbiter", "cases": selected,
        }
        names = set()
        with ZipFile(output, "x", compression=ZIP_DEFLATED) as target:
            target.writestr("review-manifest.json", json.dumps(clean_manifest, ensure_ascii=False, indent=2))
            for case in selected:
                for relative in case["media"].values():
                    if not relative or relative in names:
                        continue
                    path = PurePosixPath(relative)
                    if path.is_absolute() or ".." in path.parts:
                        raise ValueError("Unexpected asset path")
                    names.add(relative)
                    with source.open(str(folder / path)) as incoming, target.open(str(path), "w") as outgoing:
                        while chunk := incoming.read(1024 * 1024):
                            outgoing.write(chunk)
        return {"disputed_cases": len(selected), "awaiting_two_reviews": pending, "arbiter_bundle": str(output)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--labels", type=Path, nargs=2, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(prepare(args.bundle, args.labels, args.out), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
