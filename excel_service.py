# -*- coding: utf-8 -*-
"""Excel 测试用例解析与写回核心。

负责：
- 解析多 Sheet 的测试用例（跳过统计页与分组标题行）。
- 幂等新增"实际现象"、"发现时间"两列。
- 将执行结果原子写回 xlsx，并在首次加载时生成备份。
"""

import os
import shutil
import tempfile
from datetime import datetime
from threading import Lock

import openpyxl

# 统计汇总页，不参与用例执行
SUMMARY_SHEET = "统计汇总"

# 列常量（1-based）
COL_CASE_ID = 1      # 用例编号
COL_MODULE = 2       # 功能模块
COL_SCENARIO = 3     # 场景
COL_TITLE = 4        # 标题
COL_PRECONDITION = 5  # 前置条件
COL_STEPS = 6        # 测试步骤
COL_EXPECTED = 7     # 预期结果
COL_PRIORITY = 8     # 优先级
COL_RISK = 9         # 风险等级
COL_RESULT = 10      # 测试结果
COL_BUGID = 11       # BugID
COL_TESTER = 12      # 测试人员
COL_NOTE = 13        # 备注
COL_DIAGRAM = 14     # 示意图
COL_ACTUAL = 15      # 实际现象（新增）
COL_FOUND_TIME = 16  # 发现时间（新增）

HEADER_ACTUAL = "实际现象"
HEADER_FOUND_TIME = "发现时间"

# 写文件锁，避免并发写回损坏文件
_write_lock = Lock()


def _cell_str(value):
    """将单元格值规范为去除首尾空白的字符串。"""
    if value is None:
        return ""
    return str(value).strip()


def _find_header_row(ws):
    """在前若干行中定位表头行（col1 == '用例编号'）。找不到返回 None。"""
    max_scan = min(ws.max_row, 5)
    for row_idx in range(1, max_scan + 1):
        if _cell_str(ws.cell(row=row_idx, column=COL_CASE_ID).value) == "用例编号":
            return row_idx
    return None


def _ensure_extra_columns(ws, header_row):
    """幂等地为用例 Sheet 新增两列表头。返回是否发生了修改。"""
    changed = False
    if _cell_str(ws.cell(row=header_row, column=COL_ACTUAL).value) != HEADER_ACTUAL:
        ws.cell(row=header_row, column=COL_ACTUAL).value = HEADER_ACTUAL
        changed = True
    if _cell_str(ws.cell(row=header_row, column=COL_FOUND_TIME).value) != HEADER_FOUND_TIME:
        ws.cell(row=header_row, column=COL_FOUND_TIME).value = HEADER_FOUND_TIME
        changed = True
    return changed


def _is_real_case(ws, row_idx):
    """真实用例：用例编号非空 且 预期结果非空。仅 col1 有值的为分组标题行。"""
    case_id = _cell_str(ws.cell(row=row_idx, column=COL_CASE_ID).value)
    expected = _cell_str(ws.cell(row=row_idx, column=COL_EXPECTED).value)
    return bool(case_id) and bool(expected)


