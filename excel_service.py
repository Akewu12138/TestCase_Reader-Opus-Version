# -*- coding: utf-8 -*-
"""Excel 测试用例解析与写回核心。

负责：
- 自动识别每个 Sheet 的类型：功能用例(functional) / 场景用例(scenario) /
  结果矩阵(matrix) / 信息页(info)。
- 用表头名（别名词库 + 归一化打分 + difflib 模糊兜底）通用解析列号，兼容多种
  表头布局；可通过同目录 field_aliases.json 外置补充自定义别名而无需改代码；
  对旧版固定 14 列布局保持完全一致的解析与写回结果。
- 未匹配到已知字段的非空列自动作为"附加字段"(extras)随用例返回，只读展示，
  确保任意额外/未来新增列都不丢数据。
- 幂等新增"实际现象"、"发现时间"两列（仅对可执行的功能/场景 Sheet）。
- 提取内嵌锚定图片（以 data URL 形式随负载返回），矩阵/场景页可展示。
- 将执行结果原子写回 xlsx，并在首次加载时生成备份。
"""

import base64
import difflib
import json
import os
import shutil
import tempfile
from datetime import datetime
from threading import Lock

import openpyxl
from openpyxl.cell.cell import MergedCell

HEADER_ACTUAL = "实际现象"
HEADER_FOUND_TIME = "发现时间"
# 当文件未提供这些可编辑字段列时，用于幂等补齐的默认表头名
HEADER_RESULT = "测试结果"
HEADER_NOTE = "备注"
HEADER_TESTER = "测试人员"
HEADER_BUGID = "BugID"

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

# 字段 -> 表头别名词库。顺序即优先级：同分时靠前的字段优先占用命中的列。
# 匹配采用"归一化 + 打分"：精确相等=1.0，双向包含≈0.6~0.9，否则不命中。
# 新增/变体表头只要与某个别名相同或互相包含即可自动命中，无需改动匹配逻辑；
# 未命中任何字段的非空列会作为"附加字段"随用例返回（只读展示，绝不丢数据）。
_FIELD_ALIASES = [
    ("caseId", ["用例编号", "用例id", "编号", "case id", "caseid"]),
    ("title", ["用例标题", "用例名称", "测试用例名称", "用例名", "标题", "case title", "title"]),
    ("module", ["所属模块", "功能模块", "用例模块", "所属分组", "一级模块", "功能点", "模块", "分组", "module"]),
    ("desc", ["场景说明", "场景描述", "用例说明", "说明", "描述"]),
    ("scenario", ["场景名称", "起步场景", "场景类型", "场景"]),
    ("precondition", ["前置条件", "预置条件", "前提条件", "初始条件", "前置"]),
    ("steps", ["测试步骤", "操作步骤", "执行步骤", "步骤描述", "步骤"]),
    ("expected", ["预期结果", "期望结果", "预期表现", "预期"]),
    ("priority", ["优先级", "用例等级", "重要级别", "级别"]),
    ("risk", ["风险等级", "风险"]),
    ("result", ["测试结果", "执行结果", "pass/fail", "s100测试结果", "结果"]),
    ("bugId", ["bugid", "缺陷编号", "bug编号", "缺陷id", "bug"]),
    ("tester", ["测试人员", "测试人", "执行人", "维护人", "测试者"]),
    ("note", ["备注", "结果备注", "问题描述", "说明备注"]),
    ("diagram", ["示意图", "图示"]),
    ("actual", [HEADER_ACTUAL, "实际结果", "实际表现", "实际情况", "实际"]),
    ("foundTime", [HEADER_FOUND_TIME, "发现日期", "发现时间"]),
]

# 字段优先级顺序（同分时靠前者优先占用列）
_FIELD_ORDER = [field for field, _ in _FIELD_ALIASES]

# 判定命中的最低分数：双向包含最低约 0.6，精确相等为 1.0
_MATCH_THRESHOLD = 0.6

