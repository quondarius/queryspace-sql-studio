@echo off
setlocal
cd /d "%~dp0"
echo Starting Queryspace's local SQLite workspace...
python server.py
if errorlevel 1 (
  echo.
  echo Queryspace stopped with an error. Make sure Python 3 is installed and port 5502 is available.
  pause
)
