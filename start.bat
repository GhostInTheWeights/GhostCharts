@echo off
rem Starts Ghost Charts at http://localhost:8765 and opens it in the browser.
cd /d "%~dp0"
start "Ghost Charts server" python server.py 8765
timeout /t 2 /nobreak >nul
start "" http://localhost:8765/
