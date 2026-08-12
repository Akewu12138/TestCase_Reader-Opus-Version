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
- 图片惰性加载：锚点 URL 元信息 / get_sheet_image / 端点（#6②）

运行：python -m unittest discover tests
夹具全部用 openpyxl 现场生成微型 xlsx，不依赖真实用例文件。
"""
import os
import json
import shutil
import sys
import tempfile
import unittest
from io import BytesIO
from zipfile import ZipFile

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

    def test_field_score_ignores_header_separators(self):
        # Excel 表头经常包含换行、斜杠或短横线，不能因此丢失结果列映射
        result_score = es._field_score(es._norm_header("测试\n结果"), "result")
        actual_score = es._field_score(es._norm_header("实际/结果"), "actual")
        self.assertEqual(result_score, 1.0)
        self.assertEqual(actual_score, 1.0)

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

    @staticmethod
    def _cell_from(path, sheet, row, col):
        wb = openpyxl.load_workbook(path)
        try:
            return es._cell_str(wb[sheet].cell(row=row, column=col).value)
        finally:
            wb.close()

    def test_update_case_writes_result(self):
        es.update_case(self.path, "功能A", 3, {"result": "PASS"},
                       expected_name="TC1")
        self.assertEqual(self._cell("功能A", 3, 5), "PASS")

    def test_update_case_writes_fuzzy_result_and_actual_columns(self):
        # 结果列和实际结果列的轻微分隔符差异也必须落到原列，而不是新增同名列
        wb = openpyxl.Workbook()
        wb.remove(wb.active)
        ws = wb.create_sheet("模糊列")
        for col, header in enumerate(
                ["用例编号", "用例标题", "测试步骤", "预期结果", "测试-结果", "实际/结果"], 1):
            ws.cell(row=1, column=col, value=header)
        ws.cell(row=2, column=1, value="FUZZY-1")
        ws.cell(row=2, column=2, value="模糊列用例")
        ws.cell(row=2, column=3, value="执行")
        ws.cell(row=2, column=4, value="完成")
        fuzzy_path = os.path.join(self.tmp, "fuzzy.xlsx")
        wb.save(fuzzy_path)
        wb.close()

        es.update_case(fuzzy_path, "模糊列", 2,
                       {"result": "FAIL", "actual": "实际观察结果"},
                       expected_name="FUZZY-1")
        self.assertEqual(self._cell_from(fuzzy_path, "模糊列", 2, 5), "FAIL")
        self.assertEqual(self._cell_from(fuzzy_path, "模糊列", 2, 6), "实际观察结果")

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


class TestSubtaskExportEndpoint(unittest.TestCase):
    """子任务导出 HTTP 闭环：下载内容必须是可打开的 xlsx。"""

    def setUp(self):
        import app as app_module

        self.app_module = app_module
        self.tmp = tempfile.mkdtemp()
        self.path = os.path.join(self.tmp, "主报告.xlsx")
        self.export_dir = os.path.join(self.tmp, "exports")
        os.makedirs(self.export_dir, exist_ok=True)
        wb = openpyxl.Workbook()
        wb.remove(wb.active)
        _make_functional_sheet(wb, "功能页", rows=[
            ("TC1", "用例一", "步骤", "预期", ""),
        ])
        wb.save(self.path)
        wb.close()
        self._saved_state = dict(app_module.STATE)
        self._saved_tmp_dir = app_module.TMP_DIR
        app_module.STATE["current_path"] = self.path
        app_module.TMP_DIR = self.export_dir
        self.client = app_module.app.test_client()

    def tearDown(self):
        self.app_module.STATE.update(self._saved_state)
        self.app_module.TMP_DIR = self._saved_tmp_dir
        es._parse_cache.clear()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_returns_downloadable_xlsx_with_utf8_filename(self):
        response = self.client.post("/api/subtask/export", json={
            "targets": [{"sheet": "功能页", "rowIndex": 3}],
            "fileName": "主报告.xlsx",
        })

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype,
                         "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        disposition = response.headers.get("Content-Disposition", "")
        self.assertIn("filename*=UTF-8''", disposition)
        self.assertTrue(response.data.startswith(b"PK\x03\x04"))
        with ZipFile(BytesIO(response.data)) as archive:
            self.assertIn("[Content_Types].xml", archive.namelist())
        wb = openpyxl.load_workbook(BytesIO(response.data))
        try:
            self.assertEqual(wb.sheetnames, ["功能页", "_qoder_map"])
            self.assertEqual(wb["功能页"].cell(row=3, column=1).value, "TC1")
        finally:
            wb.close()
        self.assertEqual(os.listdir(self.export_dir), [])


class TestImageLazyLoading(unittest.TestCase):
    """#6② 图片惰性加载：解析只下发锚点 URL，字节由端点按需提供。"""

    def setUp(self):
        from PIL import Image as PILImage
        from openpyxl.drawing.image import Image as XLImage
        self.tmp = tempfile.mkdtemp()
        png = os.path.join(self.tmp, "p.png")
        PILImage.new("RGB", (2, 2), (255, 0, 0)).save(png)
        self.path = os.path.join(self.tmp, "img.xlsx")
        wb = openpyxl.Workbook()
        wb.remove(wb.active)
        ws = _make_functional_sheet(wb, "功能A", rows=[
            ("TC1", "用例一", "步骤", "预期", ""),
        ])
        ws.add_image(XLImage(png), "H3")
        wb.save(self.path)
        wb.close()

    def tearDown(self):
        es._parse_cache.clear()
        es._image_cache.clear()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_meta_src_is_lazy_url(self):
        wb = openpyxl.load_workbook(self.path)
        meta = es._sheet_image_meta(wb)
        wb.close()
        self.assertIn("功能A", meta)
        item = meta["功能A"][0]
        self.assertTrue(item["src"].startswith("/api/sheet-image?sheet="))
        self.assertTrue(item["src"].endswith("&idx=0"))
        self.assertEqual(item["row"], 3)  # 锚点 H3 → 第 3 行

    def test_functional_case_receives_embedded_image(self):
        # 倒车入库类文件带“用例标题”列，会被识别为 functional，图片仍应归属卡片用例
        payload, _ = es.parse_workbook(self.path)
        self.assertEqual(len(payload["cases"]), 1)
        self.assertEqual(len(payload["cases"][0]["images"]), 1)
        self.assertTrue(payload["cases"][0]["images"][0].startswith(
            "/api/sheet-image?sheet="))

    def test_get_sheet_image_returns_bytes(self):
        item = es.get_sheet_image(self.path, "功能A", 0)
        self.assertIsNotNone(item)
        data, fmt = item
        self.assertEqual(fmt, "png")
        self.assertTrue(data.startswith(b"\x89PNG"))
        # 同指纹二次请求命中缓存（对象同一）
        self.assertIs(es.get_sheet_image(self.path, "功能A", 0)[0], data)

    def test_bad_index_or_sheet_returns_none(self):
        self.assertIsNone(es.get_sheet_image(self.path, "功能A", 5))
        self.assertIsNone(es.get_sheet_image(self.path, "不存在", 0))

    def test_endpoint_serves_image(self):
        import app as app_module
        saved = dict(app_module.STATE)
        app_module.STATE["current_path"] = self.path
        try:
            client = app_module.app.test_client()
            r = client.get("/api/sheet-image?sheet=功能A&idx=0")
            self.assertEqual(r.status_code, 200)
            self.assertEqual(r.mimetype, "image/png")
            r2 = client.get("/api/sheet-image?sheet=功能A&idx=9")
            self.assertEqual(r2.status_code, 404)
        finally:
            app_module.STATE.update(saved)




