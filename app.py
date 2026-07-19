# -*- coding: utf-8 -*-
"""Flask 入口与 API 路由。

默认加载并原地读写工作区内的目标 Excel，以满足"实时同步回原始文件"。
也支持上传其他 xlsx（写回服务端副本，经 /api/download 下载）。
"""

import os

from flask import Flask, jsonify, request, send_file, send_from_directory
from werkzeug.utils import secure_filename

import excel_service

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
BACKUP_DIR = os.path.join(UPLOAD_DIR, "backups")

# 工作区内的默认目标文件
DEFAULT_EXCEL = os.path.join(BASE_DIR, "多机测试用例_合并版.xlsx")

app = Flask(__name__, static_folder=None)

# 当前工作文件路径；已备份的文件集合（避免重复备份）
STATE = {
    "current_path": DEFAULT_EXCEL,
    "backed_up": set(),
}


def _ensure_backup(path):
    """对某个文件首次访问时生成一次备份。"""
    real = os.path.abspath(path)
    if real in STATE["backed_up"]:
        return
    if os.path.exists(path):
        try:
            excel_service.make_backup(path, BACKUP_DIR)
        except Exception as exc:  # 备份失败不阻断主流程，但记录
            app.logger.warning("备份失败: %s", exc)
        STATE["backed_up"].add(real)


@app.route("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.route("/static/<path:filename>")
def static_files(filename):
    return send_from_directory(STATIC_DIR, filename)


@app.route("/api/cases", methods=["GET"])
def get_cases():
    path = STATE["current_path"]
    if not os.path.exists(path):
        return jsonify({"error": f"未找到 Excel 文件: {os.path.basename(path)}"}), 404
    _ensure_backup(path)
    try:
        cases, progress = excel_service.parse_workbook(path)
    except Exception as exc:
        return jsonify({"error": f"解析失败: {exc}"}), 500
    return jsonify({
        "fileName": os.path.basename(path),
        "cases": cases,
        "progress": progress,
    })


@app.route("/api/upload", methods=["POST"])
def upload():
    if "file" not in request.files:
        return jsonify({"error": "未收到文件"}), 400
    file = request.files["file"]
    if not file.filename:
        return jsonify({"error": "文件名为空"}), 400
    if not file.filename.lower().endswith((".xlsx", ".xls")):
        return jsonify({"error": "仅支持 .xlsx/.xls 文件"}), 400

    os.makedirs(UPLOAD_DIR, exist_ok=True)
    filename = secure_filename(file.filename) or "working.xlsx"
    if not filename.lower().endswith((".xlsx", ".xls")):
        filename += ".xlsx"
    save_path = os.path.join(UPLOAD_DIR, filename)
    file.save(save_path)

    STATE["current_path"] = save_path
    _ensure_backup(save_path)
    try:
        cases, progress = excel_service.parse_workbook(save_path)
    except Exception as exc:
        return jsonify({"error": f"解析失败: {exc}"}), 500
    return jsonify({
        "fileName": os.path.basename(save_path),
        "cases": cases,
        "progress": progress,
    })


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
    if not os.path.exists(path):
        return jsonify({"error": "当前文件不存在"}), 404
    try:
        progress = excel_service.update_case(path, sheet, row_index, fields)
    except Exception as exc:
        return jsonify({"error": f"写回失败: {exc}"}), 500
    return jsonify({"ok": True, "progress": progress})


@app.route("/api/download", methods=["GET"])
def download():
    path = STATE["current_path"]
    if not os.path.exists(path):
        return jsonify({"error": "文件不存在"}), 404
    return send_file(path, as_attachment=True, download_name=os.path.basename(path))


if __name__ == "__main__":
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    app.run(host="127.0.0.1", port=5000, debug=True)
