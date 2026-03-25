@echo off
setlocal
pushd "%~dp0"
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\private-hosting\launcher.ps1" status
set EXIT_CODE=%ERRORLEVEL%
popd
echo.
pause
exit /b %EXIT_CODE%