class TestSimilarityAndFingerprint(unittest.TestCase):
    """子任务匹配基础：相似度阈值与身份指纹。"""

    def test_similarity_identical_is_1(self):
        self.assertEqual(es._similarity("相同标题", "相同标题"), 1.0)

    def test_similarity_threshold_hit(self):
        s = es._similarity("导航避障测试用例", "导航避障测试用例。")
        self.assertGreaterEqual(s, es._FUZZY_THRESHOLD)

    def test_similarity_miss(self):
        s = es._similarity("导航避障测试", "乘梯到达测试")
        self.assertLess(s, es._FUZZY_THRESHOLD)

    def test_similarity_empty_edges(self):
        self.assertEqual(es._similarity("", ""), 1.0)
        self.assertEqual(es._similarity("", "x"), 0.0)

    def test_fingerprint_deterministic_and_folds_whitespace(self):
        a = es._subtask_fingerprint("C1", "标题", "步骤一\n步骤二")
        b = es._subtask_fingerprint(" C1 ", " 标题 ", "步骤一  步骤二")
        self.assertEqual(a, b)
        self.assertEqual(len(a), 40)  # sha1 十六进制长度

    def test_fingerprint_differs_on_identity_change(self):
        self.assertNotEqual(
            es._subtask_fingerprint("C1", "标题", "步骤"),
            es._subtask_fingerprint("C1", "标题", "步骤改"))


