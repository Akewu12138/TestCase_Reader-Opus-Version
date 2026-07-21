# -*- coding: utf-8 -*-
"""Excel 测试用例解析与写回核心。

负责：
- 自动识别每个 Sheet 的类型：功能用例(functional) / 场景用例(scenario) /
  结果矩阵(matrix) / 信息页(info)。
- 用表头名（含同义词）通用解析列号，兼容多种表头布局；对旧版固定
  14 列布局保持完全一致的解析与写回结果。
- 幂等新增"实际现象"、"发现时间"两列（仅对可执行的功能/场景 Sheet）。
- 提取内嵌锚定图片（以 data URL 形式随负载返回），矩阵/场景页可展示。
- 将执行结果原子写回 xlsx，并在首次加载时生成备份。
"""

import base64
import os
import shutil
import tempfile
from datetime import datetime
from threading import Lock

import openpyxl

HEADER_ACTUAL = "实际现象"
HEADER_FOUND_TIME = "发现时间"

# 信息/预览页的 Sheet 名关键字（命中则视为只读信息页）
INFO_NAME_KEYWORDS = [
    "总结", "汇总", "统计", "说明", "封面", "目录", "策略",
    "bug等级", "版本", "变更记录", "修订", "report", "summary", "cover",
]

# 结果单元格常见取值（用于矩阵页启发式判断）
RESULT_TOKENS = {
    "PASS", "FAIL", "BLOCK", "NA", "NT", "N/A",
    "通过", "失败", "阻塞", "跳过", "不涉及", "未测",
}

# 字段 -> 表头匹配规则。mode: "eq" 精确相等；"contains" 包含。
# 顺序即优先级：靠前的字段优先占用命中的列。
_FIELD_RULES = [
    ("caseId", [("eq", "用例编号"), ("eq", "编号"), ("contains", "用例编号")]),
    ("title", [("eq", "标题"), ("eq", "用例名称"), ("contains", "用例名称")]),
    ("module", [("eq", "功能模块"), ("eq", "所属分组"), ("eq", "一级模块"),
                ("contains", "功能模块"), ("contains", "所属分组")]),
    ("desc", [("eq", "场景说明"), ("contains", "场景说明"), ("eq", "说明"),
              ("contains", "场景描述")]),
    ("scenario", [("eq", "场景"), ("eq", "场景名称"), ("eq", "起步场景"),
                  ("contains", "场景")]),
    ("precondition", [("eq", "前置条件"), ("contains", "前置")]),
    ("steps", [("eq", "测试步骤"), ("eq", "步骤描述"), ("contains", "步骤")]),
    ("expected", [("contains", "预期结果"), ("eq", "预期")]),
    ("priority", [("eq", "优先级"), ("eq", "用例等级"), ("contains", "优先级")]),
    ("risk", [("eq", "风险等级"), ("contains", "风险")]),
    ("result", [("eq", "测试结果"), ("eq", "结果"), ("eq", "pass/fail"),
                ("eq", "s100测试结果"), ("contains", "测试结果")]),
    ("bugId", [("eq", "bugid"), ("contains", "bugid")]),
    ("tester", [("eq", "测试人员"), ("eq", "测试人"), ("eq", "维护人"),
                ("contains", "测试人"), ("contains", "维护")]),
    ("note", [("eq", "备注"), ("eq", "结果备注"), ("contains", "备注")]),
    ("diagram", [("eq", "示意图"), ("contains", "示意图")]),
    ("actual", [("eq", HEADER_ACTUAL), ("eq", "实际结果"), ("contains", "实际")]),
    ("foundTime", [("eq", HEADER_FOUND_TIME), ("contains", "发现时间")]),
]

# 允许前端提交的字段集合（写回时按列映射）
_WRITABLE_FIELDS = ("result", "bugId", "tester", "note", "actual", "foundTime")

# 写文件锁，避免并发写回损坏文件
_write_lock = Lock()


def _cell_str(value):
    """将单元格值规范为去除首尾空白的字符串。"""
    if value is None:
        return ""
    return str(value).strip()


def _norm_header(value):
    """规范化表头文本用于匹配：去空白、去结尾星号、小写化。"""
    s = _cell_str(value)
    s = s.replace("*", "").replace("＊", "")
    s = " ".join(s.split())  # 折叠内部空白
    return s.lower()


