@echo off
setlocal
REM ATENCION: el local_loader escribe en la base Supabase REAL (extract/inject) y puede sincronizar a Sheets.
REM Iniciar solo de forma deliberada.
cd /d "%~dp0..\extraction\local_loader"
set PORT=
for /f "usebackq tokens=1,* delims==" %%a in (`findstr /b /c:"LOADER_PORT=" "..\..\.env"`) do set PORT=%%b
if "%PORT%"=="" set PORT=3010
title EOR Extraccion local (puerto %PORT%)
echo Iniciando local_loader en http://localhost:%PORT% ...
node --env-file=..\..\.env server.js
pause