# difflib 模糊相似度兜底阈值：仅在精确/双向包含都未命中时启用，
# 且相似度达到该阈值才视为候选，以容忍错别字/细微变体。
_FUZZY_THRESHOLD = 0.82

# 外置别名配置文件（可选）：为核心字段补充自定义表头别名，无需改代码。
_ALIAS_CONFIG_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "field_aliases.json")

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


def _load_alias_overrides():
    """读取外置别名配置，返回 {field: [别名, ...]}。文件不存在/非法时返回空字典。

    配置为 JSON 对象：键为字段名（见 _FIELD_ALIASES），值为别名字符串数组；
    非数组值或未知键会被忽略（如“_说明”这类注释键）。
    """
    try:
        with open(_ALIAS_CONFIG_PATH, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    overrides = {}
    for field, aliases in data.items():
        if isinstance(aliases, list):
            overrides[field] = [str(a) for a in aliases if str(a).strip()]
    return overrides


# 内置别名 + 外置配置合并，预归一化：field -> [归一化别名, ...]（模块加载时构建一次）
_ALIAS_OVERRIDES = _load_alias_overrides()
_FIELD_ALIAS_NORM = {}
for _field, _aliases in _FIELD_ALIASES:
    _seen = set()
    _norm_list = []
    for _raw in list(_aliases) + _ALIAS_OVERRIDES.get(_field, []):
        _nx = _norm_header(_raw)
        if _nx and _nx not in _seen:
            _seen.add(_nx)
            _norm_list.append(_nx)
    _FIELD_ALIAS_NORM[_field] = _norm_list


def _field_score(header_norm, field):
    """表头（已归一化）对某字段的匹配得分。

    精确相等=1.0；双向包含=0.6~0.9；均未命中时用 difflib 模糊相似度兜底
    （≥_FUZZY_THRESHOLD 才计入）；否则 0。
    """
    best = 0.0
    for alias in _FIELD_ALIAS_NORM[field]:
        if header_norm == alias:
            return 1.0
        if alias in header_norm or header_norm in alias:
            shorter = min(len(alias), len(header_norm))
            longer = max(len(alias), len(header_norm)) or 1
            score = 0.6 + 0.3 * (shorter / longer)
            if score > best:
                best = score
        elif len(header_norm) >= 2 and len(alias) >= 2:
            ratio = difflib.SequenceMatcher(None, header_norm, alias).ratio()
            if ratio >= _FUZZY_THRESHOLD and ratio > best:
                best = ratio
    return best


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

    对所有表头列 × 所有字段打分，再按"分数降序、字段优先级、列号升序"
    贪心分配：保证一列只归一个字段、一字段只取最优（同分取最左）命中列，
    多结果列时自然取首个。
    """
    max_col = min(ws.max_column, 60)
    candidates = []  # (score, field_priority, col, field)
    for col_idx in range(1, max_col + 1):
        htext = _norm_header(ws.cell(row=header_row, column=col_idx).value)
        if not htext:
            continue
        for prio, field in enumerate(_FIELD_ORDER):
            score = _field_score(htext, field)
            if score >= _MATCH_THRESHOLD:
                candidates.append((score, prio, col_idx, field))
    candidates.sort(key=lambda t: (-t[0], t[1], t[2]))
    cols = {}
    used_cols = set()
    for _score, _prio, col_idx, field in candidates:
        if field in cols or col_idx in used_cols:
            continue
        cols[field] = col_idx
        used_cols.add(col_idx)
    return cols


def _extra_columns(ws, header_row, cols, exclude=None):
    """未被识别为已知字段的非空表头列，返回 [(col, header_text)]，按列序。

    用于将任意额外/未知列作为附加字段随用例展示，避免数据丢失。
    应在 _ensure_extra_columns 之后调用，以便排除已补齐的实际现象/发现时间列。
    exclude: 额外排除的列号集合（如已被识别为结果类的轮次列，避免重复展示）。
    """
    used = set(cols.values())
    if exclude:
        used |= set(exclude)
    items = []
    for col_idx in range(1, min(ws.max_column, 60) + 1):
        if col_idx in used:
            continue
        text = _cell_str(ws.cell(row=header_row, column=col_idx).value)
        if text:
            items.append((col_idx, text))
    return items


def _result_columns(ws, header_row, cols):
    """该 Sheet 所有"测试结果类"列，返回 [(col, header_text)]，按列号升序。

    包含主结果列（cols["result"]）以及其余表头命中 result 别名词库的列
    （如"rc9测试结果""S100测试结果"等轮次变体，复用打分+模糊匹配机制）。
    已被其他字段占用的列不参与，避免把"预期结果""结果备注"等误纳入。
    """
    other_used = {c for f, c in cols.items() if f != "result"}
    items = []
    for col_idx in range(1, min(ws.max_column, 60) + 1):
        text = _cell_str(ws.cell(row=header_row, column=col_idx).value)
        if not text or col_idx in other_used:
            continue
        if col_idx == cols.get("result") or \
                _field_score(_norm_header(text), "result") >= _MATCH_THRESHOLD:
            items.append((col_idx, text))
    return items


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


# 可编辑字段若在文件中缺失，按此顺序幂等补齐表头列，确保前端可编辑项都有落地列
_ENSURE_COLUMN_SPECS = [
    ("result", HEADER_RESULT),
    ("note", HEADER_NOTE),
    ("tester", HEADER_TESTER),
    ("bugId", HEADER_BUGID),
    ("actual", HEADER_ACTUAL),
    ("foundTime", HEADER_FOUND_TIME),
]


def _ensure_extra_columns(ws, header_row, cols):
    """幂等地为可执行 Sheet 补齐所有可编辑字段列。

    包括测试结果/备注/测试人员/BugID/实际现象/发现时间；已存在（含模糊
    匹配命中）的不重复添加。返回 (changed, cols)，cols 会被补充对应列号。
    """
    changed = False
    next_col = _last_header_col(ws, header_row) + 1
    for field, header in _ENSURE_COLUMN_SPECS:
        if field in cols:
            continue
        ws.cell(row=header_row, column=next_col).value = header
        cols[field] = next_col
        next_col += 1
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


# 预览表格最大列数（矩阵页结果列超出此范围时不提供行内编辑）
_PREVIEW_MAX_COLS = 30


def _sheet_grid(ws, header_row, max_rows=200, max_cols=_PREVIEW_MAX_COLS):
    """把 Sheet 内容读为行列表（用于预览）。

    每行为 {"r": 真实行号, "cells": [...]}，保留行号以支持矩阵页结果写回定位。
    """
    start = 1
    row_end = min(ws.max_row, start + max_rows - 1)
    col_end = min(ws.max_column, max_cols)
    rows = []
    for r in range(start, row_end + 1):
        row_vals = []
        any_val = False
        for c in range(1, col_end + 1):
            v = _cell_str(ws.cell(row=r, column=c).value)
            if v:
                any_val = True
            row_vals.append(v)
        if any_val:
            rows.append({"r": r, "cells": row_vals})
    return rows


def _matrix_row_fingerprint(ws, row_idx):
    """矩阵行指纹：该行首个非空单元格文本，用于写回前校验行未错位。"""
    for col_idx in range(1, min(ws.max_column, 60) + 1):
        v = _cell_str(ws.cell(row=row_idx, column=col_idx).value)
        if v:
            return v
    return ""


def _matrix_result_cols(ws, header_row, max_cols=_PREVIEW_MAX_COLS):
    """矩阵页全部结果列号（升序）。每列对应一种测试条件，均可行内编辑。

    一列满足任一规则即入选（表头含"备注"的列始终排除）：
    A. 表头含"结果"/"result"（如 测试结果 / S100测试结果 / 宽路结果）；
    B. 正文结果 token 命中 ≥ 2，或命中 ≥ 1 且占该列非空正文单元格一半以上
       （覆盖"避障/乘梯"这类表头为条件名、正文为 通过/失败 的列）。
    """
    cols = []
    row_end = min(ws.max_row, header_row + 200)
    for col_idx in range(1, min(ws.max_column, max_cols) + 1):
        htext = _cell_str(ws.cell(row=header_row, column=col_idx).value).lower()
        if "备注" in htext or "note" in htext:
            continue
        if "结果" in htext or "result" in htext:
            cols.append(col_idx)
            continue
        hits = 0
        non_empty = 0
        for r in range(header_row + 1, row_end + 1):
            v = _cell_str(ws.cell(row=r, column=col_idx).value)
            if not v:
                continue
            non_empty += 1
            if v.upper() in RESULT_TOKENS:
                hits += 1
        if hits >= 2 or (hits >= 1 and hits * 2 >= non_empty):
            cols.append(col_idx)
    return cols


def _anchor_cell(ws, row_idx, col_idx):
    """若目标位于合并区域，返回其左上角锚点单元格（否则返回自身）。

    直接对 MergedCell 赋值会抛“attribute 'value' is read-only”，
    矩阵/场景页常见纵向合并结果列，统一写入锚点。
    """
    cell = ws.cell(row=row_idx, column=col_idx)
    if isinstance(cell, MergedCell):
        for rng in ws.merged_cells.ranges:
            if (rng.min_row <= row_idx <= rng.max_row
                    and rng.min_col <= col_idx <= rng.max_col):
                return ws.cell(row=rng.min_row, column=rng.min_col)
    return cell


def parse_workbook(path):
    """解析工作簿，返回 (payload, header_changed)。

    payload: {
        cases: [...],            # 仅 functional + scenario
        sheets: [{name, kind, title}],
        previews: [{sheet, kind, title, grid, images}],  # matrix + info
        progress: {done, total},
    }
    若补齐了新增列表头会自动保存。
    整个解析（含补列保存）持写锁执行，避免与 update_case 的写回交错
    导致丢失更新。
    """
    with _write_lock:
        return _parse_workbook_unlocked(path)


def _parse_workbook_unlocked(path):
    wb = openpyxl.load_workbook(path)
    sheet_images = _extract_sheet_images(path)

    cases = []
    sheets_meta = []
    previews = []
    result_columns_map = {}
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
            # 结果类列（多轮次）：随负载给出列名列表；从 extras 排除避免重复展示
            result_cols = _result_columns(ws, header_row, cols)
            result_columns_map[ws.title] = [h for _, h in result_cols]
            extra_cols = _extra_columns(ws, header_row, cols,
                                        exclude=[c for c, _ in result_cols])
            sheet_cases = []
            for row_idx in range(header_row + 1, ws.max_row + 1):
                if not _is_real_case(ws, row_idx, cols, meta["kind"]):
                    continue

                def g(field):
                    col = cols.get(field)
                    return _cell_str(ws.cell(row=row_idx, column=col).value) if col else ""

                extras = []
                for col_idx, header in extra_cols:
                    val = _cell_str(ws.cell(row=row_idx, column=col_idx).value)
                    if val:
                        extras.append({"header": header, "value": val})

                # 各结果列取值：{列名: 值}（重复表头取首个，避免键覆盖）
                results = {}
                for col_idx, header in result_cols:
                    if header not in results:
                        results[header] = _cell_str(
                            ws.cell(row=row_idx, column=col_idx).value)

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
                    "results": results,
                    "bugId": g("bugId"),
                    "tester": g("tester"),
                    "note": g("note"),
                    "actual": g("actual"),
                    "foundTime": g("foundTime"),
                    "extras": extras,
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
            # matrix / info：预览（矩阵页各结果列可行内编辑，其余只读）
            header_row = meta["headerRow"] or 1
            result_cols = (_matrix_result_cols(ws, header_row)
                           if meta["kind"] == "matrix" else [])
            previews.append({
                "sheet": ws.title,
                "kind": meta["kind"],
                "title": meta["title"],
                "rows": _sheet_grid(ws, header_row),
                "headerRow": header_row,
                "resultCols": result_cols,
                "images": sheet_images.get(ws.title, []),
            })

    if header_changed:
        try:
            _atomic_save(wb, path)
        except OSError:
            # 文件被占用（如正在 Excel 中打开）时，补齐的列无法立即落盘；
            # 不阻断页面展示，待下次成功写回时再持久化。
            header_changed = False
    wb.close()

    done = sum(1 for c in cases if c["result"])
    payload = {
        "cases": cases,
        "sheets": sheets_meta,
        "previews": previews,
        "resultColumns": result_columns_map,
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


def update_case(path, sheet, row_index, fields, expected_name=None,
                result_col=None, result_column=None):
    """写回单条用例的执行结果并原子保存。返回最新进度。

    fields: dict，键可为 result/bugId/tester/note/actual/foundTime；
    目标列按该 Sheet 的表头动态解析（多结果列时取首个）。
    matrix 页仅允许写回 result 单字段，需通过 result_col 指明目标结果列
    （多结果列对应不同测试条件），不补列、不改动其余内容。
    result_column: 可选，功能/场景页 result 字段的目标结果列表头名
    （测试轮次，如"rc10测试结果"）；未匹配到时回退主结果列，
    其余字段不受影响。与矩阵页的 result_col（列号）互不相干。
    expected_name: 可选，前端所见的用例名（caseId/标题/场景；矩阵页为
    行首个非空单元格），用于校验目标行未因外部编辑而错位。
    校验失败或没有任何字段落地时抛 ValueError。
    """
    with _write_lock:
        wb = openpyxl.load_workbook(path)
        try:
            if sheet not in wb.sheetnames:
                raise ValueError("Sheet 不存在: %s" % sheet)
            ws = wb[sheet]
            meta = classify_sheet(ws)
            if meta["kind"] not in ("functional", "scenario", "matrix"):
                raise ValueError("该 Sheet 为只读页（%s），不支持写回: %s"
                                 % (meta["kind"], sheet))
            header_row = meta["headerRow"]
            cols = meta["columns"]
            if not (header_row < row_index <= ws.max_row):
                raise ValueError("目标行号超出范围，文件可能已被外部修改，请刷新页面后重试")

            # 矩阵页：仅写回 result 单字段到指定结果列，行指纹校验后直接落地
            if meta["kind"] == "matrix":
                valid_cols = _matrix_result_cols(ws, header_row)
                if not valid_cols:
                    raise ValueError("该矩阵页未识别到结果列，不支持编辑")
                if "result" not in fields:
                    raise ValueError("矩阵页仅支持修改测试结果")
                if not result_col:
                    raise ValueError("矩阵页写回需指定结果列")
                if result_col not in valid_cols:
                    raise ValueError("该列不是可编辑的结果列")
                if expected_name:
                    fp = _matrix_row_fingerprint(ws, row_index)
                    if fp != expected_name:
                        raise ValueError("目标行与页面所见内容不一致（文件可能被外部修改），请刷新页面后重试")
                value = fields["result"]
                _anchor_cell(ws, row_index, result_col).value = (
                    value if value != "" else None)
                _atomic_save(wb, path)
                return _compute_progress(wb)

            _, cols = _ensure_extra_columns(ws, header_row, cols)

            # 测试轮次：按表头名解析 result 的目标写入列（未匹配回退主列）
            result_cols = (_result_columns(ws, header_row, cols)
                           if result_column else [])

            # 校验目标行内容与页面所见一致，防止外部插/删行后写错行
            if expected_name:
                def _val(field):
                    col = cols.get(field)
                    return _cell_str(ws.cell(row=row_index, column=col).value) if col else ""
                row_name = _val("caseId") or _val("title") or _val("scenario") or "(未命名)"
                if row_name != expected_name:
                    raise ValueError("目标行与页面所见用例不一致（文件可能被外部修改），请刷新页面后重试")

            written = False
            for key, value in fields.items():
                if key not in _WRITABLE_FIELDS:
                    continue
                col = cols.get(key)
                if key == "result" and result_column:
                    col = next((c for c, h in result_cols
                                if h == result_column), col)
                if not col:
                    continue
                _anchor_cell(ws, row_index, col).value = value if value != "" else None
                written = True
            if fields and not written:
                raise ValueError("未找到可写回的字段列，写回未生效")

            _atomic_save(wb, path)
            return _compute_progress(wb)
        finally:
            wb.close()


def add_result_column(path, name):
    """在所有可执行 Sheet（功能/场景）表头末尾统一新增一个结果列。

    用于开启新一轮测试（如"rc11测试结果"）。校验：
    - 列名非空且不超过 30 字；
    - 须命中 result 别名打分（保证新列必然被识别为结果列）；
    - 不得与任一可执行 Sheet 的现有结果列重名（归一化比较）。
    校验失败抛 ValueError；文件被占用时由 _atomic_save 抛 OSError。
    """
    name = _cell_str(name)
    if not name:
        raise ValueError("列名不能为空")
    if len(name) > 30:
        raise ValueError("列名过长（最多 30 个字符）")
    if _field_score(_norm_header(name), "result") < _MATCH_THRESHOLD:
        raise ValueError('列名需包含"测试结果"等结果类关键词，如：rc11测试结果')
    with _write_lock:
        wb = openpyxl.load_workbook(path)
        try:
            targets = list(_iter_case_sheets(wb))
            if not targets:
                raise ValueError("该文件没有可执行的用例 Sheet")
            norm_new = _norm_header(name).replace(" ", "")
            for ws, meta in targets:
                for _, header in _result_columns(
                        ws, meta["headerRow"], meta["columns"]):
                    if _norm_header(header).replace(" ", "") == norm_new:
                        raise ValueError(
                            "结果列已存在：%s（%s）" % (header, ws.title))
            for ws, meta in targets:
                header_row = meta["headerRow"]
                col = _last_header_col(ws, header_row) + 1
                ws.cell(row=header_row, column=col).value = name
            _atomic_save(wb, path)
        finally:
            wb.close()


def clear_result_column(path, column_name):
    """批量清空所有可执行 Sheet 中当前轮次结果列的用例结果。

    column_name: 目标结果列表头名（测试轮次）；每个 Sheet 按与前端
    effectiveColFor 一致的口径解析——表头匹配则用之，否则回退该
    Sheet 首个结果列，保证"清的就是页面上看到的"。空串即回退语义。
    仅清空真实用例行（跳过分组标题/空行），其余字段与其他轮次列不动。
    返回 {"cleared": N, "progress": {...}}。
    """
    target_name = _cell_str(column_name)
    with _write_lock:
        wb = openpyxl.load_workbook(path)
        try:
            targets = list(_iter_case_sheets(wb))
            if not targets:
                raise ValueError("该文件没有可执行的用例 Sheet")
            cleared = 0
            for ws, meta in targets:
                header_row = meta["headerRow"]
                cols = meta["columns"]
                result_cols = _result_columns(ws, header_row, cols)
                if not result_cols:
                    continue
                col = next((c for c, h in result_cols if h == target_name),
                           result_cols[0][0])
                for row_idx in range(header_row + 1, ws.max_row + 1):
                    if not _is_real_case(ws, row_idx, cols, meta["kind"]):
                        continue
                    cell = _anchor_cell(ws, row_idx, col)
                    if _cell_str(cell.value):
                        cell.value = None
                        cleared += 1
            if cleared:
                _atomic_save(wb, path)
            return {"cleared": cleared, "progress": _compute_progress(wb)}
        finally:
            wb.close()


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
