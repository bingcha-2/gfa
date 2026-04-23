@echo off
setlocal
pushd "%~dp0"
call pnpm start:stop
set EXIT_CODE=%ERRORLEVEL%
popd
echo.
pause
exit /b %EXIT_CODE%