def _make_full_sheet(wb, name, rows):
    """建一个带 tester/实际现象/发现时间的功能页。

    rows: [(编号, 标题, 步骤, 预期, 结果, rc2结果, 测试人员, 备注, 实际现象, 发现时间)]
    表头在第 2 行，第 1 行为标题行，与真实用例文件布局一致。
    """
    ws = wb.create_sheet(name)
    ws.cell(row=1, column=1, value="%s 用例集" % name)
    headers = ["用例编号", "用例标题", "测试步骤", "预期结果",
               "测试结果", "rc2测试结果", "测试人员", "备注",
               "实际现象", "发现时间"]
    for c, h in enumerate(headers, 1):
        ws.cell(row=2, column=c, value=h)
    for r, row in enumerate(rows, 3):
        for c, v in enumerate(row, 1):
            if v:
                ws.cell(row=r, column=c, value=v)
    return ws


class TestExportSubtask(unittest.TestCase):
    """子任务导出：结构、元数据、结果列裁剪、tester 写回。"""

    def setUp(self):
        self.wb = openpyxl.Workbook()
        self.wb.remove(self.wb.active)
        self.dir = tempfile.mkdtemp()
        self.main_path = os.path.join(self.dir, "主报告.xlsx")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def _save(self):
        self.wb.save(self.main_path)

    def test_export_basic_structure(self):
        _make_full_sheet(self.wb, "功能页", [
            ("C1", "用例一", "步骤一", "预期一", "", "", "", "", "", ""),
            ("C2", "用例二", "步骤二", "预期二", "PASS", "", "", "", "", ""),
            ("分组", "", "", "", "", "", "", "", "", ""),   # 非真实用例，应剔除
            ("C3", "用例三", "步骤三", "预期三", "", "", "", "", "", ""),
        ])
        self._save()
        sub = es.export_subtask(
            self.main_path,
            [{"sheet": "功能页", "rowIndex": 3}, {"sheet": "功能页", "rowIndex": 4},
             {"sheet": "功能页", "rowIndex": 5}, {"sheet": "功能页", "rowIndex": 6}],
            out_dir=self.dir)
        self.assertTrue(os.path.exists(sub))
        wb2 = openpyxl.load_workbook(sub)
        try:
            self.assertIn("功能页", wb2.sheetnames)
            self.assertIn("_qoder_map", wb2.sheetnames)
            ws2 = wb2["功能页"]
            headers = [ws2.cell(row=2, column=c).value
                       for c in range(1, ws2.max_column + 1)]
            # 结果类列只保留主结果列，rc2 结果列被裁剪
            self.assertIn("测试结果", headers)
            self.assertNotIn("rc2测试结果", headers)
            # 仅 3 个真实用例行，连续不留空行（分组行被剔除）
            ids = [ws2.cell(row=r, column=1).value
                   for r in range(3, ws2.max_row + 1)]
            self.assertEqual(ids, ["C1", "C2", "C3"])
            # 隐藏元数据页：行级记录 source_row 与指纹
            map_ws = wb2["_qoder_map"]
            self.assertEqual(map_ws.sheet_state, "hidden")
            self.assertEqual(map_ws.cell(row=3, column=2).value, "功能页")
            self.assertEqual(int(map_ws.cell(row=3, column=3).value), 3)
            self.assertEqual(int(map_ws.cell(row=5, column=3).value), 6)
            self.assertTrue(map_ws.cell(row=3, column=7).value)
        finally:
            wb2.close()

    def test_export_with_result_header_keeps_only_that_column(self):
        _make_full_sheet(self.wb, "功能页", [
            ("C1", "用例一", "步骤一", "预期一", "", "PASS", "", "", "", ""),
        ])
        self._save()
        sub = es.export_subtask(
            self.main_path, [{"sheet": "功能页", "rowIndex": 3}],
            result_header="rc2测试结果", out_dir=self.dir)
        wb2 = openpyxl.load_workbook(sub)
        try:
            ws2 = wb2["功能页"]
            headers = [ws2.cell(row=2, column=c).value
                       for c in range(1, ws2.max_column + 1)]
            self.assertIn("rc2测试结果", headers)
            self.assertNotIn("测试结果", headers)
            # 值也被正确复制到 rc2 列（第 6 列 -> 子文件第 5 列）
            self.assertEqual(ws2.cell(row=3, column=5).value, "PASS")
        finally:
            wb2.close()

    def test_export_tester_writes_main_and_sub(self):
        _make_full_sheet(self.wb, "功能页", [
            ("C1", "用例一", "步骤一", "预期一", "", "", "", "", "", ""),
            ("C2", "用例二", "步骤二", "预期二", "", "", "李四", "", "", ""),
        ])
        self._save()
        es.parse_workbook(self.main_path)  # 预热缓存，验证导出后缓存失效
        sub = es.export_subtask(
            self.main_path, [{"sheet": "功能页", "rowIndex": 3},
                             {"sheet": "功能页", "rowIndex": 4}],
            tester="张三", out_dir=self.dir)
        # 主文件 tester 列已写入
        payload, _ = es.parse_workbook(self.main_path)
        cases = {c["caseId"]: c for c in payload["cases"]}
        self.assertEqual(cases["C1"]["tester"], "张三")
        self.assertEqual(cases["C2"]["tester"], "张三")
        # 子文件 tester 列预填
        wb2 = openpyxl.load_workbook(sub)
        try:
            ws2 = wb2["功能页"]
            headers = [ws2.cell(row=2, column=c).value
                       for c in range(1, ws2.max_column + 1)]
            tcol = headers.index("测试人员") + 1
            self.assertEqual(ws2.cell(row=3, column=tcol).value, "张三")
            self.assertEqual(ws2.cell(row=4, column=tcol).value, "张三")
        finally:
            wb2.close()

    def test_export_empty_targets_raises(self):
        _make_full_sheet(self.wb, "功能页", [
            ("C1", "用例一", "步骤一", "预期一", "", "", "", "", "", ""),
        ])
        self._save()
        with self.assertRaises(ValueError):
            es.export_subtask(self.main_path, [], out_dir=self.dir)

    def test_export_skips_matrix_sheet(self):
        _make_full_sheet(self.wb, "功能页", [
            ("C1", "用例一", "步骤一", "预期一", "", "", "", "", "", ""),
        ])
        # 矩阵页：正文出现结果 token 的宽表
        ws = self.wb.create_sheet("结果矩阵")
        ws.cell(row=1, column=1, value="矩阵")
        ws.cell(row=2, column=1, value="条件1")
        ws.cell(row=2, column=2, value="条件2")
        ws.cell(row=3, column=1, value="PASS")
        ws.cell(row=3, column=2, value="FAIL")
        self._save()
        sub = es.export_subtask(
            self.main_path, [{"sheet": "功能页", "rowIndex": 3},
                             {"sheet": "结果矩阵", "rowIndex": 3}],
            out_dir=self.dir)
        wb2 = openpyxl.load_workbook(sub)
        try:
            self.assertIn("功能页", wb2.sheetnames)
            self.assertNotIn("结果矩阵", wb2.sheetnames)  # 矩阵行不导出
        finally:
            wb2.close()


