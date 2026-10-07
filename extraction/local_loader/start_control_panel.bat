@echo off
title ETL Local Hub - Panel de Control (Puerto 3010)
cd /d "%~dp0"

echo ======================================================================
echo    🚛 ETL LOCAL HUB & PANEL DE CONTROL (Sheets -^> Local -^> Supabase)
echo ======================================================================
echo.
echo   Iniciando servidor local en el puerto 3010...
echo   Abriendo panel de control en tu navegador: http://localhost:3010
echo.
echo ======================================================================

start "" "http://localhost:3010"

node server.js
pause
