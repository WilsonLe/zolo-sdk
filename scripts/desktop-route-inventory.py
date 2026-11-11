#!/usr/bin/env python3
"""Inventory route literals from the installed ASAR without extracting the app."""

import argparse
from collections import defaultdict
import hashlib
import json
from pathlib import Path
import re
import struct
import subprocess


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", nargs="?", default="/Applications/Zalo.app/Contents/Resources/app.asar", type=Path)
    parser.add_argument("--upstream", default=Path(__file__).resolve().parents[1] / "node_modules/zca-js/dist/apis", type=Path)
    parser.add_argument("--sdk", action="store_true", help="Add conservative current SDK literal/expression source evidence. Requires installed TypeScript.")
    args = parser.parse_args()
    sdk_evidence = {}
    if args.sdk:
        project = Path(__file__).resolve().parents[1]
        result = subprocess.run(["node", str(project / "scripts/desktop-sdk-route-evidence.mjs"), str(project)],
                                capture_output=True, text=True, check=True)
        sdk_evidence = json.loads(result.stdout)

    with args.archive.open("rb") as archive:
        _, header_size, _, json_size = struct.unpack("<4I", archive.read(16))
        lazy = json.loads(archive.read(json_size))["files"]["pc-dist"]["files"]["lazy"]["files"]
        candidates = [name for name in lazy if name.startswith("default-login-main-startup-shared-worker-znotification.") and name.endswith(".js")]
        if len(candidates) != 1:
            parser.error("Expected one desktop shared JavaScript member; the app layout may have changed.")
        entry = lazy[candidates[0]]
        archive.seek(8 + header_size + int(entry["offset"]))
        source = archive.read(entry["size"])

    digest = hashlib.sha256(source).hexdigest()
    if digest != entry["integrity"]["hash"]:
        parser.error("The shared JavaScript member did not match the ASAR integrity metadata.")

    modules = defaultdict(set)
    for module in args.upstream.glob("*.js"):
        for route in re.findall(rb"/api/[A-Za-z0-9/_-]+", module.read_bytes()):
            modules[route].add(module.stem)
    if not modules:
        parser.error("No upstream route literals found. Install the pinned dependency first.")

    desktop = defaultdict(list)
    for match in re.finditer(rb'["`\x27](/api/[A-Za-z0-9/_-]+)["`\x27]', source):
        desktop[match.group(1)].append(match.start(1))

    print(f"# pc-dist/lazy/{candidates[0]}")
    print(f"# sha256={digest}")
    print(f"# desktop_routes={len(desktop)} upstream_routes={len(modules)} shared_literals={len(desktop.keys() & modules.keys())}")
    header = "route\tfirst_byte_offset\toccurrences\tzca_modules_with_same_literal"
    if args.sdk:
        header += "\tsdk_literal_sources\tsdk_expression_candidates"
    print(header)
    for route, offsets in sorted(desktop.items()):
        name = route.decode("ascii")
        row = f"{name}\t{offsets[0]}\t{len(offsets)}\t{','.join(sorted(modules.get(route, [])))}"
        if args.sdk:
            evidence = sdk_evidence.get(name, {})
            row += f"\t{','.join(evidence.get('literal', []))}\t{','.join(evidence.get('expression', []))}"
        print(row)


if __name__ == "__main__":
    main()