class TestParseSubtask(unittest.TestCase):
    """合入预览：匹配链、冲突识别、警告与报错路径。"""

    def setUp(self):
        self.wb = openpyxl.Workbook()
        self.wb.remove(self.wb.active)
        self.dir = tempfile.mkdtemp()
        self.main_path = os.path.join(self.dir, "主报告.xlsx")
        _make_full_sheet(self.wb, "功能页", [
            ("C1", "导航避障测试", "步骤一", "预期一", "PASS", "", "张三", "", "旧现象", "2026-08-01 10:00:00"),
            ("C2", "乘梯到达测试", "步骤二", "预期二", "", "", "", "", "", ""),
            ("C3", "跨楼层测试", "步骤三", "预期三", "", "", "", "", "", ""),
        ])
        self.wb.save(self.main_path)
        self.sub_path = es.export_subtask(
            self.main_path,
            [{"sheet": "功能页", "rowIndex": 3},
             {"sheet": "功能页", "rowIndex": 4},
             {"sheet": "功能页", "rowIndex": 5}],
            tester="张三", out_dir=self.dir)

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def _set_sub(self, case_no, col_off, value):
        """修改子文件第 case_no 个用例行（1-based）的单元格。

        子文件表头在第 2 行，数据连续从第 3 行开始；第 5 列为测试结果，
        第 9 列为实际现象。
        """
        wb2 = openpyxl.load_workbook(self.sub_path)
        try:
            ws2 = wb2["功能页"]
            ws2.cell(row=2 + case_no, column=col_off).value = value
            wb2.save(self.sub_path)
        finally:
            wb2.close()

    def test_parse_exact_match_and_values(self):
        # C2（第 2 个用例）补结果；子文件裁剪 rc2 列后"实际现象"在第 8 列
        self._set_sub(2, 5, "FAIL")
        self._set_sub(2, 8, "新现象")
        result = es.parse_subtask_for_merge(self.main_path, self.sub_path)
        self.assertFalse(result["warning"])
        self.assertEqual(len(result["items"]), 3)
        c2 = result["items"][1]
        self.assertEqual(c2["status"], "exact")
        self.assertEqual(c2["mainRow"], 4)
        self.assertEqual(c2["sub"]["result"], "FAIL")
        self.assertEqual(c2["sub"]["actual"], "新现象")
        # 主文件现值字段已读取
        c1 = result["items"][0]
        self.assertEqual(c1["main"]["result"], "PASS")

    def test_parse_conflicts_detected(self):
        # C1（第 1 个用例）主文件已有 PASS，子文件改成 FAIL → 冲突
        self._set_sub(1, 5, "FAIL")
        result = es.parse_subtask_for_merge(self.main_path, self.sub_path)
        c1 = result["items"][0]
        self.assertIn("result", c1["conflicts"])
        self.assertIn(0, result["conflicts"])

    def test_parse_sourcefile_warning(self):
        # 主文件换名后 sourceFile 不一致 → 走内容匹配并给出警告
        renamed = os.path.join(self.dir, "改名后报告.xlsx")
        shutil.copy2(self.main_path, renamed)
        result = es.parse_subtask_for_merge(renamed, self.sub_path)
        self.assertTrue(result["warning"])
        # 内容匹配仍能命中（caseId 精确通道）
        c2 = result["items"][1]
        self.assertEqual(c2["status"], "caseid")

    def test_parse_missing_map_raises(self):
        plain = os.path.join(self.dir, "普通文件.xlsx")
        wb2 = openpyxl.Workbook()
        wb2.save(plain)
        with self.assertRaises(ValueError):
            es.parse_subtask_for_merge(self.main_path, plain)

    def test_parse_missing_result_column_raises(self):
        # 子文件结果列表头改为主文件没有的列名 → 明确报错
        wb2 = openpyxl.load_workbook(self.sub_path)
        try:
            ws2 = wb2["功能页"]
            ws2.cell(row=2, column=5).value = "RC9测试结果"
            wb2.save(self.sub_path)
        finally:
            wb2.close()
        with self.assertRaises(ValueError) as ctx:
            es.parse_subtask_for_merge(self.main_path, self.sub_path)
        self.assertIn("RC9测试结果", str(ctx.exception))

    def test_parse_title_fuzzy_fallback(self):
        # 主文件换名（sourceFile 警告，跳过精确通道）+ 子文件 C2 编号被误改
        # （caseId 通道失效）→ 标题模糊通道命中
        renamed = os.path.join(self.dir, "改名后报告.xlsx")
        shutil.copy2(self.main_path, renamed)
        wb2 = openpyxl.load_workbook(self.sub_path)
        try:
            ws2 = wb2["功能页"]
            ws2.cell(row=4, column=1).value = "C2X"  # 辅助人员手误改编号
            wb2.save(self.sub_path)
        finally:
            wb2.close()
        result = es.parse_subtask_for_merge(renamed, self.sub_path)
        self.assertTrue(result["warning"])
        statuses = {it["status"] for it in result["items"]}
        self.assertIn("title", statuses)


