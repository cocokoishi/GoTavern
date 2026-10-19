@echo off
setlocal
cd /d "%~dp0"
if not exist "%~dp0gotavern.exe" (
  echo error: "%~dp0gotavern.exe" was not found.
  echo Install a prebuilt GoTavern release first.
  exit /b 1
)
"%~dp0gotavern.exe" %*
