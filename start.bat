@echo off
cd /d "%~dp0"
set "PY="
where python >nul 2>nul && set "PY=python"
if not defined PY where py >nul 2>nul && set "PY=py -3"
if not defined PY if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" set "PY=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
if not defined PY (
  echo Python not found. Install Python 3 from https://www.python.org/downloads/
  echo and check "Add python.exe to PATH" during installation.
  pause
  exit /b 1
)
echo Starting NS Bus server... Do not close this window.
start "" http://localhost:8000
%PY% server.py --port 8000
echo.
echo Server stopped.
pause
