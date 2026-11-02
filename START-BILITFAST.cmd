@echo off
setlocal
cd /d "%~dp0"
if not exist "%~dp0runtime\node.exe" (
  echo ERROR: runtime\node.exe was not found. Obtain the complete portable package from the seller.
  pause
  exit /b 1
)
"%~dp0runtime\node.exe" "%~dp0scripts\portable-run.js"
if errorlevel 1 (
  echo.
  echo BilitFast could not start. Check the error above. Do not delete data or .env.
  pause
)
