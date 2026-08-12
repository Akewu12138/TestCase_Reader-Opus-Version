# -*- coding: utf-8 -*-
"""Flask 入口与 API 路由。

工作模型：
- 测试用例文件统一存放在 uploads/testing。启动时若该目录为空且存在旧版
  根目录文件，则自动播种一份，保证历史进度可延续。
- 初始页列出 testing 目录中的文件，由用户选择"测试阶段/测试人员"并开始测试。
- 选中文件后原地读写以实现"实时同步回原始文件"，并在首次访问时生成备份。
"""

import logging
import json
import os
import shutil
import time
import uuid

from flask import Flask, jsonify, request, send_file, send_from_directory

import excel_service
import format_converter

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
TESTING_DIR = os.path.join(UPLOAD_DIR, "testing")
BACKUP_DIR = os.path.join(UPLOAD_DIR, "backups")
ORIGINALS_DIR = os.path.join(UPLOAD_DIR, "originals")
TMP_DIR = os.path.join(UPLOAD_DIR, "tmp")  # 子任务导出/导入中间产物，>24h 启动清理
ATTACHMENTS_DIR = os.path.join(UPLOAD_DIR, "attachments")
LIBRARY_ARCHIVE_DIR = os.path.join(UPLOAD_DIR, "archive")
LIBRARY_TRASH_DIR = os.path.join(UPLOAD_DIR, "trash")

# 旧版根目录默认文件：仅用于首次向 testing 目录播种，保证历史进度延续
LEGACY_EXCEL = os.path.join(BASE_DIR, "多机测试用例_合并版.xlsx")

# testing 目录内只存 .xlsx；其他格式上传时自动转换（原件留档 originals）
ALLOWED_EXT = (".xlsx",)
CONVERT_EXT = format_converter.CONVERTIBLE_EXT
SUPPORTED_LABEL = "xlsx / xlsm / xls / csv / md / xmind"

app = Flask(__name__, static_folder=None)

# 上传大小上限：50MB 已远超正常用例文件（当前最大约 1.4MB），防止误传大文件打爆内存
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024


@app.errorhandler(413)
def _too_large(_e):
    return jsonify({"error": "文件超过 50MB 上限，请检查是否选错了文件"}), 413

# 当前工作文件路径、会话信息（测试阶段/测试人员）、已备份文件集合
STATE = {
    "current_path": None,
    "stage": "",
    "tester": "",
    "activity": {},
    "run_id": "",
    "backed_up": set(),
}

# 子任务导入会话：importId -> 上传的子文件临时路径（uuid 命名防撞，合入后移除）
_import_store = {}


def _safe_name(filename):
    """仅取文件名部分并剔除危险字符，保留中文（werkzeug 会误删非 ASCII）。"""
    name = os.path.basename(filename or "").replace("\\", "").replace("/", "")
    name = name.replace("..", "").strip()
    return name


def _ensure_dirs():
    os.makedirs(TESTING_DIR, exist_ok=True)
    os.makedirs(BACKUP_DIR, exist_ok=True)
    os.makedirs(TMP_DIR, exist_ok=True)
    os.makedirs(ATTACHMENTS_DIR, exist_ok=True)
    os.makedirs(LIBRARY_ARCHIVE_DIR, exist_ok=True)
    os.makedirs(LIBRARY_TRASH_DIR, exist_ok=True)


def _cleanup_tmp_dir():
    """清理 uploads/tmp 中超过 24h 的残留临时文件（进程异常退出时的兜底）。"""
    _ensure_dirs()
    now = time.time()
    try:
        for name in os.listdir(TMP_DIR):
            full = os.path.join(TMP_DIR, name)
            try:
                if os.path.isfile(full) and now - os.stat(full).st_mtime > 24 * 3600:
                    os.remove(full)
            except OSError:
                pass
    except OSError:
        pass


def _seed_testing_dir():
    """若 testing 目录为空且旧版根文件存在，则播种一份，延续历史进度。"""
    _ensure_dirs()
    has_excel = any(f.lower().endswith(ALLOWED_EXT) for f in os.listdir(TESTING_DIR))
    if not has_excel and os.path.exists(LEGACY_EXCEL):
        try:
            shutil.copy2(LEGACY_EXCEL, os.path.join(TESTING_DIR, os.path.basename(LEGACY_EXCEL)))
        except Exception as exc:
            app.logger.warning("播种默认用例失败: %s", exc)


