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

import difflib
import hashlib
import json
import os
import re
import shutil
import tempfile
from collections import defaultdict
from datetime import datetime, timedelta
from threading import Lock
from urllib.parse import quote
from uuid import uuid4

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

# 解析扫描范围上限（防御异常宽/高的表格拖慢解析，正常用例文件远小于此）
_MAX_SCAN_COLS = 60        # 字段列解析/结果列识别扫描的最大列数
_HEADER_SCAN_ROWS = 6      # 表头行探测范围：只在前若干行内找
_HEADER_SCAN_COLS = 40     # 表头行探测时每行统计的最大列数
_MATRIX_SCAN_ROWS = 40     # 矩阵启发式判定扫描的正文行数
_MATRIX_SCAN_COLS = 30     # 矩阵启发式判定扫描的列数
_TITLE_SCAN_COLS = 10      # Sheet 展示标题在表头上方扫描的列数
_PREVIEW_MAX_ROWS = 200    # 预览网格/矩阵结果列判定读取的最大行数

# 写文件锁，避免并发写回损坏文件
_write_lock = Lock()

# 解析结果缓存：abspath -> ((mtime_ns, size), payload)。持 _write_lock 读写。
_parse_cache = {}
_PARSE_CACHE_MAX = 8

# v2.1 工作簿内的轻量活动元数据。该 Sheet 始终隐藏，并由解析器统一跳过。
RUN_SHEET_NAME = "_qoder_runs"
RUN_HEADERS = [
    "runId", "resultHeader", "stage", "tester", "version", "build",
    "device", "environment", "scope", "startedAt", "endedAt", "status",
    "updatedAt",
]
RUN_FIELDS = tuple(RUN_HEADERS)

TASK_SHEET_NAME = "_qoder_tasks"
TASK_HEADERS = [
    "taskId", "runId", "tester", "assignedAt", "dueAt", "status",
    "createdAt", "returnedAt", "mergedAt", "targetCount", "targets",
    "exportName", "note", "updatedAt",
]
TASK_FIELDS = tuple(TASK_HEADERS)


def _cell_str(value):
    """将单元格值规范为去除首尾空白的字符串。"""
    if value is None:
        return ""
    return str(value).strip()


def file_fingerprint(path):
    """返回用于客户端断点/写回校验的文件指纹。"""
    st = os.stat(path)
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return {
        "mtimeNs": st.st_mtime_ns,
        "size": st.st_size,
        "sha256": digest.hexdigest(),
    }


def _norm_header(value):
    """规范化表头文本用于匹配：去空白、去结尾星号、小写化。"""
    s = _cell_str(value)
    s = s.replace("*", "").replace("＊", "")
    s = " ".join(s.split())  # 折叠内部空白
    return s.lower()


def _header_match_key(value):
    """返回表头匹配键：忽略空白、标点和分隔符，保留中英文文字与数字。"""
    return re.sub(r"[\W_]+", "", _norm_header(value), flags=re.UNICODE)


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
    header_key = _header_match_key(header_norm)
    best = 0.0
    for alias in _FIELD_ALIAS_NORM[field]:
        alias_key = _header_match_key(alias)
        if not header_key or not alias_key:
            continue
        if header_key == alias_key:
            return 1.0
        if alias_key in header_key or header_key in alias_key:
            shorter = min(len(alias_key), len(header_key))
            longer = max(len(alias_key), len(header_key)) or 1
            score = 0.6 + 0.3 * (shorter / longer)
            if score > best:
                best = score
        elif len(header_key) >= 2 and len(alias_key) >= 2:
            ratio = difflib.SequenceMatcher(None, header_key, alias_key).ratio()
            if ratio >= _FUZZY_THRESHOLD and ratio > best:
                best = ratio
    return best


def _similarity(a, b):
    """两段文本的 difflib 相似度，用于子任务合入的标题/步骤模糊兜底匹配。

    空串与空串视为 1.0（两边都空无比较意义），单边为空视为 0.0。
    阈值复用 _FUZZY_THRESHOLD=0.82。
    """
    a = _cell_str(a)
    b = _cell_str(b)
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    return difflib.SequenceMatcher(None, a, b).ratio()


def _subtask_fingerprint(case_id, title, steps):
    """用例身份指纹：sha1(caseId|title|steps)，各段 strip + 折叠空白。

    仅使用前端不可编辑的身份字段（编号/标题/步骤），多标签页并发合入
    互不破坏校验；导出与合入必须共用此函数保证确定性。
    """
    def _norm(part):
        return " ".join(_cell_str(part).split())
    raw = "|".join([_norm(case_id), _norm(title), _norm(steps)])
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def _find_header_row(ws):
    """在前若干行中定位表头行：取"非空单元格最多"的一行。找不到返回 None。

    要求该行至少含 2 个非空单元格，避免把标题行/空行当表头。
    """
    max_scan = min(ws.max_row, _HEADER_SCAN_ROWS)
    best_row = None
    best_count = 0
    for row_idx in range(1, max_scan + 1):
        count = 0
        for col_idx in range(1, min(ws.max_column, _HEADER_SCAN_COLS) + 1):
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
    max_col = min(ws.max_column, _MAX_SCAN_COLS)
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
    for col_idx in range(1, min(ws.max_column, _MAX_SCAN_COLS) + 1):
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
    for col_idx in range(1, min(ws.max_column, _MAX_SCAN_COLS) + 1):
        text = _cell_str(ws.cell(row=header_row, column=col_idx).value)
        if not text or col_idx in other_used:
            continue
        if col_idx == cols.get("result") or \
                _field_score(_norm_header(text), "result") >= _MATCH_THRESHOLD:
            items.append((col_idx, text))
    return items


def _effective_result_col(result_cols, target_name):
    """轮次结果列回退解析的唯一口径（前端 effectiveColFor 与此保持一致）：

    目标表头名在该 Sheet 结果列中则用之，否则回退首个结果列
    （即页面上实际显示的列），保证"写的/清的就是看到的"。
    result_cols 为空返回 None。
    """
    if not result_cols:
        return None
    for col, header in result_cols:
        if header == target_name:
            return col, header
    return result_cols[0]


def _last_header_col(ws, header_row):
    """表头行最右侧非空列号。"""
    last = 0
    for col_idx in range(1, min(ws.max_column, _MAX_SCAN_COLS) + 1):
        if _cell_str(ws.cell(row=header_row, column=col_idx).value):
            last = col_idx
    return last


