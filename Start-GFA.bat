@echo off
title Google Family Automation — 启动中
setlocal
pushd "%~dp0"
echo.
echo  ====================================
echo   Google Family Automation
echo  ====================================
echo.
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\private-hosting\launcher.ps1" start
set EXIT_CODE=%ERRORLEVEL%
popd
if %EXIT_CODE% NEQ 0 (
  echo.
  echo  [错误] 启动失败，请查看上方日志。
)
echo.
pause
exit /b %EXIT_CODE%
