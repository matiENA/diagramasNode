@echo off
setlocal
cd /d "%~dp0..\apps\frontend"
set FPORT=
for /f "usebackq tokens=1,* delims==" %%a in (`findstr /b /c:"FRONT_PORT=" "..\..\.env"`) do set FPORT=%%b
if "%FPORT%"=="" set FPORT=3000
title EOR Frontend (puerto %FPORT%)
echo Iniciando frontend EOR (Vite) en http://localhost:%FPORT% ...
call npm run dev
pause
