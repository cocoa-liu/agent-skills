#!/usr/bin/env python3
"""Collect every changed PR file and stable, independently markable diff lines."""

import difflib
import hashlib
import json
import os
import subprocess
from pathlib import Path


def git(repository: Path, *arguments: str) -> bytes:
    result = subprocess.run(
        ["git", "--literal-pathspecs", "-C", str(repository), *arguments],
        capture_output=True,
        check=False,
    )
    if result.returncode:
        raise ValueError(result.stderr.decode("utf-8", errors="replace").strip())
    return result.stdout


def changed_blob(repository: Path, mode: str, object_id: str, path: str | None, working: bool) -> bytes | None:
    if mode == "000000":
        return b""
    if mode == "160000":
        return None
    if not working:
        return git(repository, "cat-file", "blob", object_id)
    location = repository / path
    # Show a symlink's target string, never the file it points to.
    if mode == "120000":
        return os.readlink(location).encode("utf-8")
    for parent in [location, *location.parents]:
        if parent == repository:
            break
        if parent.is_symlink():
            raise ValueError(f"Cannot capture a regular file through a symlink: {path}")
    return location.read_bytes()


def text_lines(content: bytes) -> list[str]:
    if b"\0" in content:
        raise UnicodeError("binary content")
    text = content.decode("utf-8")
    parts = text.split("\n")
    return [part + "\n" for part in parts[:-1]] + ([parts[-1]] if parts[-1] else [])


def build_review(repository: Path, head: str, base: str | None, working_tree: bool = False) -> dict:
    if base is None:
        return {"enabled": False, "files": []}
    revisions = [base] if working_tree else [base, head]
    raw = git(repository, "diff", "--raw", "-z", "--no-abbrev", "--find-renames", "--no-ext-diff", *revisions, "--")
    tokens = raw.split(b"\0")
    files = []
    offset = 0
    while offset < len(tokens) and tokens[offset]:
        header = tokens[offset].decode("ascii").split()
        old_mode, new_mode, old_object, new_object, status = header
        old_mode = old_mode.lstrip(":")
        first_path = tokens[offset + 1].decode("utf-8")
        offset += 2
        second_path = first_path
        if status[0] in {"R", "C"}:
            second_path = tokens[offset].decode("utf-8")
            offset += 1
        old_path = None if status[0] == "A" else first_path
        new_path = None if status[0] == "D" else second_path
        before = changed_blob(repository, old_mode, old_object, old_path, False)
        after = changed_blob(repository, new_mode, new_object, new_path, working_tree)
        before_digest = hashlib.sha256(before).hexdigest() if before is not None else old_object
        after_digest = hashlib.sha256(after).hexdigest() if after is not None else new_object
        identity = [old_path, new_path, old_mode, new_mode, before_digest, after_digest]
        file_id = hashlib.sha256(json.dumps(identity, ensure_ascii=False).encode()).hexdigest()[:24]
        record = {"id": file_id, "path": new_path or old_path, "old_path": old_path, "new_path": new_path, "status": status, "old_mode": old_mode, "new_mode": new_mode, "before_sha256": before_digest, "after_sha256": after_digest, "hunks": [], "added": 0, "deleted": 0}
        reason = ""
        if before is None or after is None:
            reason = f"子模块引用：{old_object} → {new_object}"
        else:
            try:
                old_lines, new_lines = text_lines(before), text_lines(after)
            except UnicodeError:
                reason = "二进制或非 UTF-8 内容变更；此处记录文件进度，不将内容伪装成代码行。"
            else:
                groups = difflib.SequenceMatcher(a=old_lines, b=new_lines, autojunk=False).get_grouped_opcodes(3)
                for group in groups:
                    start_old, end_old = group[0][1], group[-1][2]
                    start_new, end_new = group[0][3], group[-1][4]
                    hunk = {"header": f"@@ -{start_old + (end_old > start_old)},{end_old-start_old} +{start_new + (end_new > start_new)},{end_new-start_new} @@", "rows": []}
                    for operation, old_start, old_end, new_start, new_end in group:
                        if operation == "equal":
                            for index in range(old_end - old_start):
                                hunk["rows"].append({"kind": "context", "old": old_start+index+1, "new": new_start+index+1, "text": old_lines[old_start+index].rstrip("\r\n")})
                        else:
                            if operation in {"delete", "replace"}:
                                for index in range(old_start, old_end):
                                    line = old_lines[index]
                                    hunk["rows"].append({"id": f"{file_id}:old:{index+1}", "kind": "delete", "old": index+1, "new": None, "text": line.rstrip("\r\n"), "ending": "CRLF" if line.endswith("\r\n") else "LF" if line.endswith("\n") else "none"})
                                    record["deleted"] += 1
                            if operation in {"insert", "replace"}:
                                for index in range(new_start, new_end):
                                    line = new_lines[index]
                                    hunk["rows"].append({"id": f"{file_id}:new:{index+1}", "kind": "add", "old": None, "new": index+1, "text": line.rstrip("\r\n"), "ending": "CRLF" if line.endswith("\r\n") else "LF" if line.endswith("\n") else "none"})
                                    record["added"] += 1
                    record["hunks"].append(hunk)
        if not record["hunks"]:
            changes = []
            if old_path != new_path:
                changes.append(f"路径：{old_path or '不存在'} → {new_path or '删除'}")
            if old_mode != new_mode:
                changes.append(f"文件模式：{old_mode} → {new_mode}")
            summary = reason or "；".join(changes) or "文件元数据发生变化"
            record["notice"] = summary
            record["hunks"] = [{"header": "文件变更", "rows": [{"id": f"{file_id}:metadata", "kind": "metadata", "old": None, "new": None, "text": summary}]}]
        record["units"] = sum(1 for hunk in record["hunks"] for row in hunk["rows"] if "id" in row)
        files.append(record)
    review = {"enabled": True, "base": base, "head": head, "mode": "tracked-working-tree" if working_tree else "commit", "files": files, "total_units": sum(file["units"] for file in files)}
    review["id"] = hashlib.sha256(json.dumps(review, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    return review
