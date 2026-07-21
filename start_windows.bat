@echo off
REM 测试用例执行器 - Windows 双击启动器
REM 首次运行自动创建虚拟环境并安装依赖，随后启动服务并打开浏览器。
setlocal

cd /d "%~dp0"

echo ===============================================
echo   测试用例执行器
echo   工作目录: %cd%
echo ===============================================

REM 1) 检测 python
where python >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 python，请先安装 Python 3 并勾选 "Add to PATH"。
  echo 下载地址: https://www.python.org/downloads/
  pause
  exit /b 1
)

set "VENV_DIR=%cd%\.venv"
set "PY=%VENV_DIR%\Scripts\python.exe"

REM 2) 首次创建虚拟环境并安装依赖
if not exist "%PY%" (
  echo [初始化] 正在创建虚拟环境 .venv ...
  python -m venv "%VENV_DIR%"
  echo [初始化] 正在安装依赖（首次较慢，请稍候）...
  "%PY%" -m pip install --upgrade pip >nul
  "%PY%" -m pip install -r "%cd%\requirements.txt"
) else (
  REM 已有虚拟环境：仍确保依赖齐全（用于补齐新增依赖如 Pillow）
  echo [就绪] 已存在虚拟环境，正在校验依赖...
  "%PY%" -m pip install -r "%cd%\requirements.txt" >nul 2>&1
)

REM 服务端口（如需修改，只改这里即可；app.py 会读取 PORT 环境变量）
set "PORT=5000"
set "URL=http://127.0.0.1:%PORT%"

REM 3) 后台启动服务
echo [启动] 正在启动服务 %URL% ...
start "测试用例执行器" /min "%PY%" "%cd%\app.py"

REM 4) 等待服务就绪后打开浏览器
echo [等待] 等待服务就绪...
for /l %%i in (1,1,30) do (
  timeout /t 1 /nobreak >nul
  powershell -NoProfile -Command "try { (Invoke-WebRequest -Uri '%URL%' -UseBasicParsing -TimeoutSec 1) ^| Out-Null; exit 0 } catch { exit 1 }" >nul 2>nul
  if not errorlevel 1 goto :ready
)
:ready

echo [打开] 正在打开浏览器...
start "" "%URL%"

echo.
echo 服务已在后台启动。关闭弹出的服务窗口即可停止服务。
echo.
pause
endlocal