def _list_testing_files():
    """列出 testing 目录下的 Excel 文件（按修改时间倒序）。"""
    _ensure_dirs()
    items = []
    for name in os.listdir(TESTING_DIR):
        if not name.lower().endswith(ALLOWED_EXT):
            continue
        if name.startswith("~$"):
            # Excel 打开文件时生成的锁文件，并非真实用例文件
            continue
        full = os.path.join(TESTING_DIR, name)
        try:
            st = os.stat(full)
        except OSError:
            continue
        items.append({"name": name, "mtime": int(st.st_mtime), "size": st.st_size})
    items.sort(key=lambda x: x["mtime"], reverse=True)
    return items


def _ensure_backup(path):
    """对某个文件首次访问时生成一次备份。"""
    real = os.path.abspath(path)
    if real in STATE["backed_up"]:
        return
    if os.path.exists(path):
        try:
            excel_service.make_backup(path, BACKUP_DIR)
        except Exception as exc:
            app.logger.warning("备份失败: %s", exc)
        STATE["backed_up"].add(real)


def _resolve_testing_path(file_name):
    """将文件名解析为 testing 目录下的合法绝对路径，防止路径穿越。"""
    name = _safe_name(file_name)
    if not name or not name.lower().endswith(ALLOWED_EXT):
        return None
    if name.startswith("~$"):
        return None
    path = os.path.join(TESTING_DIR, name)
    if os.path.abspath(os.path.dirname(path)) != os.path.abspath(TESTING_DIR):
        return None
    return path


def _cases_response(path):
    """解析当前文件并组织完整响应负载。"""
    _ensure_backup(path)
    payload, _ = excel_service.parse_workbook(path)
    payload["fileName"] = os.path.basename(path)
    payload["stage"] = STATE["stage"]
    payload["tester"] = STATE["tester"]
    payload["activity"] = dict(STATE.get("activity") or {})
    payload["runId"] = STATE.get("run_id", "")
    try:
        payload["runs"] = excel_service.list_runs(path)
        payload["fileFingerprint"] = excel_service.file_fingerprint(path)
    except OSError:
        payload["runs"] = []
    return payload


def _session_conflict(data, path):
    """会话隔离校验：请求声明的 fileName 与当前工作文件不一致时返回 409。

    多标签页各自选择不同文件时，写请求可能落到别人切走后的文件上；
    仿 expectedName 的可选校验模式：前端始终携带，缺失时放行以兼容旧页面。
    """
    claimed = _safe_name(data.get("fileName", ""))
    if claimed and claimed != os.path.basename(path):
        return jsonify({
            "error": "当前工作文件已切换为 %s，页面显示的是 %s，"
                     "请刷新页面后重试" % (os.path.basename(path), claimed),
            "conflict": True,
        }), 409
    claimed_fp = data.get("fileFingerprint")
    if claimed_fp:
        try:
            current_fp = excel_service.file_fingerprint(path)
        except OSError:
            return jsonify({"error": "当前文件不存在", "conflict": True}), 409
        if not isinstance(claimed_fp, dict) or \
                claimed_fp.get("sha256") != current_fp.get("sha256"):
            return jsonify({
                "error": "文件已被外部修改，请刷新后重试",
                "conflict": True,
                "currentFingerprint": current_fp,
            }), 409
    return None


@app.route("/")
def index():
    resp = send_from_directory(STATIC_DIR, "index.html")
    # 前端下载逻辑属于应用代码，入口页必须重新校验，避免浏览器继续使用旧 app.js。
    resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.route("/static/<path:filename>")
def static_files(filename):
    resp = send_from_directory(STATIC_DIR, filename)
    if filename.lower().endswith((".js", ".css")):
        # 新版本发布后及时拿到下载链路修复；图片等静态资源仍使用默认缓存策略。
        resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.route("/api/testing-files", methods=["GET"])
def testing_files():
    return jsonify({
        "files": _list_testing_files(),
        "current": os.path.basename(STATE["current_path"]) if STATE["current_path"] else None,
        "stage": STATE["stage"],
        "tester": STATE["tester"],
    })


def _library_name(value):
    name = _safe_name(value)
    if not name or name.startswith("~$") or not name.lower().endswith(ALLOWED_EXT):
        return None
    return name


def _library_items():
    _ensure_dirs()
    items = []
    for directory, archived in ((TESTING_DIR, False), (LIBRARY_ARCHIVE_DIR, True)):
        try:
            names = os.listdir(directory)
        except OSError:
            names = []
        for name in names:
            if not _library_name(name):
                continue
            path = os.path.join(directory, name)
            try:
                stat = os.stat(path)
            except OSError:
                continue
            items.append({"name": name, "size": stat.st_size, "mtime": int(stat.st_mtime),
                          "archived": archived})
    items.sort(key=lambda item: item["mtime"], reverse=True)
    return items