def _name_is_info(name):
    low = (name or "").lower()
    return any(kw in low for kw in INFO_NAME_KEYWORDS)


def _looks_like_matrix(ws, header_row):
    """启发式：正文中出现多个结果类取值(PASS/FAIL/...)则视为结果矩阵。"""
    hits = 0
    row_end = min(ws.max_row, header_row + _MATRIX_SCAN_ROWS)
    col_end = min(ws.max_column, _MATRIX_SCAN_COLS)
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
        for col_idx in range(1, min(ws.max_column, _TITLE_SCAN_COLS) + 1):
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


def _field_mapping(meta, ws):
    """把内部字段列映射转成预检可直接展示的结构。"""
    headers = {}
    if meta.get("headerRow"):
        for field, col in meta.get("columns", {}).items():
            headers[field] = _cell_str(ws.cell(
                row=meta["headerRow"], column=col).value)
    mappings = []
    for field in _FIELD_ORDER:
        mappings.append({
            "field": field,
            "header": headers.get(field, ""),
            "column": meta.get("columns", {}).get(field),
            "status": "matched" if field in headers else "missing",
        })
    return mappings


def inspect_workbook(path):
    """只读预检工作簿，不补列表头、不保存文件。

    预检使用与正式解析相同的 Sheet 分类和表头识别规则，但只读取
    已存在的列，明确列出正式加载时可能发生的自动补列行为。
    """
    with _write_lock:
        before = file_fingerprint(path)
        wb = openpyxl.load_workbook(path)
        try:
            sheets = []
            skipped = []
            warnings = []
            changes = []
            executable_total = 0
            for ws in wb.worksheets:
                if ws.title.startswith("_qoder"):
                    skipped.append({"name": ws.title, "reason": "系统元数据页"})
                    continue
                meta = classify_sheet(ws)
                mappings = _field_mapping(meta, ws)
                case_count = 0
                result_headers = []
                if meta["kind"] in ("functional", "scenario"):
                    for row_idx in range((meta["headerRow"] or 0) + 1,
                                         ws.max_row + 1):
                        if _is_real_case(ws, row_idx, meta["columns"],
                                         meta["kind"]):
                            case_count += 1
                    result_headers = [h for _, h in _result_columns(
                        ws, meta["headerRow"], meta["columns"])]
                    executable_total += case_count
                    for item in mappings:
                        if item["field"] in ("result", "note", "tester",
                                              "bugId", "actual", "foundTime") \
                                and item["status"] == "missing":
                            changes.append({
                                "sheet": ws.title,
                                "field": item["field"],
                                "header": dict(_ENSURE_COLUMN_SPECS).get(
                                    item["field"], item["field"]),
                                "action": "addColumn",
                            })
                if meta["kind"] in ("matrix", "info"):
                    skipped.append({
                        "name": ws.title,
                        "reason": "只读预览页",
                        "kind": meta["kind"],
                    })
                sheets.append({
                    "name": ws.title,
                    "kind": meta["kind"],
                    "title": meta["title"],
                    "hidden": ws.sheet_state != "visible",
                    "headerRow": meta["headerRow"],
                    "caseCount": case_count,
                    "resultHeaders": result_headers,
                    "fieldMappings": mappings,
                })

            if not executable_total:
                warnings.append({
                    "level": "error",
                    "code": "NO_CASES",
                    "message": "未识别到可执行用例，请检查表头或文件内容",
                })
            if changes:
                warnings.append({
                    "level": "warning",
                    "code": "AUTO_COLUMNS",
                    "message": "正式加载时将自动补齐可编辑字段列",
                })
            if skipped:
                warnings.append({
                    "level": "info",
                    "code": "READ_ONLY_SHEETS",
                    "message": "部分 Sheet 将作为只读预览或系统页处理",
                })

            # 仅提示近似同分的表头，正式识别仍沿用现有确定性规则。
            for item in sheets:
                ws = wb[item["name"]]
                header_row = item["headerRow"]
                if not header_row:
                    continue
                for col in range(1, min(ws.max_column, _MAX_SCAN_COLS) + 1):
                    header = _norm_header(ws.cell(row=header_row, column=col).value)
                    if not header:
                        continue
                    ranked = sorted(
                        ((_field_score(header, field), field)
                         for field in _FIELD_ORDER), reverse=True)
                    if (ranked[0][0] >= _MATCH_THRESHOLD and
                            ranked[1][0] >= _MATCH_THRESHOLD and
                            ranked[0][0] - ranked[1][0] < 0.05):
                        warnings.append({
                            "level": "warning",
                            "code": "AMBIGUOUS_HEADER",
                            "sheet": item["name"],
                            "column": col,
                            "message": "表头“%s”可能同时匹配 %s / %s，正式解析将按优先级选择"
                                       % (header, ranked[0][1], ranked[1][1]),
                        })
            return {
                "fileName": os.path.basename(path),
                "fileSize": before["size"],
                "fingerprint": before,
                "sheetCount": len(sheets),
                "executableCaseCount": executable_total,
                "sheets": sheets,
                "skippedSheets": skipped,
                "warnings": warnings,
                "changes": changes,
            }
        finally:
            wb.close()


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


def _img_fmt(img):
    """图片 MIME 子类型（png/jpeg/...），未知按 png 处理。"""
    fmt = (getattr(img, "format", None) or "png").lower()
    return "jpeg" if fmt == "jpg" else fmt


def _sheet_image_meta(wb):
    """读取各 Sheet 内嵌图片的锚点元信息（不取字节，不消费图片流）。

    返回 {sheet: [{row, col, src}]}，src 为惰性加载端点 URL，
    idx 与 ws._images 顺序一一对应（get_sheet_image 按同序取字节）。
    图片字节不再随解析负载下发，大幅缩小 JSON 体积与解析内存。
    """
    result = {}
    for ws in wb.worksheets:
        items = []
        for idx, img in enumerate(getattr(ws, "_images", None) or []):
            row, col = _img_anchor(img)
            items.append({
                "row": row,
                "col": col,
                "src": "/api/sheet-image?sheet=%s&idx=%d"
                       % (quote(ws.title), idx),
            })
        if items:
            result[ws.title] = items
    return result


# 图片字节缓存：abspath -> ((mtime_ns, size), {sheet: [(bytes|None, fmt)]})
# 首次请求时整册提取一次，同指纹内直接命中；图片体积大，仅保留少量文件。
_image_cache = {}
_IMAGE_CACHE_MAX = 2


