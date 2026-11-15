"""Create a v2 blind arbitration package for precisely the comparable disagreements."""

import argparse
from collections import defaultdict
import hashlib
import json
from pathlib import Path, PurePosixPath
from zipfile import ZIP_DEFLATED, ZIP_STORED, ZipFile, ZipInfo

if __package__:
    from .review_contract import (build_evidence_index, comparable_questions, digest, organize_reviews, require,
                                  safe_asset_path, validate_manifest)
else:
    from review_contract import (build_evidence_index, comparable_questions, digest, organize_reviews, require,
                                 safe_asset_path, validate_manifest)


def read_labels(paths):
    for path in paths:
        with path.open(encoding="utf-8") as stream:
            for line in stream:
                if line.strip():
                    yield json.loads(line)


def arbitration_manifest(manifest, organized, arbiter_id, *, correspondence=None):
    require(arbiter_id and arbiter_id not in manifest["reviewer_ids"], "select a third, designated arbiter")
    selected = defaultdict(lambda: defaultdict(set))
    for decision in organized["disagreements"]:
        key = decision["correspondence_id"]
        if correspondence is None or key == correspondence or key is None:
            selected[decision["blind_id"]][key].add(decision["dimension"])
    cases = []
    for case in manifest["cases"]:
        disputes = selected.get(case["blind_id"], {})
        if not disputes:
            continue
        specific = [key for key in disputes if key is not None]
        require(len(specific) <= 1, "multiple mappings are disputed for one case; select one with --correspondence")
        chosen = specific[0] if specific else correspondence or case["task_card"]["allowed_correspondence_ids"][0]
        dimensions = disputes.get(chosen, set()) | disputes.get(None, set())
        cases.append({**case, "review_dimensions": sorted(dimensions), "assigned_correspondence_id": chosen})
    if not cases:
        return None
    id_hash = digest({"from_assignment": manifest["assignment_id"], "arbiter": arbiter_id,
                      "assigned": [[case["case_fingerprint"], case["assigned_correspondence_id"], case["review_dimensions"]]
                                   for case in cases]}).split(":")[1][:22]
    result = {
        "schema_version": 2, "review_schema_version": 2, "batch_id": manifest["batch_id"],
        "source_assignment_id": manifest["assignment_id"], "assignment_id": f"arbiter-{id_hash}",
        "assignment_role": "arbiter", "reviewer_ids": [arbiter_id],
        "title": f"{manifest.get('title', '盲审')} · 复核", "cases": cases,
    }
    comparable_questions(manifest, result)
    return result


def _member_names(source):
    names = source.namelist()
    require(len(names) == len(set(names)), "source zip contains conflicting member names")
    require(all(safe_asset_path(name.rstrip("/")) for name in names), "unsafe path in source ZIP")
    manifests = [name for name in names if PurePosixPath(name).name == "review-manifest.json"]
    require(len(manifests) == 1, "expected exactly one review-manifest.json")
    return manifests[0], set(names)


def _verify_member(source, name, expected):
    sha = hashlib.sha256()
    with source.open(name) as incoming:
        while chunk := incoming.read(1024 * 1024):
            sha.update(chunk)
    require("sha256:" + sha.hexdigest() == expected, "source archive media differs from the bound case")


def prepare(archive, label_paths, output, *, arbiter_id, receipt=None, correspondence=None):
    with ZipFile(archive) as source:
        manifest_name, members = _member_names(source)
        folder = PurePosixPath(manifest_name).parent
        manifest = validate_manifest(json.loads(source.read(manifest_name)))
        labels = list(read_labels(label_paths))
        checked = set()

        def evidence_index(case):
            def read_asset(relative):
                name = str(folder / relative)
                require(name in members, f"bound review asset missing: {relative}")
                return source.read(name)
            for field, relative in case["media"].items():
                if relative and field in {"source", "execution", "execution_closeup"}:
                    name, expected = str(folder / relative), case["media_hashes"][field]
                    if (name, expected) not in checked:
                        _verify_member(source, name, expected)
                        checked.add((name, expected))
            return build_evidence_index(case, read_asset)

        organized = organize_reviews(labels, manifest, evidence_index_for=evidence_index)
        result = arbitration_manifest(manifest, organized, arbiter_id, correspondence=correspondence)
        summary = {
            "disputed_cases": len(result["cases"]) if result else 0,
            "disputed_dimensions": sum(len(case["review_dimensions"]) for case in result["cases"]) if result else 0,
            "stale_rows": len(organized["stale_rows"]),
            "awaiting_two_reviews": sum(
                any(len(item["independent"]) < 2 for dim in case.values()
                    for item in ([dim] if "assessment_state" in dim else dim.values())
                    if item["assessment_state"] == "pending") for case in organized["by_case"].values()
            ),
        }
        if result is None:
            return summary
        # The party holding the private key can attach this assignment later.
        if receipt is None:
            receipt = output.with_suffix(".assignment.json")
        require(not output.exists() and not receipt.exists(), "arbitration output already exists")
        with ZipFile(output, "x") as target:
            target.writestr("review-manifest.json", json.dumps(result, ensure_ascii=False, indent=2),
                            compress_type=ZIP_DEFLATED)
            added = {}
            for case in result["cases"]:
                for field, relative in case["media"].items():
                    if not relative:
                        continue
                    expected = case["media_hashes"][field]
                    if relative in added:
                        require(added[relative] == expected, "shared path has different bound content")
                        continue
                    added[relative] = expected
                    info = source.getinfo(str(folder / relative))
                    compression = ZIP_STORED if relative.endswith((".mp4", ".mov", ".webm")) else ZIP_DEFLATED
                    archive_info = ZipInfo(relative)
                    archive_info.compress_type = compression
                    actual = hashlib.sha256()
                    with source.open(info) as incoming, target.open(archive_info, "w") as outgoing:
                        while chunk := incoming.read(1024 * 1024):
                            actual.update(chunk)
                            outgoing.write(chunk)
                    require("sha256:" + actual.hexdigest() == expected, "arbitration source evidence integrity mismatch")
        with receipt.open("x", encoding="utf-8") as stream:
            json.dump({"review_schema_version": 2, "review_manifest": result,
                       "source_assignment_hash": digest(manifest), "arbitration_assignment_hash": digest(result)},
                      stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        return dict(summary, arbiter_bundle=str(output), assignment_receipt=str(receipt))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--labels", type=Path, nargs=2, required=True)
    parser.add_argument("--arbiter-id", required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--receipt", type=Path)
    parser.add_argument("--correspondence")
    args = parser.parse_args()
    print(json.dumps(prepare(args.bundle, args.labels, args.out, arbiter_id=args.arbiter_id,
                             receipt=args.receipt, correspondence=args.correspondence), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
