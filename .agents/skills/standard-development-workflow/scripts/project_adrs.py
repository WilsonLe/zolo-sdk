#!/usr/bin/env python3
"""Maintain the fallback project-local ADR store; never decide architecture."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import date
from pathlib import Path
import re
import sys

MARKER = "# Architecture decisions\n\n<!-- project-adrs:v1 -->\n"
FIELDS = ("Status", "Date", "Owner", "Evidence", "Supersedes", "Superseded by")
SECTIONS = ("Context", "Decision", "Alternatives", "Consequences", "Revisit")
STATUSES = {"proposed", "accepted", "rejected", "deprecated", "superseded"}
NAME = re.compile(r"([0-9]{4,})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md")
PLACEHOLDER = re.compile(r"\b(?:TODO|TBD)\b")


def store_path(project: Path, directory: str) -> Path:
    project = project.resolve(strict=True)
    relative = Path(directory)
    if not project.is_dir() or relative.is_absolute() or not relative.parts or any(
        part == ".." for part in relative.parts
    ):
        raise ValueError("ADR directory must be a relative child of the project")
    current = project
    for part in relative.parts:
        current = current / part
        if current.is_symlink():
            raise ValueError(f"symlink is not supported: {current}")
    if current == project:
        raise ValueError("ADR directory must be a child of the project")
    return current


def regular(path: Path) -> None:
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"expected a regular file: {path}")


@contextmanager
def writer(store: Path):
    lock = store / ".project-adrs-lock"
    try:
        lock.mkdir()
    except FileExistsError:
        raise ValueError(f"ADR writer active or interrupted; inspect before removing {lock}") from None
    try:
        yield
    finally:
        lock.rmdir()


def managed(store: Path) -> None:
    index = store / "README.md"
    regular(index)
    if not index.read_text(encoding="utf-8").startswith(MARKER):
        raise ValueError("existing ADR convention is not helper-managed; use its own tooling")


def references(value: str) -> list[str]:
    if value == "none":
        return []
    ids = value.split(", ")
    if any(not re.fullmatch(r"[0-9]{4,}", item) or int(item) < 1 for item in ids) or len(set(ids)) != len(ids):
        raise ValueError("ADR references must be unique numeric IDs separated by ', ', or none")
    return ids


def records(store: Path) -> dict[str, dict]:
    result = {}
    numeric_ids = set()
    for path in sorted(store.glob("*.md")):
        if path.name == "README.md":
            continue
        regular(path)
        match = NAME.fullmatch(path.name)
        if not match or int(match[1]) < 1 or match[1] != f"{int(match[1]):04d}":
            raise ValueError(f"invalid ADR filename: {path.name}")
        identifier = match[1]
        if int(identifier) in numeric_ids:
            raise ValueError(f"duplicate ADR ID: {identifier}")
        numeric_ids.add(int(identifier))
        text = path.read_text(encoding="utf-8")
        heading = re.match(rf"# ADR-{identifier}: ([^\n]+)\n", text)
        if not heading or not heading[1].strip() or "|" in heading[1] or PLACEHOLDER.search(heading[1]):
            raise ValueError(f"{path.name}: missing or invalid ADR title")
        # Metadata belongs before the first section, never inside decision prose.
        header = text.split("\n## ", 1)[0]
        metadata = {}
        for field in FIELDS:
            values = re.findall(rf"^- {field}: (.+)$", header, re.MULTILINE)
            if len(values) != 1 or not values[0].strip() or PLACEHOLDER.search(values[0]):
                raise ValueError(f"{path.name}: {field} must occur once without placeholders")
            metadata[field] = values[0]
        if metadata["Status"] not in STATUSES:
            raise ValueError(f"{path.name}: invalid status")
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", metadata["Date"]):
            raise ValueError(f"{path.name}: date must be YYYY-MM-DD")
        date.fromisoformat(metadata["Date"])
        for section in SECTIONS:
            bodies = re.findall(rf"^## {section}\n(.*?)(?=^## |\Z)", text, re.MULTILINE | re.DOTALL)
            if len(bodies) != 1 or not bodies[0].strip() or PLACEHOLDER.search(bodies[0]):
                raise ValueError(f"{path.name}: complete the {section} section")
        result[identifier] = {
            "path": path, "title": heading[1], **metadata,
            "supersedes": references(metadata["Supersedes"]),
            "replaced_by": references(metadata["Superseded by"]),
        }
    for identifier, record in result.items():
        older, newer = record["supersedes"], record["replaced_by"]
        if len(newer) > 1 or bool(newer) != (record["Status"] == "superseded"):
            raise ValueError(f"{identifier}: superseded status requires exactly one replacement")
        if older and record["Status"] not in {"accepted", "deprecated", "superseded"}:
            raise ValueError(f"{identifier}: only a chosen decision can supersede another")
        for target in older + newer:
            if target == identifier or target not in result:
                raise ValueError(f"{identifier}: missing or self ADR reference {target}")
        for target in older:
            if result[target]["replaced_by"] != [identifier]:
                raise ValueError(f"{identifier}: nonreciprocal supersession with {target}")
        for target in newer:
            if identifier not in result[target]["supersedes"]:
                raise ValueError(f"{identifier}: nonreciprocal replacement with {target}")
    for start in result:
        seen = set()
        current = start
        while result[current]["replaced_by"]:
            if current in seen:
                raise ValueError(f"supersession cycle at {current}")
            seen.add(current)
            current = result[current]["replaced_by"][0]
    return result


def index_text(items: dict[str, dict]) -> str:
    lines = [MARKER.rstrip(), "", "Project-owned decision history. Read relevant accepted decisions before design.",
             "Update affected ADRs with the implementation; preserve rationale when superseding.",
             "This index is generated by the Standard Development Workflow project_adrs helper.",
             "Edit records, then run refresh and check; do not hand-edit this index.", "",
             "| ADR | Decision | Status | Date |", "| --- | --- | --- | --- |"]
    for identifier in sorted(items, key=int):
        record = items[identifier]
        lines.append(f"| [ADR-{identifier}]({record['path'].name}) | {record['title']} | {record['Status']} | {record['Date']} |")
    return "\n".join(lines) + "\n"


def initialize(store: Path) -> None:
    store.mkdir(parents=True, exist_ok=True)
    with writer(store):
        existing = [path for path in store.iterdir() if path.name != ".project-adrs-lock"]
        if existing:
            managed(store)
            records(store)
            return  # Preserve an existing index, including staleness, for check/refresh.
        with (store / "README.md").open("x", encoding="utf-8") as output:
            output.write(index_text({}))


def create(store: Path, title: str, day: str) -> Path:
    if not title.strip() or any(char in title for char in "\n\r|") or PLACEHOLDER.search(title):
        raise ValueError("title must be nonempty single-line text without pipes or placeholders")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
        raise ValueError("date must be YYYY-MM-DD")
    date.fromisoformat(day)
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:80].rstrip("-")
    if not slug:
        raise ValueError("title must contain an ASCII letter or digit for the filename")
    with writer(store):
        managed(store)
        items = records(store)
        identifier = f"{max((int(item) for item in items), default=0) + 1:04d}"
        path = store / f"{identifier}-{slug}.md"
        text = f"# ADR-{identifier}: {title}\n\n- Status: proposed\n- Date: {day}\n"
        text += "- Owner: TODO\n- Evidence: TODO\n- Supersedes: none\n- Superseded by: none\n"
        text += "".join(f"\n## {section}\n\nTODO\n" for section in SECTIONS)
        with path.open("x", encoding="utf-8") as output:
            output.write(text)
        return path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("init", "new", "refresh", "check"))
    parser.add_argument("--project-root", type=Path, required=True)
    parser.add_argument("--directory", default="docs/adr")
    parser.add_argument("--title")
    parser.add_argument("--date", help="project-local decision date, YYYY-MM-DD; required for new")
    args = parser.parse_args()
    try:
        store = store_path(args.project_root, args.directory)
        if args.command == "init":
            initialize(store)
        elif args.command == "new":
            if not args.title or not args.date:
                raise ValueError("new requires --title and --date")
            print(create(store, args.title, args.date))
        else:
            managed(store)
            if args.command == "refresh":
                with writer(store):
                    expected = index_text(records(store))
                    # Replace atomically; an interrupted write cannot truncate the index.
                    temporary = store / ".project-adrs-index.tmp"
                    owned = False
                    try:
                        with temporary.open("x", encoding="utf-8") as output:
                            owned = True
                            output.write(expected)
                        temporary.replace(store / "README.md")
                    finally:
                        # Preserve a pre-existing temporary file when exclusive open failed.
                        if owned:
                            temporary.unlink(missing_ok=True)
            else:
                expected = index_text(records(store))
                if (store / "README.md").read_text(encoding="utf-8") != expected:
                    raise ValueError("stale ADR index; run refresh")
        print(f"ADR {args.command}: OK")
        return 0
    except (OSError, ValueError, UnicodeError) as error:
        print(f"ADR error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
