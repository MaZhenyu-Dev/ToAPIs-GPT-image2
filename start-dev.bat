@echo off
setlocal enabledelayedexpansion
pushd "%~dp0"

echo ============================================
echo   GPT-Image-2 Quick Start (Dev)
echo ============================================
echo.

REM ---------- Env check ----------
if not exist ".env" (
    echo [WARN] .env not found!
    echo        Please copy .env.example to .env and fill in TOAPIS_API_KEY etc.
    echo.
    set /p CONTINUE=Continue anyway [y/n]:
    if /i not "!CONTINUE!"=="y" exit /b 1
    echo.
)

REM ---------- Backend deps (auto install on first run) ----------
if not exist ".venv\Scripts\python.exe" (
    echo [1/3] Initializing backend deps [uv sync]...
    call uv sync
    if errorlevel 1 (
        echo [ERROR] Backend deps install failed. Check uv: https://docs.astral.sh/uv/
        pause
        exit /b 1
    )
) else (
    echo [1/3] Backend deps ready (skip uv sync)
)

REM ---------- Frontend deps (auto install on first run) ----------
if not exist "frontend\node_modules" (
    echo [2/3] Installing frontend deps [npm install]...
    pushd frontend
    call npm install
    if errorlevel 1 (
        popd
        echo [ERROR] Frontend deps install failed. Check Node.js: https://nodejs.org/
        pause
        exit /b 1
    )
    popd
) else (
    echo [2/3] Frontend deps ready (skip npm install)
)

REM ---------- Start both services (separate windows for own logs) ----------
REM Note: new windows inherit current working directory (space-safe paths)
echo [3/3] Starting services...
start "GPT2 Backend :8000" cmd /k "uv run uvicorn backend.app.main:app --reload --port 8000"
start "GPT2 Frontend :5173" cmd /k "npm run dev"

echo.
echo ============================================
echo   Started. Service URLs:
echo     Backend API : http://localhost:8000/docs
echo     Frontend    : https://localhost:5173
echo   Frontend uses a self-signed cert. On first
echo   visit, click Advanced -^> Proceed in browser.
echo   Close a window to stop its service.
echo ============================================
echo.
pause
popd
endlocal