def get_sheet_image(path, sheet, idx):
    """按需取某 Sheet 第 idx 张内嵌图片，返回 (bytes, fmt) 或 None。

    idx 对应 _sheet_image_meta 生成的顺序；文件变化（指纹不符）自动重提。
    """
    key = os.path.abspath(path)
    with _write_lock:
        st = os.stat(path)
        fingerprint = (st.st_mtime_ns, st.st_size)
        hit = _image_cache.get(key)
        if not hit or hit[0] != fingerprint:
            if len(_image_cache) >= _IMAGE_CACHE_MAX and key not in _image_cache:
                _image_cache.pop(next(iter(_image_cache)))
            _image_cache[key] = (fingerprint, _extract_all_images(path))
        images = _image_cache[key][1].get(sheet) or []
        if 0 <= idx < len(images) and images[idx][0]:
            return images[idx]
        return None


def _extract_all_images(path):
    """整册提取内嵌图片字节，返回 {sheet: [(bytes|None, fmt)]}。

    使用独立的工作簿实例读取：调用 img._data() 会消费底层图片流，若在
    随后需要保存的同一工作簿上执行会导致 save 失败/丢图，故单独加载再丢弃。
    每张图占一个槽位（取不到字节记 None），保证与锚点元信息的 idx 对齐。
    """
    result = {}
    try:
        wb = openpyxl.load_workbook(path)
    except Exception:
        return result
    try:
        for ws in wb.worksheets:
            items = []
            for img in getattr(ws, "_images", None) or []:
                items.append((_img_bytes(img), _img_fmt(img)))
            if items:
                result[ws.title] = items
    finally:
        wb.close()
    return result


# 预览表格最大列数（矩阵页结果列超出此范围时不提供行内编辑）
_PREVIEW_MAX_COLS = 30