class TestMergeSubtask(unittest.TestCase):
    """合入写回：approvals 子集、指纹防错位、skipped/failures。"""

    def setUp(self):
        self.wb = openpyxl.Workbook()
        self.wb.remove(self.wb.active)
        self.dir = tempfile.mkdtemp()
        self.main_path = os.path.join(self.dir, "主报告.xlsx")
        _make_full_sheet(self.wb, "功能页", [
            ("C1", "导航避障测试", "步骤一", "预期一", "PASS", "", "", "", "", ""),
            ("C2", "乘梯到达测试", "步骤二", "预期二", "", "", "", "", "", ""),
        ])
        self.wb.save(self.main_path)
        self.sub_path = es.export_subtask(
            self.main_path,
            [{"sheet": "功能页", "rowIndex": 3},
             {"sheet": "功能页", "rowIndex": 4}],
            out_dir=self.dir)
        # C2 补结果 + 实际现象（子文件裁剪 rc2 后"实际现象"在第 8 列）
        wb2 = openpyxl.load_workbook(self.sub_path)
        try:
            ws2 = wb2["功能页"]
            ws2.cell(row=4, column=5).value = "FAIL"
            ws2.cell(row=4, column=8).value = "现象B"
            wb2.save(self.sub_path)
        finally:
            wb2.close()

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_merge_writes_approved_fields_only(self):
        result = es.merge_subtask_results(self.main_path, self.sub_path, [
            {"sheet": "功能页", "mainRowIndex": 4,
             "fields": {"result": "FAIL", "actual": "现象B"}},
        ])
        self.assertEqual(result["merged"], 2)
        self.assertEqual(result["failures"], [])
        payload, _ = es.parse_workbook(self.main_path)
        c2 = next(c for c in payload["cases"] if c["caseId"] == "C2")
        self.assertEqual(c2["result"], "FAIL")
        self.assertEqual(c2["actual"], "现象B")
        # 未勾选的 C1 保持原值
        c1 = next(c for c in payload["cases"] if c["caseId"] == "C1")
        self.assertEqual(c1["result"], "PASS")

    def test_merge_skips_when_value_unchanged(self):
        result = es.merge_subtask_results(self.main_path, self.sub_path, [
            {"sheet": "功能页", "mainRowIndex": 3, "fields": {"result": "PASS"}},
        ])
        self.assertEqual(result["merged"], 0)
        self.assertEqual(result["skipped"], 1)

    def test_merge_fingerprint_mismatch_fails(self):
        # 预览后主文件被外部修改（标题变更）→ 指纹校验失败，该条进 failures
        wb2 = openpyxl.load_workbook(self.main_path)
        try:
            ws2 = wb2["功能页"]
            ws2.cell(row=4, column=2).value = "乘梯到达测试（外部改动）"
            wb2.save(self.main_path)
        finally:
            wb2.close()
        result = es.merge_subtask_results(self.main_path, self.sub_path, [
            {"sheet": "功能页", "mainRowIndex": 4, "fields": {"result": "FAIL"}},
        ])
        self.assertEqual(result["merged"], 0)
        self.assertEqual(len(result["failures"]), 1)
        self.assertIn("不一致", result["failures"][0]["reason"])

    def test_merge_empty_approvals(self):
        result = es.merge_subtask_results(self.main_path, self.sub_path, [])
        self.assertEqual(result["merged"], 0)