def _library_path(name, archived=False):
    safe = _library_name(name)
    if not safe:
        return None
    root = LIBRARY_ARCHIVE_DIR if archived else TESTING_DIR
    path = os.path.abspath(os.path.join(root, safe))
    if os.path.dirname(path) != os.path.abspath(root):
        return None
    return path


@app.route("/api/library", methods=["GET", "PATCH"])
def library():
    if request.method == "GET":
        return jsonify({"files": _library_items()})
    data = request.get_json(silent=True) or {}
    old_name = _library_name(data.get("fileName"))
    new_name = _library_name(data.get("newName")) or old_name
    archived = bool(data.get("archived", False))
    source = _library_path(old_name, archived)
    if not source or not os.path.isfile(source):
        return jsonify({"error": "文件不存在"}), 404
    if STATE.get("current_path") and os.path.abspath(source) == os.path.abspath(STATE["current_path"]):
        return jsonify({"error": "当前正在使用的文件不能归档或重命名，请先切换文件"}), 409
    target_archived = bool(data.get("archive", archived))
    target = _library_path(new_name, target_archived)
    if not target:
        return jsonify({"error": "文件名必须是 .xlsx 文件"}), 400
    if os.path.abspath(source) != os.path.abspath(target) and os.path.exists(target):
        return jsonify({"error": "目标文件名已存在"}), 409
    try:
        os.replace(source, target)
    except OSError as exc:
        return jsonify({"error": "文件操作失败: %s" % exc}), 400
    return jsonify({"ok": True, "files": _library_items()})


@app.route("/api/library/<path:file_name>", methods=["DELETE"])
def delete_library_file(file_name):
    name = _library_name(file_name)
    if not name:
        return jsonify({"error": "文件名不合法"}), 400
    archived = request.args.get("archived", "0") == "1"
    source = _library_path(name, archived)
    if not source or not os.path.isfile(source):
        return jsonify({"error": "文件不存在"}), 404
    if STATE.get("current_path") and os.path.abspath(source) == os.path.abspath(STATE["current_path"]):
        return jsonify({"error": "当前正在使用的文件不能删除，请先切换文件"}), 409
    _ensure_dirs()
    target = os.path.join(LIBRARY_TRASH_DIR, "%d_%s_%s" % (int(time.time()), uuid.uuid4().hex[:8], name))
    try:
        os.replace(source, target)
    except OSError as exc:
        return jsonify({"error": "文件移入回收区失败: %s" % exc}), 400
    return jsonify({"ok": True, "recoverable": True, "files": _library_items()})


@app.route("/api/upload", methods=["POST"])
def upload():
    if "file" not in request.files:
        return jsonify({"error": "未收到文件"}), 400
    file = request.files["file"]
    if not file.filename:
        return jsonify({"error": "文件名为空"}), 400
    lower = file.filename.lower()
    ext = os.path.splitext(lower)[1]
    if not lower.endswith(ALLOWED_EXT + CONVERT_EXT):
        return jsonify({"error": "不支持 %s 格式，当前支持：%s"
                        % (ext or "该", SUPPORTED_LABEL)}), 400

    _ensure_dirs()
    filename = _safe_name(file.filename) or ("working" + (ext or ".xlsx"))

    # 非 xlsx：原件留档 originals，转换产物同名 .xlsx 存入 testing
    if lower.endswith(CONVERT_EXT):
        os.makedirs(ORIGINALS_DIR, exist_ok=True)
        original_path = os.path.join(ORIGINALS_DIR, filename)
        file.save(original_path)
        xlsx_name = os.path.splitext(filename)[0] + ".xlsx"
        save_path = os.path.join(TESTING_DIR, xlsx_name)
        try:
            format_converter.convert_to_xlsx(original_path, save_path)
        except ValueError as exc:
            return jsonify({"error": "转换失败：%s" % exc}), 400
        except Exception as exc:
            app.logger.exception("转换失败")
            return jsonify({"error": "转换失败：%s" % exc}), 400
        return jsonify({"files": _list_testing_files(), "uploaded": xlsx_name,
                        "converted": True,
                        "hint": "已自动转换为 xlsx，原件已备份至 uploads/originals"})

    if not filename.lower().endswith(ALLOWED_EXT):
        filename += ".xlsx"
    save_path = os.path.join(TESTING_DIR, filename)
    file.save(save_path)

    return jsonify({"files": _list_testing_files(), "uploaded": filename})


