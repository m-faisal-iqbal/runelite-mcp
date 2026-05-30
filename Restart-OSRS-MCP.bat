@echo off
setlocal
echo This will close any running RuneLite window so the local OSRS MCP plugin can load.
echo Use this only when you are safely logged out or ready to restart RuneLite.
pause
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Start-OsrsMcp.ps1" -RestartRuneLite
pause