class TestParseSkipsQoder(unittest.TestCase):
    """回归：_qoder* 元数据页不被解析为用例/预览页。"""

    def test_parse_workbook_skips_qoder_sheet(self):
        wb = openpyxl.Workbook()
        wb.remove(wb.active)
        _make_full_sheet(wb, "功能页", [
            ("C1", "用例一", "步骤一", "预期一", "", "", "", "", "", ""),
        ])
        dir_ = tempfile.mkdtemp()
        try:
            path = os.path.join(dir_, "带元数据.xlsx")
            wb.save(path)
            sub = es.export_subtask(
                path, [{"sheet": "功能页", "rowIndex": 3}], out_dir=dir_)
            payload, _ = es.parse_workbook(sub)
            self.assertEqual([s["name"] for s in payload["sheets"]], ["功能页"])
            self.assertEqual(len(payload["cases"]), 1)
        finally:
            shutil.rmtree(dir_, ignore_errors=True)


class TestV21WorkbookService(unittest.TestCase):
    """v2.1 预检、活动上下文和备份恢复的核心回归。"""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.path = os.path.join(self.tmp, "活动.xlsx")
        wb = openpyxl.Workbook()
        wb.remove(wb.active)
        _make_functional_sheet(wb, "功能页", rows=[
            ("TC1", "用例一", "步骤", "预期", ""),
        ])
        info = wb.create_sheet("说明")
        info.cell(row=1, column=1, value="仅供参考")
        wb.save(self.path)
        wb.close()
        es._parse_cache.clear()

    def tearDown(self):
        es._parse_cache.clear()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_preflight_is_read_only_and_lists_changes(self):
        before = es.file_fingerprint(self.path)
        result = es.inspect_workbook(self.path)
        after = es.file_fingerprint(self.path)
        self.assertEqual(before["sha256"], after["sha256"])
        self.assertEqual(result["executableCaseCount"], 1)
        self.assertTrue(result["changes"])
        self.assertTrue(any(x["name"] == "说明" for x in result["skippedSheets"]))
        wb = openpyxl.load_workbook(self.path)
        try:
            headers = [es._cell_str(c.value) for c in wb["功能页"][2]]
            self.assertNotIn("实际现象", headers)
        finally:
            wb.close()

    def test_runs_round_trip_and_are_skipped_by_parser(self):
        run = es.create_run(self.path, {
            "stage": "回归", "tester": "张三", "version": "v2.1",
            "resultHeader": "测试结果", "scope": {"sheet": "功能页"},
        })
        self.assertTrue(run["runId"])
        runs = es.list_runs(self.path)
        self.assertEqual(len(runs), 1)
        self.assertEqual(runs[0]["version"], "v2.1")
        updated = es.update_run(self.path, run["runId"], {"status": "已完成"})
        self.assertEqual(updated["status"], "已完成")
        payload, _ = es.parse_workbook(self.path)
        self.assertEqual(len(payload["cases"]), 1)
        self.assertEqual(payload["runs"][0]["runId"], run["runId"])

    def test_restore_creates_before_backup_and_restores_selected_version(self):
        wb = openpyxl.load_workbook(self.path)
        try:
            wb["功能页"].cell(row=3, column=5).value = "PASS"
            wb.save(self.path)
        finally:
            wb.close()
        backup_dir = os.path.join(self.tmp, "backups")
        selected = es.make_backup(self.path, backup_dir)
        wb = openpyxl.load_workbook(self.path)
        try:
            wb["功能页"].cell(row=3, column=5).value = "FAIL"
            wb.save(self.path)
        finally:
            wb.close()
        result = es.restore_backup(self.path, os.path.basename(selected), backup_dir)
        self.assertTrue(result["beforeBackup"])
        wb = openpyxl.load_workbook(self.path)
        try:
            self.assertEqual(es._cell_str(wb["功能页"].cell(row=3, column=5).value), "PASS")
        finally:
            wb.close()


