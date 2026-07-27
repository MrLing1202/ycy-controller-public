@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo [1/3] Checking Python...
py --version || goto :no_python
echo [2/3] Installing dependencies...
py -m pip install --upgrade pip
py -m pip install -r requirements.txt
if not exist .env copy .env.example .env >nul
echo [3/3] Starting YCY Controller...
py run.py
pause
exit /b
:no_python
echo Python not found. Install Python 3.10+ and enable Add Python to PATH.
pause