def parse_workbook(path):
    """解析工作簿，返回 (cases, progress)。

    cases: list[dict]
    progress: {"done": int, "total": int}
    同时保证两列表头已写入（若有改动会保存）。
    """
    wb = openpyxl.load_workbook(path)
    cases = []
    global_index = 0
    header_changed = False

    for ws in wb.worksheets:
        if ws.title == SUMMARY_SHEET:
            continue
        header_row = _find_header_row(ws)
        if header_row is None:
            continue
        if _ensure_extra_columns(ws, header_row):
            header_changed = True

        # Sheet 主标题（第 1 行 col1），无则用 sheet 名
        sheet_title = _cell_str(ws.cell(row=1, column=COL_CASE_ID).value) or ws.title

        for row_idx in range(header_row + 1, ws.max_row + 1):
            if not _is_real_case(ws, row_idx):
                continue
            cases.append({
                "globalIndex": global_index,
                "sheet": ws.title,
                "sheetTitle": sheet_title,
                "rowIndex": row_idx,
                "caseId": _cell_str(ws.cell(row=row_idx, column=COL_CASE_ID).value),
                "module": _cell_str(ws.cell(row=row_idx, column=COL_MODULE).value),
                "scenario": _cell_str(ws.cell(row=row_idx, column=COL_SCENARIO).value),
                "title": _cell_str(ws.cell(row=row_idx, column=COL_TITLE).value),
                "precondition": _cell_str(ws.cell(row=row_idx, column=COL_PRECONDITION).value),
                "steps": _cell_str(ws.cell(row=row_idx, column=COL_STEPS).value),
                "expected": _cell_str(ws.cell(row=row_idx, column=COL_EXPECTED).value),
                "priority": _cell_str(ws.cell(row=row_idx, column=COL_PRIORITY).value),
                "risk": _cell_str(ws.cell(row=row_idx, column=COL_RISK).value),
                "result": _cell_str(ws.cell(row=row_idx, column=COL_RESULT).value),
                "bugId": _cell_str(ws.cell(row=row_idx, column=COL_BUGID).value),
                "tester": _cell_str(ws.cell(row=row_idx, column=COL_TESTER).value),
                "note": _cell_str(ws.cell(row=row_idx, column=COL_NOTE).value),
                "actual": _cell_str(ws.cell(row=row_idx, column=COL_ACTUAL).value),
                "foundTime": _cell_str(ws.cell(row=row_idx, column=COL_FOUND_TIME).value),
            })
            global_index += 1

    if header_changed:
        _atomic_save(wb, path)
    wb.close()

    done = sum(1 for c in cases if c["result"])
    return cases, {"done": done, "total": len(cases)}


def _atomic_save(wb, path):
    """写临时文件后原子替换，避免写入中断损坏原文件。"""
    directory = os.path.dirname(os.path.abspath(path)) or "."
    fd, tmp_path = tempfile.mkstemp(suffix=".xlsx", dir=directory)
    os.close(fd)
    try:
        wb.save(tmp_path)
        os.replace(tmp_path, path)
    except Exception:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        raise


def make_backup(path, backup_dir):
    """在 backup_dir 生成带时间戳的备份，返回备份路径。"""
    os.makedirs(backup_dir, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    base = os.path.splitext(os.path.basename(path))[0]
    backup_path = os.path.join(backup_dir, f"backup_{base}_{ts}.xlsx")
    shutil.copy2(path, backup_path)
    return backup_path


# 允许前端提交的字段 -> 列号映射
_FIELD_COLUMNS = {
    "result": COL_RESULT,
    "bugId": COL_BUGID,
    "tester": COL_TESTER,
    "note": COL_NOTE,
    "actual": COL_ACTUAL,
    "foundTime": COL_FOUND_TIME,
}


def update_case(path, sheet, row_index, fields):
    """写回单条用例的执行结果并原子保存。返回最新进度。

    fields: dict，键可为 result/bugId/tester/note/actual/foundTime。
    """
    with _write_lock:
        wb = openpyxl.load_workbook(path)
        if sheet not in wb.sheetnames:
            wb.close()
            raise ValueError(f"Sheet 不存在: {sheet}")
        ws = wb[sheet]
        header_row = _find_header_row(ws)
        if header_row is not None:
            _ensure_extra_columns(ws, header_row)

        for key, value in fields.items():
            col = _FIELD_COLUMNS.get(key)
            if col is None:
                continue
            ws.cell(row=row_index, column=col).value = value if value != "" else None

        _atomic_save(wb, path)

        # 重新统计进度
        progress = _compute_progress(wb)
        wb.close()
        return progress


def _compute_progress(wb):
    done = 0
    total = 0
    for ws in wb.worksheets:
        if ws.title == SUMMARY_SHEET:
            continue
        header_row = _find_header_row(ws)
        if header_row is None:
            continue
        for row_idx in range(header_row + 1, ws.max_row + 1):
            if not _is_real_case(ws, row_idx):
                continue
            total += 1
            if _cell_str(ws.cell(row=row_idx, column=COL_RESULT).value):
                done += 1
    return {"done": done, "total": total}
