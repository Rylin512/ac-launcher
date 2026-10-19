@echo off
rem ===========================================================================
rem  AgileCampus launcher - folder mode (Windows)
rem
rem  Folder mode runs the SAME code as ac-launcher.exe, straight from this
rem  directory. It is the development form: edit a file, re-run, see it.
rem  The .exe is the shipping form: one file, no Node.js required on the
rem  target machine. Use this script when you have Node.js and want to hack.
rem
rem  IMPORTANT: this file is intentionally PURE ASCII, for the same reason
rem  spelled out in deploy\start.cmd - cmd.exe parses .cmd bytes using the
rem  system ANSI codepage (GBK on Chinese Windows), so non-ASCII here becomes
rem  mojibake that cmd then tries to execute as a command. "chcp 65001" does
rem  NOT fix that. All Chinese text lives in the browser UI instead.
rem
rem  PowerShell is deliberately NOT used anywhere: quoting through
rem  cmd -> PowerShell is fragile. Only curl.exe and tar.exe are used, both
rem  shipped in System32 since Windows 10 1803.
rem ===========================================================================

setlocal EnableExtensions
title AgileCampus Launcher

set "HERE=%~dp0"

rem --- Runtime directory. Priority: AC_RUNTIME_DIR > %LOCALAPPDATA%\AgileCampus
rem     There is deliberately no command-line override here: a positional
rem     argument means "the repository to open", and stealing it for the
rem     runtime directory would be a silent trap. Use the environment
rem     variable, or pass --runtime-dir through to main.mjs.
if "%AC_RUNTIME_DIR%"=="" set "AC_RUNTIME_DIR=%LOCALAPPDATA%\AgileCampus"
if not exist "%AC_RUNTIME_DIR%\tmp" mkdir "%AC_RUNTIME_DIR%\tmp" >nul 2>nul

echo.
echo   AgileCampus launcher (folder mode)
echo   Source     : %HERE%
echo   Runtime    : %AC_RUNTIME_DIR%
echo.

rem --------------------------------------------------------------------------
rem  1. A portable Node.js already downloaded by a previous run wins over PATH.
rem     nodebin.mjs looks here too (<runtime>\node\**), and the two MUST agree:
rem     if they disagree, the panel would build with one Node and run the app
rem     with another, which shows up as "works on my machine" and nothing else.
rem --------------------------------------------------------------------------
set "NODE_CMD="
for /d %%d in ("%AC_RUNTIME_DIR%\node\node-*-win-x64") do if exist "%%d\node.exe" set "NODE_CMD=%%d\node.exe"
if defined NODE_CMD (
  for /f "delims=" %%v in ('"%NODE_CMD%" -p "process.version"') do echo   Portable Node.js %%v found under the runtime directory.
  goto :have_node
)

rem --------------------------------------------------------------------------
rem  2. Otherwise look on PATH. Ask Node itself for its major version rather
rem     than parsing the string in batch.
rem --------------------------------------------------------------------------
where node >nul 2>nul
if errorlevel 1 goto :no_node

node -e "process.exit(+process.versions.node.split('.')[0]>=20?0:1)" >nul 2>nul
if errorlevel 1 (
  echo   Node.js on PATH is older than v20; a portable one will be downloaded.
  goto :no_node
)

set "NODE_CMD=node"
for /f "delims=" %%v in ('node -p "process.version"') do echo   Node.js %%v detected on PATH.
goto :have_node

rem --------------------------------------------------------------------------
rem  3. No usable Node.js: download a portable one into the runtime directory.
rem     No installer, no registry, no admin rights required.
rem --------------------------------------------------------------------------
:no_node
where curl.exe >nul 2>nul || goto :no_curl
where tar.exe >nul 2>nul || goto :no_tar

set "NODE_ZIP=%AC_RUNTIME_DIR%\tmp\node.zip"
set "NODE_GOT="

if exist "%NODE_ZIP%" (
  echo   Reusing previously downloaded %NODE_ZIP%
  set "NODE_GOT=1"
)

if not defined NODE_GOT call :fetch_node v22.23.2
if not defined NODE_GOT call :fetch_node v22.22.2
if not defined NODE_GOT call :fetch_node v22.21.1

if not defined NODE_GOT (
  echo.
  echo   [ERROR] Could not download a portable Node.js.
  echo.
  echo   Either install Node.js from https://nodejs.org/ and run this again,
  echo   or use dist\ac-launcher.exe, which needs no Node.js at all.
  echo.
  pause
  exit /b 1
)

echo   Extracting Node.js ...
if not exist "%AC_RUNTIME_DIR%\node" mkdir "%AC_RUNTIME_DIR%\node" >nul 2>nul
tar.exe -xf "%NODE_ZIP%" -C "%AC_RUNTIME_DIR%\node"
if errorlevel 1 (
  echo   [ERROR] Failed to extract %NODE_ZIP%
  pause
  exit /b 1
)

for /d %%d in ("%AC_RUNTIME_DIR%\node\node-*-win-x64") do set "NODE_CMD=%%d\node.exe"

if not defined NODE_CMD (
  echo   [ERROR] No node.exe found after extracting. The archive may be corrupt.
  pause
  exit /b 1
)
echo   Portable Node.js ready.

:have_node
rem --------------------------------------------------------------------------
rem  4. Start the launcher. It is a plain Node script with zero runtime
rem     dependencies, so it can run long before "npm ci" has ever been run.
rem     No arguments -> the hub (which manages and monitors every registered
rem     project). A repository argument, or --repo, -> that project's panel.
rem --------------------------------------------------------------------------
echo.
echo   Starting ...

"%NODE_CMD%" "%HERE%main.mjs" %*

set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo   [ERROR] The launcher exited with code %RC%.
  echo   Log file: %AC_RUNTIME_DIR%\logs\hub.log
  echo.
  pause
)

endlocal
exit /b 0

rem --------------------------------------------------------------------------
rem  Subroutine: try to download one Node.js version.
rem  --fail makes curl return non-zero on HTTP 404, so trying a short list of
rem  candidate versions is enough to survive a version being pulled.
rem --------------------------------------------------------------------------
:fetch_node
echo   Downloading Node.js %1 (about 30 MB, this may take a while) ...
curl.exe -L --fail --retry 3 --retry-delay 3 ^
  -o "%NODE_ZIP%" ^
  "https://nodejs.org/dist/%1/node-%1-win-x64.zip"
if errorlevel 1 (
  echo   Version %1 unavailable, trying the next one ...
  if exist "%NODE_ZIP%" del /q "%NODE_ZIP%" >nul 2>nul
  exit /b 0
)
rem A truncated download must never be treated as success.
for %%f in ("%NODE_ZIP%") do if %%~zf LSS 10000000 (
  echo   Downloaded file is too small, treating as failure ...
  if exist "%NODE_ZIP%" del /q "%NODE_ZIP%" >nul 2>nul
  exit /b 0
)
set "NODE_GOT=1"
exit /b 0

:no_curl
echo.
echo   [ERROR] curl.exe was not found. It ships with Windows 10 1803 and later.
echo   Install Node.js manually from https://nodejs.org/ and run this again.
echo.
pause
exit /b 1

:no_tar
echo.
echo   [ERROR] tar.exe was not found. It ships with Windows 10 1803 and later.
echo   Install Node.js manually from https://nodejs.org/ and run this again.
echo.
pause
exit /b 1
