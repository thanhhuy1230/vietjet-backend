@echo off
chcp 65001 >nul
cd /d "%~dp0backend"
if not exist node_modules call npm install
echo Backend: http://localhost:3000/api/v1/health
call npm start
pause
