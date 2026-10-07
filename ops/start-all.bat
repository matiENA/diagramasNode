@echo off
REM Levanta backend + frontend (NO levanta extraccion ni n8n: ver start-extraction.bat y start-n8n.bat).
start "EOR Backend" cmd /k "%~dp0start-backend.bat"
timeout /t 3 /nobreak > nul
start "EOR Frontend" cmd /k "%~dp0start-frontend.bat"
