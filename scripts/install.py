#!/usr/bin/env python3
"""Install selected skills as symlinks without replacing existing files."""

import argparse
from pathlib import Path
import sys


def main() -> int:
    source_root = Path(__file__).resolve().parents[1] / "skills"
    available = {
        entry.name: entry
        for entry in sorted(source_root.iterdir())
        if entry.is_dir() and (entry / "SKILL.md").is_file()
    }
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("names", nargs="*", help="Names of skills to install")
    parser.add_argument("--list", action="store_true", help="List available skills")
    parser.add_argument(
        "--target", type=Path, default=Path.home() / ".agents" / "skills",
        help="Destination directory (default: ~/.agents/skills)",
    )
    args = parser.parse_args()
    if args.list:
        print("\n".join(available))
        return 0
    if not args.names:
        parser.error("select at least one skill, or use --list")

    names = list(dict.fromkeys(args.names))
    unknown = [name for name in names if name not in available]
    if unknown:
        parser.error("unknown skills: " + ", ".join(unknown))

    target = args.target.expanduser().resolve()
    pending = []
    existing = []
    conflicts = []
    for name in names:
        source = available[name].resolve()
        destination = target / name
        if destination.is_symlink() and destination.resolve() == source:
            existing.append(destination)
        elif destination.exists() or destination.is_symlink():
            conflicts.append(destination)
        else:
            pending.append((source, destination))

    if conflicts:
        for path in conflicts:
            print(f"Conflict: {path}", file=sys.stderr)
        print("Nothing installed. Back up or relocate conflicting entries first.", file=sys.stderr)
        return 1

    target.mkdir(parents=True, exist_ok=True)
    for source, destination in pending:
        destination.symlink_to(source, target_is_directory=True)
        print(f"Installed: {destination} -> {source}")
    for destination in existing:
        print(f"Already installed: {destination}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, RuntimeError) as error:
        print(f"Installation failed: {error}", file=sys.stderr)
        sys.exit(1)
