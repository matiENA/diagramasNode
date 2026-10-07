@echo off
title n8n - Orquestador (puerto 5678)
REM n8n comparte estado (~/.n8n) con la instalacion original. No importar workflows de prueba sin revisar.
start "" "http://localhost:5678"
call "%APPDATA%\npm\n8n.cmd" start
pause
