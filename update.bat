@echo off

REM ============================================================
REM  GPT-Image-2 一键安装 / 更新脚本 (update.bat)
REM
REM  用途：
REM    首次运行 = 自动下载项目源码到本文件所在目录
REM    之后运行 = 检测到新版本时自动更新
REM    无需安装 Git；GitHub 无法直连时自动切换镜像
REM
REM  说明：
REM    1. 请把本文件放到您希望存放项目的文件夹中，双击运行
REM    2. 脚本会先把自身复制到临时目录再执行，因此可以安全地自我更新
REM    3. 若已用 Git 克隆过本项目（存在 .git 目录），会自动改用 git pull 更新
REM    4. 高级用户可通过环境变量 GPT2_ZIP_URL / GPT2_MIRROR1 ~ GPT2_MIRROR3
REM       自定义下载源（默认 GitHub 官方源 + 3 个公共镜像）
REM ============================================================

if /i "%~1"=="__inner" goto :main

:bootstrap
setlocal EnableExtensions
set "PROJECT=%~dp0"
set "PROJECT_BAT=%~nx0"
set "INNER=%TEMP%\gpt2_update_inner_%RANDOM%.bat"
copy /y "%~f0" "%INNER%" >nul 2>nul
if not exist "%INNER%" endlocal & goto :main
call "%INNER%" __inner "%PROJECT%" "%PROJECT_BAT%" & del "%INNER%" >nul 2>nul & exit /b

:main
setlocal EnableExtensions
if not defined PROJECT set "PROJECT=%~dp0"
if not defined PROJECT_BAT set "PROJECT_BAT=%~nx0"
if "%PROJECT:~-1%"=="\" set "PROJECT=%PROJECT:~0,-1%"
pushd "%PROJECT%"

REM ---------- 配置 ----------
set "SCRIPT_VER=v1.0"
set "REPO=MaZhenyu-Dev/ToAPIs-GPT-image2"
set "BRANCH=main"
set "VER_FILE=%PROJECT%\.update-version"
set "WORK=%TEMP%\gpt2_update_work_%RANDOM%"
if not defined GPT2_ZIP_URL set "GPT2_ZIP_URL=https://codeload.github.com/%REPO%/zip/refs/heads/%BRANCH%"
if not defined GPT2_MIRROR1 set "GPT2_MIRROR1=https://ghproxy.net/https://github.com/%REPO%/archive/refs/heads/%BRANCH%.zip"
if not defined GPT2_MIRROR2 set "GPT2_MIRROR2=https://gh-proxy.com/https://github.com/%REPO%/archive/refs/heads/%BRANCH%.zip"
if not defined GPT2_MIRROR3 set "GPT2_MIRROR3=https://ghfast.top/https://github.com/%REPO%/archive/refs/heads/%BRANCH%.zip"

echo ============================================
echo   GPT-Image-2 安装 / 更新  （脚本 %SCRIPT_VER%）
echo   目标目录：%PROJECT%
echo ============================================
echo.

REM ---------- 是否已安装 ----------
set "INSTALLED="
if exist "%PROJECT%\backend\app\main.py" set "INSTALLED=1"
if defined INSTALLED goto :check_done

set "OTHER="
for /f "delims=" %%F in ('dir /a /b "%PROJECT%" 2^>nul') do if /i not "%%F"=="%PROJECT_BAT%" if /i not "%%F"==".update-version" set "OTHER=1"
if not defined OTHER goto :check_done
echo   [警告] 当前文件夹不是空文件夹，也不是项目目录：
echo          %PROJECT%
echo          继续操作会把项目源码写入该文件夹（不会删除已有文件）。
choice /C YN /N /M "确定继续吗？[Y=继续 / N=退出] "
if errorlevel 2 goto :cancelled
echo.

:check_done
REM ---------- 优先使用 Git（仅当存在 .git 且安装了 git 时） ----------
if not exist "%PROJECT%\.git" goto :zip_flow
where git >nul 2>nul
if errorlevel 1 goto :git_unavailable

echo   [1/3] 正在通过 Git 检查更新...
git fetch --prune origin %BRANCH%
if errorlevel 1 goto :git_failed

set "G_LOCAL="
set "G_REMOTE="
for /f "delims=" %%H in ('git rev-parse HEAD 2^>nul') do set "G_LOCAL=%%H"
for /f "delims=" %%H in ('git rev-parse "origin/%BRANCH%" 2^>nul') do set "G_REMOTE=%%H"
if /i "%G_LOCAL%"=="%G_REMOTE%" goto :up_to_date

echo   [2/3] 发现新版本，正在更新...
git pull --ff-only origin %BRANCH%
if not errorlevel 1 goto :update_done

echo   [提示] 自动更新失败，当前目录可能有未提交的修改。
choice /C YN /N /M "是否放弃本地修改并使用远程最新版本？[Y=覆盖 / N=改用压缩包更新] "
if errorlevel 2 goto :zip_flow
git fetch origin %BRANCH%
git reset --hard "origin/%BRANCH%"
if errorlevel 1 goto :git_failed
goto :update_done

:git_unavailable
echo   [提示] 检测到 .git 目录，但系统未安装 Git，改用压缩包方式更新...
echo.
goto :zip_flow

:git_failed
echo   [提示] Git 更新失败（常见原因：网络无法访问 GitHub）。
echo          将自动改用压缩包方式更新...
echo.
goto :zip_flow

:zip_flow
if exist "%WORK%" rmdir /s /q "%WORK%" >nul 2>nul
mkdir "%WORK%" >nul 2>nul

