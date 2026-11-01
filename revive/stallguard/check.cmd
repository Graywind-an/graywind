@echo off
rem stallguard - offline loop analysis for DSH sessions (no plugin, no DSH needed).
rem ASCII only on purpose: this file must never break because of encoding.

setlocal
set "HERE=%~dp0"
cd /d "%HERE%"

rem 2026-11-02: a clean machine has no node in PATH, but DSH bundles one.
rem Only checking "where node" made this script fail on a fresh Windows.
rem NOTE: no non-ASCII in this file. cmd reads .cmd as ANSI; CJK comments
rem       corrupt the parse and silently break the if/else below.
set "NODE="
set "DSHNODE=%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
if exist "%DSHNODE%" set "NODE=%DSHNODE%"
if not defined NODE (
  where node >nul 2>nul
  if not errorlevel 1 set "NODE=node"
)
if not defined NODE (
  echo [X] Node.js not found.
  echo     Install Node.js, or install DeepSeek Harness ^(it bundles one^).
  pause
  exit /b 1
)

"%NODE%" analyze.mjs %*
echo.
pause
exit /b %errorlevel%