def _sheet_grid(ws, header_row, max_rows=_PREVIEW_MAX_ROWS,
                max_cols=_PREVIEW_MAX_COLS):
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
    for col_idx in range(1, min(ws.max_column, _MAX_SCAN_COLS) + 1):
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
    row_end = min(ws.max_row, header_row + _PREVIEW_MAX_ROWS)
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

    结果按 (mtime_ns, size) 缓存：文件未变时直接命中，避免大文件反复
    解析；任何写回都经 _atomic_save 替换文件而使指纹变化，自动失效。
    """
    key = os.path.abspath(path)
    with _write_lock:
        st = os.stat(path)
        fingerprint = (st.st_mtime_ns, st.st_size)
        hit = _parse_cache.get(key)
        if hit and hit[0] == fingerprint:
            return dict(hit[1]), False
        payload, header_changed = _parse_workbook_unlocked(path)
        if header_changed:
            # 补列已落盘，指纹以保存后的文件为准
            st = os.stat(path)
            fingerprint = (st.st_mtime_ns, st.st_size)
        if len(_parse_cache) >= _PARSE_CACHE_MAX and key not in _parse_cache:
            # 极简淘汰：满了清最早插入的一条（文件数通常远小于上限）
            _parse_cache.pop(next(iter(_parse_cache)))
        _parse_cache[key] = (fingerprint, payload)
        return dict(payload), header_changed


def _collect_sheet_cases(ws, meta, imgs, start_index):
    """解析一个功能/场景页的全部用例行。

    返回 (header_changed, cases, round_headers)：
    - cases 的 globalIndex 从 start_index 起连续编号；
    - round_headers 为该页全部结果类列的表头名列表（多轮次候选）。
    """
    header_row = meta["headerRow"]
    cols = meta["columns"]
    header_changed, cols = _ensure_extra_columns(ws, header_row, cols)

    # 结果类列（多轮次）：随负载给出列名列表；从 extras 排除避免重复展示
    result_cols = _result_columns(ws, header_row, cols)
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
            "globalIndex": start_index + len(sheet_cases),
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
        sheet_cases.append(case)

    # 所有可执行 Sheet 都可能包含内嵌示意图，按锚点行归属到覆盖该行区间的用例。
    if imgs and sheet_cases:
        for i, case in enumerate(sheet_cases):
            start_row = case["rowIndex"]
            end_row = (sheet_cases[i + 1]["rowIndex"]
                       if i + 1 < len(sheet_cases) else ws.max_row + 1)
            case["images"] = [im["src"] for im in imgs
                              if start_row <= im["row"] < end_row]

    round_headers = [h for _, h in result_cols]
    return header_changed, sheet_cases, round_headers


def _build_preview(ws, meta, images):
    """matrix / info 页的只读预览负载（矩阵页各结果列可行内编辑）。"""
    header_row = meta["headerRow"] or 1
    result_cols = (_matrix_result_cols(ws, header_row)
                   if meta["kind"] == "matrix" else [])
    return {
        "sheet": ws.title,
        "kind": meta["kind"],
        "title": meta["title"],
        "rows": _sheet_grid(ws, header_row),
        "headerRow": header_row,
        "resultCols": result_cols,
        "images": images,
    }


def _parse_workbook_unlocked(path):
    wb = openpyxl.load_workbook(path)
    # 只读锚点元信息，图片字节由 /api/sheet-image 惰性提供
    sheet_images = _sheet_image_meta(wb)

    cases = []
    sheets_meta = []
    previews = []
    result_columns_map = {}
    header_changed = False
    runs = _read_runs_from_wb(wb)

    for ws in wb.worksheets:
        # 子任务元数据页（_qoder_map 等）跳过，避免被误判为用例页/信息页
        if ws.title.startswith("_qoder"):
            continue
        meta = classify_sheet(ws)
        sheets_meta.append({"name": ws.title, "kind": meta["kind"], "title": meta["title"]})
        imgs = sheet_images.get(ws.title, [])

        if meta["kind"] in ("functional", "scenario"):
            changed, sheet_cases, round_headers = _collect_sheet_cases(
                ws, meta, imgs, len(cases))
            if changed:
                header_changed = True
            cases.extend(sheet_cases)
            result_columns_map[ws.title] = round_headers
        else:
            previews.append(_build_preview(ws, meta, imgs))

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
        "runs": runs,
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
        _parse_cache.pop(os.path.abspath(path), None)
        _image_cache.pop(os.path.abspath(path), None)
    except Exception:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        raise


_BACKUP_KEEP = 10  # 同一源文件保留的最近备份数，超出自动清理


def make_backup(path, backup_dir):
    """在 backup_dir 生成带时间戳的备份，返回备份路径。

    同一源文件仅保留最近 _BACKUP_KEEP 份，避免 backups 目录无限增长；
    清理失败不影响备份本身（静默跳过被占用的旧文件）。
    """
    os.makedirs(backup_dir, exist_ok=True)
    base = os.path.splitext(os.path.basename(path))[0]
    clock = datetime.now()
    backup_path = None
    for offset in range(100):
        ts = (clock + timedelta(seconds=offset)).strftime("%Y%m%d_%H%M%S")
        candidate = os.path.join(backup_dir, "backup_%s_%s.xlsx" % (base, ts))
        if not os.path.exists(candidate):
            backup_path = candidate
            break
    if backup_path is None:
        raise OSError("无法生成唯一备份文件名")
    shutil.copy2(path, backup_path)
    _prune_backups(backup_dir, base)
    return backup_path


def _backup_pattern(base):
    return re.compile(r"^backup_%s_\d{8}_\d{6}\.xlsx$" % re.escape(base))


def list_backups(path, backup_dir):
    """返回某个源文件的可恢复备份，严禁把相近文件名混入。"""
    base = os.path.splitext(os.path.basename(path))[0]
    pattern = _backup_pattern(base)
    result = []
    try:
        names = os.listdir(backup_dir)
    except OSError:
        names = []
    for name in names:
        if not pattern.match(name):
            continue
        full = os.path.abspath(os.path.join(backup_dir, name))
        try:
            st = os.stat(full)
        except OSError:
            continue
        result.append({
            "id": name,
            "name": name,
            "sourceName": os.path.basename(path),
            "mtime": int(st.st_mtime),
            "size": st.st_size,
            "createdAt": datetime.fromtimestamp(st.st_mtime).isoformat(
                timespec="seconds"),
        })
    result.sort(key=lambda item: (item["mtime"], item["name"]), reverse=True)
    return result


def restore_backup(path, backup_id, backup_dir):
    """恢复指定备份；恢复前先留档，并通过临时文件原子替换。"""
    base = os.path.splitext(os.path.basename(path))[0]
    if not isinstance(backup_id, str) or not _backup_pattern(base).match(backup_id):
        raise ValueError("备份标识不合法")
    backup_root = os.path.abspath(backup_dir)
    backup_path = os.path.abspath(os.path.join(backup_root, backup_id))
    if os.path.dirname(backup_path) != backup_root or not os.path.isfile(backup_path):
        raise ValueError("备份不存在")
    with _write_lock:
        try:
            check = openpyxl.load_workbook(backup_path, read_only=True)
            check.close()
        except Exception as exc:
            raise ValueError("备份文件损坏，无法恢复: %s" % exc)
        before_backup = make_backup(path, backup_dir) if os.path.exists(path) else None
        directory = os.path.dirname(os.path.abspath(path)) or "."
        fd, tmp_path = tempfile.mkstemp(suffix=".xlsx", dir=directory)
        os.close(fd)
        try:
            shutil.copy2(backup_path, tmp_path)
            os.replace(tmp_path, path)
        except Exception:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
            raise
        _parse_cache.pop(os.path.abspath(path), None)
        _image_cache.pop(os.path.abspath(path), None)
        return {
            "backup": backup_id,
            "beforeBackup": os.path.basename(before_backup)
                             if before_backup else None,
            "fingerprint": file_fingerprint(path),
        }


def _read_runs_from_wb(wb):
    """从已打开的工作簿读取活动元数据，缺失 Sheet 兼容旧文件。"""
    if RUN_SHEET_NAME not in wb.sheetnames:
        return []
    ws = wb[RUN_SHEET_NAME]
    headers = [_cell_str(cell.value) for cell in ws[1]]
    indices = {name: idx for idx, name in enumerate(headers) if name}
    rows = []
    for row in ws.iter_rows(min_row=2, values_only=True):
        record = {}
        for field in RUN_FIELDS:
            idx = indices.get(field)
            record[field] = _cell_str(row[idx]) if idx is not None and idx < len(row) else ""
        if record.get("runId"):
            rows.append(record)
    return rows


def list_runs(path):
    with _write_lock:
        wb = openpyxl.load_workbook(path)
        try:
            return _read_runs_from_wb(wb)
        finally:
            wb.close()


def _ensure_runs_sheet(wb):
    if RUN_SHEET_NAME in wb.sheetnames:
        ws = wb[RUN_SHEET_NAME]
    else:
        ws = wb.create_sheet(RUN_SHEET_NAME)
        ws.sheet_state = "hidden"
        for col, header in enumerate(RUN_HEADERS, 1):
            ws.cell(row=1, column=col, value=header)
    return ws


def _run_value(data, field, default=""):
    value = data.get(field, default) if isinstance(data, dict) else default
    if field == "scope" and isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return _cell_str(value)


def create_run(path, data):
    """新建一条活动上下文并隐藏存储在工作簿内。"""
    with _write_lock:
        wb = openpyxl.load_workbook(path)
        try:
            ws = _ensure_runs_sheet(wb)
            now = datetime.now().isoformat(timespec="seconds")
            record = {field: _run_value(data, field) for field in RUN_FIELDS}
            record["runId"] = record["runId"] or uuid4().hex
            record["startedAt"] = record["startedAt"] or now
            record["updatedAt"] = now
            record["status"] = record["status"] or "进行中"
            row = ws.max_row + 1
            for col, field in enumerate(RUN_HEADERS, 1):
                ws.cell(row=row, column=col, value=record[field] or None)
            _atomic_save(wb, path)
            return record
        finally:
            wb.close()


def update_run(path, run_id, data):
    with _write_lock:
        wb = openpyxl.load_workbook(path)
        try:
            if RUN_SHEET_NAME not in wb.sheetnames:
                raise ValueError("测试活动不存在")
            ws = wb[RUN_SHEET_NAME]
            headers = [_cell_str(cell.value) for cell in ws[1]]
            indices = {name: idx + 1 for idx, name in enumerate(headers) if name}
            id_col = indices.get("runId")
            if not id_col:
                raise ValueError("活动元数据格式无效")
            target = None
            for row in range(2, ws.max_row + 1):
                if _cell_str(ws.cell(row=row, column=id_col).value) == run_id:
                    target = row
                    break
            if target is None:
                raise ValueError("测试活动不存在")
            for field in RUN_FIELDS:
                if field in data and field != "runId" and field in indices:
                    ws.cell(row=target, column=indices[field]).value = _run_value(data, field)
            if "updatedAt" in indices:
                ws.cell(row=target, column=indices["updatedAt"]).value = datetime.now().isoformat(timespec="seconds")
            _atomic_save(wb, path)
            records = _read_runs_from_wb(wb)
            return next(item for item in records if item["runId"] == run_id)
        finally:
            wb.close()


def _read_tasks_from_wb(wb):
    """读取隐藏任务页；旧文件不存在该 Sheet 时返回空列表。"""
    if TASK_SHEET_NAME not in wb.sheetnames:
        return []
    ws = wb[TASK_SHEET_NAME]
    headers = [_cell_str(cell.value) for cell in ws[1]]
    indices = {name: idx for idx, name in enumerate(headers) if name}
    rows = []
    for row in ws.iter_rows(min_row=2, values_only=True):
        item = {}
        for field in TASK_FIELDS:
            idx = indices.get(field)
            item[field] = _cell_str(row[idx]) if idx is not None and idx < len(row) else ""
        if not item.get("taskId"):
            continue
        try:
            item["targetCount"] = int(item.get("targetCount") or 0)
        except (TypeError, ValueError):
            item["targetCount"] = 0
        try:
            item["targets"] = json.loads(item.get("targets") or "[]")
        except (TypeError, ValueError):
            item["targets"] = []
        rows.append(item)
    rows.sort(key=lambda item: item.get("updatedAt", ""), reverse=True)
    return rows


def list_tasks(path):
    with _write_lock:
        wb = openpyxl.load_workbook(path)
        try:
            return _read_tasks_from_wb(wb)
        finally:
            wb.close()


def _ensure_tasks_sheet(wb):
    if TASK_SHEET_NAME in wb.sheetnames:
        return wb[TASK_SHEET_NAME]
    ws = wb.create_sheet(TASK_SHEET_NAME)
    ws.sheet_state = "hidden"
    for col, header in enumerate(TASK_HEADERS, 1):
        ws.cell(row=1, column=col, value=header)
    return ws


def _task_value(data, field, default=""):
    value = data.get(field, default) if isinstance(data, dict) else default
    if field == "targets" and isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return _cell_str(value)


def create_task(path, data):
    """创建分发任务，目标行只存最小定位信息，不复制用例内容。"""
    with _write_lock:
        wb = openpyxl.load_workbook(path)
        try:
            ws = _ensure_tasks_sheet(wb)
            now = datetime.now().isoformat(timespec="seconds")
            record = {field: _task_value(data, field) for field in TASK_FIELDS}
            record["taskId"] = record["taskId"] or uuid4().hex
            record["createdAt"] = record["createdAt"] or now
            record["updatedAt"] = now
            record["status"] = record["status"] or "待执行"
            if not record["targetCount"]:
                try:
                    record["targetCount"] = str(len(json.loads(record["targets"] or "[]")))
                except (TypeError, ValueError):
                    record["targetCount"] = "0"
            row = ws.max_row + 1
            for col, field in enumerate(TASK_HEADERS, 1):
                ws.cell(row=row, column=col, value=record[field] or None)
            _atomic_save(wb, path)
            result = dict(record)
            result["targetCount"] = int(result["targetCount"] or 0)
            result["targets"] = json.loads(result["targets"] or "[]")
            return result
        finally:
            wb.close()


def update_task(path, task_id, data):
    with _write_lock:
        wb = openpyxl.load_workbook(path)
        try:
            if TASK_SHEET_NAME not in wb.sheetnames:
                raise ValueError("分发任务不存在")
            ws = wb[TASK_SHEET_NAME]
            headers = [_cell_str(cell.value) for cell in ws[1]]
            indices = {name: idx + 1 for idx, name in enumerate(headers) if name}
            id_col = indices.get("taskId")
            target = None
            for row in range(2, ws.max_row + 1):
                if _cell_str(ws.cell(row=row, column=id_col).value) == task_id:
                    target = row
                    break
            if target is None:
                raise ValueError("分发任务不存在")
            for field in TASK_FIELDS:
                if field in data and field != "taskId" and field in indices:
                    ws.cell(row=target, column=indices[field]).value = _task_value(data, field)
            if "updatedAt" in indices:
                ws.cell(row=target, column=indices["updatedAt"]).value = datetime.now().isoformat(timespec="seconds")
            _atomic_save(wb, path)
            records = _read_tasks_from_wb(wb)
            return next(item for item in records if item["taskId"] == task_id)
        finally:
            wb.close()


def _prune_backups(backup_dir, base):
    """删除同源多余备份，按文件名时间戳倒序保留最近 _BACKUP_KEEP 份。"""
    # 严格匹配"backup_源名_时间戳.xlsx"，避免源名互为前缀时误删他人备份
    pat = _backup_pattern(base)
    same = sorted(f for f in os.listdir(backup_dir) if pat.match(f))
    for name in same[:-_BACKUP_KEEP]:
        try:
            os.remove(os.path.join(backup_dir, name))
        except OSError:
            pass


def update_case(path, sheet, row_index, fields, expected_name=None,
                result_col=None, result_column=None):
    """写回单条用例的执行结果并原子保存。返回最新进度。

    fields: dict，键可为 result/bugId/tester/note/actual/foundTime；
    目标列按该 Sheet 的表头动态解析（多结果列时取首个）。
    matrix 页仅允许写回 result 单字段，需通过 result_col 指明目标结果列
    （多结果列对应不同测试条件），不补列、不改动其余内容。
    result_column: 可选，功能/场景页 result 字段的目标结果列表头名
    （测试轮次，如"rc10测试结果"）；回退口径见 _effective_result_col，
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
                    # 与前端 effectiveColFor 同口径：未匹配回退首个结果列
                    eff = _effective_result_col(result_cols, result_column)
                    if eff:
                        col = eff[0]
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

    column_name: 目标结果列表头名（测试轮次）；每个 Sheet 按
    _effective_result_col 唯一口径解析——表头匹配则用之，否则回退该
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
                eff = _effective_result_col(result_cols, target_name)
                if not eff:
                    continue
                col = eff[0]
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

