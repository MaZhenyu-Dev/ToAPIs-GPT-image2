@echo off
setlocal enabledelayedexpansion
pushd "%~dp0"

echo ============================================
echo   GPT-Image-2 One-Click Start (Production)
echo   Frontend bundled into backend (single port :8000)
echo ============================================
echo.

REM ---------- 1. Build frontend (incremental, fast) ----------
echo [1/3] Building frontend [npm run build]...
pushd frontend
call npm run build
if errorlevel 1 (
    echo [ERROR] Frontend build failed. Check Node.js / TS errors above.
    popd
    pause
    exit /b 1
)
popd
echo.

REM ---------- 2. Env check ----------
if not exist ".env" (
    echo [WARN] .env not found! Copy .env.example to .env first.
    pause
)

REM ---------- 3. Start backend (serves API + bundled frontend) ----------
echo [2/3] Starting backend on http://localhost:8000 ...
echo       (press Ctrl+C to stop; browser opens automatically)
echo.
start "" cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:8000"
uv run uvicorn backend.app.main:app --host 0.0.0.0 --port 8000
if errorlevel 1 (
    echo [ERROR] Backend failed to start. Check errors above.
    pause
)
popd
endlocal
