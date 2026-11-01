@echo off
rem Revival entry - one shortcut, several ways back.
rem Buttons live in revive-config.json; add a line there to add a way back.
rem ASCII only on purpose: this file must never break because of encoding.

setlocal
set "HERE=%~dp0"

if not exist "%HERE%revive.ps1" (
  echo [X] Missing: "%HERE%revive.ps1"
  pause
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%HERE%revive.ps1"
exit /b %errorlevel%