# ==================== 子任务导出 / 结果合入 ====================

def export_subtask(path, targets, tester="", result_header=None, out_dir=None):
    """把 targets 指定的用例行导出为精简子集 xlsx（分发给辅助人员）。

    targets: [{sheet, rowIndex}]，来自前端筛选范围（visibleIndices）；
    仅支持 functional/scenario 用例行（矩阵页行不在 cases 中天然不出现）。
    tester: 非空时写入主文件对应用例的"测试人员"列，并在子文件预填同名。
    result_header: 目标结果列表头名；各 sheet 按 _effective_result_col 同口径
    回退（命中用之，否则回退该 sheet 主结果列）。
    out_dir: 子文件输出目录（app 传 uploads/tmp）；为 None 时与源文件同目录。
    返回子文件路径；写主文件 tester 经 _atomic_save（缓存指纹自动失效）。
    """
    if not targets:
        raise ValueError("没有要导出的用例，请先筛选或选择用例")
    with _write_lock:
        wb = openpyxl.load_workbook(path)
        try:
            # 按 sheet 分组目标行（保持首次出现顺序，去重）
            grouped = defaultdict(list)
            seen = set()
            for t in targets:
                key = (t.get("sheet"), t.get("rowIndex"))
                if key in seen or not isinstance(t.get("rowIndex"), int):
                    continue
                seen.add(key)
                grouped[t["sheet"]].append(t["rowIndex"])

            # 每个 sheet 的目标行：升序、仅真实用例行（分组行/空行剔除）
            sheet_rows = {}  # sheet -> (ws, meta, rows)
            for sheet_name in wb.sheetnames:
                if sheet_name not in grouped:
                    continue
                ws = wb[sheet_name]
                meta = classify_sheet(ws)
                if meta["kind"] not in ("functional", "scenario"):
                    continue
                rows = sorted(r for r in grouped[sheet_name]
                              if _is_real_case(ws, r, meta["columns"], meta["kind"]))
                if rows:
                    sheet_rows[sheet_name] = (ws, meta, rows)
            if not sheet_rows:
                raise ValueError("目标范围内没有可导出的用例行")

            export_ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            wb_sub = openpyxl.Workbook()
            wb_sub.remove(wb_sub.active)
            map_rows = []

            for sheet_name in wb.sheetnames:
                if sheet_name not in sheet_rows:
                    continue
                ws, meta, rows = sheet_rows[sheet_name]
                header_row = meta["headerRow"]
                cols = meta["columns"]
                result_cols = _result_columns(ws, header_row, cols)
                # 目标结果列：result_header 命中则该列，否则回退主结果列
                target_col = None
                if result_header:
                    for col, header in result_cols:
                        if _norm_header(header) == _norm_header(result_header):
                            target_col = col
                            break
                if target_col is None:
                    target_col = cols.get("result")
                skip_cols = {c for c, _ in result_cols if c != target_col}
                # 表头列映射：源列 -> 子文件列（跳过其余结果类列）
                kept = []
                nc = 1
                for c in range(1, _last_header_col(ws, header_row) + 1):
                    if c in skip_cols:
                        continue
                    kept.append((c, nc))
                    nc += 1

                sub_ws = wb_sub.create_sheet(sheet_name)
                # 表头行及其上方行原样复制（标题/说明行），保持表头行位置同源
                for r in range(1, header_row + 1):
                    for c, nc2 in kept:
                        sub_ws.cell(row=r, column=nc2).value = (
                            ws.cell(row=r, column=c).value)
                # 目标用例行：原相对顺序连续写入，不留空行
                sub_tester_col = None
                tester_src = cols.get("tester")
                for c, nc2 in kept:
                    if c == tester_src:
                        sub_tester_col = nc2
                for k, src_row in enumerate(rows, 1):
                    dst_row = header_row + k
                    for c, nc2 in kept:
                        sub_ws.cell(row=dst_row, column=nc2).value = (
                            ws.cell(row=src_row, column=c).value)
                    if tester and sub_tester_col:
                        sub_ws.cell(row=dst_row, column=sub_tester_col).value = tester

                    def gv(field):
                        col = cols.get(field)
                        return (_cell_str(ws.cell(row=src_row, column=col).value)
                                if col else "")
                    case_id = gv("caseId")
                    title = gv("title")
                    steps = gv("steps")
                    map_rows.append({
                        "source_file": os.path.basename(path),
                        "sheet_name": sheet_name,
                        "source_row": src_row,
                        "case_id": case_id,
                        "title": title,
                        "steps_head": steps[:40],
                        "fingerprint": _subtask_fingerprint(case_id, title, steps),
                    })

            # 隐藏元数据页 _qoder_map：行 1 导出信息，行 2 表头，行 3+ 数据
            map_ws = wb_sub.create_sheet("_qoder_map")
            map_ws.sheet_state = "hidden"
            map_ws.cell(row=1, column=1).value = export_ts
            map_ws.cell(row=1, column=2).value = result_header or ""
            map_headers = ["source_file", "sheet_name", "source_row",
                           "case_id", "title", "steps_head", "fingerprint"]
            for i, h in enumerate(map_headers, 1):
                map_ws.cell(row=2, column=i).value = h
            for idx, rec in enumerate(map_rows):
                r = 3 + idx
                for i, h in enumerate(map_headers, 1):
                    map_ws.cell(row=r, column=i).value = rec[h]

            # tester 非空：写主文件对应用例的测试人员列
            if tester:
                for _sn, (_ws, _meta, _rows) in sheet_rows.items():
                    tcol = _meta["columns"].get("tester")
                    if tcol is None:
                        continue
                    for src_row in _rows:
                        _anchor_cell(_ws, src_row, tcol).value = tester
                _atomic_save(wb, path)

            # 保存子文件（原子替换，uuid 短后缀防同名覆盖）
            out_dir = out_dir or os.path.dirname(os.path.abspath(path))
            os.makedirs(out_dir, exist_ok=True)
            base = os.path.splitext(os.path.basename(path))[0]
            ts = datetime.now().strftime("%Y%m%d_%H%M%S")
            sub_path = os.path.join(out_dir, "子任务_%s_%s_%s.xlsx"
                                    % (base, ts, uuid4().hex[:6]))
            _atomic_save(wb_sub, sub_path)
            return sub_path
        finally:
            wb.close()


