# -*- coding: utf-8 -*-
"""excel_service 单元测试基线。

覆盖回归风险最高的纯逻辑与写回路径：
- 表头归一化 / 模糊打分 / 表头行定位
- 字段列贪心分配（预期结果 vs 测试结果 等易混列）
- 结果列识别（多轮次列、排除结果备注）
- Sheet 分类与真实用例行判定
- update_case 行指纹校验 / 轮次列定向写回
- add_result_column / clear_result_column（含回退口径）
- make_backup 保留策略
- _effective_result_col 回退口径单源（#7）
- parse_workbook (mtime,size) 缓存命中与失效（#6①）
- 写接口 fileName 会话隔离 409（#4，走 Flask test_client）

运行：python -m unittest discover tests
夹具全部用 openpyxl 现场生成微型 xlsx，不依赖真实用例文件。
"""
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import openpyxl

import excel_service as es


def _make_functional_sheet(wb, name="功能页", extra_result_cols=(),
                           rows=()):
    """建一个最小功能页：标题行 + 表头行 + 用例行。

    rows: [(编号, 标题, 步骤, 预期, 结果)]
    extra_result_cols: 追加的轮次列表头名（如 rc2测试结果）
    """
    ws = wb.create_sheet(name)
    ws.cell(row=1, column=1, value="%s 用例集" % name)  # 标题行（非表头）
    headers = ["用例编号", "用例标题", "测试步骤", "预期结果", "测试结果", "备注"]
    headers += list(extra_result_cols)
    for c, h in enumerate(headers, 1):
        ws.cell(row=2, column=c, value=h)
    for r, row in enumerate(rows, 3):
        for c, v in enumerate(row, 1):
            if v:
                ws.cell(row=r, column=c, value=v)
    return ws


class TestHeaderMatching(unittest.TestCase):
    """表头归一化与打分：识别机制的地基。"""

    def test_norm_header_strips_star_space_case(self):
        self.assertEqual(es._norm_header(" 测试步骤* "), "测试步骤")
        self.assertEqual(es._norm_header("Case ID"), "case id")

    def test_field_score_exact_hit(self):
        self.assertEqual(es._field_score("测试结果", "result"), 1.0)

    def test_field_score_round_variant_hits_result(self):
        # 轮次列变体靠双向包含命中，是多轮次机制的前提
        score = es._field_score(es._norm_header("rc2测试结果"), "result")
        self.assertGreaterEqual(score, es._MATCH_THRESHOLD)

    def test_field_score_unrelated_miss(self):
        self.assertLess(es._field_score("前置条件", "result"),
                        es._MATCH_THRESHOLD)


class TestColumnResolution(unittest.TestCase):
    """列分配：同名歧义列必须归属正确字段。"""

    def setUp(self):
        self.wb = openpyxl.Workbook()
        self.wb.remove(self.wb.active)

    def test_find_header_row_prefers_densest_row(self):
        ws = _make_functional_sheet(self.wb, rows=[("1", "t", "s", "e", "")])
        self.assertEqual(es._find_header_row(ws), 2)

    def test_find_header_row_empty_sheet_returns_none(self):
        ws = self.wb.create_sheet("空页")
        self.assertIsNone(es._find_header_row(ws))

    def test_expected_vs_result_not_confused(self):
        # "预期结果"对 result 也有包含分，但 expected 精确分更高应胜出
        ws = _make_functional_sheet(self.wb)
        cols = es._resolve_columns(ws, 2)
        self.assertEqual(cols["expected"], 4)
        self.assertEqual(cols["result"], 5)

    def test_result_columns_multi_round(self):
        ws = _make_functional_sheet(self.wb, extra_result_cols=("rc2测试结果",))
        cols = es._resolve_columns(ws, 2)
        rc = es._result_columns(ws, 2, cols)
        self.assertEqual([h for _, h in rc], ["测试结果", "rc2测试结果"])

    def test_result_columns_excludes_note_variant(self):
        # "结果备注"是 note 别名，不得被当成结果列（否则清除/统计会殃及备注）
        ws = self.wb.create_sheet("s")
        for c, h in enumerate(["用例编号", "用例标题", "预期结果",
                               "测试结果", "结果备注"], 1):
            ws.cell(row=1, column=c, value=h)
        cols = es._resolve_columns(ws, 1)
        rc = es._result_columns(ws, 1, cols)
        self.assertEqual([h for _, h in rc], ["测试结果"])


