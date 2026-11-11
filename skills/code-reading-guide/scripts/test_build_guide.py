#!/usr/bin/env python3
"""Test snapshot integrity and generate a small independent browser-test fixture."""

import argparse
import copy
import json
import re
import runpy
import tempfile
import unittest
from pathlib import Path

from build_guide import build, git


NEW_SOURCE = '''def total(price_cents: int, quantity: int, discount_cents: int) -> int:
    subtotal = price_cents * quantity
    return subtotal - discount_cents


def submit_order(price_cents: int, quantity: int, discount_cents: int) -> dict:
    return {"total_cents": total(price_cents, quantity, discount_cents)}
'''


def make_fixture(folder: Path) -> tuple[Path, Path, str]:
    repository = folder / "repository"
    repository.mkdir(parents=True)
    git(repository, "init", "-q")
    source = repository / "orders.py"
    source.write_text(NEW_SOURCE.replace("return subtotal - discount_cents", "return subtotal"))
    git(repository, "add", "orders.py")
    git(repository, "-c", "user.name=Guide Test", "-c", "user.email=guide@example.invalid", "commit", "-qm", "Initial order calculator")
    baseline = git(repository, "rev-parse", "HEAD").decode().strip()
    source.write_text(NEW_SOURCE)
    git(repository, "add", "orders.py")
    git(repository, "-c", "user.name=Guide Test", "-c", "user.email=guide@example.invalid", "commit", "-qm", "Apply order discount")
    references = [
        {"path": "orders.py", "start": 6, "end": 7, "title": "接收输入并调用金额计算", "purpose": "将金额规则交给 total，入口负责包装响应。", "caller": "订单提交的调用者执行 submit_order。", "input": "单价 1200 分，数量 3，优惠 250 分", "output": "一个带 total_cents 字段的字典", "example": "submit_order(1200, 3, 250) → {total_cents: 3350}", "steps": [{"start": 6, "end": 6, "text": "入口接收三个明确的业务参数；类型标注说明约定，函数没有自行校验类型。"}, {"start": 7, "end": 7, "text": "先调用 total 取得整数金额，再把结果放入响应字典。这条调用把入口连接到计算逻辑。"}], "question": "哪一行真正触发金额计算？", "answer": "第 7 行的 total(...) 调用；函数定义本身不会计算订单。"},
        {"path": "orders.py", "start": 1, "end": 3, "title": "在商品小计上应用整单折扣", "purpose": "将价格和数量换算为小计，再扣除一次订单级优惠。", "caller": "submit_order() 在包装响应前调用。", "input": "price_cents=1200, quantity=3, discount_cents=250", "output": "3350 分", "example": "1200 × 3 = 3600；3600 − 250 = 3350。", "steps": [{"start": 1, "end": 2, "text": "金额使用整数分；数量是计数。两者相乘得到商品小计，单位仍是分。"}, {"start": 3, "end": 3, "text": "整单只减一次折扣。它没有乘 quantity，所以不是逐件优惠。"}], "caution": "本函数未阻止折扣大于商品小计；负金额是否合法需要业务规则支持，不能推测。", "question": "数量变成 4，折扣会自动变成 1000 分吗？", "answer": "不会；当前参数是整单折扣，总额为 1200 × 4 − 250 = 4550 分。"},
    ]
    old_reference = copy.deepcopy(references[1])
    old_reference.update(version="base", title="旧版：只返回商品小计", purpose="用于确认改动前确实没有应用折扣。", output="3600 分", example="旧版 1200 × 3 = 3600，discount_cents 没有参与返回值。", question="旧版哪一步使用了 discount_cents？", answer="没有。它虽然接收参数，但返回值没有减去折扣。", caution="这是 base 版本的行为，不是当前实现。")
    old_reference["steps"][-1]["text"] = "旧版直接返回 subtotal；与新版对照可见，新增行为是减去一次折扣。"
    spec = {"title": "订单金额 PR：从一次调用读懂折扣", "subtitle": "先建立调用轮廓，再逐块解释；这是独立的小型示例。", "audience": "会写 Python，希望能独立解释和维护这段实现", "overview": {"summary": "提交入口调用金额函数，再将金额包装成响应。", "problem": "旧版接收折扣参数却没有用于金额计算。", "scenario": {"input": "单价 1200 分 × 3 件，整单优惠 250 分", "before": "返回 3600 分。", "after": "返回 {total_cents: 3350}。", "basis": "derived"}, "flow_note": "执行顺序是 submit_order → total → 返回 submit_order；数据流最后回到入口完成包装。", "flow": [{"name": "接收订单", "role": "建立调用入口", "input": "单价、数量、折扣", "output": "传给计算函数的参数", "block": "entry"}, {"name": "计算金额", "role": "应用整单折扣", "input": "1200、3、250", "output": "3350 分", "block": "total"}, {"name": "返回响应", "role": "对调用者暴露结果", "input": "3350 分", "output": "{total_cents: 3350}", "block": "entry"}]}, "blocks": [], "trace": [{"title": "进入提交函数", "block": "entry", "input": "1200、3、250", "operation": "submit_order 调用 total", "output": "三个参数保持不变", "basis": "derived"}, {"title": "应用一次优惠", "block": "total", "input": "1200、3、250", "operation": "1200 × 3 − 250", "output": "3350 分", "basis": "derived"}, {"title": "返回结果", "block": "entry", "input": "3350 分", "operation": "包装进字典", "output": "{total_cents: 3350}", "basis": "derived"}], "maintenance": [{"symptom": "优惠金额不正确", "block": "total", "check": "先核对金额单位和折扣的作用层级，再比较新旧返回值。", "verification": "用无折扣、多件、零数量和优惠超过小计的例子核对业务约定。"}], "evidence": [{"kind": "derived", "claim": "示例订单返回 3350 分", "detail": "按固定源码中的整数公式推导，没有调用支付系统。"}], "limitations": ["这是教学用的小型仓库，不包含输入校验和真实支付流程。"]}
    for identifier, title, purpose, reference, answer in [
        ("entry", "先找到真实调用入口", "接收参数，调用规则，再包装结果。", references[0], 1),
        ("total", "计算小计，再减整单折扣", "解释新旧行为差异以及货币单位。", references[1], 0),
    ]:
        spec["blocks"].append({"id": identifier, "title": title, "phase": "每笔订单", "purpose": purpose, "caller": reference["caller"], "input": reference["input"], "output": reference["output"], "concept": {"name": "调用与返回" if identifier == "entry" else "整数货币单位", "example": "A 先调用 B(2)，B 返回 4，A 再包装 {result: 4}。" if identifier == "entry" else "12 元记作 1200 分；不要把 2 元折扣直接当成 2 分。"}, "explanation": [purpose, "先对照调用关系与输入输出，再展开下面的源码。"], "refs": [reference] if identifier == "entry" else [reference, old_reference], "checkpoint": {"question": "金额规则在哪个函数执行？" if identifier == "entry" else "数量改成 4，总金额是多少分？", "choices": ["定义函数时", "调用 total 时", "字典打印时"] if identifier == "entry" else ["4550", "3800", "4800"], "answer": answer, "explanation": "表达式调用 total 后取得结果，再由入口返回字典。" if identifier == "entry" else "1200 × 4 − 250 = 4550，折扣只扣一次。", "simpler": "先看 f() 调用 g(2)，只有执行调用表达式才会进入 g。" if identifier == "entry" else "两件各 10 分、整单优惠 3 分：10 × 2 − 3 = 17。", "deeper": "维护时先确认规则属于哪个函数，再针对它选择边界测试。"}})
    specification = folder / "guide.json"
    specification.write_text(json.dumps(spec, ensure_ascii=False, indent=2))
    return repository, specification, baseline


