@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "KONTUR_NODE=node"
where node >nul 2>nul
if errorlevel 1 (
  if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" (
    set "KONTUR_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
  ) else (
    echo Нужен Node.js версии 24 или новее.
    pause
    exit /b 1
  )
)
"%KONTUR_NODE%" scripts\stop.mjs
if errorlevel 1 pause
