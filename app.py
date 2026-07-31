# -*- coding: utf-8 -*-
"""Flask 入口与 API 路由。

工作模型：
- 测试用例文件统一存放在 uploads/testing。启动时若该目录为空且存在旧版
  根目录文件，则自动播种一份，保证历史进度可延续。
- 初始页列出 testing 目录中的文件，由用户选择"测试阶段/测试人员"并开始测试。
- 选中文件后原地读写以实现"实时同步回原始文件"，并在首次访问时生成备份。
"""

import logging
import os
import shutil

from flask import Flask, jsonify, request, send_file, send_from_directory

import excel_service
import format_converter

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
TESTING_DIR = os.path.join(UPLOAD_DIR, "testing")
BACKUP_DIR = os.path.join(UPLOAD_DIR, "backups")
ORIGINALS_DIR = os.path.join(UPLOAD_DIR, "originals")

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
    "backed_up": set(),
}


def _safe_name(filename):
    """仅取文件名部分并剔除危险字符，保留中文（werkzeug 会误删非 ASCII）。"""
    name = os.path.basename(filename or "").replace("\\", "").replace("/", "")
    name = name.replace("..", "").strip()
    return name


def _ensure_dirs():
    os.makedirs(TESTING_DIR, exist_ok=True)
    os.makedirs(BACKUP_DIR, exist_ok=True)


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
    return None


@app.route("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.route("/static/<path:filename>")
def static_files(filename):
    return send_from_directory(STATIC_DIR, filename)


@app.route("/api/testing-files", methods=["GET"])
def testing_files():
    return jsonify({
        "files": _list_testing_files(),
        "current": os.path.basename(STATE["current_path"]) if STATE["current_path"] else None,
        "stage": STATE["stage"],
        "tester": STATE["tester"],
    })


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

    STATE["current_path"] = path
    STATE["stage"] = str(data.get("stage", "") or "").strip()
    STATE["tester"] = str(data.get("tester", "") or "").strip()
    try:
        payload = _cases_response(path)
    except Exception as exc:
        return jsonify({"error": "解析失败: %s" % exc}), 500
    return jsonify(payload)


@app.route("/api/cases", methods=["GET"])
def get_cases():
    path = STATE["current_path"]
    if not path or not os.path.exists(path):
        return jsonify({"needsSetup": True, "files": _list_testing_files()})
    try:
        payload = _cases_response(path)
    except Exception as exc:
        return jsonify({"error": "解析失败: %s" % exc}), 500
    return jsonify(payload)


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
    return jsonify({"ok": True, "progress": progress})


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
        excel_service.add_result_column(path, name)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except OSError:
        return jsonify({"error": "写入失败：请先关闭正在打开该 Excel 的程序后重试"}), 400
    except Exception as exc:
        return jsonify({"error": "新建结果列失败: %s" % exc}), 500
    return jsonify({"ok": True, "name": name})


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
                    "progress": result["progress"]})


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


if __name__ == "__main__":
    _seed_testing_dir()
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