class TestSheetClassify(unittest.TestCase):
    def setUp(self):
        self.wb = openpyxl.Workbook()
        self.wb.remove(self.wb.active)

    def test_functional_sheet(self):
        ws = _make_functional_sheet(self.wb)
        self.assertEqual(es.classify_sheet(ws)["kind"], "functional")

    def test_scenario_sheet(self):
        ws = self.wb.create_sheet("场景页")
        for c, h in enumerate(["用例编号", "场景名称", "预期结果", "测试结果"], 1):
            ws.cell(row=1, column=c, value=h)
        self.assertEqual(es.classify_sheet(ws)["kind"], "scenario")

    def test_headerless_sheet_is_info(self):
        ws = self.wb.create_sheet("说明")
        ws.cell(row=1, column=1, value="仅一段说明文字")
        self.assertEqual(es.classify_sheet(ws)["kind"], "info")

    def test_is_real_case_skips_group_row(self):
        ws = _make_functional_sheet(self.wb, rows=[
            ("", "一、登录模块", "", "", ""),        # 分组标题行
            ("TC1", "正常登录", "输入账号", "登录成功", ""),
        ])
        meta = es.classify_sheet(ws)
        self.assertFalse(es._is_real_case(ws, 3, meta["columns"], meta["kind"]))
        self.assertTrue(es._is_real_case(ws, 4, meta["columns"], meta["kind"]))


class TestWriteback(unittest.TestCase):
    """写回路径：在临时文件上验证落盘行为与防护。"""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.path = os.path.join(self.tmp, "t.xlsx")
        wb = openpyxl.Workbook()
        wb.remove(wb.active)
        _make_functional_sheet(wb, "功能A", extra_result_cols=("rc2测试结果",),
                               rows=[
            ("TC1", "用例一", "步骤", "预期", ""),
            ("TC2", "用例二", "步骤", "预期", "PASS"),
        ])
        _make_functional_sheet(wb, "功能B", rows=[
            ("TB1", "用例三", "步骤", "预期", "FAIL"),
        ])
        wb.save(self.path)
        wb.close()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _cell(self, sheet, row, col):
        wb = openpyxl.load_workbook(self.path)
        try:
            return es._cell_str(wb[sheet].cell(row=row, column=col).value)
        finally:
            wb.close()

    def test_update_case_writes_result(self):
        es.update_case(self.path, "功能A", 3, {"result": "PASS"},
                       expected_name="TC1")
        self.assertEqual(self._cell("功能A", 3, 5), "PASS")

    def test_update_case_rejects_moved_row(self):
        # 行指纹校验：页面所见与目标行不符必须拒写，防串行
        with self.assertRaises(ValueError):
            es.update_case(self.path, "功能A", 3, {"result": "PASS"},
                           expected_name="TC999")

    def test_update_case_targets_round_column(self):
        es.update_case(self.path, "功能A", 3, {"result": "NA"},
                       expected_name="TC1", result_column="rc2测试结果")
        self.assertEqual(self._cell("功能A", 3, 7), "NA")   # rc2 列
        self.assertEqual(self._cell("功能A", 3, 5), "")     # 主结果列不动

    def test_add_result_column_validates_name(self):
        with self.assertRaises(ValueError):
            es.add_result_column(self.path, "第二轮")  # 未含结果类关键词
        with self.assertRaises(ValueError):
            es.add_result_column(self.path, "rc2测试结果")  # 与现有列重名

    def test_add_result_column_appends_to_all_case_sheets(self):
        es.add_result_column(self.path, "rc3测试结果")
        wb = openpyxl.load_workbook(self.path)
        try:
            for name in ("功能A", "功能B"):
                headers = [es._cell_str(c.value) for c in wb[name][2]]
                self.assertIn("rc3测试结果", headers)
        finally:
            wb.close()

    def test_clear_result_column_with_fallback(self):
        # 功能A 的 rc2 列录 1 条；功能B 无 rc2 列，应回退清其主结果列
        es.update_case(self.path, "功能A", 3, {"result": "PASS"},
                       result_column="rc2测试结果")
        res = es.clear_result_column(self.path, "rc2测试结果")
        self.assertEqual(res["cleared"], 2)  # A:rc2 1 条 + B:主列 1 条
        self.assertEqual(self._cell("功能A", 3, 7), "")
        self.assertEqual(self._cell("功能B", 3, 5), "")
        # 功能A 主结果列（TC2 的 PASS）与备注列均不受影响
        self.assertEqual(self._cell("功能A", 4, 5), "PASS")

    def test_clear_result_column_empty_is_noop(self):
        es.clear_result_column(self.path, "测试结果")
        res = es.clear_result_column(self.path, "测试结果")
        self.assertEqual(res["cleared"], 0)