def _header_match(cell_text, rules):
    """判断某个表头单元格文本是否命中字段规则。"""
    norm = _norm_header(cell_text)
    if not norm:
        return False
    for mode, text in rules:
        if mode == "eq" and norm == text:
            return True
        if mode == "contains" and text in norm:
            return True
    return False


def _find_header_row(ws):
    """在前若干行中定位表头行：取"非空单元格最多"的一行。找不到返回 None。

    要求该行至少含 2 个非空单元格，避免把标题行/空行当表头。
    """
    max_scan = min(ws.max_row, 6)
    best_row = None
    best_count = 0
    for row_idx in range(1, max_scan + 1):
        count = 0
        for col_idx in range(1, min(ws.max_column, 40) + 1):
            if _cell_str(ws.cell(row=row_idx, column=col_idx).value):
                count += 1
        if count > best_count:
            best_count = count
            best_row = row_idx
    if best_count >= 2:
        return best_row
    return None


def _resolve_columns(ws, header_row):
    """按表头名解析各字段所在列号，返回 {field: col}。

    从左到右扫描表头：每个列归属于第一个命中的、尚未被占用的字段；
    每个字段只取第一个命中的列（保证多结果列时取首个）。
    """
    cols = {}
    max_col = min(ws.max_column, 40)
    for col_idx in range(1, max_col + 1):
        text = ws.cell(row=header_row, column=col_idx).value
        if not _cell_str(text):
            continue
        for field, rules in _FIELD_RULES:
            if field in cols:
                continue
            if _header_match(text, rules):
                cols[field] = col_idx
                break
    return cols


def _last_header_col(ws, header_row):
    """表头行最右侧非空列号。"""
    last = 0
    for col_idx in range(1, min(ws.max_column, 60) + 1):
        if _cell_str(ws.cell(row=header_row, column=col_idx).value):
            last = col_idx
    return last


def _name_is_info(name):
    low = (name or "").lower()
    return any(kw in low for kw in INFO_NAME_KEYWORDS)


def _looks_like_matrix(ws, header_row):
    """启发式：正文中出现多个结果类取值(PASS/FAIL/...)则视为结果矩阵。"""
    hits = 0
    row_end = min(ws.max_row, header_row + 40)
    col_end = min(ws.max_column, 30)
    for r in range(header_row + 1, row_end + 1):
        for c in range(1, col_end + 1):
            v = _cell_str(ws.cell(row=r, column=c).value).upper()
            if v in RESULT_TOKENS:
                hits += 1
                if hits >= 2:
                    return True
    return False


def _sheet_title(ws, header_row):
    """Sheet 展示标题：表头行之上的首个非空单元格，否则用 Sheet 名。"""
    for row_idx in range(1, header_row):
        for col_idx in range(1, min(ws.max_column, 10) + 1):
            t = _cell_str(ws.cell(row=row_idx, column=col_idx).value)
            if t:
                return t
    return ws.title


def classify_sheet(ws):
    """判定 Sheet 类型，返回 dict：{name, kind, title, headerRow, columns}。

    kind ∈ {functional, scenario, matrix, info}。
    """
    header_row = _find_header_row(ws)
    if header_row is None:
        return {"name": ws.title, "kind": "info", "title": ws.title,
                "headerRow": None, "columns": {}}

    cols = _resolve_columns(ws, header_row)
    title = _sheet_title(ws, header_row)

    if _name_is_info(ws.title):
        return {"name": ws.title, "kind": "info", "title": title,
                "headerRow": header_row, "columns": cols}

    has_ident = ("caseId" in cols) or ("title" in cols)
    has_body = ("expected" in cols) or ("steps" in cols) or ("scenario" in cols)

    if has_ident and has_body:
        # 场景页：含"场景"主列且无"标题"列（旧版功能页含标题列，归 functional）
        if ("scenario" in cols) and ("title" not in cols):
            kind = "scenario"
        else:
            kind = "functional"
        return {"name": ws.title, "kind": kind, "title": title,
                "headerRow": header_row, "columns": cols}

    if _looks_like_matrix(ws, header_row) or ("result" in cols):
        return {"name": ws.title, "kind": "matrix", "title": title,
                "headerRow": header_row, "columns": cols}

    return {"name": ws.title, "kind": "info", "title": title,
            "headerRow": header_row, "columns": cols}