def parse_subtask_for_merge(main_path, sub_path):
    """解析子文件并匹配主文件用例，生成合入预览数据。

    返回 {items, conflicts, unmatched, resultHeader, warning}：
    - items: [{subRow, sheet, status(exact/caseid/title/steps/unmatched),
               caseId, title, mainRow(可空), main{5字段现值}, sub{5字段新值},
               conflicts:[字段]}]
    - conflicts: items 下标列表（双方均有值且不同）
    - unmatched: 未匹配条目的 items 下标列表
    - resultHeader: 子文件结果列表头名（首个非空，展示用）
    - warning: 子文件 sourceFile 与主文件 basename 不一致时为 True
    子文件结果列表头在主文件对应 Sheet 不存在时抛 ValueError。
    """
    wb_sub = openpyxl.load_workbook(sub_path)
    try:
        if "_qoder_map" not in wb_sub.sheetnames:
            raise ValueError("非子任务文件：缺少 _qoder_map 元数据，请使用本工具导出的子任务文件")
        map_ws = wb_sub["_qoder_map"]
        recs = []
        r = 3
        while (map_ws.cell(row=r, column=1).value is not None
               or map_ws.cell(row=r, column=2).value is not None):
            recs.append({
                "source_file": _cell_str(map_ws.cell(row=r, column=1).value),
                "sheet_name": _cell_str(map_ws.cell(row=r, column=2).value),
                "source_row": int(map_ws.cell(row=r, column=3).value or 0),
                "case_id": _cell_str(map_ws.cell(row=r, column=4).value),
                "title": _cell_str(map_ws.cell(row=r, column=5).value),
                "steps_head": _cell_str(map_ws.cell(row=r, column=6).value),
                "fingerprint": _cell_str(map_ws.cell(row=r, column=7).value),
            })
            r += 1
        if not recs:
            raise ValueError("子任务文件没有可合入的用例记录")
        warning = bool(recs[0]["source_file"]) and \
            recs[0]["source_file"] != os.path.basename(main_path)

        # 子文件各 sheet 结构与结果列头
        sub_metas = {}
        sub_result_headers = {}
        for ws in wb_sub.worksheets:
            if ws.title.startswith("_qoder"):
                continue
            meta = classify_sheet(ws)
            sub_metas[ws.title] = (ws, meta)
            rcs = _result_columns(ws, meta["headerRow"], meta["columns"])
            sub_result_headers[ws.title] = (rcs[0][1] if rcs else "", meta)

        # 校验子结果列表头在主文件对应 Sheet 存在（_norm_header 归一比较）
        wb_main = openpyxl.load_workbook(main_path)
        try:
            missing = []
            for sheet_name, (h, _m) in sub_result_headers.items():
                if not h or sheet_name not in wb_main.sheetnames:
                    continue
                ws_m = wb_main[sheet_name]
                meta_m = classify_sheet(ws_m)
                rcs = _result_columns(ws_m, meta_m["headerRow"], meta_m["columns"])
                if not any(_norm_header(x[1]) == _norm_header(h) for x in rcs):
                    missing.append((sheet_name, h))
        finally:
            wb_main.close()
        if missing:
            raise ValueError("主文件缺少结果列 %s（Sheet %s），请先在主文件补齐该列"
                             % (missing[0][1], missing[0][0]))

        # 主文件用例索引（parse_workbook 有缓存，与前端所见口径一致）
        main_payload, _ = parse_workbook(main_path)
        sheet_cases = defaultdict(list)
        for c in main_payload["cases"]:
            sheet_cases[c["sheet"]].append(c)

        items = []
        by_sheet = defaultdict(list)
        for i, rec in enumerate(recs):
            by_sheet[rec["sheet_name"]].append((i, rec))
        for sheet_name in wb_sub.sheetnames:
            if sheet_name.startswith("_qoder") or sheet_name not in by_sheet:
                continue
            entries = by_sheet[sheet_name]
            ws_sub, meta_sub = sub_metas.get(sheet_name, (None, None))
            if ws_sub is None or not meta_sub.get("headerRow"):
                continue
            main_list = sheet_cases.get(sheet_name, [])
            sub_header = meta_sub["headerRow"]
            res_h = sub_result_headers.get(sheet_name, ("", None))[0]
            sub_rcs = _result_columns(ws_sub, sub_header, meta_sub["columns"])

            def sv(field, row):
                col = meta_sub["columns"].get(field)
                if col is None:
                    return ""
                return _cell_str(ws_sub.cell(row=row, column=col).value)

            for k, (_i, rec) in enumerate(entries):
                sub_row = sub_header + 1 + k
                sub_case_id = sv("caseId", sub_row)
                sub_title = sv("title", sub_row)
                sub_steps = sv("steps", sub_row)
                # ---- 匹配链 ----
                main_row = None
                status = "unmatched"
                if not warning:
                    mc = next((c for c in main_list
                               if c["rowIndex"] == rec["source_row"]), None)
                    if mc is not None:
                        fp = _subtask_fingerprint(mc["caseId"], mc["title"], mc["steps"])
                        if (fp == rec["fingerprint"] and mc["caseId"] == rec["case_id"]
                                and mc["title"] == rec["title"]):
                            main_row = mc["rowIndex"]
                            status = "exact"
                if main_row is None and sub_case_id:
                    cands = [c for c in main_list if c["caseId"] == sub_case_id]
                    if len(cands) == 1:
                        main_row = cands[0]["rowIndex"]
                        status = "caseid"
                    elif len(cands) > 1:
                        t2 = [c for c in cands if c["title"] == sub_title]
                        if len(t2) == 1:
                            main_row = t2[0]["rowIndex"]
                            status = "caseid"
                if main_row is None and sub_title:
                    scored = [(c, _similarity(c["title"], sub_title))
                              for c in main_list if c["title"]]
                    scored = [(c, s) for c, s in scored
                              if s >= _FUZZY_THRESHOLD]
                    if scored:
                        scored.sort(key=lambda t: -t[1])
                        if len(scored) == 1 or scored[0][1] > scored[1][1]:
                            main_row = scored[0][0]["rowIndex"]
                            status = "title"
                if main_row is None and sub_steps:
                    s40 = sub_steps[:40]
                    scored = [(c, _similarity(c["steps"][:40], s40))
                              for c in main_list if c["steps"]]
                    scored = [(c, s) for c, s in scored
                              if s >= _FUZZY_THRESHOLD]
                    if scored:
                        scored.sort(key=lambda t: -t[1])
                        if len(scored) == 1 or scored[0][1] > scored[1][1]:
                            main_row = scored[0][0]["rowIndex"]
                            status = "steps"
                # ---- 现值 / 新值 ----
                main_case = None
                if main_row is not None:
                    main_case = next((c for c in main_list
                                      if c["rowIndex"] == main_row), None)

                def main_v(field):
                    if main_case is None:
                        return ""
                    if field == "result":
                        v = main_case["results"].get(res_h, "")
                        return v if v != "" else main_case["result"]
                    return main_case.get(field, "")

                def sub_v(field):
                    if field == "result":
                        if not sub_rcs:
                            return ""
                        return _cell_str(ws_sub.cell(
                            row=sub_row, column=sub_rcs[0][0]).value)
                    return sv(field, sub_row)

                main_vals = {f: main_v(f)
                             for f in ("result", "actual", "bugId", "note", "foundTime")}
                sub_vals = {f: sub_v(f)
                            for f in ("result", "actual", "bugId", "note", "foundTime")}
                conflicts = [f for f in main_vals
                             if main_vals[f] and sub_vals[f]
                             and main_vals[f] != sub_vals[f]]
                items.append({
                    "subRow": sub_row,
                    "sheet": sheet_name,
                    "status": status,
                    "caseId": sub_case_id,
                    "title": sub_title,
                    "mainRow": main_row,
                    "main": main_vals,
                    "sub": sub_vals,
                    "conflicts": conflicts,
                })
        result_headers = [h for h, _ in sub_result_headers.values() if h]
        return {
            "items": items,
            "conflicts": [i for i, it in enumerate(items) if it["conflicts"]],
            "unmatched": [i for i, it in enumerate(items)
                          if it["status"] == "unmatched"],
            "resultHeader": result_headers[0] if result_headers else "",
            "warning": warning,
        }
    finally:
        wb_sub.close()


