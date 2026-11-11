#!/usr/bin/env python3
"""Build an offline reading guide from authored explanations and exact Git sources."""

import argparse
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit

from review_diff import build_review, git

SKILL_ROOT = Path(__file__).resolve().parents[1]
KINDS = {"observed", "derived", "historical", "hypothesis"}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def mapping(value: object, location: str) -> dict:
    require(isinstance(value, dict), f"{location}: expected an object")
    return value


def strings(record: dict, fields: tuple[str, ...], location: str) -> None:
    for field in fields:
        value = record.get(field)
        require(isinstance(value, str) and bool(value.strip()), f"{location}.{field}: expected nonempty text")


def records(value: object, location: str) -> list:
    require(isinstance(value, list) and bool(value), f"{location}: expected a nonempty array")
    return value


def source_path(value: object) -> str:
    require(isinstance(value, str) and bool(value), "ref.path: expected a relative file path")
    path = PurePosixPath(value)
    require(
        bool(path.parts) and not path.is_absolute() and ".." not in path.parts and path.as_posix() == value
        and "\\" not in value and not any(ord(character) < 32 for character in value),
        f"Unsafe or non-normalized source path: {value!r}",
    )
    return value


def line_range(record: dict, location: str, lower: int, upper: int) -> None:
    start, end = record.get("start"), record.get("end")
    require(
        type(start) is int and type(end) is int and lower <= start <= end <= upper,
        f"{location}: line range must be within {lower}..{upper}",
    )