def _is_real_case(ws, row_idx, cols, kind):
    """按类型判定某行是否为真实用例（跳过分组标题行/空行）。"""
    def val(field):
        col = cols.get(field)
        return _cell_str(ws.cell(row=row_idx, column=col).value) if col else ""

    case_id = val("caseId")
    title = val("title")
    scenario = val("scenario")
    expected = val("expected")
    steps = val("steps")
    result = val("result")

    if kind == "scenario":
        ident = case_id or title or scenario
        return bool(ident) and bool(scenario or result or expected or steps)
    # functional
    ident = case_id or title
    return bool(ident) and bool(expected or steps)


def _ensure_extra_columns(ws, header_row, cols):
    """幂等地为可执行 Sheet 补齐"实际现象"/"发现时间"两列表头。

    返回 (changed, cols)：cols 会被补充 actual/foundTime 的列号。
    """
    changed = False
    next_col = _last_header_col(ws, header_row) + 1
    if "actual" not in cols:
        ws.cell(row=header_row, column=next_col).value = HEADER_ACTUAL
        cols["actual"] = next_col
        next_col += 1
        changed = True
    if "foundTime" not in cols:
        ws.cell(row=header_row, column=next_col).value = HEADER_FOUND_TIME
        cols["foundTime"] = next_col
        changed = True
    return changed, cols


def _iter_case_sheets(wb):
    """遍历工作簿，产出可执行 Sheet 的元信息。

    yield (ws, meta) —— meta 为 classify_sheet 结果，kind ∈ {functional, scenario}。
    """
    for ws in wb.worksheets:
        meta = classify_sheet(ws)
        if meta["kind"] in ("functional", "scenario"):
            yield ws, meta


def _img_bytes(img):
    try:
        data = getattr(img, "_data", None)
        if callable(data):
            return data()
        return data
    except Exception:
        return None


def _img_anchor(img):
    """返回图片锚点起始 (row, col)，均为 1-based；解析失败返回 (0, 0)。"""
    try:
        anchor = img.anchor
        frm = getattr(anchor, "_from", None)
        if frm is not None:
            return int(frm.row) + 1, int(frm.col) + 1
    except Exception:
        pass
    return 0, 0


def _extract_sheet_images(path):
    """提取每个 Sheet 的内嵌锚定图片，返回 {sheet: [{row, col, dataUrl}]}。

    使用独立的工作簿实例读取：调用 img._data() 会消费底层图片流，若在
    随后需要保存的同一工作簿上执行会导致 save 失败/丢图，故单独加载再丢弃。
    """
    result = {}
    try:
        wb = openpyxl.load_workbook(path)
    except Exception:
        return result
    try:
        for ws in wb.worksheets:
            imgs = getattr(ws, "_images", None) or []
            items = []
            for img in imgs:
                data = _img_bytes(img)
                if not data:
                    continue
                fmt = (getattr(img, "format", None) or "png").lower()
                if fmt == "jpg":
                    fmt = "jpeg"
                row, col = _img_anchor(img)
                b64 = base64.b64encode(data).decode("ascii")
                items.append({
                    "row": row,
                    "col": col,
                    "dataUrl": "data:image/%s;base64,%s" % (fmt, b64),
                })
            if items:
                result[ws.title] = items
    finally:
        wb.close()
    return result


def _sheet_grid(ws, header_row, max_rows=200, max_cols=30):
    """把 Sheet 内容读为二维字符串数组（用于只读预览）。"""
    start = 1
    row_end = min(ws.max_row, start + max_rows - 1)
    col_end = min(ws.max_column, max_cols)
    grid = []
    for r in range(start, row_end + 1):
        row_vals = []
        any_val = False
        for c in range(1, col_end + 1):
            v = _cell_str(ws.cell(row=r, column=c).value)
            if v:
                any_val = True
            row_vals.append(v)
        if any_val:
            grid.append(row_vals)
    return grid