def merge_subtask_results(main_path, sub_path, approvals):
    """按 approvals 勾选将子文件结果写回主文件。

    approvals: [{sheet, mainRowIndex, fields:{result?, actual?, bugId?,
               note?, foundTime?}}]，仅含用户勾选的字段。
    逐条重新校验行 fingerprint（防预览期间主文件被改动）；结果字段写入
    _norm_header 匹配子文件结果列表头的列；全部完成后一次性 _atomic_save。
    返回 {merged, skipped, failures:[{title, reason}]}。
    """
    if not approvals:
        return {"merged": 0, "skipped": 0, "failures": []}
    with _write_lock:
        wb_main = openpyxl.load_workbook(main_path)
        wb_sub = openpyxl.load_workbook(sub_path)
        try:
            # 子文件：sheet -> (结果列头, meta)
            sub_result_headers = {}
            for ws in wb_sub.worksheets:
                if ws.title.startswith("_qoder"):
                    continue
                meta = classify_sheet(ws)
                rcs = _result_columns(ws, meta["headerRow"], meta["columns"])
                sub_result_headers[ws.title] = (rcs[0][1] if rcs else "", meta)
            # 指纹索引 (sheet, source_row) -> fingerprint
            fp_index = {}
            if "_qoder_map" in wb_sub.sheetnames:
                map_ws = wb_sub["_qoder_map"]
                r = 3
                while (map_ws.cell(row=r, column=1).value is not None
                       or map_ws.cell(row=r, column=2).value is not None):
                    fp_index[(_cell_str(map_ws.cell(row=r, column=2).value),
                              int(map_ws.cell(row=r, column=3).value or 0))] = \
                        _cell_str(map_ws.cell(row=r, column=7).value)
                    r += 1

            merged = 0
            skipped = 0
            failures = []
            for appr in approvals:
                sheet = appr.get("sheet")
                mrow = appr.get("mainRowIndex")
                fields = appr.get("fields") or {}
                if not sheet or not isinstance(mrow, int) \
                        or sheet not in wb_main.sheetnames:
                    failures.append({"title": "", "reason": "缺少 sheet 或行号"})
                    continue
                ws_m = wb_main[sheet]
                meta_m = classify_sheet(ws_m)
                if meta_m["kind"] not in ("functional", "scenario", "matrix"):
                    failures.append({"title": sheet,
                                     "reason": "该 Sheet 为只读页，不支持写回"})
                    continue
                cols_m = meta_m["columns"]
                header_row = meta_m["headerRow"]

                def _v(field):
                    col = cols_m.get(field)
                    return (_cell_str(ws_m.cell(row=mrow, column=col).value)
                            if col else "")

                # fingerprint 校验（防预览期间主文件被改导致错位）
                expect = fp_index.get((sheet, mrow))
                if not expect:
                    failures.append({
                        "title": _v("title") or _v("caseId") or ("#%s" % mrow),
                        "reason": "子任务元数据中未找到该行记录"})
                    continue
                if _subtask_fingerprint(_v("caseId"), _v("title"), _v("steps")) != expect:
                    failures.append({
                        "title": _v("title") or _v("caseId") or ("#%s" % mrow),
                        "reason": "该行内容与导出时不一致（文件可能被外部修改），已跳过"})
                    continue

                # 结果列定位（_norm_header 匹配子文件结果列表头）
                res_h, _meta_sub = sub_result_headers.get(sheet, ("", None))
                result_col = None
                if res_h:
                    for col, header in _result_columns(ws_m, header_row, cols_m):
                        if _norm_header(header) == _norm_header(res_h):
                            result_col = col
                            break
                    if result_col is None:
                        failures.append({
                            "title": _v("title") or _v("caseId") or ("#%s" % mrow),
                            "reason": "主文件缺少结果列 %s" % res_h})
                        continue

                for key, value in fields.items():
                    if key not in _WRITABLE_FIELDS or key == "tester":
                        continue
                    col = result_col if key == "result" else cols_m.get(key)
                    if not col:
                        failures.append({
                            "title": _v("title") or _v("caseId") or ("#%s" % mrow),
                            "reason": "未找到字段 %s 对应列，已跳过该行" % key})
                        break
                    val = "" if value is None else str(value)
                    cell = _anchor_cell(ws_m, mrow, col)
                    if _cell_str(cell.value) == val:
                        skipped += 1
                        continue
                    cell.value = val if val != "" else None
                    merged += 1

            if merged:
                _atomic_save(wb_main, main_path)
            return {"merged": merged, "skipped": skipped, "failures": failures}
        finally:
            wb_main.close()
            wb_sub.close()