@app.route("/api/select", methods=["POST"])
def select_file():
    data = request.get_json(silent=True) or {}
    path = _resolve_testing_path(data.get("fileName", ""))
    if not path or not os.path.exists(path):
        return jsonify({"error": "文件不存在或不合法"}), 400

    claimed_fp = data.get("fileFingerprint")
    if claimed_fp:
        current_fp = excel_service.file_fingerprint(path)
        if not isinstance(claimed_fp, dict) or \
                claimed_fp.get("sha256") != current_fp.get("sha256"):
            return jsonify({"error": "预检后文件已变化，请重新预检",
                            "conflict": True,
                            "currentFingerprint": current_fp}), 409

    STATE["current_path"] = path
    STATE["stage"] = str(data.get("stage", "") or "").strip()
    STATE["tester"] = str(data.get("tester", "") or "").strip()
    STATE["activity"] = {
        key: str(data.get(key, "") or "").strip()
        for key in ("stage", "tester", "version", "build", "device",
                    "environment", "scope", "owner")
    }
    try:
        payload = _cases_response(path)
        result_header = str(data.get("resultHeader") or "").strip()
        if not result_header:
            for values in payload.get("resultColumns", {}).values():
                if values:
                    result_header = values[0]
                    break
        run = excel_service.create_run(path, {
            "runId": data.get("runId", ""),
            "resultHeader": result_header,
            **STATE["activity"],
            "scope": data.get("scope", ""),
        })
        STATE["run_id"] = run["runId"]
        payload = _cases_response(path)
    except Exception as exc:
        return jsonify({"error": "解析失败: %s" % exc}), 500
    return jsonify(payload)


@app.route("/api/workbook/preflight", methods=["POST"])
def workbook_preflight():
    """执行只读预检，绝不调用会自动补列的正式解析路径。"""
    data = request.get_json(silent=True) or {}
    path = _resolve_testing_path(data.get("fileName", ""))
    if not path or not os.path.exists(path):
        return jsonify({"error": "文件不存在或不合法"}), 400
    try:
        return jsonify(excel_service.inspect_workbook(path))
    except (ValueError, OSError) as exc:
        return jsonify({"error": "预检失败: %s" % exc}), 400
    except Exception as exc:
        app.logger.exception("Excel 预检失败")
        return jsonify({"error": "预检失败: %s" % exc}), 500


@app.route("/api/cases", methods=["GET"])
def get_cases():
    path = STATE["current_path"]
    if not path or not os.path.exists(path):
        return jsonify({"needsSetup": True, "files": _list_testing_files()})
    try:
        payload = _cases_response(path)
    except Exception as exc:
        return jsonify({"error": "解析失败: %s" % exc}), 500
    tag = (payload.get("fileFingerprint") or {}).get("sha256")
    if tag and request.headers.get("If-None-Match", "").strip('"') == tag:
        return "", 304
    response = jsonify(payload)
    if tag:
        response.set_etag(tag)
    response.headers["Cache-Control"] = "private, no-cache"
    return response


@app.route("/api/cases", methods=["PATCH"])
def patch_case():
    data = request.get_json(silent=True) or {}
    sheet = data.get("sheet")
    row_index = data.get("rowIndex")
    if not sheet or not isinstance(row_index, int):
        return jsonify({"error": "缺少 sheet 或 rowIndex"}), 400

    fields = {}
    for key in ("result", "bugId", "tester", "note", "actual", "foundTime"):
        if key in data:
            fields[key] = "" if data[key] is None else str(data[key])

    path = STATE["current_path"]
    if not path or not os.path.exists(path):
        return jsonify({"error": "当前文件不存在"}), 404
    conflict = _session_conflict(data, path)
    if conflict:
        return conflict
    # 矩阵页多结果列：透传目标结果列号（functional/scenario 路径忽略）
    result_col = data.get("resultCol")
    if not isinstance(result_col, int):
        result_col = None
    # 测试轮次：功能/场景页 result 的目标结果列表头名（仅影响 result 字段）
    result_column = str(data.get("resultColumn") or "").strip() or None
    try:
        progress = excel_service.update_case(
            path, sheet, row_index, fields,
            expected_name=data.get("expectedName") or None,
            result_col=result_col, result_column=result_column)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        return jsonify({"error": "写回失败: %s" % exc}), 500
    return jsonify({"ok": True, "progress": progress,
                    "fileFingerprint": excel_service.file_fingerprint(path)})


