@echo off
setlocal
cd /d "%~dp0..\apps\backend"
set PORT=
for /f "usebackq tokens=1,* delims==" %%a in (`findstr /b /c:"BACKEND_PORT=" "..\..\.env"`) do set PORT=%%b
if "%PORT%"=="" set PORT=3005
title EOR Backend (puerto %PORT%)
echo Iniciando backend EOR en http://localhost:%PORT% ...
node --env-file=..\..\.env server.js
pause
