@echo off
setlocal

rem Clear DSH auth cookies, then start DSH.   (revive pack copy)
rem
rem Why: DSH desktop uses a RANDOM PORT on every launch, and the auth cookie
rem   name is derived from host:port -- so every launch adds one dsh-auth-*
rem   cookie, 30 days TTL, never collected. At ~70 cookies they all go into the
rem   request header, overflow the 16 KiB limit, the server answers 431 and
rem   startup crashes with "Web authentication failed".
rem
rem Deleting the cookie DB is safe: it is rebuilt empty on the next launch.
rem Sessions, chat history and settings are NOT touched.
rem
rem Source: GitHub deepseek-ai/deepseek-harness discussion #11408
rem         (our own 2026-11-01 test: 53 KB cookies -> 20 KB, sessions intact)

set "NET=%APPDATA%\@deepseek-ai\dsh-desktop\Network"
set "EXE=%LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe"

if not exist "%EXE%" (
  echo [X] DSH not found: "%EXE%"
  echo     Edit this file and set EXE to your install path.
  pause
  exit /b 1
)

tasklist /FI "IMAGENAME eq DeepSeek Harness.exe" /NH 2>nul | find /I "DeepSeek Harness" >nul
if not errorlevel 1 (
  echo [X] DSH is still running. Quit it from the tray first, then run this again.
  pause
  exit /b 2
)

echo [*] Clearing cookies in: %NET%
if exist "%NET%\Cookies" (
  del /f /q "%NET%\Cookies" 2>nul
  del /f /q "%NET%\Cookies-journal" 2>nul
  del /f /q "%NET%\Cookies-wal" 2>nul
  del /f /q "%NET%\Cookies-shm" 2>nul
)
if exist "%NET%\Cookies" (
  echo [X] Delete failed. Cookies still there. Try running as administrator.
  pause
  exit /b 3
)
echo [OK] Cookies cleared.

echo [*] Starting DSH ...
start "" "%EXE%"
exit /b 0