@app.route("/api/runs", methods=["GET", "POST", "PATCH"])
def runs():
    path = STATE["current_path"]
    if not path or not os.path.exists(path):
        return jsonify({"error": "当前文件不存在"}), 404
    if request.method == "GET":
        return jsonify({"runs": excel_service.list_runs(path)})
    data = request.get_json(silent=True) or {}
    conflict = _session_conflict(data, path)
    if conflict:
        return conflict
    try:
        if request.method == "POST":
            run = excel_service.create_run(path, data)
        else:
            run_id = str(data.get("runId") or "").strip()
            if not run_id:
                return jsonify({"error": "缺少 runId"}), 400
            run = excel_service.update_run(path, run_id, data)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except OSError:
        return jsonify({"error": "写入失败：请先关闭正在打开该 Excel 的程序后重试"}), 400
    except Exception as exc:
        app.logger.exception("测试活动写入失败")
        return jsonify({"error": "测试活动写入失败: %s" % exc}), 500
    if run.get("runId") == STATE.get("run_id") or request.method == "POST":
        STATE["run_id"] = run["runId"]
    return jsonify({"ok": True, "run": run,
                    "fileFingerprint": excel_service.file_fingerprint(path)})


@app.route("/api/tasks", methods=["GET", "POST", "PATCH"])
def tasks():
    path = STATE["current_path"]
    if not path or not os.path.exists(path):
        return jsonify({"error": "当前文件不存在"}), 404
    if request.method == "GET":
        return jsonify({"tasks": excel_service.list_tasks(path)})
    data = request.get_json(silent=True) or {}
    conflict = _session_conflict(data, path)
    if conflict:
        return conflict
    try:
        if request.method == "POST":
            task = excel_service.create_task(path, data)
        else:
            task_id = str(data.get("taskId") or "").strip()
            if not task_id:
                return jsonify({"error": "缺少 taskId"}), 400
            task = excel_service.update_task(path, task_id, data)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except OSError:
        return jsonify({"error": "任务写入失败：请先关闭正在打开该 Excel 的程序后重试"}), 400
    except Exception as exc:
        app.logger.exception("任务写入失败")
        return jsonify({"error": "任务写入失败: %s" % exc}), 500
    return jsonify({"ok": True, "task": task,
                    "fileFingerprint": excel_service.file_fingerprint(path)})


@app.route("/api/backups", methods=["GET"])
def backups():
    path = STATE["current_path"]
    if not path or not os.path.exists(path):
        return jsonify({"error": "当前文件不存在"}), 404
    return jsonify({"backups": excel_service.list_backups(path, BACKUP_DIR),
                    "fileName": os.path.basename(path)})


def _attachment_root(path):
    base = os.path.splitext(os.path.basename(path))[0]
    return os.path.join(ATTACHMENTS_DIR, base)


def _attachment_id_is_valid(value):
    return isinstance(value, str) and len(value) == 32 and all(
        ch in "0123456789abcdef" for ch in value.lower())