def parse_workbook(path):
    """解析工作簿，返回 (payload, header_changed)。

    payload: {
        cases: [...],            # 仅 functional + scenario
        sheets: [{name, kind, title}],
        previews: [{sheet, kind, title, grid, images}],  # matrix + info
        progress: {done, total},
    }
    若补齐了新增列表头会自动保存。
    """
    wb = openpyxl.load_workbook(path)
    sheet_images = _extract_sheet_images(path)

    cases = []
    sheets_meta = []
    previews = []
    global_index = 0
    header_changed = False

    for ws in wb.worksheets:
        meta = classify_sheet(ws)
        sheets_meta.append({"name": ws.title, "kind": meta["kind"], "title": meta["title"]})

        if meta["kind"] in ("functional", "scenario"):
            header_row = meta["headerRow"]
            cols = meta["columns"]
            changed, cols = _ensure_extra_columns(ws, header_row, cols)
            if changed:
                header_changed = True

            imgs = sheet_images.get(ws.title, [])
            sheet_cases = []
            for row_idx in range(header_row + 1, ws.max_row + 1):
                if not _is_real_case(ws, row_idx, cols, meta["kind"]):
                    continue

                def g(field):
                    col = cols.get(field)
                    return _cell_str(ws.cell(row=row_idx, column=col).value) if col else ""

                case = {
                    "globalIndex": global_index,
                    "sheet": ws.title,
                    "sheetTitle": meta["title"],
                    "kind": meta["kind"],
                    "rowIndex": row_idx,
                    "caseId": g("caseId"),
                    "module": g("module"),
                    "scenario": g("scenario"),
                    "desc": g("desc"),
                    "title": g("title"),
                    "precondition": g("precondition"),
                    "steps": g("steps"),
                    "expected": g("expected"),
                    "priority": g("priority"),
                    "risk": g("risk"),
                    "result": g("result"),
                    "bugId": g("bugId"),
                    "tester": g("tester"),
                    "note": g("note"),
                    "actual": g("actual"),
                    "foundTime": g("foundTime"),
                    "images": [],
                }
                case["name"] = case["caseId"] or case["title"] or case["scenario"] or "(未命名)"
                cases.append(case)
                sheet_cases.append(case)
                global_index += 1

            # 场景页：把图片按锚点行归属到覆盖该行区间的用例
            if meta["kind"] == "scenario" and imgs and sheet_cases:
                for i, case in enumerate(sheet_cases):
                    start_row = case["rowIndex"]
                    end_row = (sheet_cases[i + 1]["rowIndex"]
                               if i + 1 < len(sheet_cases) else ws.max_row + 1)
                    case["images"] = [im["dataUrl"] for im in imgs
                                      if start_row <= im["row"] < end_row]
        else:
            # matrix / info：只读预览
            header_row = meta["headerRow"] or 1
            previews.append({
                "sheet": ws.title,
                "kind": meta["kind"],
                "title": meta["title"],
                "grid": _sheet_grid(ws, header_row),
                "images": sheet_images.get(ws.title, []),
            })

    if header_changed:
        _atomic_save(wb, path)
    wb.close()

    done = sum(1 for c in cases if c["result"])
    payload = {
        "cases": cases,
        "sheets": sheets_meta,
        "previews": previews,
        "progress": {"done": done, "total": len(cases)},
    }
    return payload, header_changed


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
    backup_path = os.path.join(backup_dir, "backup_%s_%s.xlsx" % (base, ts))
    shutil.copy2(path, backup_path)
    return backup_path


def update_case(path, sheet, row_index, fields):
    """写回单条用例的执行结果并原子保存。返回最新进度。

    fields: dict，键可为 result/bugId/tester/note/actual/foundTime；
    目标列按该 Sheet 的表头动态解析（多结果列时取首个）。
    """
    with _write_lock:
        wb = openpyxl.load_workbook(path)
        if sheet not in wb.sheetnames:
            wb.close()
            raise ValueError("Sheet 不存在: %s" % sheet)
        ws = wb[sheet]
        header_row = _find_header_row(ws)
        cols = _resolve_columns(ws, header_row) if header_row is not None else {}
        if header_row is not None:
            _, cols = _ensure_extra_columns(ws, header_row, cols)

        for key, value in fields.items():
            if key not in _WRITABLE_FIELDS:
                continue
            col = cols.get(key)
            if not col:
                continue
            ws.cell(row=row_index, column=col).value = value if value != "" else None

        _atomic_save(wb, path)
        progress = _compute_progress(wb)
        wb.close()
        return progress


def _compute_progress(wb):
    """统计可执行用例的完成进度，与 parse_workbook 口径一致。"""
    done = 0
    total = 0
    for ws, meta in _iter_case_sheets(wb):
        header_row = meta["headerRow"]
        cols = meta["columns"]
        result_col = cols.get("result")
        for row_idx in range(header_row + 1, ws.max_row + 1):
            if not _is_real_case(ws, row_idx, cols, meta["kind"]):
                continue
            total += 1
            if result_col and _cell_str(ws.cell(row=row_idx, column=result_col).value):
                done += 1
    return {"done": done, "total": total}
