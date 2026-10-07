@echo off
title Disparador de Sincronizacion - Sheets a Supabase
echo ======================================================================
echo    DISPARADOR DE SINCRONIZACION: GOOGLE SHEETS -^> SUPABASE
echo    Modulo: local_loader (Entorno Local)
echo ======================================================================
echo.

cd /d "%~dp0"

echo Iniciando proceso de extraccion y actualizacion...
echo.

call npm run sync

echo.
echo ======================================================================
echo    PROCESO FINALIZADO
echo ======================================================================
echo.
pause