class TestBackupPrune(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.backup_dir = os.path.join(self.tmp, "backups")
        self.src = os.path.join(self.tmp, "报告.xlsx")
        wb = openpyxl.Workbook()
        wb.save(self.src)
        wb.close()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_keeps_recent_and_spares_prefix_sibling(self):
        os.makedirs(self.backup_dir)
        # 同源旧备份 12 份 + 一个"互为前缀"的近邻源备份（不得误删）
        for i in range(12):
            open(os.path.join(
                self.backup_dir,
                "backup_报告_20260101_%06d.xlsx" % i), "w").close()
        sibling = os.path.join(
            self.backup_dir, "backup_报告_v2_20260101_000000.xlsx")
        open(sibling, "w").close()

        es.make_backup(self.src, self.backup_dir)

        same = [f for f in os.listdir(self.backup_dir)
                if f.startswith("backup_报告_2") and "_v2_" not in f]
        self.assertEqual(len(same), es._BACKUP_KEEP)
        self.assertTrue(os.path.exists(sibling))


class TestEffectiveResultCol(unittest.TestCase):
    """轮次结果列回退解析唯一口径（#7 单源化）。"""

    COLS = [(5, "测试结果"), (7, "rc2测试结果")]

    def test_match_returns_named_column(self):
        self.assertEqual(es._effective_result_col(self.COLS, "rc2测试结果"),
                         (7, "rc2测试结果"))

    def test_miss_falls_back_to_first(self):
        # 与前端 effectiveColFor 一致：未匹配回退首列而非主列
        self.assertEqual(es._effective_result_col(self.COLS, "rc9测试结果"),
                         (5, "测试结果"))
        self.assertEqual(es._effective_result_col(self.COLS, ""),
                         (5, "测试结果"))

    def test_empty_returns_none(self):
        self.assertIsNone(es._effective_result_col([], "测试结果"))


class TestParseCache(unittest.TestCase):
    """parse_workbook (mtime, size) 缓存：命中不重解析、写回后自动失效。"""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.path = os.path.join(self.tmp, "c.xlsx")
        wb = openpyxl.Workbook()
        wb.remove(wb.active)
        _make_functional_sheet(wb, "功能A", rows=[
            ("TC1", "用例一", "步骤", "预期", ""),
        ])
        wb.save(self.path)
        wb.close()

    def tearDown(self):
        es._parse_cache.clear()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_second_parse_hits_cache(self):
        p1, _ = es.parse_workbook(self.path)
        key = os.path.abspath(self.path)
        self.assertIn(key, es._parse_cache)
        cached_payload = es._parse_cache[key][1]
        p2, changed = es.parse_workbook(self.path)
        self.assertFalse(changed)
        # 命中时返回的是缓存对象的顶层拷贝（同一嵌套引用、不同外层 dict）
        self.assertIsNot(p2, cached_payload)
        self.assertIs(p2["cases"], cached_payload["cases"])

    def test_write_invalidates_cache(self):
        p1, _ = es.parse_workbook(self.path)
        self.assertEqual(p1["progress"]["done"], 0)
        es.update_case(self.path, "功能A", 3, {"result": "PASS"},
                       expected_name="TC1")
        p2, _ = es.parse_workbook(self.path)
        self.assertEqual(p2["progress"]["done"], 1)

    def test_toplevel_copy_protects_cache(self):
        # 调用方在负载上补 fileName 等顶层键，不得污染缓存
        p1, _ = es.parse_workbook(self.path)
        p1["fileName"] = "x.xlsx"
        p2, _ = es.parse_workbook(self.path)
        self.assertNotIn("fileName", p2)


class TestSessionIsolation(unittest.TestCase):
    """#4 会话隔离：写接口 fileName 与当前工作文件不符时返回 409。"""

    def setUp(self):
        import app as app_module
        self.app_module = app_module
        self.tmp = tempfile.mkdtemp()
        self.path = os.path.join(self.tmp, "当前文件.xlsx")
        wb = openpyxl.Workbook()
        wb.remove(wb.active)
        _make_functional_sheet(wb, "功能A", rows=[
            ("TC1", "用例一", "步骤", "预期", "PASS"),
        ])
        wb.save(self.path)
        wb.close()
        self._saved_state = dict(app_module.STATE)
        self._saved_backup_dir = app_module.BACKUP_DIR
        app_module.STATE["current_path"] = self.path
        app_module.BACKUP_DIR = os.path.join(self.tmp, "backups")
        self.client = app_module.app.test_client()

    def tearDown(self):
        self.app_module.STATE.update(self._saved_state)
        self.app_module.BACKUP_DIR = self._saved_backup_dir
        es._parse_cache.clear()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_patch_with_stale_filename_conflicts(self):
        r = self.client.patch("/api/cases", json={
            "sheet": "功能A", "rowIndex": 3, "result": "FAIL",
            "fileName": "别的文件.xlsx"})
        self.assertEqual(r.status_code, 409)
        self.assertTrue(r.get_json().get("conflict"))

    def test_clear_with_stale_filename_conflicts(self):
        r = self.client.post("/api/results/clear", json={
            "resultColumn": "", "fileName": "别的文件.xlsx"})
        self.assertEqual(r.status_code, 409)

    def test_matching_filename_passes(self):
        r = self.client.post("/api/results/clear", json={
            "resultColumn": "", "fileName": "当前文件.xlsx"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.get_json()["cleared"], 1)

    def test_missing_filename_allowed_for_compat(self):
        # 旧页面不带 fileName：放行（与 expectedName 可选校验同模式）
        r = self.client.patch("/api/cases", json={
            "sheet": "功能A", "rowIndex": 3, "result": "NA",
            "expectedName": "TC1"})
        self.assertEqual(r.status_code, 200)


if __name__ == "__main__":
    unittest.main()