@app.route("/api/attachments", methods=["GET", "POST"])
def attachments():
    path = STATE["current_path"]
    if not path or not os.path.exists(path):
        return jsonify({"error": "当前文件不存在"}), 404
    if request.method == "GET":
        sheet = str(request.args.get("sheet") or "")
        row_index = request.args.get("rowIndex", type=int)
        case_key = "%s_%s" % (sheet, row_index) if sheet and row_index else ""
        root = _attachment_root(path)
        items = []
        if os.path.isdir(root):
            for name in os.listdir(root):
                if not name.endswith(".json"):
                    continue
                try:
                    with open(os.path.join(root, name), encoding="utf-8") as stream:
                        item = json.load(stream)
                except (OSError, ValueError):
                    continue
                if case_key and item.get("caseKey") != case_key:
                    continue
                item["url"] = "/api/attachments/%s" % item.get("attachmentId", "")
                items.append(item)
        items.sort(key=lambda item: item.get("createdAt", ""), reverse=True)
        return jsonify({"attachments": items})

    data = request.form
    try:
        fingerprint = json.loads(data.get("fileFingerprint", "{}") or "{}")
    except (TypeError, ValueError):
        return jsonify({"error": "fileFingerprint 格式无效"}), 400
    if not isinstance(fingerprint, dict):
        return jsonify({"error": "fileFingerprint 格式无效"}), 400
    conflict = _session_conflict({
        "fileName": data.get("fileName", ""),
        "fileFingerprint": fingerprint,
    }, path)
    if conflict:
        return conflict
    upload = request.files.get("file")
    sheet = str(data.get("sheet") or "").strip()
    row_index = str(data.get("rowIndex") or "").strip()
    if upload is None or not upload.filename or not sheet or not row_index:
        return jsonify({"error": "缺少文件、Sheet 或行号"}), 400
    try:
        row_number = int(row_index)
    except (TypeError, ValueError):
        return jsonify({"error": "行号必须是正整数"}), 400
    if row_number < 1:
        return jsonify({"error": "行号必须是正整数"}), 400
    original = _safe_name(upload.filename) or "evidence.bin"
    attachment_id = uuid.uuid4().hex
    root = _attachment_root(path)
    os.makedirs(root, exist_ok=True)
    file_path = os.path.join(root, "%s_%s" % (attachment_id, original))
    meta_path = os.path.join(root, attachment_id + ".json")
    try:
        upload.save(file_path)
        item = {
            "attachmentId": attachment_id,
            "name": original,
            "sheet": sheet,
            "rowIndex": row_number,
            "caseKey": "%s_%s" % (sheet, row_index),
            "size": os.path.getsize(file_path),
            "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        }
        with open(meta_path, "w", encoding="utf-8") as stream:
            json.dump(item, stream, ensure_ascii=False)
    except Exception as exc:
        for target in (file_path, meta_path):
            try:
                os.remove(target)
            except OSError:
                pass
        return jsonify({"error": "附件保存失败: %s" % exc}), 500
    item["url"] = "/api/attachments/%s" % attachment_id
    return jsonify({"ok": True, "attachment": item})


@app.route("/api/attachments/<attachment_id>", methods=["GET"])
def attachment_file(attachment_id):
    path = STATE["current_path"]
    if not path or not os.path.exists(path) or not _attachment_id_is_valid(attachment_id):
        return jsonify({"error": "附件不存在"}), 404
    root = os.path.abspath(_attachment_root(path))
    try:
        target = next(os.path.join(root, name) for name in os.listdir(root)
                      if name.startswith(attachment_id + "_") and not name.endswith(".json"))
    except (OSError, StopIteration):
        return jsonify({"error": "附件不存在"}), 404
    if os.path.abspath(os.path.dirname(target)) != root or not os.path.isfile(target):
        return jsonify({"error": "附件不存在"}), 404
    return send_file(target, as_attachment=False, download_name=os.path.basename(target)[33:])


@app.route("/api/backups/restore", methods=["POST"])
def restore_backup():
    data = request.get_json(silent=True) or {}
    path = STATE["current_path"]
    if not path or not os.path.exists(path):
        return jsonify({"error": "当前文件不存在"}), 404
    conflict = _session_conflict(data, path)
    if conflict:
        return conflict
    try:
        result = excel_service.restore_backup(
            path, str(data.get("backupId") or ""), BACKUP_DIR)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except OSError:
        return jsonify({"error": "恢复失败：请先关闭正在打开该 Excel 的程序后重试"}), 400
    except Exception as exc:
        app.logger.exception("备份恢复失败")
        return jsonify({"error": "恢复失败: %s" % exc}), 500
    return jsonify({"ok": True, **result,
                    "payload": _cases_response(path)})


@app.route("/api/result-columns", methods=["POST"])
def create_result_column():
    """在所有可执行 Sheet 统一新建一个结果列（开启新一轮测试）。"""
    data = request.get_json(silent=True) or {}
    name = str(data.get("name") or "").strip()
    path = STATE["current_path"]
    if not path or not os.path.exists(path):
        return jsonify({"error": "当前文件不存在"}), 404
    conflict = _session_conflict(data, path)
    if conflict:
        return conflict
    try:
        # 新轮次会改变整册表头，先留一份可恢复版本。
        excel_service.make_backup(path, BACKUP_DIR)
        excel_service.add_result_column(path, name)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except OSError:
        return jsonify({"error": "写入失败：请先关闭正在打开该 Excel 的程序后重试"}), 400
    except Exception as exc:
        return jsonify({"error": "新建结果列失败: %s" % exc}), 500
    return jsonify({"ok": True, "name": name,
                    "fileFingerprint": excel_service.file_fingerprint(path)})


@app.route("/api/results/clear", methods=["POST"])
def clear_results():
    """批量清空当前轮次结果列（回归老用例前的一键重置）。"""
    data = request.get_json(silent=True) or {}
    result_column = str(data.get("resultColumn") or "").strip()
    path = STATE["current_path"]
    if not path or not os.path.exists(path):
        return jsonify({"error": "当前文件不存在"}), 404
    conflict = _session_conflict(data, path)
    if conflict:
        return conflict
    # 破坏性操作前单独留档一份即时备份（不依赖会话级首次备份）
    try:
        excel_service.make_backup(path, BACKUP_DIR)
    except Exception as exc:
        app.logger.warning("清除前备份失败: %s", exc)
    try:
        result = excel_service.clear_result_column(path, result_column)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except OSError:
        return jsonify({"error": "写入失败：请先关闭正在打开该 Excel 的程序后重试"}), 400
    except Exception as exc:
        return jsonify({"error": "清除失败: %s" % exc}), 500
    return jsonify({"ok": True, "cleared": result["cleared"],
                    "progress": result["progress"],
                    "fileFingerprint": excel_service.file_fingerprint(path)})


@app.route("/api/sheet-image", methods=["GET"])
def sheet_image():
    """按需下发某 Sheet 的内嵌图片（解析负载只含 URL，不再内联 base64）。"""
    sheet = request.args.get("sheet", "")
    idx = request.args.get("idx", type=int)
    path = STATE["current_path"]
    if not path or not os.path.exists(path) or idx is None or idx < 0:
        return jsonify({"error": "图片不存在"}), 404
    item = excel_service.get_sheet_image(path, sheet, idx)
    if not item:
        return jsonify({"error": "图片不存在"}), 404
    data, fmt = item
    resp = app.response_class(data, mimetype="image/%s" % fmt)
    # 同一文件指纹内内容不变，允许浏览器短期缓存，减少重复请求
    resp.headers["Cache-Control"] = "private, max-age=3600"
    return resp


@app.route("/api/download", methods=["GET"])
def download():
    path = STATE["current_path"]
    if not path or not os.path.exists(path):
        return jsonify({"error": "文件不存在"}), 404
    return send_file(path, as_attachment=True, download_name=os.path.basename(path))


@app.route("/api/subtask/export", methods=["POST"])
def subtask_export():
    """导出子任务：按 targets（前端筛选范围）生成精简子集 xlsx 下发，发送后删除。"""
    data = request.get_json(silent=True) or {}
    path = STATE["current_path"]
    if not path or not os.path.exists(path):
        return jsonify({"error": "当前文件不存在"}), 404
    conflict = _session_conflict(data, path)
    if conflict:
        return conflict
    targets = data.get("targets")
    if not isinstance(targets, list) or not targets:
        return jsonify({"error": "没有要导出的用例，请先筛选或选择用例"}), 400
    tester = str(data.get("tester") or "").strip()
    result_header = str(data.get("resultHeader") or "").strip() or None
    task = None
    if data.get("createTask"):
        try:
            task = excel_service.create_task(path, {
                "runId": STATE.get("run_id", ""),
                "tester": tester,
                "assignedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "dueAt": str(data.get("dueAt") or "").strip(),
                "status": "执行中",
                "targetCount": len(targets),
                "targets": targets,
                "note": str(data.get("taskNote") or "").strip(),
            })
        except Exception as exc:
            app.logger.exception("创建分发任务失败")
            return jsonify({"error": "创建分发任务失败: %s" % exc}), 500
    try:
        sub_path = excel_service.export_subtask(
            path, targets, tester=tester, result_header=result_header,
            out_dir=TMP_DIR)
        if task:
            task = excel_service.update_task(path, task["taskId"], {
                "status": "待回传",
                "exportName": os.path.basename(sub_path),
            })
    except ValueError as exc:
        if task:
            try:
                excel_service.update_task(path, task["taskId"], {"status": "导出失败", "note": str(exc)})
            except Exception:
                pass
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        if task:
            try:
                excel_service.update_task(path, task["taskId"], {"status": "导出失败", "note": str(exc)})
            except Exception:
                pass
        app.logger.exception("导出子任务失败")
        return jsonify({"error": "导出失败: %s" % exc}), 500

    # 先读成字节再下发，避免流式发送时 Windows 句柄占用导致删除失败。
    # 读取失败必须单独返回，不能继续把未赋值的 data 交给 send_file。
    from io import BytesIO
    try:
        with open(sub_path, "rb") as f:
            file_bytes = f.read()
    except OSError as exc:
        app.logger.exception("读取子任务导出文件失败: %s", sub_path)
        try:
            os.remove(sub_path)
        except OSError:
            pass
        return jsonify({"error": "导出文件读取失败: %s" % exc}), 500
    try:
        os.remove(sub_path)
    except OSError:
        app.logger.warning("清理子任务临时文件失败: %s", sub_path)
    response = send_file(BytesIO(file_bytes), as_attachment=True,
                          download_name=os.path.basename(sub_path))
    if task:
        response.headers["X-Task-Id"] = task["taskId"]
        response.headers["X-Task-Status"] = task["status"]
    return response


@app.route("/api/subtask/import-preview", methods=["POST"])
def subtask_import_preview():
    """上传子任务文件并返回合入预览（匹配统计 + 差异项）。"""
    path = STATE["current_path"]
    if not path or not os.path.exists(path):
        return jsonify({"error": "当前文件不存在"}), 404
    file = request.files.get("file")
    if file is None or not file.filename:
        return jsonify({"error": "未收到文件"}), 400
    if not file.filename.lower().endswith(".xlsx"):
        return jsonify({"error": "仅支持 .xlsx 子任务文件"}), 400
    claimed = str(request.form.get("fileName") or "").strip()
    claimed_fp = request.form.get("fileFingerprint")
    try:
        claimed_fp = json.loads(claimed_fp) if claimed_fp else None
    except (TypeError, ValueError):
        claimed_fp = None
    conflict = _session_conflict({"fileName": claimed,
                                  "fileFingerprint": claimed_fp}, path)
    if conflict:
        return conflict
    _ensure_dirs()
    import_id = uuid.uuid4().hex
    sub_path = os.path.join(TMP_DIR, import_id + ".xlsx")
    file.save(sub_path)
    try:
        result = excel_service.parse_subtask_for_merge(path, sub_path)
    except ValueError as exc:
        try:
            os.remove(sub_path)
        except OSError:
            pass
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        app.logger.exception("子任务解析失败")
        try:
            os.remove(sub_path)
        except OSError:
            pass
        return jsonify({"error": "解析失败: %s" % exc}), 500
    _import_store[import_id] = sub_path
    return jsonify({
        "importId": import_id,
        "items": result["items"],
        "conflicts": result["conflicts"],
        "unmatched": result["unmatched"],
        "resultHeader": result["resultHeader"],
        "warning": result["warning"],
    })


@app.route("/api/subtask/merge", methods=["POST"])
def subtask_merge():
    """确认合入：把勾选的子文件结果写回主报告，成功后清理导入会话。"""
    data = request.get_json(silent=True) or {}
    path = STATE["current_path"]
    if not path or not os.path.exists(path):
        return jsonify({"error": "当前文件不存在"}), 404
    conflict = _session_conflict(data, path)
    if conflict:
        return conflict
    import_id = str(data.get("importId") or "").strip()
    sub_path = _import_store.get(import_id)
    if not sub_path or not os.path.exists(sub_path):
        return jsonify({"error": "导入会话不存在或已过期，请重新上传子任务文件"}), 404
    approvals = data.get("approvals")
    if not isinstance(approvals, list):
        return jsonify({"error": "缺少勾选清单"}), 400
    # 破坏性写回前单独留档备份（对齐 clear_results 模式）
    try:
        excel_service.make_backup(path, BACKUP_DIR)
    except Exception as exc:
        app.logger.warning("合入前备份失败: %s", exc)
    try:
        result = excel_service.merge_subtask_results(path, sub_path, approvals)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except OSError:
        return jsonify({"error": "写入失败：请先关闭正在打开该 Excel 的程序后重试"}), 400
    except Exception as exc:
        app.logger.exception("合入失败")
        return jsonify({"error": "合入失败: %s" % exc}), 500
    finally:
        # 无论成败，导入会话即失效（临时文件残留由启动清理兜底）
        _import_store.pop(import_id, None)
        try:
            os.remove(sub_path)
        except OSError:
            pass
    task_id = str(data.get("taskId") or "").strip()
    if task_id:
        try:
            excel_service.update_task(path, task_id, {
                "status": "已完成",
                "mergedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
            })
        except Exception:
            app.logger.warning("更新分发任务状态失败: %s", task_id)
    return jsonify({**result,
                    "fileFingerprint": excel_service.file_fingerprint(path)})


if __name__ == "__main__":
    _seed_testing_dir()
    _cleanup_tmp_dir()
    # 端口可通过环境变量 PORT 覆盖（默认 5000）；启动器与此保持一致。
    # macOS 的隔空播放接收器会占用 5000，此时可改用其他端口。
    port = int(os.environ.get("PORT", "5000"))
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    try:
        from waitress import serve
    except ImportError:
        # 未安装 waitress 时回退开发服务器，保证双击启动器仍可用
        app.run(host="127.0.0.1", port=port)
    else:
        # waitress 不打请求日志，用 after_request 补一份简易访问日志
        access_log = logging.getLogger("access")

        @app.after_request
        def _log_request(resp):
            access_log.info("%s %s -> %s", request.method,
                            request.path, resp.status_code)
            return resp

        logging.getLogger("app").info(
            "waitress 已启动: http://127.0.0.1:%s", port)
        serve(app, host="127.0.0.1", port=port, threads=8)