class TestV21Endpoints(unittest.TestCase):
    def setUp(self):
        import app as app_module
        self.app_module = app_module
        self.tmp = tempfile.mkdtemp()
        self.testing = os.path.join(self.tmp, "testing")
        self.backups = os.path.join(self.tmp, "backups")
        os.makedirs(self.testing)
        self.path = os.path.join(self.testing, "接口.xlsx")
        wb = openpyxl.Workbook()
        wb.remove(wb.active)
        _make_functional_sheet(wb, "功能页", rows=[
            ("TC1", "用例一", "步骤", "预期", ""),
        ])
        wb.save(self.path)
        wb.close()
        self.old_testing = app_module.TESTING_DIR
        self.old_backup = app_module.BACKUP_DIR
        self.old_state = dict(app_module.STATE)
        app_module.TESTING_DIR = self.testing
        app_module.BACKUP_DIR = self.backups
        app_module.STATE.update({"current_path": self.path, "stage": "",
                                 "tester": "", "activity": {}, "run_id": "",
                                 "backed_up": set()})
        self.client = app_module.app.test_client()

    def tearDown(self):
        self.app_module.TESTING_DIR = self.old_testing
        self.app_module.BACKUP_DIR = self.old_backup
        self.app_module.STATE.clear()
        self.app_module.STATE.update(self.old_state)
        es._parse_cache.clear()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_preflight_endpoint_and_fingerprint_conflict(self):
        response = self.client.post("/api/workbook/preflight", json={"fileName": "接口.xlsx"})
        self.assertEqual(response.status_code, 200)
        fingerprint = response.get_json()["fingerprint"]
        self.assertEqual(response.get_json()["executableCaseCount"], 1)
        with open(self.path, "ab") as stream:
            stream.write(b"x")
        response = self.client.patch("/api/cases", json={
            "sheet": "功能页", "rowIndex": 3, "result": "PASS",
            "fileName": "接口.xlsx", "fileFingerprint": fingerprint,
        })
        self.assertEqual(response.status_code, 409)
        self.assertTrue(response.get_json().get("conflict"))