echo   [1/3] 正在获取最新源码包...
call :try_download "%GPT2_ZIP_URL%" "%WORK%\src.zip" "GitHub 官方源"
if defined DL_OK goto :download_done
call :try_download "%GPT2_MIRROR1%" "%WORK%\src.zip" "镜像 ghproxy.net"
if defined DL_OK goto :download_done
call :try_download "%GPT2_MIRROR2%" "%WORK%\src.zip" "镜像 gh-proxy.com"
if defined DL_OK goto :download_done
call :try_download "%GPT2_MIRROR3%" "%WORK%\src.zip" "镜像 ghfast.top"
if defined DL_OK goto :download_done
goto :err_network

:download_done
echo   [2/3] 正在校验版本...
call :hash_file "%WORK%\src.zip"
if not defined FILE_HASH goto :err_extract
set "LOCAL_HASH="
if exist "%VER_FILE%" set /p LOCAL_HASH=<"%VER_FILE%"
if defined LOCAL_HASH set "LOCAL_HASH=%LOCAL_HASH: =%"
if /i "%LOCAL_HASH%"=="%FILE_HASH%" goto :up_to_date
echo        发现新版本，开始更新...
echo   [3/3] 正在解压并写入项目文件...

pushd "%WORK%"
tar -xf "src.zip" >nul 2>nul
if errorlevel 1 powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath 'src.zip' -DestinationPath '.' -Force" >nul 2>nul
popd

set "SRC="
for /d %%D in ("%WORK%\*") do if not defined SRC set "SRC=%%D"
if not defined SRC goto :err_extract

robocopy "%SRC%" "%PROJECT%" /E /NFL /NDL /NJH /NJS /R:1 /W:1 >nul
if errorlevel 8 goto :err_copy
if not defined FILE_HASH goto :skip_write_hash
> "%VER_FILE%" echo %FILE_HASH%
:skip_write_hash

:update_done
rmdir /s /q "%WORK%" >nul 2>nul
echo.
echo ============================================
echo   更新完成！
echo ============================================
echo.
goto :finish

:up_to_date
rmdir /s /q "%WORK%" >nul 2>nul
echo.
echo ============================================
echo   已是最新版本，无需更新。
echo ============================================
echo.
goto :finish

:finish
where uv >nul 2>nul
if errorlevel 1 echo   [提示] 未检测到 uv（Python 依赖管理工具），启动前请先安装：https://docs.astral.sh/uv/
where node >nul 2>nul
if errorlevel 1 echo   [提示] 未检测到 Node.js（前端构建环境），启动前请先安装：https://nodejs.org/
echo.
choice /C YN /N /T 15 /D Y /M "现在启动项目吗？[Y=启动 / N=退出] "
if errorlevel 2 goto :the_end
echo.
if not exist "%PROJECT%\start.bat" goto :err_no_start
call "%PROJECT%\start.bat"
goto :the_end

:err_network
rmdir /s /q "%WORK%" >nul 2>nul
echo.
echo   [错误] 源码包下载失败，请检查网络后重试。
echo          GitHub 无法直连时，可开启代理/VPN 后重试。
goto :fail

:err_extract
rmdir /s /q "%WORK%" >nul 2>nul
echo.
echo   [错误] 源码包解压失败或文件校验失败，请重新运行本脚本重试。
goto :fail

:err_copy
rmdir /s /q "%WORK%" >nul 2>nul
echo.
echo   [错误] 写入项目文件失败（文件被占用或权限不足）。
echo          请关闭正在运行的项目窗口，然后重新运行本脚本。
goto :fail

:err_no_start
echo   [错误] 未找到 start.bat，无法启动项目。
goto :fail

:the_end
popd
endlocal
exit /b 0

:cancelled
popd
endlocal
exit /b 0

:fail
echo.
pause
popd
endlocal
exit /b 1

REM ============================================================
REM  子过程
REM ============================================================

:try_download
REM %1=下载地址  %2=保存路径  %3=显示名称
set "DL_URL=%~1"
set "DL_DEST=%~2"
set "DL_LABEL=%~3"
set "DL_OK="
echo        正在从 %DL_LABEL% 下载...
del /q "%DL_DEST%" >nul 2>nul
where curl >nul 2>nul
if errorlevel 1 goto :try_download_ps
curl -L --fail --connect-timeout 10 --max-time 180 -s -S -o "%DL_DEST%" "%DL_URL%" 2>nul
if exist "%DL_DEST%" for %%A in ("%DL_DEST%") do if %%~zA GTR 50000 set "DL_OK=1"
if defined DL_OK exit /b 0

:try_download_ps
del /q "%DL_DEST%" >nul 2>nul
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; $ProgressPreference='SilentlyContinue'; try { Invoke-WebRequest -UseBasicParsing -Uri '%DL_URL%' -OutFile '%DL_DEST%' -TimeoutSec 180 } catch { exit 1 }" >nul 2>nul
if exist "%DL_DEST%" for %%A in ("%DL_DEST%") do if %%~zA GTR 50000 set "DL_OK=1"
exit /b 0

:hash_file
REM %1=文件路径，结果写入 FILE_HASH
set "FILE_HASH="
set "HF_PATH=%~1"
for /f "delims=" %%H in ('powershell -NoProfile -Command "(Get-FileHash -LiteralPath '%HF_PATH%' -Algorithm SHA256).Hash" 2^>nul') do set "FILE_HASH=%%H"
exit /b 0
