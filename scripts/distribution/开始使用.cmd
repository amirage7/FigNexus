@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
set "task_exit=%errorlevel%"
pause
exit /b %task_exit%