class TestV22V23Endpoints(unittest.TestCase):
    def setUp(self):
        import app as app_module
        self.app_module = app_module
        self.tmp = tempfile.mkdtemp()
        self.testing = os.path.join(self.tmp, "testing")
        self.backups = os.path.join(self.tmp, "backups")
        self.archive = os.path.join(self.tmp, "archive")
        self.trash = os.path.join(self.tmp, "trash")
        self.attachments = os.path.join(self.tmp, "attachments")
        for directory in (self.testing, self.backups, self.archive, self.trash, self.attachments):
            os.makedirs(directory)
        self.path = os.path.join(self.testing, "接口.xlsx")
        wb = openpyxl.Workbook()
        wb.remove(wb.active)
        _make_functional_sheet(wb, "功能页", rows=[
            ("TC1", "用例一", "步骤", "预期", ""),
        ])
        wb.save(self.path)
        wb.close()
        self.old_dirs = {key: getattr(app_module, key) for key in (
            "TESTING_DIR", "BACKUP_DIR", "LIBRARY_ARCHIVE_DIR", "LIBRARY_TRASH_DIR", "ATTACHMENTS_DIR")}
        self.old_state = dict(app_module.STATE)
        app_module.TESTING_DIR = self.testing
        app_module.BACKUP_DIR = self.backups
        app_module.LIBRARY_ARCHIVE_DIR = self.archive
        app_module.LIBRARY_TRASH_DIR = self.trash
        app_module.ATTACHMENTS_DIR = self.attachments
        app_module.STATE.update({"current_path": self.path, "stage": "", "tester": "",
                                 "activity": {}, "run_id": "", "backed_up": set()})
        self.client = app_module.app.test_client()
        self.fingerprint = es.file_fingerprint(self.path)

    def tearDown(self):
        for key, value in self.old_dirs.items():
            setattr(self.app_module, key, value)
        self.app_module.STATE.clear()
        self.app_module.STATE.update(self.old_state)
        es._parse_cache.clear()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_etag_and_task_lifecycle(self):
        first = self.client.get("/api/cases")
        self.assertEqual(first.status_code, 200)
        tag = first.headers.get("ETag")
        self.assertTrue(tag)
        self.fingerprint = first.get_json()["fileFingerprint"]
        cached = self.client.get("/api/cases", headers={"If-None-Match": tag})
        self.assertEqual(cached.status_code, 304)
        created = self.client.post("/api/tasks", json={
            "fileName": "接口.xlsx", "fileFingerprint": self.fingerprint,
            "tester": "李四", "targetCount": 1,
            "targets": [{"sheet": "功能页", "rowIndex": 3}], "status": "待执行",
        })
        self.assertEqual(created.status_code, 200)
        task = created.get_json()["task"]
        self.assertTrue(task["taskId"])
        listed = self.client.get("/api/tasks").get_json()["tasks"]
        self.assertEqual(len(listed), 1)
        updated = self.client.patch("/api/tasks", json={
            "fileName": "接口.xlsx", "fileFingerprint": created.get_json()["fileFingerprint"],
            "taskId": task["taskId"], "status": "执行中",
        })
        self.assertEqual(updated.status_code, 200)
        self.assertEqual(updated.get_json()["task"]["status"], "执行中")

    def test_attachment_rejects_invalid_fingerprint_and_isolated_upload(self):
        bad = self.client.post("/api/attachments", data={
            "fileName": "接口.xlsx", "fileFingerprint": "not-json",
            "sheet": "功能页", "rowIndex": "3",
            "file": (BytesIO(b"evidence"), "log.txt"),
        }, content_type="multipart/form-data")
        self.assertEqual(bad.status_code, 400)
        good = self.client.post("/api/attachments", data={
            "fileName": "接口.xlsx", "fileFingerprint": json.dumps(self.fingerprint),
            "sheet": "功能页", "rowIndex": "3",
            "file": (BytesIO(b"evidence"), "log.txt"),
        }, content_type="multipart/form-data")
        self.assertEqual(good.status_code, 200)
        attachment_id = good.get_json()["attachment"]["attachmentId"]
        listed = self.client.get("/api/attachments?sheet=功能页&rowIndex=3")
        self.assertEqual(len(listed.get_json()["attachments"]), 1)
        downloaded = self.client.get("/api/attachments/" + attachment_id)
        self.assertEqual(downloaded.status_code, 200)
        self.assertEqual(downloaded.data, b"evidence")
        downloaded.close()

    def test_library_cannot_mutate_current_file_and_moves_deleted_file_to_trash(self):
        second = os.path.join(self.testing, "其他.xlsx")
        shutil.copy2(self.path, second)
        current_delete = self.client.delete("/api/library/接口.xlsx")
        self.assertEqual(current_delete.status_code, 409)
        current_archive = self.client.patch("/api/library", json={
            "fileName": "接口.xlsx", "archived": False, "archive": True,
        })
        self.assertEqual(current_archive.status_code, 409)
        archived = self.client.patch("/api/library", json={
            "fileName": "其他.xlsx", "archived": False, "archive": True,
        })
        self.assertEqual(archived.status_code, 200)
        self.assertTrue(any(item["name"] == "其他.xlsx" and item["archived"]
                            for item in archived.get_json()["files"]))
        restored = self.client.patch("/api/library", json={
            "fileName": "其他.xlsx", "archived": True, "archive": False,
        })
        self.assertEqual(restored.status_code, 200)
        deleted = self.client.delete("/api/library/其他.xlsx")
        self.assertEqual(deleted.status_code, 200)
        self.assertTrue(deleted.get_json()["recoverable"])
        self.assertFalse(os.path.exists(second))
        self.assertTrue(os.listdir(self.trash))


if __name__ == "__main__":
    unittest.main()
