@echo off
setlocal enabledelayedexpansion
pushd "%~dp0"

echo ============================================
echo   GPT-Image-2 One-Click Start (Production)
echo   Frontend bundled into backend (single port :8000)
echo ============================================
echo.

REM ---------- 1. Backend deps (auto install on first run) ----------
if not exist ".venv\Scripts\python.exe" (
    echo [1/5] Initializing backend deps [uv sync]...
    call uv sync
    if errorlevel 1 (
        echo [ERROR] Backend deps install failed. Check uv: https://docs.astral.sh/uv/
        pause
        exit /b 1
    )
) else (
    echo [1/5] Backend deps ready (skip uv sync)
)

REM ---------- 2. Frontend deps (auto install on first run) ----------
if not exist "frontend\node_modules" (
    echo [2/5] Installing frontend deps [npm install]...
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
    echo [2/5] Frontend deps ready (skip npm install)
)

REM ---------- 3. Build frontend (incremental, fast) ----------
echo [3/5] Building frontend [npm run build]...
pushd frontend
call npm run build
if errorlevel 1 (
    echo [ERROR] Frontend build failed. Check TS errors above.
    popd
    pause
    exit /b 1
)
popd
echo.

REM ---------- 4. Env check ----------
echo [4/5] Checking environment...
if not exist ".env" (
    echo [WARN] .env not found! Copy .env.example to .env
    echo        and fill in TOAPIS_API_KEY / MySQL credentials first.
    pause
)

REM ---------- 5. Start backend (serves API + bundled frontend) ----------
echo [5/5] Starting backend on http://localhost:8000 ...
echo       (press Ctrl+C to stop; browser opens automatically)
start "" cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:8000"
uv run uvicorn backend.app.main:app --host 0.0.0.0 --port 8000
if errorlevel 1 (
    echo [ERROR] Backend failed to start. Check errors above.
    pause
)
popd
endlocal
