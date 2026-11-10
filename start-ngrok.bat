@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Can 3 thu muc vietjet-backend, vietjet-admin, vietjet-customer nam canh nhau. Them --no-build de bo qua build web.
node tools\share.js %*
pause
