@echo off
REM PM2 Resurrect — Restore saved PM2 process list
REM This script is called by Windows Task Scheduler on login

set PM2_HOME=C:\Users\Administrator\.pm2
set PATH=%PATH%;C:\Program Files\nodejs;C:\Users\Administrator\AppData\Roaming\npm

echo [%date% %time%] PM2 Resurrect starting... >> "%PM2_HOME%\resurrect.log"

pm2 resurrect >> "%PM2_HOME%\resurrect.log" 2>&1

echo [%date% %time%] PM2 Resurrect done. >> "%PM2_HOME%\resurrect.log"
