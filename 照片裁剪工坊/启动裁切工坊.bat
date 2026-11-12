@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

title Ratio Crop Studio - Local Save Service

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js was not found.
  echo Install Node.js 18 or newer from https://nodejs.org
  echo then run this file again.
  echo.
  pause
  exit /b 1
)

echo.
echo Starting Ratio Crop Studio local server...
echo The browser will open automatically.
echo Keep this window open. Close it to stop the server.
echo.

node app-server.js

echo.
echo Local server stopped.
pause
