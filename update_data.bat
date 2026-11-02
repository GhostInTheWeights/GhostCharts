@echo off
rem Fetches new candles from MetaTrader 5 and rebuilds the app's data files.
cd /d "%~dp0"
python update_data.py
pause
