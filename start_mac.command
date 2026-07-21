#!/bin/bash
# 测试用例执行器 - macOS 双击启动器
# 首次运行自动创建虚拟环境并安装依赖，随后启动服务并打开浏览器。

set -e

# 定位脚本所在目录（支持从任意位置双击）
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo "==============================================="
echo "  测试用例执行器"
echo "  工作目录: $DIR"
echo "==============================================="

# 1) 检测 python3
if ! command -v python3 >/dev/null 2>&1; then
  echo "[错误] 未找到 python3，请先安装 Python 3（https://www.python.org/downloads/）。"
  echo "按回车键退出…"
  read -r
  exit 1
fi

VENV_DIR="$DIR/.venv"
PY="$VENV_DIR/bin/python"

# 2) 首次创建虚拟环境并安装依赖
if [ ! -x "$PY" ]; then
  echo "[初始化] 正在创建虚拟环境 .venv …"
  python3 -m venv "$VENV_DIR"
  echo "[初始化] 正在安装依赖（首次较慢，请稍候）…"
  "$PY" -m pip install --upgrade pip >/dev/null
  "$PY" -m pip install -r "$DIR/requirements.txt"
else
  # 已有虚拟环境：仍确保依赖齐全（pip 已满足时很快；用于补齐新增依赖如 Pillow）
  echo "[就绪] 已存在虚拟环境，正在校验依赖…"
  "$PY" -m pip install -r "$DIR/requirements.txt" >/dev/null 2>&1 \
    && echo "[就绪] 依赖已就绪。" \
    || echo "[提示] 依赖校验未完成（可能离线），将尝试直接启动。"
fi

# 服务端口（如需修改，只改这里即可；app.py 会读取 PORT 环境变量）
export PORT=8080
URL="http://127.0.0.1:$PORT"

# 3) 后台启动服务
echo "[启动] 正在启动服务 $URL …"
"$PY" "$DIR/app.py" &
SERVER_PID=$!

# 关闭窗口/中断时一并停止服务
trap 'echo; echo "[退出] 正在停止服务…"; kill $SERVER_PID 2>/dev/null; exit 0' INT TERM

# 4) 等待端口就绪后打开浏览器
echo "[等待] 等待服务就绪…"
for _ in $(seq 1 30); do
  if curl -s -o /dev/null "$URL"; then
    break
  fi
  sleep 0.5
done

echo "[打开] 正在打开浏览器…"
open "$URL"

echo
echo "服务已启动。关闭此窗口或按 Ctrl+C 可停止服务。"
echo

# 保持前台，等待服务进程结束
wait $SERVER_PID
