#!/usr/bin/env python3
"""Read-only inventory of frontend data versus the actual Pages package.

No deletion recommendations are executed. Symlinks are not followed, and a
same-named published file is distinguished from a byte-identical copy.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from collections import defaultdict
from pathlib import Path


def digest(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def inventory(root: Path) -> dict[str, Path]:
    if not root.is_dir() or root.is_symlink():
        raise ValueError(f"Expected a real directory: {root}")
    result = {}
    for path in root.rglob("*"):
        relative = path.relative_to(root)
        if any(part.startswith(".") for part in relative.parts):
            continue
        if path.is_symlink() or any(parent.is_symlink() for parent in path.parents if parent != root):
            continue
        if path.is_file():
            result[relative.as_posix()] = path
    return result


def audit(source: Path, published: Path, *, verify_hashes: bool = False) -> dict:
    local, remote = inventory(source), inventory(published)
    groups = defaultdict(lambda: {"files": 0, "bytes": 0, "local_only_files": 0,
                                 "local_only_bytes": 0, "different_files": 0,
                                 "identical_files": 0, "unverified_files": 0})
    for name, path in local.items():
        size = path.stat().st_size
        group = groups[name.split("/")[0] if "/" in name else "(root files)"]
        group["files"] += 1
        group["bytes"] += size
        target = remote.get(name)
        if target is None:
            group["local_only_files"] += 1
            group["local_only_bytes"] += size
        elif size != target.stat().st_size:
            group["different_files"] += 1
        elif verify_hashes:
            group["identical_files" if digest(path) == digest(target) else "different_files"] += 1
        else:
            group["unverified_files"] += 1
    return {
        "read_only": True,
        "hashes_verified": verify_hashes,
        "source": str(source.resolve()),
        "published": str(published.resolve()),
        "local_bytes": sum(row["bytes"] for row in groups.values()),
        "published_bytes": sum(path.stat().st_size for path in remote.values()),
        "local_only_bytes": sum(row["local_only_bytes"] for row in groups.values()),
        "published_only_files": sorted(set(remote) - set(local)),
        "groups": dict(sorted(groups.items(), key=lambda item: (-item[1]["bytes"], item[0]))),
        "boundary": "Local-only research files are not disposable; archive or delete only after explicit review.",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path("frontend/data"))
    parser.add_argument("--published", type=Path,
                        default=Path("/private/tmp/factor-lib-pages-publish-20260701/repo/data"))
    parser.add_argument("--verify-hashes", action="store_true")
    args = parser.parse_args()
    print(json.dumps(audit(args.source, args.published, verify_hashes=args.verify_hashes),
                     ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