def payload(output: Path) -> dict:
    match = re.search(r'<script id="guide-data" type="application/json">(.*?)</script>', output.read_text(), re.S)
    return json.loads(match[1])


class BuildGuideTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.folder = Path(self.temporary.name)
        self.repository, self.specification, self.base = make_fixture(self.folder)
        self.output = self.folder / "guide.html"

    def run_build(self, **arguments: object) -> dict:
        return build(self.repository, self.specification, self.output, base=self.base, **arguments)

    def test_head_and_base_are_read_from_commits(self) -> None:
        (self.repository / "orders.py").write_text("uncommitted changes\n")
        report = self.run_build()
        document = payload(self.output)
        self.assertEqual(report["references"], 3)
        self.assertEqual(document["sources"]["head:orders.py"]["lines"][2], "    return subtotal - discount_cents")
        self.assertEqual(document["sources"]["base:orders.py"]["lines"][2], "    return subtotal")
        self.assertTrue(Path(report["manifest"]).exists())

    def test_working_tree_changes_content_and_progress_fingerprint(self) -> None:
        first = self.run_build()
        (self.repository / "orders.py").write_text(NEW_SOURCE.replace("return subtotal - discount_cents", "return max(0, subtotal - discount_cents)"))
        second = self.run_build(working_tree=True)
        self.assertNotEqual(first["fingerprint"], second["fingerprint"])
        self.assertEqual(payload(self.output)["snapshot"]["mode"], "working-tree")
        self.assertIn("max(0", payload(self.output)["sources"]["head:orders.py"]["lines"][2])
        self.assertEqual(second["fingerprint"], self.run_build(working_tree=True)["fingerprint"])

    def test_review_identity_survives_teaching_changes_but_not_code_changes(self) -> None:
        self.run_build()
        original = payload(self.output)
        spec = json.loads(self.specification.read_text())
        spec["title"] = "改进后的讲解标题"
        self.specification.write_text(json.dumps(spec))
        self.run_build()
        updated = payload(self.output)
        self.assertNotEqual(original["fingerprint"], updated["fingerprint"])
        self.assertEqual(original["review"]["id"], updated["review"]["id"])
        (self.repository / "orders.py").write_text(NEW_SOURCE.replace("return subtotal - discount_cents", "return max(0, subtotal - discount_cents)"))
        self.run_build(working_tree=True)
        self.assertNotEqual(updated["review"]["id"], payload(self.output)["review"]["id"])

    def test_review_includes_files_outside_the_authored_reading_blocks(self) -> None:
        for name in ("deleted.txt", "renamed.txt", "mode.sh"):
            (self.repository / name).write_text(f"unchanged contents of {name}\n")
        (self.repository / "ending.txt").write_text("same text\n")
        (self.repository / "link").symlink_to("old-target")
        git(self.repository, "add", ".")
        git(self.repository, "-c", "user.name=Guide Test", "-c", "user.email=guide@example.invalid", "commit", "-qm", "Additional old files")
        self.base = git(self.repository, "rev-parse", "HEAD").decode().strip()
        git(self.repository, "rm", "deleted.txt")
        git(self.repository, "mv", "renamed.txt", "renamed [new].txt")
        (self.repository / "mode.sh").chmod(0o755)
        (self.repository / "ending.txt").write_text("same text")
        (self.repository / "[中文] file.py").write_text("value = 42\n")
        (self.repository / "empty.txt").touch()
        (self.repository / "binary.bin").write_bytes(b"\0\xff\x01")
        (self.repository / "link").unlink()
        (self.repository / "link").symlink_to("/never/read/external/contents")
        git(self.repository, "add", ".")
        git(self.repository, "-c", "user.name=Guide Test", "-c", "user.email=guide@example.invalid", "commit", "-qm", "Mixed PR file changes")
        self.run_build()
        review = payload(self.output)["review"]
        files = {file["path"]: file for file in review["files"]}
        expected = {path.decode() for path in git(self.repository, "diff", "--name-only", "-z", "--find-renames", self.base, "HEAD").split(b"\0") if path}
        self.assertEqual(set(files), expected)
        self.assertEqual(len(files), 8)
        self.assertEqual(files["renamed [new].txt"]["old_path"], "renamed.txt")
        self.assertEqual(files["mode.sh"]["units"], 1)
        self.assertEqual(files["empty.txt"]["units"], 1)
        self.assertIn("二进制", files["binary.bin"]["notice"])
        ending_rows = files["ending.txt"]["hunks"][0]["rows"]
        self.assertEqual([row["ending"] for row in ending_rows], ["LF", "none"])
        self.assertEqual(files["deleted.txt"]["deleted"], 1)
        link_rows = files["link"]["hunks"][0]["rows"]
        self.assertEqual(link_rows[-1]["text"], "/never/read/external/contents")
        units = [row["id"] for file in files.values() for hunk in file["hunks"] for row in hunk["rows"] if "id" in row]
        self.assertEqual(len(units), len(set(units)))
        self.assertEqual(len(units), review["total_units"])

    def test_review_rows_have_exact_old_and_new_line_numbers(self) -> None:
        self.run_build()
        document = payload(self.output)
        review = document["review"]
        self.assertEqual(len(review["files"]), 1)
        changed = [row for hunk in review["files"][0]["hunks"] for row in hunk["rows"] if "id" in row]
        self.assertEqual(len(changed), 2)
        for row in changed:
            side, number = ("base", row["old"]) if row["kind"] == "delete" else ("head", row["new"])
            self.assertEqual(number, 3)
            self.assertEqual(row["text"], document["sources"][side + ":orders.py"]["lines"][number-1])

    def test_working_tree_review_uses_actual_tracked_contents(self) -> None:
        (self.repository / "orders.py").write_text(NEW_SOURCE.replace("return subtotal - discount_cents", "return subtotal - 2 * discount_cents"))
        (self.repository / "untracked-secret.txt").write_text("not in the tracked PR diff")
        self.run_build(working_tree=True)
        review = payload(self.output)["review"]
        self.assertEqual(review["mode"], "tracked-working-tree")
        self.assertEqual([file["path"] for file in review["files"]], ["orders.py"])
        added = [row["text"] for hunk in review["files"][0]["hunks"] for row in hunk["rows"] if row["kind"] == "add"]
        self.assertEqual(added, ["    return subtotal - 2 * discount_cents"])

    def test_bracketed_route_filenames_are_literal(self) -> None:
        git(self.repository, "mv", "orders.py", "[order].py")
        git(self.repository, "-c", "user.name=Guide Test", "-c", "user.email=guide@example.invalid", "commit", "-qm", "Use a route-style filename")
        spec = json.loads(self.specification.read_text())
        for block in spec["blocks"]:
            for reference in block["refs"]:
                if reference.get("version", "head") == "head":
                    reference["path"] = "[order].py"
        self.specification.write_text(json.dumps(spec))
        self.run_build()
        self.assertEqual(payload(self.output)["sources"]["head:[order].py"]["lines"][2], "    return subtotal - discount_cents")

    def test_example_executes_the_documented_end_to_end_result(self) -> None:
        namespace = runpy.run_path(str(self.repository / "orders.py"))
        self.assertEqual(namespace["submit_order"](1200, 3, 250), {"total_cents": 3350})

    def test_rejects_invalid_references_and_missing_explanations(self) -> None:
        original = json.loads(self.specification.read_text())
        for field, invalid in [("path", "../outside.py"), ("path", "/etc/passwd"), ("end", 9999), ("purpose", ""), ("start", True)]:
            with self.subTest(field=field, invalid=invalid):
                spec = copy.deepcopy(original)
                spec["blocks"][0]["refs"][0][field] = invalid
                self.specification.write_text(json.dumps(spec))
                with self.assertRaises(ValueError):
                    self.run_build()
        self.assertFalse(self.output.exists())

    def test_rejects_broken_navigation_quizzes_and_steps(self) -> None:
        original = json.loads(self.specification.read_text())
        mutations = [lambda spec: spec["overview"]["flow"][0].update(block="missing"), lambda spec: spec["blocks"][0]["checkpoint"].update(answer=99), lambda spec: spec["blocks"][0]["refs"][0]["steps"][0].update(start=1), lambda spec: spec["blocks"][1].update(id="entry")]
        for mutate in mutations:
            spec = copy.deepcopy(original)
            mutate(spec)
            self.specification.write_text(json.dumps(spec))
            with self.assertRaises(ValueError):
                self.run_build()

    def test_requires_explicit_base_for_old_sources(self) -> None:
        with self.assertRaisesRegex(ValueError, "requires --base"):
            build(self.repository, self.specification, self.output)

    def test_does_not_overwrite_tracked_files_or_specification(self) -> None:
        for output in [self.repository / "orders.py", self.specification]:
            before = output.read_bytes()
            with self.assertRaises(ValueError):
                build(self.repository, self.specification, output, base=self.base)
            self.assertEqual(before, output.read_bytes())

    def test_rejects_working_tree_symlinks(self) -> None:
        source = self.repository / "orders.py"
        outside = self.folder / "outside.py"
        outside.write_text(NEW_SOURCE)
        source.unlink()
        source.symlink_to(outside)
        with self.assertRaisesRegex(ValueError, "symlinks"):
            self.run_build(working_tree=True)

    def test_embedded_text_cannot_end_the_data_script(self) -> None:
        injection = '</script><script>globalThis.__guideInjection = true</script>'
        spec = json.loads(self.specification.read_text())
        spec["title"] = injection
        self.specification.write_text(json.dumps(spec))
        (self.repository / "orders.py").write_text(NEW_SOURCE + "# " + injection + "\n")
        self.run_build(working_tree=True)
        self.assertNotIn(injection, self.output.read_text())
        self.assertEqual(payload(self.output)["title"], injection)
        self.assertIn(injection, payload(self.output)["sources"]["head:orders.py"]["lines"][-1])


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--demo-output", type=Path, help="Also generate an independent demo repository and HTML in a new directory")
    arguments, remaining = parser.parse_known_args()
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(BuildGuideTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if not result.wasSuccessful():
        raise SystemExit(1)
    if arguments.demo_output:
        folder = arguments.demo_output.resolve()
        folder.mkdir(parents=True, exist_ok=False)
        repository, specification, baseline = make_fixture(folder)
        print(json.dumps(build(repository, specification, folder / "guide.html", base=baseline), ensure_ascii=False))
