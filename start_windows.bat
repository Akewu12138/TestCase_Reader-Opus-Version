@echo off
REM ============================================================
REM 测试用例执行器 - Windows 双击启动器（健壮版）
REM 修复点：
REM   1) 优先复用已有 .venv，不再强制要求系统 PATH 中的 python
REM   2) 端口冲突时自动处理：若是本项目在跑则直接打开浏览器复用；
REM      否则自动切换到空闲备用端口，避免崩溃
REM   3) 启动失败/超时给出明确提示，不再静默
REM ============================================================
setlocal EnableExtensions

REM 脚本所在目录（去掉结尾反斜杠隐患，统一用变量引用）
set "BASE=%~dp0"
if "%BASE:~-1%"=="\" set "BASE=%BASE:~0,-1%"
cd /d "%BASE%" 2>nul || (echo [错误] 无法切换到脚本所在目录 & pause & exit /b 1)

echo ===============================================
echo   测试用例执行器
echo   工作目录: %BASE%
echo ===============================================

REM 虚拟环境
set "VENV_DIR=%BASE%\.venv"
set "PY=%VENV_DIR%\Scripts\python.exe"

REM 1) 若 venv 不存在，才需要系统 python 来创建
if not exist "%PY%" (
    echo [初始化] 未检测到 .venv，准备创建虚拟环境...
    set "SYS_PY="
    for /f "delims=" %%p in ('where python 2^>nul') do (
        if not defined SYS_PY set "SYS_PY=%%p"
    )
    if not defined SYS_PY (
        echo [错误] 未找到 python，请先安装 Python 3 并勾选 "Add to PATH"。
        echo 下载地址: https://www.python.org/downloads/
        pause
        exit /b 1
    )
    echo [初始化] 使用 %SYS_PY% 创建虚拟环境...
    "%SYS_PY%" -m venv "%VENV_DIR%" || (echo [错误] 创建虚拟环境失败 & pause & exit /b 1)
    echo [初始化] 正在安装依赖（首次较慢，请稍候）...
    "%PY%" -m pip install --upgrade pip
    "%PY%" -m pip install -r "%BASE%\requirements.txt"
) else (
    echo [就绪] 已存在虚拟环境，正在校验依赖...
    "%PY%" -m pip install -r "%BASE%\requirements.txt" >nul 2>&1
)

REM 2) 选择可用端口（默认 5000，冲突时自动切换）
set "PORT=5000"
call :checkport %PORT%
if defined PORT_BUSY (
    REM 判断占用者是否为本项目服务（能返回 HTTP 200 即视为本项目）
    set "IS_OURS="
    powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:%PORT%/' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>nul
    if not errorlevel 1 set "IS_OURS=1"
    if defined IS_OURS (
        echo [提示] 端口 %PORT% 已由本项目服务占用，直接打开浏览器复用。
        goto :open
    )
    echo [提示] 端口 %PORT% 被其他程序占用，正在寻找空闲端口...
    set "PORT=5001"
)
:findfree
call :checkport %PORT%
if defined PORT_BUSY (
    set /a PORT+=1
    if %PORT% gtr 5010 (
        echo [错误] 在 5000-5010 范围内未找到空闲端口。
        pause
        exit /b 1
    )
    goto :findfree
)
set "URL=http://127.0.0.1:%PORT%"

REM 3) 后台启动服务（最小化窗口，独立运行）
echo [启动] 正在启动服务 %URL% ...
start "测试用例执行器" /min "%PY%" "%BASE%\app.py"

REM 4) 等待服务就绪后打开浏览器
echo [等待] 等待服务就绪...
set "READY="
for /l %%i in (1,1,40) do (
    ping -n 2 127.0.0.1 >nul 2>nul
    powershell -NoProfile -Command "try { (Invoke-WebRequest -Uri '%URL%' -UseBasicParsing -TimeoutSec 1) | Out-Null; exit 0 } catch { exit 1 }" >nul 2>nul
    if not errorlevel 1 (
        set "READY=1"
        goto :open
    )
)
if not defined READY (
    echo [错误] 服务启动超时。请确认依赖已安装，或手动运行：
    echo   "%PY%" "%BASE%\app.py"
    pause
    exit /b 1
)

:open
set "URL=http://127.0.0.1:%PORT%"
echo [打开] 正在打开浏览器 %URL% ...
start "" "%URL%" >nul 2>nul
echo.
echo 服务已在后台启动（窗口标题：测试用例执行器）。
echo 关闭该窗口即可停止服务。访问地址: %URL%
echo.
pause
goto :eof

REM ---------- 子程序：检测指定端口是否被占用 ----------
:checkport
set "PORT_BUSY="
for /f "tokens=*" %%a in ('netstat -ano -p tcp 2^>nul ^| findstr /r ":%1[^0-9]"') do set "PORT_BUSY=1"
exit /b