def validate(spec: dict) -> None:
    strings(spec, ("title",), "guide")
    for field in ("subtitle", "language", "audience", "url"):
        if field in spec:
            strings(spec, (field,), "guide")
    if "url" in spec:
        url = urlsplit(spec["url"])
        require(url.scheme in {"http", "https"} and bool(url.netloc) and not url.username and not url.password, "guide.url: expected an HTTP(S) URL without credentials")
    overview = mapping(spec.get("overview"), "overview")
    strings(overview, ("summary", "problem"), "overview")
    scenario = mapping(overview.get("scenario"), "overview.scenario")
    strings(scenario, ("input", "after", "basis"), "overview.scenario")
    require(scenario["basis"] in KINDS, "overview.scenario.basis: unknown evidence kind")
    for parent, field in ((scenario, "before"), (overview, "flow_note")):
        if field in parent:
            strings(parent, (field,), "overview")
    blocks = records(spec.get("blocks"), "blocks")
    identifiers = set()
    for index, value in enumerate(blocks):
        where = f"blocks[{index}]"
        block = mapping(value, where)
        strings(block, ("id", "title", "phase", "purpose", "caller", "input", "output"), where)
        require(bool(re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", block["id"])), f"{where}.id: use lowercase hyphenated identifiers")
        require(block["id"] not in identifiers, f"Duplicate block id: {block['id']}")
        identifiers.add(block["id"])
        strings(mapping(block.get("concept"), where + ".concept"), ("name", "example"), where + ".concept")
        for paragraph in records(block.get("explanation"), where + ".explanation"):
            require(isinstance(paragraph, str) and bool(paragraph.strip()), f"{where}.explanation: expected text paragraphs")
        for number, value in enumerate(records(block.get("refs"), where + ".refs")):
            location = f"{where}.refs[{number}]"
            reference = mapping(value, location)
            strings(reference, ("title", "purpose", "caller", "input", "output", "example", "question", "answer"), location)
            reference["path"] = source_path(reference.get("path"))
            reference.setdefault("version", "head")
            require(isinstance(reference["version"], str) and reference["version"] in {"head", "base"}, f"{location}.version: use head or base")
            line_range(reference, location, 1, 2**31)
            for step in records(reference.get("steps"), location + ".steps"):
                step = mapping(step, location + ".step")
                strings(step, ("text",), location + ".step")
                line_range(step, location + ".step", reference["start"], reference["end"])
            if "caution" in reference:
                strings(reference, ("caution",), location)
        checkpoint = mapping(block.get("checkpoint"), where + ".checkpoint")
        strings(checkpoint, ("question", "explanation", "simpler", "deeper"), where + ".checkpoint")
        choices = records(checkpoint.get("choices"), where + ".checkpoint.choices")
        require(len(choices) >= 2 and all(isinstance(choice, str) and choice.strip() for choice in choices), f"{where}.checkpoint: provide at least two textual choices")
        answer = checkpoint.get("answer")
        require(type(answer) is int and 0 <= answer < len(choices), f"{where}.checkpoint.answer: index out of range")
    for value in records(overview.get("flow"), "overview.flow"):
        node = mapping(value, "overview.flow node")
        strings(node, ("name", "role", "input", "output", "block"), "overview.flow node")
        require(node["block"] in identifiers, "overview.flow: unknown block")
    for group, fields in (
        ("trace", ("title", "block", "input", "operation", "output", "basis")),
        ("maintenance", ("symptom", "block", "check", "verification")),
        ("evidence", ("kind", "claim", "detail")),
    ):
        for value in records(spec.get(group), group):
            record = mapping(value, group)
            strings(record, fields, group)
            if "block" in record:
                require(record["block"] in identifiers, f"{group}: unknown block")
            for key in ("kind", "basis"):
                if key in record:
                    require(record[key] in KINDS, f"{group}.{key}: unknown evidence kind")
    if "limitations" in spec:
        require(isinstance(spec["limitations"], list) and all(isinstance(item, str) and item.strip() for item in spec["limitations"]), "limitations: expected an array of text")


def read_source(repository: Path, relative: str, revision: str | None) -> bytes:
    if revision is not None:
        entry = git(repository, "ls-tree", "-z", revision, "--", relative)
        require(bool(entry), f"Source missing at {revision[:12]}: {relative}")
        header, filename = entry.rstrip(b"\0").split(b"\t", 1)
        mode, kind, _ = header.split()
        require(filename.decode("utf-8") == relative and kind == b"blob" and mode in {b"100644", b"100755"}, f"Source must be a regular file, not a symlink: {relative}")
        return git(repository, "show", f"{revision}:{relative}")
    path = repository
    for part in PurePosixPath(relative).parts:
        path = path / part
        require(not path.is_symlink(), f"Source symlinks are not embedded: {relative}")
    require(path.is_file(), f"Source file missing: {relative}")
    return path.read_bytes()


def resolve_revision(repository: Path, revision: str) -> str:
    return git(repository, "rev-parse", "--verify", "--end-of-options", revision + "^{commit}").decode().strip()


def protect_output(repository: Path, output: Path, specification: Path) -> None:
    require(output != specification, "Output cannot overwrite the input specification")
    require(not output.is_symlink(), f"Output must not be a symlink: {output}")
    try:
        relative = output.relative_to(repository).as_posix()
    except ValueError:
        return
    require(not git(repository, "ls-files", "-z", "--", relative), f"Refusing to overwrite a tracked file: {relative}; generate outside the repository and review before copying")


def build(repository: Path, specification: Path, output: Path, revision: str = "HEAD", base: str | None = None, working_tree: bool = False) -> dict:
    repository = Path(git(repository, "rev-parse", "--show-toplevel").decode().strip()).resolve()
    specification = specification.resolve()
    # Resolve the parent, keeping a final symlink visible for the output guard.
    output = output.parent.resolve() / output.name
    manifest_path = output.with_suffix(output.suffix + ".manifest.json")
    for target in (output, manifest_path):
        protect_output(repository, target, specification)
    require(output.suffix.lower() == ".html", "Output must end in .html")
    spec = mapping(json.loads(specification.read_text(encoding="utf-8")), "guide")
    validate(spec)
    head = resolve_revision(repository, revision)
    baseline = resolve_revision(repository, base) if base else None
    if working_tree:
        require(head == resolve_revision(repository, "HEAD"), "Working-tree mode must be associated with the current HEAD")
    sources = {}
    for block in spec["blocks"]:
        for reference in block["refs"]:
            version, relative = reference["version"], reference["path"]
            require(version != "base" or baseline is not None, "A base reference requires --base")
            key = f"{version}:{relative}"
            reference["source"] = key
            if key not in sources:
                commit = baseline if version == "base" else (None if working_tree else head)
                content = read_source(repository, relative, commit)
                require(b"\0" not in content, f"Binary source is not supported: {relative}")
                lines = content.decode("utf-8").splitlines()
                sources[key] = {"path": relative, "version": version, "revision": commit or "working-tree", "sha256": hashlib.sha256(content).hexdigest(), "lines": lines}
            line_range(reference, relative, 1, len(sources[key]["lines"]))
    snapshot = {"head": head, "base": baseline, "mode": "working-tree" if working_tree else "commit"}
    payload = {**spec, "snapshot": snapshot, "sources": sources}
    fingerprint = hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    payload["fingerprint"] = fingerprint
    payload["review"] = build_review(repository, head, baseline, working_tree)
    payload["built_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    encoded = json.dumps(payload, ensure_ascii=False).replace("&", "\\u0026").replace("<", "\\u003c").replace(">", "\\u003e").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    template = (SKILL_ROOT / "assets/guide.html").read_text(encoding="utf-8")
    require(template.count("__GUIDE_DATA__") == 1, "Template must contain one payload placeholder")
    document = template.replace("__GUIDE_DATA__", encoded)
    for marker, filename in (("__REVIEW_CSS__", "review.css"), ("__REVIEW_SYNTAX__", "highlight.min.js"), ("__REVIEW_JS__", "review.js")):
        require(document.count(marker) == 1, f"Template must contain one {marker}")
        document = document.replace(marker, (SKILL_ROOT / "assets" / filename).read_text(encoding="utf-8"))
    manifest = {"title": spec["title"], "snapshot": snapshot, "fingerprint": fingerprint, "built_at": payload["built_at"], "html_sha256": hashlib.sha256(document.encode()).hexdigest(), "review_id": payload["review"].get("id"), "review_files": len(payload["review"]["files"]), "review_units": payload["review"].get("total_units", 0), "blocks": len(spec["blocks"]), "references": sum(len(block["refs"]) for block in spec["blocks"]), "sources": {key: {name: value for name, value in source.items() if name != "lines"} for key, source in sources.items()}}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(document, encoding="utf-8")
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {"output": str(output), "manifest": str(manifest_path), "blocks": manifest["blocks"], "references": manifest["references"], "fingerprint": fingerprint}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--spec", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--revision", default="HEAD")
    parser.add_argument("--base")
    parser.add_argument("--working-tree", action="store_true")
    arguments = parser.parse_args()
    try:
        report = build(arguments.repo, arguments.spec, arguments.output, arguments.revision, arguments.base, arguments.working_tree)
    except (ValueError, OSError, UnicodeError) as error:
        parser.exit(1, f"Cannot build guide: {error}\n")
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
